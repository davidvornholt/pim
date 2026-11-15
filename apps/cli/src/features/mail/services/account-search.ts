import { Effect } from 'effect';
import type {
  MailNotConfiguredError,
  UnknownAccountError,
} from '../../../shared/errors/accounts';
import { type MailError, SearchAccountsError } from '../errors/errors';
import type {
  SearchHit,
  SearchOptions,
  SearchOptionsInput,
  SearchResult,
} from '../schemas/mail';
import type { MailboxSearchHit } from './imap-search';
import { withoutCopies } from './search-copies';
import { resolveAccountSearchOptions } from './search-options';

type AccountSearchHit = MailboxSearchHit & {
  readonly account: string;
};

type AccountSearchOutcome =
  | {
      readonly _tag: 'success';
      readonly hits: ReadonlyArray<AccountSearchHit>;
    }
  | {
      readonly _tag: 'failure';
      readonly account: string;
      readonly error: MailError;
    };

export type SearchMailbox = (
  account: string,
  options: SearchOptions,
) => Effect.Effect<ReadonlyArray<MailboxSearchHit>, MailError>;

type SearchAccountsInput = {
  readonly accounts: ReadonlyArray<string>;
  readonly account: string | undefined;
  readonly options: SearchOptionsInput;
  readonly validateAccount: (
    account: string,
  ) => Effect.Effect<unknown, UnknownAccountError | MailNotConfiguredError>;
  readonly searchMailbox: SearchMailbox;
  readonly searchMailboxWithinDeadline: SearchMailbox;
};

const searchConcurrency = 5;

const newestFirst = (left: AccountSearchHit, right: AccountSearchHit): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  left.account.localeCompare(right.account) ||
  left.hit.folder.localeCompare(right.hit.folder) ||
  right.hit.uid - left.hit.uid;

const toSearchHit = ({ account, hit }: AccountSearchHit): SearchHit => ({
  account,
  ...hit,
});

export const searchOneAccount = (
  account: string,
  options: SearchOptions,
  searchMailbox: SearchMailbox,
): Effect.Effect<SearchResult, MailError> =>
  searchMailbox(account, options).pipe(
    Effect.map((hits) => ({
      hits: hits.map((hit) => toSearchHit({ account, ...hit })),
      failures: [],
    })),
  );

export const searchAllAccounts = (
  accounts: ReadonlyArray<string>,
  options: SearchOptions,
  searchMailbox: SearchMailbox,
): Effect.Effect<SearchResult, SearchAccountsError> =>
  Effect.gen(function* () {
    if (accounts.length === 0) {
      return yield* new SearchAccountsError({
        message:
          'No account has mail: add a mail table to an account in the account config',
      });
    }
    const outcomes = yield* Effect.forEach(
      accounts,
      (account) =>
        searchMailbox(account, options).pipe(
          Effect.match({
            onFailure: (error): AccountSearchOutcome => ({
              _tag: 'failure',
              account,
              error,
            }),
            onSuccess: (mailboxHits): AccountSearchOutcome => ({
              _tag: 'success',
              hits: mailboxHits.map((hit) => ({ account, ...hit })),
            }),
          }),
        ),
      { concurrency: searchConcurrency },
    );
    const successes = outcomes.filter((outcome) => outcome._tag === 'success');
    if (successes.length === 0) {
      const details = outcomes
        .filter((outcome) => outcome._tag === 'failure')
        .map(({ account, error }) => `${account}: ${error.message}`)
        .join('; ');
      return yield* Effect.fail(
        new SearchAccountsError({
          message: `Search failed for every account. ${details}`,
        }),
      );
    }
    const mergedHits = successes.flatMap(
      ({ hits: accountHits }) => accountHits,
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome._tag === 'failure'
        ? [
            {
              account: outcome.account,
              errorTag: outcome.error._tag,
              message: outcome.error.message,
            },
          ]
        : [],
    );
    return {
      hits: withoutCopies(
        mergedHits.sort(newestFirst),
        ({ copyKey }) => copyKey,
        ({ account }) => account,
      )
        .slice(0, options.limit)
        .map(toSearchHit),
      failures,
    };
  });

export const searchAccounts = ({
  accounts,
  account,
  options,
  validateAccount,
  searchMailbox,
  searchMailboxWithinDeadline,
}: SearchAccountsInput): Effect.Effect<SearchResult, MailError> =>
  Effect.gen(function* () {
    const resolvedOptions = yield* resolveAccountSearchOptions({
      account,
      options,
      validateAccount,
    });
    if (account === undefined) {
      return yield* searchAllAccounts(
        accounts,
        resolvedOptions,
        searchMailboxWithinDeadline,
      );
    }
    return yield* searchOneAccount(account, resolvedOptions, searchMailbox);
  });
