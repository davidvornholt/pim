import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { ConfigError, UnknownAccountError } from '../errors/accounts';
import { type Account, decodeAccounts, findAccount } from './account';

// PIM_CONFIG overrides the XDG location (tests point it at fixtures). Every OS
// uses ~/.config, and os.homedir() finds the home directory on Windows, which
// usually has no HOME.
const configPath = (): string =>
  Bun.env.PIM_CONFIG ||
  join(
    Bun.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'pim',
    'accounts.toml',
  );

// pim's other config files, such as the drafting guide, live in the folder of
// the account config, so PIM_CONFIG moves them too.
export const besideAccountConfig = (fileName: string): string =>
  join(dirname(configPath()), fileName);

const missingConfigMessage = (path: string): string =>
  `No account config at ${path}. Create it with one [accounts."<email>"] table per account containing name and at least one of: mail = { host = "<imap host>" } (port defaults to 993, secure to true, user to the email, auth to "password"), dav = { url = "<https DAV root>" }, graph = {}. Then run: pim login`;

const loadAccounts = Effect.gen(function* () {
  const path = configPath();
  const file = Bun.file(path);
  const exists = yield* Effect.promise(() => file.exists());
  if (!exists) {
    return yield* Effect.fail(
      new ConfigError({ message: missingConfigMessage(path) }),
    );
  }
  const text = yield* Effect.tryPromise({
    try: () => file.text(),
    catch: (cause) =>
      new ConfigError({
        message: `Could not read the account config at ${path}: ${String(cause)}`,
      }),
  });
  const parsed = yield* Effect.try({
    try: (): unknown => Bun.TOML.parse(text),
    catch: (cause) =>
      new ConfigError({
        message: `The account config at ${path} is not valid TOML: ${String(cause)}`,
      }),
  });
  return yield* Result.match(decodeAccounts(parsed), {
    onFailure: (details) =>
      Effect.fail(
        new ConfigError({
          message: `Invalid account config at ${path}:\n${details}`,
        }),
      ),
    onSuccess: (accounts) => Effect.succeed(accounts),
  });
});

export class AccountConfig extends Context.Service<
  AccountConfig,
  {
    readonly accounts: ReadonlyArray<Account>;
    readonly emails: ReadonlyArray<string>;
    // Matches case-insensitively and returns the configured spelling.
    readonly getAccount: (
      email: string,
    ) => Effect.Effect<Account, UnknownAccountError>;
  }
>()('shared/AccountConfig') {
  static readonly layer = Layer.effect(
    AccountConfig,
    Effect.gen(function* () {
      const accounts = yield* loadAccounts;
      const emails = accounts.map((account) => account.email);
      return AccountConfig.of({
        accounts,
        emails,
        getAccount: (email) => {
          const account = findAccount(accounts, email);
          return account === undefined
            ? Effect.fail(
                new UnknownAccountError({
                  email,
                  message: `Unknown account "${email}". Configured accounts: ${emails.join(', ')}`,
                }),
              )
            : Effect.succeed(account);
        },
      });
    }),
  );
}
