import { Effect, type Scope } from 'effect';
import type { ImapFlow } from 'imapflow';
import { ImapError, type StaleUidError } from '../errors/errors';
import type { MessageHandle } from '../schemas/mail';
import { requireCurrentUidValidity } from './uid-validity';

export const lockMailbox = (client: ImapFlow, folder: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => client.getMailboxLock(folder),
      catch: (cause) =>
        new ImapError({
          message: `lock ${folder} failed: ${String(cause)}`,
        }),
    }),
    (lock) =>
      Effect.sync(() => {
        lock.release();
      }),
  );

// Locks the message's folder and checks, under the lock, that its uid still
// names the message the handle came from.
export const lockMessageFolder = (
  client: ImapFlow,
  handle: MessageHandle,
): Effect.Effect<void, ImapError | StaleUidError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* lockMailbox(client, handle.folder);
    yield* requireCurrentUidValidity(
      client,
      handle.folder,
      handle.uidValidity,
      `read message uid ${handle.uid}`,
    );
  });
