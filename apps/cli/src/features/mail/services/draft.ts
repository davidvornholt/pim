import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import type { Account } from '../../../shared/accounts/account';
import {
  DraftError,
  ImapError,
  MessageNotFoundError,
  type StaleUidError,
} from '../errors/errors';
import type {
  CalendarReplyDraft,
  DraftHandle,
  DraftInput,
  DraftLocation,
  FolderInfo,
  FullMessage,
  UpdateDraftInput,
} from '../schemas/mail';
import { selectDraftsFolder } from './draft-folder';
import { listFolders, readMessage, readMessageContents } from './imap-ops';
import { lockMailbox } from './mailbox-lock';
import { buildCalendarReply, buildMime } from './mime';
import { canExpungeByUid } from './uid-expunge';
import { requireCurrentUidValidity } from './uid-validity';

const readReplySource = (
  client: ImapFlow,
  input: DraftInput,
): Effect.Effect<FullMessage | undefined, ImapError | MessageNotFoundError> =>
  input.replySource === undefined
    ? Effect.succeed(undefined)
    : readMessage(client, input.replySource.folder, input.replySource.uid);

const appendDraft = (
  client: ImapFlow,
  folder: string,
  raw: Buffer,
): Effect.Effect<DraftLocation, ImapError> =>
  Effect.tryPromise({
    // \Seen matches how mail clients store their own drafts, so saved drafts
    // don't show up as unread.
    try: () => client.append(folder, raw, ['\\Draft', '\\Seen']),
    catch: (cause) =>
      new ImapError({
        message: `append draft to ${folder} failed: ${String(cause)}`,
      }),
  }).pipe(
    Effect.map((response) => ({
      folder,
      uid: response === false ? null : (response.uid ?? null),
      uidValidity:
        response === false ? null : (response.uidValidity?.toString() ?? null),
    })),
  );

const deleteDraftContents = (
  client: ImapFlow,
  folder: string,
  uid: number,
  expectedUidValidity: string,
): Effect.Effect<void, ImapError | MessageNotFoundError | StaleUidError> =>
  Effect.gen(function* () {
    yield* requireCurrentUidValidity(
      client,
      folder,
      expectedUidValidity,
      `modify draft uid ${uid}`,
    );
    const existing = yield* Effect.tryPromise({
      try: () => client.fetchOne(String(uid), { uid: true }, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `look up draft uid ${uid} failed: ${String(cause)}`,
        }),
    });
    if (existing === false || existing === undefined) {
      return yield* Effect.fail(
        new MessageNotFoundError({
          folder,
          uid,
          message: `draft uid ${uid} not found in "${folder}"`,
        }),
      );
    }
    const deleted = yield* Effect.tryPromise({
      try: () => client.messageDelete(String(uid), { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `delete draft uid ${uid} failed: ${String(cause)}`,
        }),
    });
    if (!deleted) {
      return yield* Effect.fail(
        new ImapError({
          message: `delete draft uid ${uid} failed: server rejected the expunge`,
        }),
      );
    }
  });

const deleteDraft = (
  client: ImapFlow,
  folder: string,
  uid: number,
  expectedUidValidity: string,
): Effect.Effect<void, ImapError | MessageNotFoundError | StaleUidError> =>
  Effect.gen(function* () {
    yield* lockMailbox(client, folder);
    yield* deleteDraftContents(client, folder, uid, expectedUidValidity);
  }).pipe(Effect.scoped);

const requireUidExpunge = (
  client: ImapFlow,
): Effect.Effect<void, DraftError> =>
  canExpungeByUid(client)
    ? Effect.void
    : Effect.fail(
        new DraftError({
          message:
            'refusing to change the draft: the mail server lacks UIDPLUS, so removing the old draft would also expunge every other message marked deleted in the drafts folder',
        }),
      );

export const requireDraftsFolder = (
  folders: ReadonlyArray<FolderInfo>,
  requestedFolder: string,
): Effect.Effect<string, DraftError> => {
  const draftsFolder = selectDraftsFolder(folders);
  return requestedFolder === draftsFolder
    ? Effect.succeed(draftsFolder)
    : Effect.fail(
        new DraftError({
          message: `refusing to modify a message outside the drafts folder "${draftsFolder}"`,
        }),
      );
};

export const writeDraft = (
  client: ImapFlow,
  account: Account,
  input: DraftInput,
): Effect.Effect<
  DraftLocation,
  ImapError | DraftError | MessageNotFoundError
> =>
  Effect.gen(function* () {
    const folders = yield* listFolders(client);
    const folder = selectDraftsFolder(folders);
    const repliedTo = yield* readReplySource(client, input);
    const raw = yield* buildMime(account, input, repliedTo);
    return yield* appendDraft(client, folder, raw);
  });

export const writeCalendarReply = (
  client: ImapFlow,
  account: Account,
  draft: CalendarReplyDraft,
): Effect.Effect<DraftLocation, ImapError | DraftError> =>
  Effect.gen(function* () {
    const folders = yield* listFolders(client);
    const raw = yield* buildCalendarReply(account, draft);
    return yield* appendDraft(client, selectDraftsFolder(folders), raw);
  });

export const replaceDraft = (
  client: ImapFlow,
  account: Account,
  input: UpdateDraftInput,
): Effect.Effect<
  DraftLocation,
  ImapError | DraftError | MessageNotFoundError | StaleUidError
> =>
  Effect.gen(function* () {
    yield* requireUidExpunge(client);
    const folders = yield* listFolders(client);
    const draftsFolder = yield* requireDraftsFolder(folders, input.folder);
    const repliedTo = yield* readReplySource(client, input);
    const replacement = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* lockMailbox(client, draftsFolder);
        yield* requireCurrentUidValidity(
          client,
          draftsFolder,
          input.uidValidity,
          `modify draft uid ${input.uid}`,
        );
        const existingBcc =
          input.bcc ??
          (yield* readMessageContents(client, draftsFolder, input.uid)).bcc;
        const raw = yield* buildMime(
          account,
          { ...input, bcc: existingBcc },
          repliedTo,
        );
        const appended = yield* appendDraft(client, draftsFolder, raw);
        yield* deleteDraftContents(
          client,
          draftsFolder,
          input.uid,
          input.uidValidity,
        ).pipe(
          Effect.mapError(
            (error) =>
              new ImapError({
                message: `replacement draft was saved as uid ${appended.uid ?? 'unknown'}, but ${error.message}`,
              }),
          ),
        );
        return appended;
      }),
    );
    return replacement;
  });

export const removeDraft = (
  client: ImapFlow,
  handle: DraftHandle,
): Effect.Effect<
  void,
  ImapError | DraftError | MessageNotFoundError | StaleUidError
> =>
  Effect.gen(function* () {
    yield* requireUidExpunge(client);
    const folders = yield* listFolders(client);
    const draftsFolder = yield* requireDraftsFolder(folders, handle.folder);
    yield* deleteDraft(client, draftsFolder, handle.uid, handle.uidValidity);
  });
