import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import type { Attachment, HeaderValue, StructuredHeader } from 'mailparser';
import {
  type ImapError,
  type MessageNotFoundError,
  NoCalendarDataError,
  type StaleUidError,
} from '../errors/errors';
import type { CalendarMessage, MessageHandle } from '../schemas/mail';
import { fetchParsedMessage, toFullMessage } from './imap-ops';
import { lockMessageFolder } from './mailbox-lock';

const calendarFile = /\.ics$/iu;

const isStructured = (
  header: HeaderValue | undefined,
): header is StructuredHeader =>
  typeof header === 'object' &&
  !Array.isArray(header) &&
  !(header instanceof Date) &&
  typeof header.value === 'string' &&
  'params' in header;

const contentTypeParameter = (
  attachment: Attachment,
  name: string,
): string | undefined => {
  const header = attachment.headers.get('content-type');
  const value = isStructured(header) ? header.params[name] : undefined;
  return value === undefined || value === '' ? undefined : value;
};

const isType = (attachment: Attachment, type: string): boolean =>
  attachment.contentType.toLowerCase() === type;

// The part an invitation carries its event in: text/calendar with the iTIP
// method (RFC 6047, section 2.4), or else a calendar file.
export const calendarPart = (
  attachments: ReadonlyArray<Attachment>,
): Attachment | undefined => {
  const calendars = attachments.filter((attachment) =>
    isType(attachment, 'text/calendar'),
  );
  return (
    calendars.find(
      (attachment) => contentTypeParameter(attachment, 'method') !== undefined,
    ) ??
    calendars[0] ??
    attachments.find(
      (attachment) =>
        isType(attachment, 'application/ics') ||
        calendarFile.test(attachment.filename ?? ''),
    )
  );
};

const decode = (attachment: Attachment): string => {
  const bytes: Uint8Array = attachment.content;
  try {
    return new TextDecoder(
      contentTypeParameter(attachment, 'charset') ?? 'utf-8',
    ).decode(bytes);
  } catch {
    // An unknown charset label; iCalendar data is UTF-8 (RFC 5545,
    // section 3.1.4).
    return new TextDecoder().decode(bytes);
  }
};

export const readCalendarMessage = (
  client: ImapFlow,
  account: string,
  handle: MessageHandle,
): Effect.Effect<
  CalendarMessage,
  ImapError | MessageNotFoundError | NoCalendarDataError | StaleUidError
> =>
  Effect.gen(function* () {
    const { folder, uid } = handle;
    yield* lockMessageFolder(client, handle);
    const { parsed } = yield* fetchParsedMessage(client, folder, uid);
    const part = calendarPart(parsed.attachments);
    if (part === undefined) {
      return yield* new NoCalendarDataError({
        folder,
        uid,
        message: `Message uid ${uid} in "${folder}" carries no calendar data (text/calendar), so it is no invitation`,
      });
    }
    const { from, subject, messageId, inReplyTo, references } = toFullMessage(
      parsed,
      folder,
      uid,
    );
    const method = contentTypeParameter(part, 'method');
    return {
      account,
      folder,
      uid,
      from,
      subject,
      messageId,
      inReplyTo,
      references,
      ...(method === undefined ? {} : { method: method.toUpperCase() }),
      ics: decode(part),
    };
  }).pipe(Effect.scoped);
