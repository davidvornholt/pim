import { Effect, Result, Schema, SchemaIssue } from 'effect';
import { MailNotConfiguredError } from '../errors/accounts';
import { pimClientId } from '../graph/app';

// Keyring service namespace for stored credentials. They live in the OS
// keyring (see secrets.ts), keyed by credential kind and account email.
export const keyringService = 'pim';

// How an account logs in to IMAP: with a password, or with a Microsoft sign-in
// for Outlook.com and Microsoft 365, which no longer accept passwords.
const MailAuth = Schema.Literals(['password', 'microsoft']);
export type MailAuth = typeof MailAuth.Type;

const implicitTlsPort = 993;
const maxPort = 65_535;

const NonEmptyTrimmedString = Schema.NonEmptyString.check(Schema.isTrimmed());

const HttpsUrl = NonEmptyTrimmedString.check(
  Schema.makeFilter(
    (value) =>
      (URL.canParse(value) && new URL(value).protocol === 'https:') ||
      'must be an https URL',
  ),
);

// IMAP access for mail.
const MailEntry = Schema.Struct({
  host: NonEmptyTrimmedString,
  port: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maxPort }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(implicitTlsPort))),
  secure: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  user: Schema.optionalKey(NonEmptyTrimmedString),
  auth: MailAuth.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('password' as const)),
  ),
});

// CalDAV and CardDAV access for calendars and contacts. url is the server's
// DAV root, from which commands discover the calendars and address books.
const DavEntry = Schema.Struct({
  url: HttpsUrl,
  user: Schema.optionalKey(NonEmptyTrimmedString),
});

// Outlook calendars through Microsoft Graph. client-id replaces pim's own app
// registration, as for a tenant that allows only apps it registered.
// hidden-calendars names calendars that pim leaves out, because Outlook has
// built-in calendars that the user cannot remove.
const GraphEntry = Schema.Struct({
  clientId: Schema.optionalKey(NonEmptyTrimmedString),
  hiddenCalendars: Schema.Array(NonEmptyTrimmedString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
}).pipe(
  Schema.encodeKeys({
    clientId: 'client-id',
    hiddenCalendars: 'hidden-calendars',
  }),
);

const AccountEntry = Schema.Struct({
  name: NonEmptyTrimmedString,
  mail: Schema.optionalKey(MailEntry),
  dav: Schema.optionalKey(DavEntry),
  graph: Schema.optionalKey(GraphEntry),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.mail !== undefined ||
      entry.dav !== undefined ||
      entry.graph !== undefined ||
      'an account needs a mail, dav, or graph table',
  ),
);

const formatIssue = SchemaIssue.makeFormatterDefault();

const sameEmail = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const emailKey = /^[^\s@]+@[^\s@]+$/u;

// Rejects a key that is no email address and keys that differ only in case,
// because lookups ignore case; TOML itself rejects exact duplicates. A key
// that fails the record's key schema would only be reported as an excess
// property, so the key schema accepts any string and this check names it.
const accountKeysIssue = (emails: ReadonlyArray<string>): true | string => {
  if (emails.length === 0) {
    return 'needs at least one account, such as [accounts."you@example.com"]';
  }
  const malformed = emails.filter((email) => !emailKey.test(email));
  if (malformed.length > 0) {
    return `account keys must be email addresses, such as [accounts."you@example.com"], not ${malformed.map((email) => JSON.stringify(email)).join(', ')}`;
  }
  const duplicates = emails.filter(
    (email, index) =>
      emails.findIndex((other) => sameEmail(other, email)) !== index,
  );
  return (
    duplicates.length === 0 ||
    `account emails must be unique ignoring case: ${duplicates.join(', ')}`
  );
};

const AccountsFile = Schema.Struct({
  accounts: Schema.Record(Schema.String, AccountEntry).check(
    Schema.makeFilter((accounts) => accountKeysIssue(Object.keys(accounts))),
  ),
});

export type MailSettings = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly auth: MailAuth;
};

export type DavSettings = {
  readonly url: string;
  readonly user: string;
};

export type GraphSettings = {
  readonly clientId: string;
  readonly hiddenCalendars: ReadonlyArray<string>;
};

export type Account = {
  readonly email: string;
  readonly name: string;
  readonly mail?: MailSettings;
  readonly dav?: DavSettings;
  readonly graph?: GraphSettings;
};

export type MailAccount = Account & { readonly mail: MailSettings };

export const hasMail = (account: Account): account is MailAccount =>
  account.mail !== undefined;

export const mailAccount = (
  account: Account,
): Effect.Effect<MailAccount, MailNotConfiguredError> =>
  hasMail(account)
    ? Effect.succeed(account)
    : Effect.fail(
        new MailNotConfiguredError({
          account: account.email,
          message: `${account.email} has no mail: its account config has no mail table`,
        }),
      );

export const findAccount = (
  accounts: ReadonlyArray<Account>,
  email: string,
): Account | undefined =>
  accounts.find((account) => sameEmail(account.email, email.trim()));

// Unknown keys are rejected so a typo such as `hots` fails loudly instead of
// silently falling back to a default.
export const decodeAccounts = (
  input: unknown,
): Result.Result<ReadonlyArray<Account>, string> =>
  Schema.decodeUnknownResult(AccountsFile)(input, {
    errors: 'all',
    onExcessProperty: 'error',
  }).pipe(
    Result.map(({ accounts }) =>
      Object.entries(accounts).map(([email, { name, mail, dav, graph }]) => {
        const user = mail?.user ?? email;
        return {
          email,
          name,
          ...(mail === undefined ? {} : { mail: { ...mail, user } }),
          ...(dav === undefined
            ? {}
            : { dav: { url: dav.url, user: dav.user ?? user } }),
          ...(graph === undefined
            ? {}
            : {
                graph: {
                  clientId: graph.clientId ?? pimClientId,
                  hiddenCalendars: graph.hiddenCalendars,
                },
              }),
        };
      }),
    ),
    Result.mapError((error) => formatIssue(error.issue)),
  );
