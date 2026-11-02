import { Effect, type Scope } from 'effect';
import type { ImapFlow, ListResponse } from 'imapflow';
import {
  FolderNotFoundError,
  ImapError,
  MessageChangeError,
  type StaleUidError,
} from '../errors/errors';
import type {
  MarkMessagesResult,
  MessageBatch,
  MoveDestination,
  MoveMessagesResult,
} from '../schemas/mail';
import { listMailboxes } from './imap-ops';
import { lockMailbox } from './mailbox-lock';
import { isSelectable, samePath } from './search-folders';
import { requireCurrentUidValidity } from './uid-validity';

// One command carries the whole batch, so its uid set must stay near the
// 8192-octet command line RFC 7162 asks for; 500 ten-digit uids fit.
const maxBatchSize = 500;

type ChangeError =
  | ImapError
  | FolderNotFoundError
  | MessageChangeError
  | StaleUidError;

const batchUids = (
  batch: MessageBatch,
): Effect.Effect<ReadonlyArray<number>, MessageChangeError> => {
  const uids = [...new Set(batch.uids)];
  if (uids.length === 0) {
    return Effect.fail(
      new MessageChangeError({ message: 'at least one uid is required' }),
    );
  }
  return uids.length > maxBatchSize
    ? Effect.fail(
        new MessageChangeError({
          message: `${uids.length} uids is more than ${maxBatchSize} at once; split them into smaller batches`,
        }),
      )
    : Effect.succeed(uids);
};

// Locks the folder for the rest of the scope and checks that every uid still
// names a message there, so the change applies to all of them or to none.
const lockBatch = (
  client: ImapFlow,
  batch: MessageBatch,
  uids: ReadonlyArray<number>,
  action: string,
): Effect.Effect<void, ChangeError, Scope.Scope> =>
  Effect.gen(function* () {
    const { folder } = batch;
    yield* lockMailbox(client, folder);
    yield* requireCurrentUidValidity(client, folder, batch.uidValidity, action);
    const found = yield* Effect.tryPromise({
      try: () => client.fetchAll([...uids], { uid: true }, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `look up messages in "${folder}" failed: ${String(cause)}`,
        }),
    });
    const foundUids = new Set(found.map((message) => message.uid));
    const missing = uids.filter((uid) => !foundUids.has(uid));
    if (missing.length > 0) {
      return yield* new MessageChangeError({
        message: `refusing to ${action}: ${missing.length === 1 ? 'uid' : 'uids'} ${missing.join(', ')} not found in "${folder}"; search again for fresh uids`,
      });
    }
  });

const destinationFolder = (
  folders: ReadonlyArray<ListResponse>,
  destination: MoveDestination,
): Effect.Effect<string, FolderNotFoundError | MessageChangeError> => {
  if (destination.kind === 'trash') {
    const trash = folders.find(
      (folder) => folder.specialUse === '\\Trash' && isSelectable(folder),
    );
    return trash === undefined
      ? Effect.fail(
          new MessageChangeError({
            message:
              'the account has no trash folder; move the messages to a named folder instead',
          }),
        )
      : Effect.succeed(trash.path);
  }
  const named = folders.find(
    (folder) =>
      samePath(folder.path, destination.folder) && isSelectable(folder),
  );
  return named === undefined
    ? Effect.fail(
        new FolderNotFoundError({
          folder: destination.folder,
          message: `Folder "${destination.folder}" was not found or cannot hold messages.`,
        }),
      )
    : Effect.succeed(named.path);
};

export const moveMessages = (
  client: ImapFlow,
  batch: MessageBatch,
  destination: MoveDestination,
): Effect.Effect<MoveMessagesResult, ChangeError> =>
  Effect.gen(function* () {
    const uids = yield* batchUids(batch);
    const folders = yield* listMailboxes(client);
    const to = yield* destinationFolder(folders, destination);
    if (samePath(to, batch.folder)) {
      return yield* new MessageChangeError({
        message: `refusing to move messages: they are already in "${to}"`,
      });
    }
    yield* lockBatch(client, batch, uids, `move messages to "${to}"`);
    const moved = yield* Effect.tryPromise({
      try: () => client.messageMove([...uids], to, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `move messages to "${to}" failed: ${String(cause)}`,
        }),
    });
    if (moved === false || moved === undefined) {
      return yield* new ImapError({
        message: `move messages to "${to}" failed: the server rejected the move`,
      });
    }
    return {
      ...batch,
      uids,
      to: { folder: to, uidValidity: moved.uidValidity?.toString() ?? null },
      moved: uids.map((uid) => ({
        uid,
        newUid: moved.uidMap?.get(uid) ?? null,
      })),
    };
  }).pipe(Effect.scoped);

export const markMessages = (
  client: ImapFlow,
  batch: MessageBatch,
  read: boolean,
): Effect.Effect<MarkMessagesResult, ChangeError> =>
  Effect.gen(function* () {
    const uids = yield* batchUids(batch);
    const action = `mark messages as ${read ? 'read' : 'unread'}`;
    yield* lockBatch(client, batch, uids, action);
    const updated = yield* Effect.tryPromise({
      try: () =>
        read
          ? client.messageFlagsAdd([...uids], ['\\Seen'], { uid: true })
          : client.messageFlagsRemove([...uids], ['\\Seen'], { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `${action} in "${batch.folder}" failed: ${String(cause)}`,
        }),
    });
    if (!updated) {
      return yield* new ImapError({
        message: `${action} in "${batch.folder}" failed: the server rejected the update`,
      });
    }
    return { ...batch, uids, read };
  }).pipe(Effect.scoped);
