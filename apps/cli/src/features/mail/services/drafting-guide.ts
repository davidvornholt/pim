import { Effect } from 'effect';
import { besideAccountConfig } from '../../../shared/accounts/config';
import { ConfigError } from '../../../shared/errors/accounts';

export const draftingGuideFile = 'drafting.md';

export type DraftingGuide = {
  readonly path: string;
  // null when the user has not written a guide.
  readonly guide: string | null;
};

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === 'ENOENT';

// The user's free-text notes on how agents should write their drafts, such as
// their sign-off. pim only passes them on; the agent follows them. Reading
// once, instead of checking that the file exists first, also reports a path
// that is not a readable file, such as a folder.
export const readDraftingGuide: Effect.Effect<DraftingGuide, ConfigError> =
  Effect.gen(function* () {
    const path = besideAccountConfig(draftingGuideFile);
    const guide = yield* Effect.tryPromise({
      try: () =>
        Bun.file(path)
          .text()
          .catch((cause: unknown) => {
            if (isMissingFile(cause)) {
              return null;
            }
            throw cause;
          }),
      catch: (cause) =>
        new ConfigError({
          message: `Could not read the drafting guide at ${path}: ${String(cause)}`,
        }),
    });
    return { path, guide };
  });
