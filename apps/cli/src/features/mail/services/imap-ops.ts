import { Effect } from 'effect';
import { convert } from 'html-to-text';
import type { ImapFlow, ListResponse, MessageStructureObject } from 'imapflow';
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import {
  ImapError,
  MessageNotFoundError,
  type StaleUidError,
} from '../errors/errors';
import type { FolderInfo, FullMessage, MessageHandle } from '../schemas/mail';
import { listAttachments } from './attachment-metadata';
import { safeAttributionText } from './attribution-safety';
import { lockMessageFolder } from './mailbox-lock';

export const imapError =
  (label: string) =>
  (cause: unknown): ImapError =>
    new ImapError({ message: `${label} failed: ${String(cause)}` });

const addressText = (
  field: AddressObject | Array<AddressObject> | undefined,
): string => {
  if (field === undefined) {
    return '';
  }
  return Array.isArray(field)
    ? field.map((entry) => entry.text).join(', ')
    : field.text;
};

const toReferences = (
  references: string | Array<string> | undefined,
): ReadonlyArray<string> => {
  if (references === undefined) {
    return [];
  }
  return Array.isArray(references) ? references : [references];
};

const toFolderInfo = (folder: ListResponse): FolderInfo => ({
  path: folder.path,
  name: folder.name,
  specialUse: folder.specialUse ?? null,
  subscribed: folder.subscribed,
});

// mailparser keeps the first of duplicated single-value headers such as Date,
// so read the same occurrence that parsed.date comes from.
const rawHeaderValue = (parsed: ParsedMail, key: string): string => {
  const line = parsed.headerLines.find((header) => header.key === key)?.line;
  if (line === undefined) {
    return '';
  }
  const unfolded = line.replaceAll(/\r?\n[ \t]+/gu, ' ');
  const separator = unfolded.indexOf(':');
  return separator === -1
    ? ''
    : safeAttributionText(unfolded.slice(separator + 1).trim());
};

// Some senders put the whole message in HTML and leave the text part empty;
// derive readable text so reading and reply quotes still show the content.
const plainText = (parsed: ParsedMail): string => {
  const text = parsed.text ?? '';
  return text.trim() === '' && typeof parsed.html === 'string'
    ? convert(parsed.html, {
        wordwrap: false,
        selectors: [{ selector: 'img', format: 'skip' }],
      })
    : text;
};

export const toFullMessage = (
  parsed: ParsedMail,
  folder: string,
  uid: number,
): FullMessage => ({
  uid,
  folder,
  from: addressText(parsed.from),
  to: addressText(parsed.to),
  cc: addressText(parsed.cc),
  bcc: addressText(parsed.bcc),
  subject: parsed.subject ?? '',
  date: parsed.date?.toISOString() ?? '',
  attributionDate: rawHeaderValue(parsed, 'date'),
  messageId: parsed.messageId ?? '',
  inReplyTo: parsed.inReplyTo ?? '',
  references: toReferences(parsed.references),
  text: plainText(parsed),
  html: typeof parsed.html === 'string' ? parsed.html : null,
  attachments: [],
});

export const listFolders = (
  client: ImapFlow,
): Effect.Effect<ReadonlyArray<FolderInfo>, ImapError> =>
  listMailboxes(client).pipe(
    Effect.map((folders) => folders.map(toFolderInfo)),
  );

export const listMailboxes = (
  client: ImapFlow,
): Effect.Effect<ReadonlyArray<ListResponse>, ImapError> =>
  Effect.tryPromise({
    try: () => client.list(),
    catch: imapError('list folders'),
  });

// The message, parsed, with its MIME structure. Callers must hold the
// folder's mailbox lock.
export const fetchParsedMessage = (
  client: ImapFlow,
  folder: string,
  uid: number,
): Effect.Effect<
  {
    readonly parsed: ParsedMail;
    readonly structure: MessageStructureObject | undefined;
  },
  ImapError | MessageNotFoundError
> =>
  Effect.gen(function* () {
    const message = yield* Effect.tryPromise({
      try: () =>
        client.fetchOne(
          String(uid),
          { uid: true, source: true, envelope: true, bodyStructure: true },
          { uid: true },
        ),
      catch: imapError('fetch message'),
    });
    if (
      message === false ||
      message === undefined ||
      message.source === undefined
    ) {
      return yield* Effect.fail(
        new MessageNotFoundError({
          folder,
          uid,
          message: `Message uid ${uid} not found in "${folder}"`,
        }),
      );
    }
    const { source } = message;
    const parsed = yield* Effect.tryPromise({
      try: () => simpleParser(source),
      catch: imapError('parse message'),
    });
    return { parsed, structure: message.bodyStructure };
  });

// Callers must hold the target folder's mailbox lock while using this helper.
export const readMessageContents = (
  client: ImapFlow,
  folder: string,
  uid: number,
): Effect.Effect<FullMessage, ImapError | MessageNotFoundError> =>
  fetchParsedMessage(client, folder, uid).pipe(
    Effect.map(({ parsed, structure }) => ({
      ...toFullMessage(parsed, folder, uid),
      attachments: listAttachments(structure),
    })),
  );

export const readMessage = (
  client: ImapFlow,
  handle: MessageHandle,
): Effect.Effect<
  FullMessage,
  ImapError | MessageNotFoundError | StaleUidError
> =>
  Effect.gen(function* () {
    yield* lockMessageFolder(client, handle);
    return yield* readMessageContents(client, handle.folder, handle.uid);
  }).pipe(Effect.scoped);
