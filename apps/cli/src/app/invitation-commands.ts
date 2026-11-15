import { DateTime, Effect } from 'effect';
import {
  type Partstat,
  partstats,
  readInvitation,
} from '../features/calendar/services/invitation';
import { describeInvitation } from '../features/calendar/services/invitation-copies';
import { importInvitation } from '../features/calendar/services/invitation-import';
import { answerInvitation } from '../features/calendar/services/invitation-reply';
import { answerOutlookMeeting } from '../features/calendar/services/outlook-answer';
import { Imap } from '../features/mail/services/imap';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { type CommandEffect, json } from './command-support';

const messageFlags = {
  account: flag.text('email', 'Account the invitation arrived in'),
  folder: flag.text('path', 'Folder from a search hit'),
  uid: flag.integer('n', 'Message uid from a search hit'),
  uidValidity: flag.text('id', 'uidValidity from the search hit'),
} as const;

const receivedInvitation = (values: {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly uidValidity: string;
}) =>
  Effect.gen(function* () {
    const config = yield* AccountConfig;
    const account = yield* config.getAccount(values.account);
    const imap = yield* Imap;
    const message = yield* imap.readCalendar(account.email, {
      folder: values.folder,
      uid: values.uid,
      uidValidity: values.uidValidity,
    });
    const invitation = yield* readInvitation(
      `Message uid ${message.uid} in "${message.folder}"`,
      message.ics,
      message.method,
    );
    return { account, message, invitation };
  });

const show = defineCommand(
  {
    name: 'calendar invitation',
    summary: 'Show the meeting an invitation email describes',
    description:
      'Read the calendar data (text/calendar) of an email, such as an invitation, and show its iTIP method (request invites, cancel cancels, reply answers), its sequence, which grows with each update, and the meeting. "attendee" is the address the user is invited as. For an account with a dav table, "copies" lists the meeting in the user\'s calendars with their answer there.',
    flags: messageFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const { account, invitation } = yield* receivedInvitation(values);
      return json(
        yield* describeInvitation(
          account,
          invitation,
          DateTime.zoneMakeLocal(),
        ),
      );
    }),
);

const calendarFlag = flag.optionalText(
  'name|href',
  'Calendar from "pim calendar list" for a meeting in none of them yet; needed when the account has several',
);

const importMessage = defineCommand(
  {
    name: 'calendar import',
    summary: 'Put an invitation, update, or cancellation into the calendar',
    description:
      'Apply an invitation (method request), an update of one, or a cancellation (method cancel) that the organizer emailed to the user\'s calendar, without answering it. pim writes so that the calendar server emails no one. A new meeting goes in with the user\'s answer open. For a meeting the calendar holds, pim keeps the user\'s answer and reminders, and opens the answer again when the organizer changed the meeting itself (a higher sequence). An invitation or cancellation for single occurrences changes only those. Prints {"import", "event"}: "created" or "updated", "current" when the calendar already holds this message or a newer one, and "absent" when it does not hold the meeting a cancellation is for. Needs a dav table: Outlook puts the invitations of a mailbox Microsoft hosts into its calendar itself, where "pim calendar respond --href" answers them.',
    flags: { ...messageFlags, calendar: calendarFlag },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const { account, invitation } = yield* receivedInvitation(values);
      const { status, event } = yield* importInvitation(
        account,
        invitation,
        values.calendar,
        DateTime.zoneMakeLocal(),
      );
      return json({
        import: status,
        ...(event === undefined ? {} : { event }),
      });
    }),
);

const isPartstat = (value: string): value is Partstat =>
  (partstats as ReadonlyArray<string>).includes(value);

const respondUsage = (message: string) =>
  new UsageError({ message: `pim calendar respond: ${message}` });

// The meeting to answer: an Outlook event, or an invitation email.
const answeredMeeting = (values: {
  readonly href: string | undefined;
  readonly folder: string | undefined;
  readonly uid: number | undefined;
  readonly uidValidity: string | undefined;
  readonly calendar: string | undefined;
  readonly series: boolean;
}) => {
  const { href, folder, uid, uidValidity } = values;
  if (href !== undefined) {
    return folder === undefined &&
      uid === undefined &&
      uidValidity === undefined &&
      values.calendar === undefined
      ? Effect.succeed({ _tag: 'Outlook' as const, href })
      : Effect.fail(
          respondUsage(
            '--href answers an Outlook meeting and takes no --folder, --uid, --uid-validity, or --calendar',
          ),
        );
  }
  if (values.series) {
    return Effect.fail(
      respondUsage(
        '--series answers a recurring Outlook meeting and needs --href; an invitation email says itself which occurrences it is for',
      ),
    );
  }
  return folder === undefined || uid === undefined || uidValidity === undefined
    ? Effect.fail(
        respondUsage(
          'pass --folder, --uid, and --uid-validity of an invitation email, or --href of an Outlook meeting',
        ),
      )
    : Effect.succeed({ _tag: 'Message' as const, folder, uid, uidValidity });
};

const respond = defineCommand(
  {
    name: 'calendar respond',
    summary: 'Answer an invitation',
    description:
      'Answer a meeting someone else organizes, as the attendee. Outlook puts the invitations of a mailbox Microsoft hosts into its calendar itself: --href answers such a meeting from "pim calendar events", which names one occurrence of a recurring meeting, or with --series its seriesHref from "pim calendar get"; pim keeps the answer in the calendar and makes Microsoft email the organizer only with --notify-organizer. It prints {"reply": "server" or "none", "event"}, without event when Microsoft removed the declined meeting from the calendar. --folder, --uid, and --uid-validity from a search hit answer an invitation email (method request). For an account with a dav table whose server sends answers itself (RFC 6638), pim first brings the meeting in the calendar up to date with the invitation as "pim calendar import" does, and then gives the answer there, which makes the server email the organizer; pim does this only with --notify-organizer. An invitation for single occurrences answers only those. It prints {"reply": "server", "event"}, where event.organizer.scheduleStatus tells, when the server reports it, how it delivered the answer (1.x: sent or pending). For an account with only a graph table whose mailbox Microsoft hosts, pim points to --href. For any other account, pim saves the answer as a reply draft to the organizer, with the calendar data their calendar reads, and prints {"reply": "draft", "draft", "to", "subject"}. The user sends the draft from their mail app; pim writes no calendar then.',
    flags: {
      account: messageFlags.account,
      href: flag.optionalText(
        'href',
        'Outlook meeting from "pim calendar events"',
      ),
      folder: flag.optionalText('path', 'Folder of the invitation email'),
      uid: flag.optionalInteger('n', 'Uid of the invitation email'),
      uidValidity: flag.optionalText(
        'id',
        'uidValidity of the invitation email from the search hit',
      ),
      partstat: flag.text(partstats.join('|'), 'The answer'),
      series: flag.switch(
        'Allow the answer for every occurrence of a recurring Outlook meeting',
      ),
      calendar: calendarFlag,
      notifyOrganizer: flag.switch(
        'Allow the answer that makes the calendar server email the organizer. Pass it only when the user asked to answer',
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const { partstat } = values;
      if (!isPartstat(partstat)) {
        return yield* new UsageError({
          message: `pim calendar respond: --partstat must be ${partstats.join(', ')}, not "${partstat}"`,
        });
      }
      const meeting = yield* answeredMeeting(values);
      if (meeting._tag === 'Outlook') {
        const config = yield* AccountConfig;
        const answered = yield* answerOutlookMeeting(
          yield* config.getAccount(values.account),
          {
            href: meeting.href,
            partstat,
            series: values.series,
            notifyOrganizer: values.notifyOrganizer,
          },
          DateTime.zoneMakeLocal(),
        );
        return json({
          reply: answered.notified ? 'server' : 'none',
          ...(answered.event === undefined ? {} : { event: answered.event }),
        });
      }
      const { account, message, invitation } = yield* receivedInvitation({
        account: values.account,
        ...meeting,
      });
      const outcome = yield* answerInvitation(
        account,
        invitation,
        {
          partstat,
          ...(values.calendar === undefined
            ? {}
            : { calendar: values.calendar }),
          notifyOrganizer: values.notifyOrganizer,
        },
        DateTime.zoneMakeLocal(),
      );
      if (outcome._tag === 'Answered') {
        return json({ reply: 'server', event: outcome.event });
      }
      const { reply } = outcome;
      const imap = yield* Imap;
      const draft = yield* imap.saveCalendarReply({
        account: account.email,
        ...reply,
        repliedTo: message,
      });
      return json({
        reply: 'draft',
        draft,
        to: reply.to,
        subject: reply.subject,
      });
    }),
);

export const invitationCommands = [show, importMessage, respond];
