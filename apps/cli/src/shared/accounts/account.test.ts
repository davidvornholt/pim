import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { decodeAccounts, findAccount, mailAccount } from './account';

const mailOnly = { name: 'A', mail: { host: 'imap.b.com' } };

const decoded = (input: unknown) =>
  Result.getOrThrowWith(decodeAccounts(input), (error) => new Error(error));

const rejection = (input: unknown): string =>
  Result.match(decodeAccounts(input), {
    onFailure: (error) => error,
    onSuccess: () => 'accepted',
  });

// Each case: the accounts table, and what the rejection must say.
const rejections: ReadonlyArray<
  readonly [string, Record<string, unknown>, string]
> = [
  ['no accounts', {}, 'needs at least one account'],
  [
    'a key that is no email address',
    { work: mailOnly },
    'account keys must be email addresses',
  ],
  [
    'account emails that differ only by case',
    { 'a@b.com': mailOnly, 'A@B.com': mailOnly },
    'unique ignoring case: A@B.com',
  ],
  [
    'an account without a service',
    { 'a@b.com': { name: 'A' } },
    'an account needs a mail, dav, or graph table',
  ],
  ['a missing name', { 'a@b.com': { mail: { host: 'x' } } }, 'name'],
  ['a missing host', { 'a@b.com': { name: 'A', mail: {} } }, 'host'],
  [
    'a mail key at the account level',
    { 'a@b.com': { ...mailOnly, host: 'imap.b.com' } },
    'host',
  ],
  [
    'a misspelled mail key',
    { 'a@b.com': { name: 'A', mail: { host: 'x', hots: 'x' } } },
    'hots',
  ],
  [
    'an out-of-range port',
    { 'a@b.com': { name: 'A', mail: { host: 'x', port: 70_000 } } },
    'port',
  ],
  [
    'an unknown auth method',
    { 'a@b.com': { name: 'A', mail: { host: 'x', auth: 'oauth' } } },
    'auth',
  ],
  [
    'a plain-http DAV url',
    { 'a@b.com': { name: 'A', dav: { url: 'http://dav.b.com/' } } },
    'must be an https URL',
  ],
  [
    'a misspelled DAV key',
    {
      'a@b.com': {
        name: 'A',
        dav: { url: 'https://dav.b.com/', usr: 'x' },
      },
    },
    'usr',
  ],
  [
    'an unknown Graph key',
    { 'a@b.com': { name: 'A', graph: { tenant: 'x' } } },
    'tenant',
  ],
  [
    'an empty Graph client-id',
    { 'a@b.com': { name: 'A', graph: { 'client-id': '' } } },
    'client-id',
  ],
  [
    'an empty name among the hidden calendars',
    { 'a@b.com': { name: 'A', graph: { 'hidden-calendars': [''] } } },
    'hidden-calendars',
  ],
];

describe('decodeAccounts', () => {
  it('takes each email from its key and fills in the mail defaults', () => {
    expect(decoded({ accounts: { 'a@b.com': mailOnly } })).toEqual([
      {
        email: 'a@b.com',
        name: 'A',
        mail: {
          host: 'imap.b.com',
          port: 993,
          secure: true,
          user: 'a@b.com',
          auth: 'password',
        },
      },
    ]);
  });

  it('keeps an explicit port, security mode, login user, and auth method', () => {
    const explicit = {
      port: 143,
      secure: false,
      user: 'a',
      auth: 'microsoft',
    } as const;
    const [account] = decoded({
      accounts: {
        'a@b.com': { name: 'A', mail: { host: 'imap.b.com', ...explicit } },
      },
    });
    expect(account?.mail).toMatchObject(explicit);
  });

  it('adds DAV settings that log in as the mail user, or the email without mail', () => {
    const [withMail, davOnly] = decoded({
      accounts: {
        'a@b.com': {
          name: 'A',
          mail: { host: 'imap.b.com', user: 'login' },
          dav: { url: 'https://dav.b.com/' },
        },
        'c@b.com': { name: 'C', dav: { url: 'https://dav.b.com/' } },
      },
    });
    expect(withMail?.dav).toEqual({ url: 'https://dav.b.com/', user: 'login' });
    expect(davOnly).toEqual({
      email: 'c@b.com',
      name: 'C',
      dav: { url: 'https://dav.b.com/', user: 'c@b.com' },
    });
  });

  it("adds Graph settings that use pim's app unless client-id replaces it", () => {
    const [account, own] = decoded({
      accounts: {
        'a@b.com': { name: 'A', graph: {} },
        'c@example.com': {
          name: 'C',
          graph: { 'client-id': '00000000-0000-4000-8000-000000000002' },
        },
      },
    });
    expect(account).toEqual({
      email: 'a@b.com',
      name: 'A',
      graph: {
        clientId: '161e31aa-5a5e-4f0f-a4c5-9660cf121f18',
        hiddenCalendars: [],
      },
    });
    expect(own?.graph).toEqual({
      clientId: '00000000-0000-4000-8000-000000000002',
      hiddenCalendars: [],
    });
    const [plain] = decoded({ accounts: { 'a@b.com': mailOnly } });
    expect(plain).not.toHaveProperty('graph');
    expect(plain).not.toHaveProperty('dav');
  });

  it('keeps the calendars that hidden-calendars names', () => {
    const [account] = decoded({
      accounts: {
        'a@b.com': { name: 'A', graph: { 'hidden-calendars': ['Birthdays'] } },
      },
    });
    expect(account?.graph?.hiddenCalendars).toEqual(['Birthdays']);
  });

  it.each(rejections)('rejects %s and says why', (_case, accounts, reason) => {
    expect(rejection({ accounts })).toContain(reason);
  });
});

describe('mailAccount', () => {
  it('fails with a typed error for an account without mail', async () => {
    const [account] = decoded({
      accounts: { 'a@b.com': { name: 'A', graph: {} } },
    });
    if (account === undefined) {
      throw new Error('expected an account');
    }
    const result = await Effect.runPromise(Effect.result(mailAccount(account)));
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'MailNotConfiguredError',
        message: 'a@b.com has no mail: its account config has no mail table',
      },
    });
  });
});

describe('findAccount', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const accounts = decoded({ accounts: { 'a@b.com': mailOnly } });
    expect(findAccount(accounts, ' A@B.COM ')?.email).toBe('a@b.com');
    expect(findAccount(accounts, 'other@b.com')).toBeUndefined();
  });
});
