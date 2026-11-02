import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { StaleUidError } from '../errors/errors';

const currentUidValidity = (client: ImapFlow): string | null =>
  client.mailbox === false ? null : client.mailbox.uidValidity.toString();

// Callers must hold the folder's mailbox lock while checking and mutating it.
// `action` completes "refusing to …" in the error message.
export const requireCurrentUidValidity = (
  client: ImapFlow,
  folder: string,
  expectedUidValidity: string,
  action: string,
): Effect.Effect<void, StaleUidError> => {
  const current = currentUidValidity(client);
  return current === expectedUidValidity
    ? Effect.void
    : Effect.fail(
        new StaleUidError({
          folder,
          message: `refusing to ${action}: "${folder}" was reindexed (uidValidity ${expectedUidValidity} → ${current ?? 'unknown'}); search again for fresh uids`,
        }),
      );
};
