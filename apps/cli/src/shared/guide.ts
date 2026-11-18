import { Effect } from 'effect';
import { besideAccountConfig } from './accounts/config';
import { ConfigError } from './errors/accounts';

export const guideFile = 'guide.md';

export type Guide = {
  readonly path: string;
  // null when the user has not written a guide.
  readonly guide: string | null;
};

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === 'ENOENT';

// The user's free-text notes on how agents should act for them, such as their
// sign-off or when they are free for calls. pim only passes them on; the agent
// follows them. Reading once, instead of checking that the file exists first,
// also reports a path that is not a readable file, such as a folder.
export const readGuide: Effect.Effect<Guide, ConfigError> = Effect.gen(
  function* () {
    const path = besideAccountConfig(guideFile);
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
          message: `Could not read the guide at ${path}: ${String(cause)}`,
        }),
    });
    return { path, guide };
  },
);
