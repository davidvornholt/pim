import { type DateTime, Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { findCollection } from '../../../shared/dav/collections';
import { Dav } from '../../../shared/dav/dav';
import type { GraphRequestError } from '../../../shared/errors/graph';
import { Graph, type GraphSessionError } from '../../../shared/graph/graph';
import { EventChangeError } from '../errors/errors';
import type { EventDetail } from '../schemas/calendar';
import { listCalendars } from './caldav';
import {
  type CalDavWriteError,
  createCalDavEvent,
  deleteCalDavEvent,
  type EventTarget,
  type NewEventRequest,
  updateCalDavEvent,
} from './caldav-write';
import { foundOrFail } from './calendar';
import { isCalDavHref } from './calendar-source';
import type { EventChanges } from './event-write';
import { findGraphCalendar, outlookCalendars } from './graph-calendar';
import { graphCalendar } from './graph-events';
import {
  createOutlookEvent,
  deleteOutlookEvent,
  type OutlookOptions,
  type OutlookWriteError,
  updateOutlookEvent,
} from './outlook-write';

// Writes go to the server that holds the calendar or event: the account's
// CalDAV server, or Outlook through Microsoft Graph.
export type CalendarWriteError =
  | CalDavWriteError
  | OutlookWriteError
  | GraphSessionError
  | GraphRequestError;

const noTeams = (href: string) =>
  new EventChangeError({
    href,
    message:
      'Only Outlook calendars of Microsoft 365 accounts have Teams meetings; pim adds none to a CalDAV calendar',
  });

const isMissing = (match: Result.Result<unknown, 'ambiguous' | 'missing'>) =>
  Result.isFailure(match) && match.failure === 'missing';

const webUrl = /^https?:\/\//iu;

// A CalDAV calendar href is a path or a URL. A calendar name may contain a
// slash too, but not at its start.
const isCalendarHref = (wanted: string) =>
  wanted.startsWith('/') || webUrl.test(wanted);

// The Outlook calendar wanted names, or none when the account keeps it on
// its CalDAV server. A CalDAV href or an Outlook id names one server, and a
// name both servers know is ambiguous.
const outlookCalendar = (account: Account, wanted: string) =>
  Effect.gen(function* () {
    if (
      account.graph === undefined ||
      (account.dav !== undefined && isCalendarHref(wanted))
    ) {
      return;
    }
    const graph = yield* Graph;
    const client = yield* graph.client(account);
    const calendars = (yield* outlookCalendars(client, account.graph)).map(
      (source) => ({
        ...graphCalendar(account.email, source),
        source,
      }),
    );
    let match = findGraphCalendar(calendars, wanted);
    const byId = calendars.some(({ href }) => href === wanted);
    if (account.dav !== undefined && !byId) {
      if (isMissing(match)) {
        return;
      }
      const dav = yield* Dav;
      const kept = yield* listCalendars(yield* dav.client(account));
      if (!isMissing(findCollection(kept, wanted))) {
        match = Result.fail('ambiguous');
      }
    }
    const found = yield* foundOrFail(account.email, calendars, wanted, match);
    return { client, calendar: found.source };
  });

// Creates the event in the account's Outlook or CalDAV calendar.
export const createEvent = (
  account: Account,
  request: NewEventRequest & OutlookOptions,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav | Graph> =>
  Effect.gen(function* () {
    const outlook = yield* outlookCalendar(account, request.calendar);
    if (outlook !== undefined) {
      return yield* createOutlookEvent(
        outlook.client,
        outlook.calendar,
        request,
        local,
      );
    }
    const { zone: _zone, teams, ...calDavRequest } = request;
    return teams
      ? yield* noTeams(request.calendar)
      : yield* createCalDavEvent(account, calDavRequest, local);
  });

// The client for an Outlook event: its href is a Microsoft Graph id, which
// has no slash.
const outlookClient = (account: Account, href: string) =>
  Effect.gen(function* () {
    if (
      account.graph === undefined ||
      (account.dav !== undefined && isCalDavHref(href))
    ) {
      return;
    }
    const graph = yield* Graph;
    return yield* graph.client(account);
  });

export const updateEvent = (
  account: Account,
  target: EventTarget,
  changes: EventChanges & OutlookOptions,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav | Graph> =>
  Effect.gen(function* () {
    const client = yield* outlookClient(account, target.href);
    if (client !== undefined) {
      return yield* updateOutlookEvent(client, target, changes, local);
    }
    const { zone: _zone, teams, ...calDavChanges } = changes;
    return teams
      ? yield* noTeams(target.href)
      : yield* updateCalDavEvent(account, target, calDavChanges, local);
  });

export const deleteEvent = (
  account: Account,
  target: EventTarget,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav | Graph> =>
  Effect.gen(function* () {
    const client = yield* outlookClient(account, target.href);
    return client === undefined
      ? yield* deleteCalDavEvent(account, target, local)
      : yield* deleteOutlookEvent(client, target, local);
  });
