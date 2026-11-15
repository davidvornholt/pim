import { type DateTime, Effect, Result } from 'effect';
import type ICAL from 'ical.js';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { describeCollections } from '../../../shared/dav/collections';
import { Dav } from '../../../shared/dav/dav';
import { discoverPrincipal } from '../../../shared/dav/discovery';
import {
  CalendarNotFoundError,
  EventChangeError,
  InvitationError,
} from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import {
  createCalendarObjectSilently,
  fetchCalendarObject,
  listCalendars,
  replaceCalendarObjectSilently,
} from './caldav';
import type { CalDavWriteError } from './caldav-write';
import { type CalendarObject, parseCalendar } from './event-fields';
import type { ReceivedInvitation } from './invitation';
import { type EventCopy, findCopies, writable } from './invitation-copies';
import {
  type ImportChange,
  importChange,
  leftToCalendarApp,
  leftToServer,
} from './invitation-merge';
import { outlookInvitation } from './outlook-answer';
import { userAddresses } from './scheduling';
import { detailOf, writableCalendar } from './stored-event';

export type InvitationImportError = CalDavWriteError | InvitationError;

// The meeting in the user's calendars, or the calendars it may go to.
export type MeetingPlace =
  | { readonly copy: EventCopy }
  | { readonly copy?: undefined; readonly calendars: ReadonlyArray<Calendar> };

// Looks for the meeting in every calendar the user may write to. A meeting
// new to them goes to the calendar wanted, if any.
export const meetingPlace = (
  client: DavClient,
  account: Account,
  uid: string,
  wanted: string | undefined,
): Effect.Effect<MeetingPlace, InvitationImportError> =>
  Effect.gen(function* () {
    const calendars = yield* listCalendars(client);
    const chosen =
      wanted === undefined
        ? undefined
        : yield* writableCalendar(account.email, calendars, wanted);
    const copies = yield* findCopies(client, writable(calendars), uid);
    const [copy, another] =
      chosen === undefined
        ? copies
        : copies.filter(({ calendar }) => calendar.href === chosen.href);
    if (another !== undefined) {
      return yield* new InvitationError({
        message: `The meeting is in several calendars of ${account.email}: ${copies.map(({ resource }) => resource.href).join(', ')}. Pass --calendar to choose one`,
      });
    }
    if (copy !== undefined) {
      return { copy };
    }
    if (chosen !== undefined && copies.length > 0) {
      return yield* new InvitationError({
        message: `The meeting is already in ${copies.map(({ resource }) => resource.href).join(', ')}, not in "${chosen.name}". Pass that calendar with --calendar, or leave it out`,
      });
    }
    return { calendars: chosen === undefined ? writable(calendars) : [chosen] };
  });

// The calendar a meeting new to the user goes to: the only one they may
// write to. None when they may write to none.
export const newMeetingCalendar = (
  account: Account,
  calendars: ReadonlyArray<Calendar>,
): Effect.Effect<Calendar | undefined, CalendarNotFoundError> => {
  const [only, second] = calendars;
  return second === undefined
    ? Effect.succeed(only)
    : Effect.fail(
        new CalendarNotFoundError({
          calendar: '',
          message: `${account.email} has several calendars; pass --calendar with the one to add the meeting to: ${describeCollections(calendars)}`,
        }),
      );
};

export const plannedChange = (
  invitation: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
  place: MeetingPlace,
): Effect.Effect<ImportChange, InvitationError> =>
  Result.match(
    importChange(
      invitation,
      addresses,
      place.copy === undefined
        ? undefined
        : { href: place.copy.resource.href, object: place.copy.object },
    ),
    {
      onSuccess: Effect.succeed,
      onFailure: (message) => Effect.fail(new InvitationError({ message })),
    },
  );

const unfinished = (href: string, reason: string) =>
  new EventChangeError({
    href,
    message: `pim wrote ${href} without telling anyone, but its organizer still leaves answers to a calendar app (SCHEDULE-AGENT=CLIENT), so the server would send none of the user's answers. Run the same pim command again to finish: ${reason}`,
  });

// The second step of a silent write: the organizer back as it was, on top
// of the version the first step stored.
const restoreScheduling = (
  client: DavClient,
  href: string,
  {
    etag,
    final,
  }: { readonly etag: string | undefined; readonly final: string },
): Effect.Effect<void, EventChangeError> =>
  Effect.gen(function* () {
    const stored =
      etag === undefined
        ? yield* fetchCalendarObject(client, href).pipe(
            Effect.flatMap((resource) =>
              parseCalendar(href, resource.ics).pipe(
                Effect.map((object) => ({
                  etag: resource.etag,
                  ics: leftToServer(object.vcalendar).toString(),
                })),
              ),
            ),
          )
        : { etag, ics: final };
    if (stored.etag === undefined) {
      return yield* unfinished(href, 'the server gave no etag');
    }
    yield* replaceCalendarObjectSilently(client, href, stored.ics, stored.etag);
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        error._tag === 'EventChangeError'
          ? error
          : unfinished(href, error.message),
      ),
    ),
  );

// Writes the copy so that the server sends no one anything. Schedule-Reply:
// F asks sabre/dav not to, and SCHEDULE-AGENT=CLIENT on the organizer tells
// any server that schedules (RFC 6638, section 3.2.2.3) to leave answers to
// a calendar app. A second write sets the organizer back; it changes no
// answer and no occurrence, so the server has nothing to send for it.
const writeSilently = (
  client: DavClient,
  href: string,
  {
    vcalendar,
    etag,
  }: {
    readonly vcalendar: ICAL.Component;
    // The version the write replaces; none for a new copy.
    readonly etag: string | undefined;
  },
): Effect.Effect<void, InvitationImportError> =>
  Effect.gen(function* () {
    const final = vcalendar.toString();
    const passing = leftToCalendarApp(vcalendar).toString();
    const stored =
      etag === undefined
        ? yield* createCalendarObjectSilently(client, href, passing)
        : yield* replaceCalendarObjectSilently(client, href, passing, etag);
    if (passing !== final) {
      yield* restoreScheduling(client, href, { etag: stored, final });
    }
  });

const readCopy = (
  client: DavClient,
  calendar: Calendar,
  href: string,
): Effect.Effect<EventCopy, InvitationImportError> =>
  fetchCalendarObject(client, href).pipe(
    Effect.flatMap((resource) =>
      parseCalendar(href, resource.ics).pipe(
        Effect.map((object) => ({ calendar, resource, object })),
      ),
    ),
  );

export type ImportStatus = 'created' | 'updated' | 'current' | 'absent';

export type ImportedCopy = {
  readonly status: ImportStatus;
  // The meeting in the calendar after the import; none when absent.
  readonly copy?: EventCopy;
};

// Writes the copy silently and reads it back. pim first checks that it can
// read what it is about to write.
const writeCopy = (
  client: DavClient,
  account: Account,
  copy: {
    readonly calendar: Calendar;
    readonly href: string;
    readonly etag: string | undefined;
    readonly vcalendar: ICAL.Component;
  },
  local: DateTime.TimeZone,
): Effect.Effect<EventCopy, InvitationImportError> =>
  detailOf(
    {
      account: account.email,
      href: copy.href,
      etag: undefined,
      ics: copy.vcalendar.toString(),
    },
    local,
  ).pipe(
    Effect.andThen(writeSilently(client, copy.href, copy)),
    Effect.andThen(readCopy(client, copy.calendar, copy.href)),
  );

export const applyImport = (
  client: DavClient,
  account: Account,
  {
    place,
    change,
  }: { readonly place: MeetingPlace; readonly change: ImportChange },
  local: DateTime.TimeZone,
): Effect.Effect<ImportedCopy, InvitationImportError> =>
  Effect.gen(function* () {
    if (change._tag === 'Absent') {
      return { status: 'absent' };
    }
    if (place.copy !== undefined) {
      const { calendar, resource } = place.copy;
      if (change._tag !== 'Change') {
        return { status: 'current', copy: place.copy };
      }
      if (resource.etag === undefined) {
        return yield* new EventChangeError({
          href: resource.href,
          message: `The server gave no etag for ${resource.href}, so pim cannot make sure it changes the version it read`,
        });
      }
      const { href, etag } = resource;
      const { vcalendar } = change;
      return {
        status: 'updated',
        copy: yield* writeCopy(
          client,
          account,
          { calendar, href, etag, vcalendar },
          local,
        ),
      };
    }
    const calendar = yield* newMeetingCalendar(account, place.calendars);
    if (change._tag !== 'Create' || calendar === undefined) {
      return yield* new InvitationError({
        message: `${account.email} has no calendar pim may add the meeting to`,
      });
    }
    const folder = calendar.href.endsWith('/')
      ? calendar.href
      : `${calendar.href}/`;
    const href = `${folder}${crypto.randomUUID()}.ics`;
    const { vcalendar } = yield* parseCalendar(href, change.ics);
    return {
      status: 'created',
      copy: yield* writeCopy(
        client,
        account,
        { calendar, href, etag: undefined, vcalendar },
        local,
      ),
    };
  });

// The meeting as a calendar holds it after the planned change, before pim
// writes it.
export const plannedCopy = (
  place: MeetingPlace,
  change: ImportChange,
): Effect.Effect<CalendarObject | undefined, InvitationImportError> => {
  switch (change._tag) {
    case 'Create':
      return parseCalendar('the new meeting', change.ics);
    case 'Change':
      return parseCalendar(
        place.copy?.resource.href ?? 'the meeting',
        change.vcalendar.toString(),
      );
    default:
      return Effect.succeed(place.copy?.object);
  }
};

export type ImportOutcome = {
  readonly status: ImportStatus;
  readonly event?: EventDetail;
};

// Adds the meeting an invitation describes to the user's calendar, or
// applies the update or cancellation the organizer sent, and answers
// nothing.
export const importInvitation = (
  account: Account,
  invitation: ReceivedInvitation,
  wanted: string | undefined,
  local: DateTime.TimeZone,
): Effect.Effect<ImportOutcome, InvitationImportError, Dav> =>
  Effect.gen(function* () {
    yield* outlookInvitation(account);
    if (account.dav === undefined) {
      return yield* new InvitationError({
        message:
          account.graph === undefined
            ? `${account.email} has no calendar server (a dav table in the account config), so pim cannot add the meeting to a calendar`
            : `Microsoft Graph cannot add an emailed invitation to the Outlook calendars of ${account.email}, and it has no calendar server (a dav table in the account config). "pim calendar respond" with --folder, --uid, and --uid-validity saves the answer as a reply draft`,
      });
    }
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const principal = yield* discoverPrincipal(client);
    const place = yield* meetingPlace(client, account, invitation.uid, wanted);
    const change = yield* plannedChange(
      invitation,
      userAddresses(account, principal.addresses),
      place,
    );
    const { status, copy } = yield* applyImport(
      client,
      account,
      { place, change },
      local,
    );
    return {
      status,
      ...(copy === undefined
        ? {}
        : {
            event: yield* detailOf(
              { account: account.email, ...copy.resource },
              local,
            ),
          }),
    };
  });
