import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { MissingCredentialsError } from '../../../shared/errors/accounts';
import { ImapError, type MailError } from '../errors/errors';
import { searchAllAccounts, searchOneAccount } from './account-search';
import { mailboxHit, searchOptions } from './account-search.fixture';
import type { MailboxSearchHit } from './imap-search';

const duplicateNewerUid = 3;
const newestUid = 4;

describe('searchAllAccounts', () => {
  it('merges, deduplicates, sorts, limits, and reports account failures', async () => {
    const searchMailbox = (
      account: string,
    ): Effect.Effect<ReadonlyArray<MailboxSearchHit>, MailError> => {
      switch (account) {
        case 'first@example.com':
          return Effect.succeed([
            {
              ...mailboxHit(
                1,
                '<duplicate@example.com>',
                '2026-07-14T08:00:00Z',
              ),
              mailboxCopyKey: 'server-one-id',
            },
            mailboxHit(2, '<older@example.com>', '2026-07-13T08:00:00Z'),
          ]);
        case 'second@example.com':
          return Effect.succeed([
            {
              ...mailboxHit(
                duplicateNewerUid,
                '<duplicate@example.com>',
                '2026-07-15T08:00:00Z',
              ),
              mailboxCopyKey: 'server-two-id',
            },
            mailboxHit(
              newestUid,
              '<newest@example.com>',
              '2026-07-16T08:00:00Z',
            ),
          ]);
        default:
          return Effect.fail(
            new MissingCredentialsError({
              account,
              message: `No stored credentials for ${account}`,
            }),
          );
      }
    };

    const result = await Effect.runPromise(
      searchAllAccounts(
        ['first@example.com', 'second@example.com', 'unavailable@example.com'],
        { ...searchOptions, limit: 3 },
        searchMailbox,
      ),
    );

    expect(
      result.hits.map(({ account, subject }) => ({ account, subject })),
    ).toEqual([
      {
        account: 'second@example.com',
        subject: '<newest@example.com>',
      },
      {
        account: 'second@example.com',
        subject: '<duplicate@example.com>',
      },
      {
        account: 'first@example.com',
        subject: '<older@example.com>',
      },
    ]);
    expect(result.failures).toEqual([
      {
        account: 'unavailable@example.com',
        errorTag: 'MissingCredentialsError',
        message: 'No stored credentials for unavailable@example.com',
      },
    ]);
  });

  it('preserves case-distinct message IDs across accounts', async () => {
    const result = await Effect.runPromise(
      searchAllAccounts(
        ['first@example.com', 'second@example.com'],
        { ...searchOptions, limit: 20 },
        (account) =>
          Effect.succeed([
            account === 'first@example.com'
              ? mailboxHit(1, '<ABC@example.com>', '2026-07-15T08:00:00Z')
              : mailboxHit(2, '<abc@example.com>', '2026-07-16T08:00:00Z'),
          ]),
      ),
    );

    expect(result.hits.map(({ subject }) => subject)).toEqual([
      '<abc@example.com>',
      '<ABC@example.com>',
    ]);
  });

  it('fails with every account error when no account can be searched', async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        searchAllAccounts(
          ['first@example.com', 'second@example.com'],
          searchOptions,
          (account) =>
            Effect.fail(
              new MissingCredentialsError({
                account,
                message: `No stored credentials for ${account}`,
              }),
            ),
        ),
      ),
    );

    expect(result).toMatchObject({ _tag: 'SearchAccountsError' });
    expect(result.message).toContain(
      'first@example.com: No stored credentials for first@example.com',
    );
    expect(result.message).toContain(
      'second@example.com: No stored credentials for second@example.com',
    );
  });
});

describe('searchAllAccounts with identical headers', () => {
  it('keeps two messages of one account when another account holds a copy', async () => {
    const result = await Effect.runPromise(
      searchAllAccounts(
        ['first@example.com', 'second@example.com'],
        { ...searchOptions, limit: 20 },
        (account) =>
          Effect.succeed(
            account === 'first@example.com'
              ? [
                  mailboxHit(
                    11,
                    '<reused@example.com>',
                    '2026-11-15T12:00:00Z',
                  ),
                  mailboxHit(
                    10,
                    '<reused@example.com>',
                    '2026-11-14T12:00:00Z',
                  ),
                ]
              : [
                  mailboxHit(
                    12,
                    '<reused@example.com>',
                    '2026-11-16T12:00:00Z',
                  ),
                ],
          ),
      ),
    );

    // second@example.com's uid 12 stands for one of first@example.com's.
    expect(result.hits.map(({ account, uid }) => ({ account, uid }))).toEqual([
      { account: 'second@example.com', uid: 12 },
      { account: 'first@example.com', uid: 10 },
    ]);
  });
});

describe('searchAllAccounts with a reused Message-ID', () => {
  it('keeps different messages of one account that share a Message-ID', async () => {
    const result = await Effect.runPromise(
      searchAllAccounts(
        ['first@example.com', 'second@example.com'],
        { ...searchOptions, limit: 20 },
        (account) =>
          Effect.succeed(
            account === 'first@example.com'
              ? [
                  mailboxHit(
                    11,
                    '<reused@example.com>',
                    '2026-11-15T12:00:00Z',
                  ),
                  mailboxHit(
                    10,
                    '<reused@example.com>',
                    '2026-11-14T12:00:00Z',
                  ),
                ]
              : [],
          ),
      ),
    );

    expect(result.hits.map(({ uid }) => uid)).toEqual([11, 10]);
  });
});

describe('searchOneAccount', () => {
  it('adds the account handle and preserves explicit-account failures', async () => {
    const successful = await Effect.runPromise(
      searchOneAccount('me@example.com', searchOptions, () =>
        Effect.succeed([
          mailboxHit(1, '<message@example.com>', '2026-07-16T08:00:00Z'),
        ]),
      ),
    );

    expect(successful).toMatchObject({
      hits: [{ account: 'me@example.com', uid: 1 }],
      failures: [],
    });

    const failed = await Effect.runPromise(
      Effect.flip(
        searchOneAccount('me@example.com', searchOptions, () =>
          Effect.fail(new ImapError({ message: 'authentication failed' })),
        ),
      ),
    );
    expect(failed).toMatchObject({
      _tag: 'ImapError',
      message: 'authentication failed',
    });
  });
});
