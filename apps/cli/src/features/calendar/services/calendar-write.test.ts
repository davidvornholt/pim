import { describe, expect, it } from 'bun:test';
import type { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { Dav } from '../../../shared/dav/dav';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import type { Graph } from '../../../shared/graph/graph';
import {
  graphAccount,
  onFakeGraph,
} from '../../../shared/graph/graph-server.fixture';
import {
  calendarRoutes,
  eventRoutes,
  type Routes,
  single,
  target,
} from './caldav-write.fixture';
import { createEvent, deleteEvent, updateEvent } from './calendar-write';
import { berlin, icsOf } from './ical.fixture';
import { received } from './invitation.fixture';
import { importInvitation } from './invitation-import';
import { answerInvitation } from './invitation-reply';

// An account with calendars on a CalDAV server and in Outlook.
const both: Account = { ...davAccount, graph: graphAccount.graph };

const outlookEvent = {
  '@odata.etag': 'W/"1"',
  id: 'event-1',
  subject: 'Planning',
  start: { dateTime: '2026-11-03T13:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-03T14:00:00.0000000', timeZone: 'UTC' },
  isOrganizer: true,
};

const graphRoutes = (...names: ReadonlyArray<string>) => ({
  '/me/calendars': {
    value: names.map((name, index) => ({
      id: `cal-${index + 1}`,
      name,
      canEdit: true,
    })),
  },
  'POST /me/calendars/cal-1/events': outlookEvent,
  '/me/events/event-1': outlookEvent,
  'PATCH /me/events/event-1': outlookEvent,
});

const onBoth = <A, E>(
  graphNames: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, Dav | Graph>,
) => onFakeGraph(graphRoutes(...graphNames), effect);

const request = {
  title: 'Planning',
  span: {
    _tag: 'Times',
    startMs: Date.parse('2026-11-03T13:00:00Z'),
    endMs: Date.parse('2026-11-03T14:00:00Z'),
  },
  attendees: [],
  notifyAttendees: false,
  zone: berlin,
  teams: false,
} as const;

const graphWrites = (requests: ReadonlyArray<{ readonly method?: string }>) =>
  requests.flatMap(({ method }) => (method === undefined ? [] : [method]));

const davCalendar = (path: string, name: string) =>
  davResponse(
    path,
    `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname>`,
  );

// Two CalDAV calendars named Work.
const twoWorkCalendars = {
  ...calendarRoutes,
  'PROPFIND /calendars/me/': {
    body: multistatus(
      davCalendar('/calendars/me/work/', 'Work'),
      davCalendar('/calendars/me/work-2/', 'Work'),
    ),
  },
};

// A CalDAV calendar whose name has a slash.
const slashedCalendar = {
  ...calendarRoutes,
  'PROPFIND /calendars/me/': {
    body: multistatus(davCalendar('/calendars/me/shared/', 'Work/Shared')),
  },
};

const createdOnCalDav = {
  ...calendarRoutes,
  'PUT /calendars/me/work/*': { status: 201, headers: { etag: '"e1"' } },
};

describe('createEvent', () => {
  it('writes to the server that holds the calendar', async () => {
    const outlook = onBoth(
      ['Calendar'],
      createEvent(both, { ...request, calendar: 'Calendar' }, berlin),
    );
    const outlookRun = await succeedsOnFakeDav(calendarRoutes, outlook.effect);
    expect(outlookRun.value.href).toBe('event-1');
    expect(graphWrites(outlook.requests)).toEqual(['POST']);
    expect(writeRequests(outlookRun.requests)).toEqual([]);

    const dav = onBoth(
      ['Calendar'],
      createEvent(both, { ...request, calendar: 'Work' }, berlin),
    );
    const davRun = await succeedsOnFakeDav(createdOnCalDav, dav.effect);
    expect(writeRequests(davRun.requests)).toHaveLength(1);
    expect(graphWrites(dav.requests)).toEqual([]);
  });

  it('reaches a CalDAV href or an Outlook id without asking the other server', async () => {
    const dav = onFakeGraph(
      {},
      createEvent(
        both,
        { ...request, calendar: '/calendars/me/work/' },
        berlin,
      ),
    );
    const davRun = await succeedsOnFakeDav(createdOnCalDav, dav.effect);
    expect(writeRequests(davRun.requests)).toHaveLength(1);
    expect(dav.requests).toEqual([]);

    const outlook = onBoth(
      ['Calendar'],
      createEvent(both, { ...request, calendar: 'cal-1' }, berlin),
    );
    const outlookRun = await succeedsOnFakeDav({}, outlook.effect);
    expect(graphWrites(outlook.requests)).toEqual(['POST']);
    expect(outlookRun.requests).toEqual([]);
  });

  it('writes nowhere for a name both servers know or Teams on CalDAV', async () => {
    const cases: ReadonlyArray<
      readonly [
        Routes,
        ReadonlyArray<string>,
        { readonly calendar: string; readonly teams?: boolean },
      ]
    > = [
      [calendarRoutes, ['work'], { calendar: 'Work' }],
      [twoWorkCalendars, ['Work'], { calendar: 'Work' }],
      [slashedCalendar, ['Work/Shared'], { calendar: 'Work/Shared' }],
      [calendarRoutes, ['Calendar'], { calendar: 'Work', teams: true }],
    ];
    const refusals = await Promise.all(
      cases.map(async ([routes, graphNames, wanted]) => {
        const { effect, requests } = onBoth(
          graphNames,
          createEvent(both, { ...request, ...wanted }, berlin),
        );
        const { error, requests: davRequests } = await failsOnFakeDav(
          routes,
          effect,
        );
        return [error._tag, graphWrites(requests), writeRequests(davRequests)];
      }),
    );
    expect(refusals).toEqual([
      ['CalendarNotFoundError', [], []],
      ['CalendarNotFoundError', [], []],
      ['CalendarNotFoundError', [], []],
      ['EventChangeError', [], []],
    ]);
  });
});

describe('updateEvent and deleteEvent', () => {
  it('change a CalDAV href on the calendar server and an id in Outlook', async () => {
    const outlook = onBoth(
      [],
      updateEvent(
        both,
        {
          href: 'event-1',
          etag: 'W/"1"',
          series: false,
          notifyAttendees: false,
        },
        { title: 'Planning, final', zone: berlin, teams: false },
        berlin,
      ),
    );
    await succeedsOnFakeDav(calendarRoutes, outlook.effect);
    expect(graphWrites(outlook.requests)).toEqual(['PATCH']);

    const dav = onBoth([], deleteEvent(both, target(), berlin));
    const davRun = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      dav.effect,
    );
    expect(writeRequests(davRun.requests).map(({ method }) => method)).toEqual([
      'DELETE',
    ]);
    expect(dav.requests).toEqual([]);
  });
});

describe('invitations of an account with only Outlook calendars', () => {
  const microsoftMail = {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    user: 'me@example.com',
    auth: 'microsoft',
  } as const;
  const accept = { partstat: 'accepted', notifyOrganizer: true } as const;

  it('point to the meeting Outlook put into the calendar of a mailbox Microsoft hosts', async () => {
    const account: Account = { ...graphAccount, mail: microsoftMail };
    const writes: ReadonlyArray<Effect.Effect<unknown, unknown, Dav>> = [
      importInvitation(account, received(), undefined, berlin),
      answerInvitation(account, received(), accept, berlin),
    ];
    const refused = await Promise.all(
      writes.map((write) => failsOnFakeDav(calendarRoutes, write)),
    );
    for (const { error, requests } of refused) {
      expect(error).toMatchObject({
        _tag: 'InvitationError',
        message:
          'Outlook puts the invitations of me@example.com into its calendar itself. Find the meeting with "pim calendar events --account me@example.com" and answer it with "pim calendar respond --account me@example.com --href <href> --partstat <accepted|tentative|declined>"',
      });
      expect(requests).toEqual([]);
    }
  });

  it('get a reply draft when Outlook does not receive the mail', async () => {
    const account: Account = {
      ...graphAccount,
      mail: { ...microsoftMail, host: 'imap.example.com', auth: 'password' },
    };
    const answered = await succeedsOnFakeDav(
      calendarRoutes,
      answerInvitation(account, received(), accept, berlin),
    );
    expect(answered.value).toMatchObject({
      _tag: 'Reply',
      reply: { to: 'boss@example.com' },
    });
    expect(answered.requests).toEqual([]);
    const imported = await failsOnFakeDav(
      calendarRoutes,
      importInvitation(account, received(), undefined, berlin),
    );
    expect(imported.error).toMatchObject({ _tag: 'InvitationError' });
    expect(imported.error.message).toStartWith(
      'Microsoft Graph cannot add an emailed invitation',
    );
    expect(imported.requests).toEqual([]);
  });
});
