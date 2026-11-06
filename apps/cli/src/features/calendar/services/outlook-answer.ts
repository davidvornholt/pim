import { type DateTime, Effect, Schema } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { GraphRequestError } from '../../../shared/errors/graph';
import type { GraphClient } from '../../../shared/graph/client';
import { Graph, type GraphSessionError } from '../../../shared/graph/graph';
import { type CalendarDataError, InvitationError } from '../errors/errors';
import type { EventDetail } from '../schemas/calendar';
import { isCalDavHref } from './calendar-source';
import { eventPath, graphDetailOf, readGraphEvent } from './graph-calendar';
import type { GraphEvent } from './graph-events';
import type { Partstat } from './invitation';

const actions: Readonly<Record<Partstat, string>> = {
  accepted: 'accept',
  tentative: 'tentativelyAccept',
  declined: 'decline',
};

export type OutlookAnswer = {
  readonly href: string;
  readonly partstat: Partstat;
  // Allows answering every occurrence of a recurring meeting.
  readonly series: boolean;
  // Lets Microsoft email the organizer the answer.
  readonly notifyOrganizer: boolean;
};

export type OutlookAnswered = {
  readonly notified: boolean;
  // Absent when Microsoft removed the declined meeting from the calendar.
  readonly event?: EventDetail;
};

// Answers a meeting in an Outlook calendar. Without notifyOrganizer,
// Microsoft keeps the answer in the user's calendar and tells no one.
export const answerOutlookEvent = (
  client: GraphClient,
  answer: OutlookAnswer,
  local: DateTime.TimeZone,
): Effect.Effect<
  OutlookAnswered,
  GraphRequestError | CalendarDataError | InvitationError
> =>
  Effect.gen(function* () {
    const { href } = answer;
    const event = yield* readGraphEvent(client, href);
    if (event.isOrganizer !== false) {
      return yield* new InvitationError({
        message: `${client.account} organizes ${href}, so there is no invitation to answer`,
      });
    }
    if (event.type === 'seriesMaster' && !answer.series) {
      return yield* new InvitationError({
        message: `${href} is a recurring meeting, so this answers every occurrence. Pass --series if that is intended`,
      });
    }
    yield* client.send(
      {
        method: 'POST',
        path: `${eventPath(href)}/${actions[answer.partstat]}`,
        body: { sendResponse: answer.notifyOrganizer },
      },
      Schema.Unknown,
    );
    const answered = yield* readGraphEvent(client, href).pipe(
      Effect.map((found): GraphEvent | undefined => found),
      Effect.catchTag('GraphNotFoundError', () => Effect.succeed(undefined)),
    );
    return {
      notified: answer.notifyOrganizer,
      ...(answered === undefined
        ? {}
        : { event: yield* graphDetailOf(client, answered, local) }),
    };
  });

// Answers a meeting in one of the account's Outlook calendars.
export const answerOutlookMeeting = (
  account: Account,
  answer: OutlookAnswer,
  local: DateTime.TimeZone,
): Effect.Effect<
  OutlookAnswered,
  GraphSessionError | GraphRequestError | CalendarDataError | InvitationError,
  Graph
> =>
  Effect.gen(function* () {
    if (
      account.graph === undefined ||
      (account.dav !== undefined && isCalDavHref(answer.href))
    ) {
      return yield* new InvitationError({
        message: `--href answers a meeting in an Outlook calendar, and ${answer.href} is none of ${account.email}. Answer the invitation email with --folder and --uid instead`,
      });
    }
    const graph = yield* Graph;
    const client = yield* graph.client(account);
    return yield* answerOutlookEvent(client, answer, local);
  });

// Outlook puts the invitations of an account with a graph table into its
// calendar itself, and pim answers them there, when Microsoft also hosts the
// mailbox, which then signs in to IMAP with Microsoft.
export const outlookInvitation = (
  account: Account,
): Effect.Effect<void, InvitationError> =>
  account.graph === undefined ||
  account.dav !== undefined ||
  account.mail?.auth !== 'microsoft'
    ? Effect.void
    : Effect.fail(
        new InvitationError({
          message: `Outlook puts the invitations of ${account.email} into its calendar itself. Find the meeting with "pim calendar events --account ${account.email}" and answer it with "pim calendar respond --account ${account.email} --href <href> --partstat <accepted|tentative|declined>"`,
        }),
      );
