import { type DateTime, Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { AccountConfig } from '../../../shared/accounts/config';
import {
  describeCollections,
  findCollection,
} from '../../../shared/dav/collections';
import { Dav, type DavSessionError } from '../../../shared/dav/dav';
import type { UnknownAccountError } from '../../../shared/errors/accounts';
import type { DavRequestError } from '../../../shared/errors/dav';
import type { GraphRequestError } from '../../../shared/errors/graph';
import type { Graph, GraphSessionError } from '../../../shared/graph/graph';
import {
  CalendarDataError,
  CalendarNotConfiguredError,
  CalendarNotFoundError,
} from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import {
  type CalendarResource,
  fetchCalendarObject,
  listCalendars,
  queryEvents,
} from './caldav';
import {
  type AccountEvents,
  type CalendarMatch,
  type CalendarSource,
  collectEvents,
  type DatedEvent,
  type EventSearch,
  findSourced,
  isCalDavHref,
} from './calendar-source';
import { eventDetail, eventSummary, parseCalendar } from './event-fields';
import { graphEvent, graphSource } from './graph-calendar';
import type { TimeWindow } from './ical-time';
import { type Occurrence, occurrencesIn } from './occurrences';

const calendarConcurrency = 4;

// The errors of reading and writing calendars through CalDAV.
export type CalendarError = DavSessionError | DavRequestError;

// The errors of reading calendars through CalDAV and Microsoft Graph.
export type CalendarReadError =
  | CalendarError
  | GraphSessionError
  | GraphRequestError
  | CalendarNotConfiguredError;

// The accounts a calendar command reads: the one named, or every account
// with a dav or graph table.
export const calendarAccounts = (
  only: string | undefined,
): Effect.Effect<
  ReadonlyArray<Account>,
  CalendarNotConfiguredError | UnknownAccountError,
  AccountConfig
> =>
  Effect.gen(function* () {
    const config = yield* AccountConfig;
    if (only !== undefined) {
      return [yield* config.getAccount(only)];
    }
    const accounts = config.accounts.filter(
      (account) => account.dav !== undefined || account.graph !== undefined,
    );
    if (accounts.length === 0) {
      return yield* new CalendarNotConfiguredError({
        message:
          'No account has calendars: add a dav table with the server DAV url, or a graph table for Outlook, to an account in the account config',
      });
    }
    return accounts;
  });

const notConfigured = (account: Account) =>
  new CalendarNotConfiguredError({
    message: `${account.email} has no calendars: its account config has neither a dav table with the server DAV url nor a graph table for Outlook`,
  });

const notFound = (
  account: string,
  calendars: ReadonlyArray<Calendar>,
  wanted: string,
  reason: 'ambiguous' | 'missing',
) =>
  new CalendarNotFoundError({
    calendar: wanted,
    message:
      reason === 'ambiguous'
        ? `${account} has several calendars that match "${wanted}"; pass an exact href from "pim calendar list" instead`
        : `${account} has no calendar "${wanted}". Its calendars: ${describeCollections(calendars)}`,
  });

export const foundOrFail = <A>(
  account: string,
  calendars: ReadonlyArray<Calendar>,
  wanted: string,
  match: Result.Result<A, 'ambiguous' | 'missing'>,
): Effect.Effect<A, CalendarNotFoundError> =>
  Result.match(match, {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(notFound(account, calendars, wanted, reason)),
  });

// A CalDAV calendar by href or name.
export const findCalendar = (
  account: string,
  calendars: ReadonlyArray<Calendar>,
  wanted: string,
): Effect.Effect<Calendar, CalendarNotFoundError> =>
  foundOrFail(account, calendars, wanted, findCollection(calendars, wanted));

export type EventQuery = {
  readonly window: TimeWindow;
  readonly calendar?: string;
  readonly text?: string;
};

const searchedProperties = ['summary', 'location', 'description'];

const mentions = (occurrence: Occurrence, text: string): boolean =>
  searchedProperties.some((name) =>
    String(occurrence.event.component.getFirstPropertyValue(name) ?? '')
      .toLowerCase()
      .includes(text),
  );

// ical.js decodes a value only when it is read, so a malformed field, such as
// an invalid DURATION, throws here rather than in parseCalendar. So does an
// event pim can't expand completely.
export const readEvent = <A>(
  href: string,
  read: () => A,
): Effect.Effect<A, CalendarDataError> =>
  Effect.try({
    try: read,
    catch: (cause) =>
      new CalendarDataError({
        href,
        message: `Could not read ${href}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// The events of one calendar object that overlap the window and mention the
// searched text.
const datedEvents = (
  resource: CalendarResource,
  calendar: Calendar,
  search: EventSearch,
): Effect.Effect<ReadonlyArray<DatedEvent>, CalendarDataError> =>
  parseCalendar(resource.href, resource.ics).pipe(
    Effect.flatMap(({ vcalendar }) =>
      readEvent(resource.href, () =>
        occurrencesIn(vcalendar, search.window, search.local)
          .filter(
            (occurrence) =>
              search.text === undefined || mentions(occurrence, search.text),
          )
          .map((occurrence) => ({
            startMs: occurrence.startMs,
            event: eventSummary(
              occurrence,
              {
                account: calendar.account,
                calendar: calendar.name,
                href: resource.href,
              },
              search.local,
            ),
          })),
      ),
    ),
  );

const davSource = (
  account: Account,
): Effect.Effect<CalendarSource<DavRequestError>, CalendarError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const calendars = yield* listCalendars(client);
    return {
      calendars,
      find: (wanted): CalendarMatch => findCollection(calendars, wanted),
      events: (calendar, search) =>
        queryEvents(client, calendar.href, search.window).pipe(
          Effect.flatMap((resources) =>
            Effect.forEach(resources, (resource) =>
              Effect.fromResult(resource).pipe(
                Effect.flatMap((found) => datedEvents(found, calendar, search)),
                Effect.result,
              ),
            ),
          ),
          Effect.map((results) => collectEvents(account.email, results)),
        ),
    };
  });

const asList = <A, E, R>(
  source: Effect.Effect<A, E, R>,
): Effect.Effect<ReadonlyArray<A>, E, R> =>
  Effect.map(source, (found) => [found]);

// The calendars of an account through CalDAV, Microsoft Graph, or both.
const calendarSources = (
  account: Account,
): Effect.Effect<
  ReadonlyArray<CalendarSource<DavRequestError | GraphRequestError>>,
  CalendarReadError,
  Dav | Graph
> =>
  account.dav === undefined && account.graph === undefined
    ? Effect.fail(notConfigured(account))
    : Effect.all(
        [
          account.dav === undefined
            ? Effect.succeed([])
            : asList(davSource(account)),
          account.graph === undefined
            ? Effect.succeed([])
            : asList(graphSource(account)),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.map(([dav, graph]) => [...dav, ...graph]));

export const accountCalendars = (
  account: Account,
): Effect.Effect<ReadonlyArray<Calendar>, CalendarReadError, Dav | Graph> =>
  calendarSources(account).pipe(
    Effect.map((sources) => sources.flatMap((source) => source.calendars)),
  );

export const accountEvents = (
  account: Account,
  query: EventQuery,
  local: DateTime.TimeZone,
): Effect.Effect<
  AccountEvents,
  CalendarReadError | CalendarNotFoundError,
  Dav | Graph
> =>
  Effect.gen(function* () {
    const sources = yield* calendarSources(account);
    const selected =
      query.calendar === undefined
        ? sources.flatMap((source) =>
            source.calendars.map((calendar) => ({ source, calendar })),
          )
        : [
            yield* foundOrFail(
              account.email,
              sources.flatMap((source) => source.calendars),
              query.calendar,
              findSourced(sources, query.calendar),
            ),
          ];
    const search = {
      window: query.window,
      text: query.text?.trim().toLowerCase(),
      local,
    };
    const found = yield* Effect.forEach(
      selected,
      ({ source, calendar }) => source.events(calendar, search),
      { concurrency: calendarConcurrency },
    );
    return {
      events: found.flatMap((events) => events.events),
      unreadable: found.flatMap((events) => events.unreadable),
    };
  });

export const byStart = (left: DatedEvent, right: DatedEvent): number =>
  left.startMs - right.startMs ||
  left.event.summary.localeCompare(right.event.summary);

const davEvent = (
  account: Account,
  href: string,
  local: DateTime.TimeZone,
): Effect.Effect<
  EventDetail & { readonly ics: string },
  CalendarError | CalendarDataError,
  Dav
> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const resource = yield* fetchCalendarObject(client, href);
    const object = yield* parseCalendar(href, resource.ics);
    const detail = yield* readEvent(href, () =>
      eventDetail(
        object,
        { account: account.email, href, etag: resource.etag },
        local,
      ),
    );
    return { ...detail, ics: resource.ics };
  });

// Only CalDAV events come with their iCalendar text.
export const accountEvent = (
  account: Account,
  href: string,
  local: DateTime.TimeZone,
): Effect.Effect<
  EventDetail & { readonly ics?: string },
  CalendarReadError | CalendarDataError,
  Dav | Graph
> => {
  if (
    account.dav !== undefined &&
    (account.graph === undefined || isCalDavHref(href))
  ) {
    return davEvent(account, href, local);
  }
  return account.graph === undefined
    ? Effect.fail(notConfigured(account))
    : graphEvent(account, href, local);
};
