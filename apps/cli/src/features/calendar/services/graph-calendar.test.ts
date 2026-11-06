import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import {
  fakeGraph,
  graphAccount,
  onFakeGraph,
} from '../../../shared/graph/graph-server.fixture';
import type { Calendar } from '../schemas/calendar';
import {
  calendarEvents,
  findGraphCalendar,
  graphCalendars,
  graphEvent,
} from './graph-calendar';
import { berlin, windowOf } from './ical.fixture';

const root = 'https://graph.microsoft.com/v1.0';
const view = '/me/calendars/cal-1/calendarView';

const utc = (time: string) => ({ dateTime: time, timeZone: 'UTC' });

const timed = (id: string, subject: string, start: string, end: string) => ({
  id,
  iCalUId: `uid-${id}`,
  subject,
  start: utc(start),
  end: utc(end),
  isAllDay: false,
});

const calendar: Calendar = {
  account: 'me@example.com',
  href: 'cal-1',
  name: 'Calendar',
};

// The week of 2026-11-03 to 2026-11-09 in Berlin.
const week = windowOf('2026-11-02T23:00:00Z', '2026-11-09T23:00:00Z');

const settings = { clientId: 'app', hiddenCalendars: [] };

const result = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

describe('graphCalendars', () => {
  it('lists the calendars with their color and edit access', async () => {
    const { client, requests } = fakeGraph({
      '/me/calendars': {
        value: [
          { id: 'cal-1', name: 'Calendar', hexColor: '', canEdit: true },
          { id: 'cal-2', name: 'Team', hexColor: '#3a87ad', canEdit: false },
        ],
      },
    });
    expect(await result(graphCalendars(client, settings))).toEqual(
      Result.succeed([
        {
          account: 'me@example.com',
          href: 'cal-1',
          name: 'Calendar',
          writable: true,
        },
        {
          account: 'me@example.com',
          href: 'cal-2',
          name: 'Team',
          color: '#3a87ad',
          writable: false,
        },
      ]),
    );
    expect(requests.map(({ url }) => url)).toEqual([
      `${root}/me/calendars?$select=id,name,hexColor,canEdit,allowedOnlineMeetingProviders`,
    ]);
  });

  it('leaves out the calendars the account hides, whatever their case', async () => {
    const { client } = fakeGraph({
      '/me/calendars': {
        value: [
          { id: 'cal-1', name: 'Calendar', hexColor: '', canEdit: true },
          { id: 'cal-2', name: 'Birthdays', hexColor: '', canEdit: false },
        ],
      },
    });
    expect(
      await result(
        graphCalendars(client, { ...settings, hiddenCalendars: ['birthdays'] }),
      ),
    ).toEqual(
      Result.succeed([
        {
          account: 'me@example.com',
          href: 'cal-1',
          name: 'Calendar',
          writable: true,
        },
      ]),
    );
  });

  it('reports calendars in an unexpected form', async () => {
    const { client } = fakeGraph({
      '/me/calendars': { value: [{ name: 'x' }] },
    });
    expect(await result(graphCalendars(client, settings))).toMatchObject({
      failure: {
        _tag: 'GraphError',
        message:
          'Microsoft Graph sent the calendars of me@example.com in an unexpected form',
      },
    });
  });
});

describe('findGraphCalendar', () => {
  const named = (href: string, name: string): Calendar => ({
    account: 'me@example.com',
    href,
    name,
  });
  const list = [
    named('cal-1', 'Calendar'),
    named('cal-2', 'Team'),
    named('cal-3', 'team'),
  ];

  it('matches the exact id first, then the name in any case', () => {
    expect(findGraphCalendar(list, 'cal-3')).toEqual(
      Result.succeed(named('cal-3', 'team')),
    );
    expect(findGraphCalendar(list, ' calendar ')).toEqual(
      Result.succeed(named('cal-1', 'Calendar')),
    );
  });

  it('reports an ambiguous or missing name', () => {
    expect(findGraphCalendar(list, 'TEAM')).toEqual(Result.fail('ambiguous'));
    expect(findGraphCalendar(list, 'Holidays')).toEqual(Result.fail('missing'));
  });
});

const viewPages = {
  [view]: {
    value: [
      // 21:00 in Berlin the day before the window.
      timed(
        'event-0',
        'Late call',
        '2026-11-02T20:00:00.0000000',
        '2026-11-02T21:00:00.0000000',
      ),
      timed(
        'event-1',
        'Planning',
        '2026-11-03T13:00:00.0000000',
        '2026-11-03T14:00:00.0000000',
      ),
    ],
    '@odata.nextLink': `${root}${view}?$skiptoken=page-2`,
  },
  [`${view}?$skiptoken=page-2`]: {
    value: [
      {
        id: 'event-2',
        subject: 'Offsite',
        start: utc('2026-11-04T00:00:00.0000000'),
        end: utc('2026-11-05T00:00:00.0000000'),
        isAllDay: true,
      },
      { id: 'event-bad', start: 'now' },
    ],
  },
};

const eventsOf = (text: string | undefined) => {
  const { client, requests } = fakeGraph(viewPages);
  return {
    requests,
    run: result(
      calendarEvents(client, calendar, { window: week, text, local: berlin }),
    ),
  };
};

describe('calendarEvents', () => {
  it('asks for every page around the window in UTC', async () => {
    const { requests, run } = eventsOf(undefined);
    await run;
    expect(requests).toEqual([
      {
        url: `${root}${view}?startDateTime=2026-11-01T21:00:00.000Z&endDateTime=2026-11-11T01:00:00.000Z&$select=id,iCalUId,subject,start,end,isAllDay,isCancelled,location,organizer,attendees,type,originalStart,bodyPreview&$top=100`,
        prefer: 'outlook.timezone="UTC"',
      },
      {
        url: `${root}${view}?$skiptoken=page-2`,
        prefer: 'outlook.timezone="UTC"',
      },
    ]);
  });

  it('keeps the events in the window and lists those it cannot read', async () => {
    const found = await eventsOf(undefined).run;
    expect(found).toMatchObject({
      success: {
        events: [
          {
            startMs: Date.UTC(2026, 10, 3, 13),
            event: { href: 'event-1', start: '2026-11-03T14:00:00+01:00' },
          },
          {
            startMs: Date.UTC(2026, 10, 3, 23),
            event: { href: 'event-2', start: '2026-11-04', allDay: true },
          },
        ],
        unreadable: [
          {
            account: 'me@example.com',
            errorTag: 'CalendarDataError',
            message:
              'Could not read Outlook event event-bad: Microsoft Graph sent it in an unexpected form',
          },
        ],
      },
    });
    expect(Result.isSuccess(found) && found.success.events).toHaveLength(2);
  });

  it('keeps only the events that mention the text', async () => {
    const found = await eventsOf('offsite').run;
    expect(
      Result.isSuccess(found) &&
        found.success.events.map(({ event }) => event.href),
    ).toEqual(['event-2']);
  });
});

const occurrence = {
  ...timed(
    'occ-1',
    'Planning',
    '2026-11-17T13:00:00.0000000',
    '2026-11-17T14:00:00.0000000',
  ),
  type: 'occurrence',
  originalStart: '2026-11-17T13:00:00Z',
  seriesMasterId: 'series-1',
  body: { contentType: 'text', content: 'Agenda' },
};

const seriesMaster = {
  ...timed(
    'series-1',
    'Planning',
    '2026-11-03T13:00:00.0000000',
    '2026-11-03T14:00:00.0000000',
  ),
  type: 'seriesMaster',
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['tuesday'] },
    range: { type: 'noEnd' },
  },
  cancelledOccurrences: ['OID.series-1.2026-11-10'],
  exceptionOccurrences: [
    {
      ...occurrence,
      id: 'exc-1',
      type: 'exception',
      start: utc('2026-11-24T15:00:00.0000000'),
      end: utc('2026-11-24T16:00:00.0000000'),
      originalStart: '2026-11-24T13:00:00Z',
    },
  ],
};

describe('graphEvent', () => {
  it('shows an occurrence with the rule of its series', async () => {
    const { requests, effect } = onFakeGraph(
      { '/me/events/occ-1': occurrence, '/me/events/series-1': seriesMaster },
      graphEvent(graphAccount, 'occ-1', berlin),
    );
    expect(await result(effect)).toMatchObject({
      success: {
        href: 'occ-1',
        start: '2026-11-17T14:00:00+01:00',
        description: 'Agenda',
        recurrence: {
          rule: 'FREQ=WEEKLY;BYDAY=TU',
          excluded: ['2026-11-10'],
          changed: [
            {
              recurrenceId: '2026-11-24T14:00:00+01:00',
              start: '2026-11-24T16:00:00+01:00',
              end: '2026-11-24T17:00:00+01:00',
            },
          ],
        },
      },
    });
    expect(requests).toEqual([
      {
        url: `${root}/me/events/occ-1?$select=id,iCalUId,subject,start,end,isAllDay,isCancelled,location,organizer,attendees,type,originalStart,body,webLink,seriesMasterId,isOrganizer,responseStatus,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,isReminderOn,reminderMinutesBeforeStart`,
        prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
      },
      {
        url: `${root}/me/events/series-1?$select=id,subject,start,end,isAllDay,isCancelled,location,attendees,type,originalStart,recurrence,cancelledOccurrences&$expand=exceptionOccurrences`,
        prefer: 'outlook.timezone="UTC"',
      },
    ]);
  });

  it('makes one request for an event that does not recur', async () => {
    const { seriesMasterId: _series, type: _type, ...single } = occurrence;
    const { requests, effect } = onFakeGraph(
      { '/me/events/occ-1': single },
      graphEvent(graphAccount, 'occ-1', berlin),
    );
    const shown = await result(effect);
    expect(Result.isSuccess(shown) && shown.success).not.toHaveProperty(
      'recurrence',
    );
    expect(requests).toHaveLength(1);
  });

  it('reports an event Microsoft Graph does not have', async () => {
    const { effect } = onFakeGraph(
      {},
      graphEvent(graphAccount, 'gone', berlin),
    );
    expect(await result(effect)).toMatchObject({
      failure: { _tag: 'GraphNotFoundError', path: '/me/events/gone' },
    });
  });

  it('reports a missing event the same way on an account that hides calendars', async () => {
    const hiding = {
      ...graphAccount,
      graph: { ...settings, hiddenCalendars: ['Birthdays'] },
    };
    const { effect } = onFakeGraph({}, graphEvent(hiding, 'gone', berlin));
    expect(await result(effect)).toMatchObject({
      failure: {
        _tag: 'GraphNotFoundError',
        path: '/me/events/gone',
        message:
          'Microsoft Graph found nothing at /me/events/gone for me@example.com (HTTP 404: ErrorItemNotFound: Not found.)',
      },
    });
  });
});
