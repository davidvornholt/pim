import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { Imap } from '../features/mail/services/imap';
import type { ImapLogin } from '../features/mail/services/imap-client';
import type { Account, MailAuth } from '../shared/accounts/account';
import { type CredentialKind, Secrets } from '../shared/accounts/secrets';
import { type Fetch, makeDavClient } from '../shared/dav/client';
import { Dav } from '../shared/dav/dav';
import { pimClientId } from '../shared/graph/app';
import { type GraphFetch, makeGraphClient } from '../shared/graph/client';
import { Graph } from '../shared/graph/graph';
import {
  type DeviceCode,
  type MicrosoftApp,
  MicrosoftAuth,
  type MicrosoftTokens,
} from '../shared/microsoft/auth';
import type { HiddenPromptResult } from '../shared/terminal';
import { loginAccounts, loginSteps } from './cli-login';

const accountFor = (email: string, auth: MailAuth): Account => ({
  email,
  name: 'Me',
  mail: {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: email,
    auth,
  },
});

const davAccount: Account = {
  ...accountFor('me@example.com', 'password'),
  dav: { url: 'https://dav.example.com/', user: 'me-dav' },
};

const graphAccount: Account = {
  ...accountFor('me@example.com', 'password'),
  graph: { clientId: pimClientId, hiddenCalendars: [] },
};

const principalReply = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat>
<d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const device: DeviceCode = {
  deviceCode: 'device-code',
  userCode: 'ABCD1234',
  verificationUri: 'https://login.microsoft.com/device',
  intervalSeconds: 5,
  expiresInSeconds: 900,
};

// Runs loginAccounts against recording fakes. `signIn` settles the Microsoft
// sign-in and `answer` settles each prompt.
const runLogin = async (
  accounts: ReadonlyArray<Account>,
  options: {
    readonly answer: Effect.Effect<HiddenPromptResult>;
    readonly signIn?: Effect.Effect<MicrosoftTokens>;
    readonly only?: CredentialKind;
    readonly davStatus?: number;
    readonly graphStatus?: number;
  },
) => {
  const prompts: Array<string> = [];
  const verified: Array<ImapLogin> = [];
  const stored: Array<string> = [];
  const davLogins: Array<string | null> = [];
  const graphLogins: Array<string | null> = [];
  const apps: Array<string> = [];
  const prompt = (question: string): Effect.Effect<HiddenPromptResult> =>
    Effect.sync(() => prompts.push(question)).pipe(
      Effect.andThen(options.answer),
    );
  const imap = {
    verifyLogin: (_email: string, login: ImapLogin) =>
      Effect.sync(() => {
        verified.push(login);
      }),
  } as unknown as typeof Imap.Service;
  const secrets = {
    setCredential: (kind: CredentialKind, _email: string, credential: string) =>
      Effect.sync(() => {
        stored.push(`${kind}:${credential}`);
      }),
  } as unknown as typeof Secrets.Service;
  const fetch: Fetch = (_url, init) => {
    davLogins.push(new Headers(init.headers).get('authorization'));
    return Promise.resolve(
      new Response(principalReply, { status: options.davStatus ?? 207 }),
    );
  };
  const dav = {
    clientWith: (account: Account, password: string) =>
      Effect.succeed(
        makeDavClient(
          {
            url: account.dav?.url ?? '',
            user: account.dav?.user ?? '',
            account: account.email,
            password,
          },
          fetch,
        ),
      ),
  } as unknown as typeof Dav.Service;
  const graphFetch: GraphFetch = (_url, init) => {
    graphLogins.push(init.headers.authorization ?? null);
    return Promise.resolve(
      Response.json({ value: [] }, { status: options.graphStatus ?? 200 }),
    );
  };
  const graph = {
    clientWith: (account: Account, accessToken: string) =>
      makeGraphClient({ account: account.email, accessToken }, graphFetch),
  } as unknown as typeof Graph.Service;
  const microsoft = {
    requestDeviceCode: (app: MicrosoftApp) =>
      Effect.sync(() => {
        apps.push(`${app.credential} ${app.clientId}`);
        return device;
      }),
    awaitSignIn: () => options.signIn ?? Effect.never,
    signInInBrowser: (app: MicrosoftApp, email: string) =>
      Effect.sync(() => {
        apps.push(`${app.credential} ${app.clientId} ${email}`);
        return {
          url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=pim',
          awaitSignIn: options.signIn ?? Effect.never,
        };
      }),
  } as unknown as typeof MicrosoftAuth.Service;

  const succeeded = await Effect.runPromise(
    loginAccounts(loginSteps(accounts, options.only), prompt).pipe(
      Effect.provideService(Imap, imap),
      Effect.provideService(Secrets, secrets),
      Effect.provideService(MicrosoftAuth, microsoft),
      Effect.provideService(Dav, dav),
      Effect.provideService(Graph, graph),
    ),
  );
  return { succeeded, prompts, verified, stored, davLogins, graphLogins, apps };
};

describe('loginAccounts', () => {
  it('stops prompting and does not verify or store after cancellation', async () => {
    const result = await runLogin(
      [
        accountFor('first@example.com', 'password'),
        accountFor('second@example.com', 'password'),
      ],
      { answer: Effect.succeed({ _tag: 'cancelled' }) },
    );

    expect(result.prompts).toEqual([
      'Mail password for first@example.com (input hidden): ',
    ]);
    expect(result.verified).toEqual([]);
    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });

  it('shows the Microsoft code, then verifies the access token and stores the refresh token', async () => {
    const result = await runLogin([accountFor('me@outlook.com', 'microsoft')], {
      answer: Effect.never,
      signIn: Effect.succeed({
        accessToken: 'access',
        refreshToken: 'refresh',
      }),
    });

    expect(result.prompts).toEqual([
      'Sign in to Microsoft as me@outlook.com: open https://login.microsoft.com/device and enter the code ABCD1234\nWaiting for sign-in (press Enter to skip): ',
    ]);
    expect(result.verified).toEqual([{ accessToken: 'access' }]);
    expect(result.stored).toEqual(['mail:refresh']);
    expect(result.succeeded).toBeTrue();
  });

  it('skips a Microsoft account when Enter is pressed before sign-in', async () => {
    const result = await runLogin([accountFor('me@outlook.com', 'microsoft')], {
      answer: Effect.succeed({ _tag: 'entered', value: '' }),
    });

    expect(result.verified).toEqual([]);
    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });

  it('logs in to mail and then DAV, and stores each under its own kind', async () => {
    const result = await runLogin([davAccount], {
      answer: Effect.succeed({ _tag: 'entered', value: 'secret' }),
    });

    expect(result.prompts).toEqual([
      'Mail password for me@example.com (input hidden): ',
      'Calendar and contacts password for me@example.com (DAV user me-dav, input hidden): ',
    ]);
    expect(result.davLogins).toEqual([
      `Basic ${Buffer.from('me-dav:secret').toString('base64')}`,
    ]);
    expect(result.stored).toEqual(['mail:secret', 'dav:secret']);
    expect(result.succeeded).toBeTrue();
  });

  it('does not store a DAV password the server rejects', async () => {
    const result = await runLogin([davAccount], {
      answer: Effect.succeed({ _tag: 'entered', value: 'wrong' }),
      only: 'dav',
      davStatus: 401,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });
});

describe('loginAccounts for Outlook calendars', () => {
  const signIn = Effect.succeed({
    accessToken: 'graph-access',
    refreshToken: 'graph-refresh',
  });

  it("signs in with pim's app, checks Microsoft Graph, and stores the refresh token", async () => {
    const result = await runLogin([graphAccount], {
      answer: Effect.never,
      signIn,
      only: 'graph',
    });

    expect(result.apps).toEqual([`graph ${pimClientId} me@example.com`]);
    expect(result.prompts).toEqual([
      'Sign in to Microsoft for the Outlook calendars of me@example.com: open this link in a browser on this computer:\nhttps://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=pim\nWaiting for sign-in (press Enter to skip): ',
    ]);
    expect(result.graphLogins).toEqual(['Bearer graph-access']);
    expect(result.stored).toEqual(['graph:graph-refresh']);
    expect(result.succeeded).toBeTrue();
  });

  it("signs in mail with the IMAP app and Outlook calendars with the account's client-id", async () => {
    const result = await runLogin(
      [
        {
          ...accountFor('me@example.com', 'microsoft'),
          graph: {
            clientId: '00000000-0000-4000-8000-000000000003',
            hiddenCalendars: [],
          },
        },
      ],
      { answer: Effect.never, signIn },
    );

    expect(result.apps).toEqual([
      'mail 9e5f94bc-e8a4-4e73-b8be-63364c29d753',
      'graph 00000000-0000-4000-8000-000000000003 me@example.com',
    ]);
    expect(result.stored).toEqual([
      'mail:graph-refresh',
      'graph:graph-refresh',
    ]);
  });

  it('does not store a sign-in Microsoft Graph rejects', async () => {
    const result = await runLogin([graphAccount], {
      answer: Effect.never,
      signIn,
      only: 'graph',
      graphStatus: 401,
    });

    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });
});

describe('loginSteps', () => {
  const mailOnly = accountFor('mail@example.com', 'password');

  it('adds DAV only for accounts that configure it', () => {
    expect(
      loginSteps([mailOnly, davAccount], undefined).map(
        ({ account, service }) => `${account.email} ${service}`,
      ),
    ).toEqual([
      'mail@example.com mail',
      'me@example.com mail',
      'me@example.com dav',
    ]);
  });

  it('adds Outlook calendars for accounts with a graph table', () => {
    expect(
      loginSteps(
        [mailOnly, { ...davAccount, ...graphAccount, dav: davAccount.dav }],
        undefined,
      ).map(({ account, service }) => `${account.email} ${service}`),
    ).toEqual([
      'mail@example.com mail',
      'me@example.com mail',
      'me@example.com dav',
      'me@example.com graph',
    ]);
    expect(
      loginSteps([mailOnly, graphAccount], 'graph').map(
        ({ account }) => account.email,
      ),
    ).toEqual(['me@example.com']);
  });

  it('skips mail for an account without a mail table', () => {
    const { mail: _mail, ...graphOnly } = graphAccount;
    expect(
      loginSteps([graphOnly], undefined).map(({ service }) => service),
    ).toEqual(['graph']);
  });

  it('limits the steps to one kind with only', () => {
    expect(
      loginSteps([mailOnly, davAccount], 'dav').map(
        ({ account }) => account.email,
      ),
    ).toEqual(['me@example.com']);
    expect(loginSteps([davAccount], 'mail')).toHaveLength(1);
  });
});
