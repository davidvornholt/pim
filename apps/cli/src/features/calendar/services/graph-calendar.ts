import { type DateTime, Effect, Result, Schema } from 'effect';
import type { Account, GraphSettings } from '../../../shared/accounts/account';
import { onlyOne } from '../../../shared/dav/collections';
import {
  GraphError,
  type GraphRequestError,
} from '../../../shared/errors/graph';
import type { GraphClient } from '../../../shared/graph/client';
import {
  Graph,
  type GraphSessionError,
  graphSettings,
} from '../../../shared/graph/graph';
import {
  type CalendarDataError,
  CalendarNotFoundError,
} from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import { floatingMs } from './caldav';
import {
  type AccountEvents,
  type CalendarSource,
  collectEvents,
  type DatedEvent,
  type EventSearch,
} from './calendar-source';
import {
  GraphSeries,
  graphEventDetail,
  seriesRecurrence,
} from './graph-detail';
import {
  decodeGraphEvent,
  GraphCalendar,
  GraphEvent,
  graphCalendar,
  graphEventSummary,
  graphMentions,
  graphSpan,
  nonEmpty,
} from './graph-events';
import { overlaps } from './occurrences';

// pim converts times to the local zone itself.
const utcTimes = 'outlook.timezone="UTC"';
const textBody = 'outlook.body-content-type="text"';
// How pim reads an event, also in the answer to a write.
export const eventPreferences = [utcTimes, textBody];
const calendarFields = 'id,name,hexColor,canEdit,allowedOnlineMeetingProviders';
const summaryFields =
  'id,iCalUId,subject,start,end,isAllDay,isCancelled,location,organizer,attendees,type,originalStart,bodyPreview';
const detailFields =
  'id,iCalUId,subject,start,end,isAllDay,isCancelled,location,organizer,attendees,type,originalStart,body,webLink,seriesMasterId,isOrganizer,responseStatus,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,isReminderOn,reminderMinutesBeforeStart';
// Microsoft Graph returns the cancelled and changed occurrences of a series
// only on a request for its series master, and gives the changed ones only
// the fields selected for the master.
const seriesFields =
  'id,subject,start,end,isAllDay,isCancelled,location,attendees,type,originalStart,recurrence,cancelledOccurrences';
const pageSize = 100;

const isHidden = (
  { hiddenCalendars }: GraphSettings,
  { name }: Calendar,
): boolean =>
  hiddenCalendars.some((hidden) => hidden.toLowerCase() === name.toLowerCase());

// Includes the calendars shared with the user that they added in Outlook.
export const outlookCalendars = (
  client: GraphClient,
  settings: GraphSettings,
): Effect.Effect<ReadonlyArray<GraphCalendar>, GraphRequestError> =>
  client.list(`/me/calendars?$select=${calendarFields}`).pipe(
    Effect.flatMap((items) =>
      Schema.decodeUnknownEffect(Schema.Array(GraphCalendar))(items).pipe(
        Effect.mapError(
          () =>
            new GraphError({
              message: `Microsoft Graph sent the calendars of ${client.account} in an unexpected form`,
            }),
        ),
      ),
    ),
    Effect.map((calendars) =>
      calendars.filter(
        (calendar) =>
          !isHidden(settings, graphCalendar(client.account, calendar)),
      ),
    ),
  );

export const graphCalendars = (
  client: GraphClient,
  settings: GraphSettings,
): Effect.Effect<ReadonlyArray<Calendar>, GraphRequestError> =>
  outlookCalendars(client, settings).pipe(
    Effect.map((calendars) =>
      calendars.map((calendar) => graphCalendar(client.account, calendar)),
    ),
  );

// An Outlook calendar by its exact id, or else by its name in any case.
export const findGraphCalendar = <C extends Calendar>(
  calendars: ReadonlyArray<C>,
  wanted: string,
): Result.Result<C, 'ambiguous' | 'missing'> => {
  const exact = calendars.find((calendar) => calendar.href === wanted);
  if (exact !== undefined) {
    return Result.succeed(exact);
  }
  const name = wanted.trim().toLowerCase();
  return onlyOne(
    calendars.filter((calendar) => calendar.name.toLowerCase() === name),
  );
};

const datedEvent = (
  item: unknown,
  calendar: Calendar,
  search: EventSearch,
): Effect.Effect<ReadonlyArray<DatedEvent>, CalendarDataError> =>
  decodeGraphEvent(item).pipe(
    Effect.flatMap((event) =>
      graphSpan(event, search.local).pipe(
        Effect.map((span) =>
          overlaps(span, search.window) &&
          (search.text === undefined || graphMentions(event, search.text))
            ? [
                {
                  startMs: span.startMs,
                  event: graphEventSummary(
                    event,
                    span,
                    { account: calendar.account, calendar: calendar.name },
                    search.local,
                  ),
                },
              ]
            : [],
        ),
      ),
    ),
  );

const isoTime = (millis: number): string => new Date(millis).toISOString();

// Microsoft Graph places an all-day event by midnight in the event's time
// zone, so the request range is as much wider as for CalDAV, and pim keeps
// the exact window.
export const calendarEvents = (
  client: GraphClient,
  calendar: Calendar,
  search: EventSearch,
): Effect.Effect<AccountEvents, GraphRequestError> =>
  client
    .list(
      `/me/calendars/${encodeURIComponent(calendar.href)}/calendarView?startDateTime=${isoTime(search.window.startMs - floatingMs)}&endDateTime=${isoTime(search.window.endMs + floatingMs)}&$select=${summaryFields}&$top=${pageSize}`,
      { prefer: [utcTimes] },
    )
    .pipe(
      Effect.flatMap((items) =>
        Effect.forEach(items, (item) =>
          datedEvent(item, calendar, search).pipe(Effect.result),
        ),
      ),
      Effect.map((results) => collectEvents(client.account, results)),
    );

export const graphSource = (
  account: Account,
): Effect.Effect<
  CalendarSource<GraphRequestError>,
  GraphSessionError | GraphRequestError,
  Graph
> =>
  Effect.gen(function* () {
    const graph = yield* Graph;
    const client = yield* graph.client(account);
    const calendars = yield* graphCalendars(
      client,
      yield* graphSettings(account),
    );
    return {
      calendars,
      find: (wanted) => findGraphCalendar(calendars, wanted),
      events: (calendar, search) => calendarEvents(client, calendar, search),
    };
  });

export const eventPath = (id: string) => `/me/events/${encodeURIComponent(id)}`;

// Refuses an event in a calendar the account hides. When Microsoft Graph finds
// no calendar, asking for the event itself reports a missing event as on any
// other account, and an event that exists still fails, because pim cannot tell
// whether its calendar is hidden.
export const refuseHiddenEvent = (
  client: GraphClient,
  settings: GraphSettings,
  id: string,
): Effect.Effect<void, GraphRequestError | CalendarNotFoundError> =>
  settings.hiddenCalendars.length === 0
    ? Effect.void
    : client
        .get(`${eventPath(id)}/calendar?$select=id,name`, GraphCalendar)
        .pipe(
          Effect.catchTag('GraphNotFoundError', (lookup) =>
            client
              .get(`${eventPath(id)}?$select=id`, Schema.Unknown)
              .pipe(Effect.flatMap(() => Effect.fail(lookup))),
          ),
          Effect.flatMap((found) => {
            const calendar = graphCalendar(client.account, found);
            return isHidden(settings, calendar)
              ? Effect.fail(
                  new CalendarNotFoundError({
                    calendar: calendar.name,
                    message: `The event ${id} is in the Outlook calendar "${calendar.name}", which ${client.account} hides with hidden-calendars in its account config, so pim does not read or change it`,
                  }),
                )
              : Effect.void;
          }),
        );

// The series master with id, with its changed occurrences.
export const readGraphSeries = (
  client: GraphClient,
  id: string,
): Effect.Effect<GraphSeries, GraphRequestError> =>
  client.get(
    `${eventPath(id)}?$select=${seriesFields}&$expand=exceptionOccurrences`,
    GraphSeries,
    { prefer: [utcTimes] },
  );

const seriesOf = (client: GraphClient, id: string, local: DateTime.TimeZone) =>
  readGraphSeries(client, id).pipe(
    Effect.flatMap((series) => seriesRecurrence(series, local)),
  );

// The event or occurrence with this id, with its etag.
export const readGraphEvent = (
  client: GraphClient,
  id: string,
): Effect.Effect<GraphEvent, GraphRequestError> =>
  client.get(`${eventPath(id)}?$select=${detailFields}`, GraphEvent, {
    prefer: eventPreferences,
  });

// A recurring event also gets the rule of its series, with the days it
// skips and the occurrences that differ from it.
export const graphDetailOf = (
  client: GraphClient,
  event: GraphEvent,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, GraphRequestError | CalendarDataError> =>
  Effect.gen(function* () {
    const span = yield* graphSpan(event, local);
    const seriesId =
      event.type === 'seriesMaster' ? event.id : nonEmpty(event.seriesMasterId);
    const recurrence =
      seriesId === undefined
        ? undefined
        : yield* seriesOf(client, seriesId, local);
    return graphEventDetail(event, span, {
      account: client.account,
      recurrence,
    });
  });

export const graphEvent = (
  account: Account,
  id: string,
  local: DateTime.TimeZone,
): Effect.Effect<
  EventDetail,
  | GraphSessionError
  | GraphRequestError
  | CalendarDataError
  | CalendarNotFoundError,
  Graph
> =>
  Effect.gen(function* () {
    const graph = yield* Graph;
    const client = yield* graph.client(account);
    yield* refuseHiddenEvent(client, yield* graphSettings(account), id);
    return yield* graphDetailOf(
      client,
      yield* readGraphEvent(client, id),
      local,
    );
  });
