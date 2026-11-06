import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import type { Account } from '../accounts/account';
import { type CredentialKind, Secrets } from '../accounts/secrets';
import { MissingCredentialsError, OAuthError } from '../errors/accounts';
import { GraphAuthError, GraphError } from '../errors/graph';
import { type MicrosoftApp, MicrosoftAuth } from '../microsoft/auth';
import { pimClientId } from './app';
import type { GraphFetch } from './client';
import { Graph, makeGraph } from './graph';
import { checkGraphAccounts, graphStatusFromError } from './status';

const account: Account = {
  email: 'me@example.com',
  name: 'Me',
  graph: { clientId: pimClientId, hiddenCalendars: [] },
};

// A keyring, Microsoft sign-in and Microsoft Graph that record their use.
const graphWith = (options: {
  readonly stored?: string;
  readonly rotated: string;
  readonly status?: number;
}) => {
  const keyring = new Map<string, string>(
    options.stored === undefined
      ? []
      : [['graph:me@example.com', options.stored]],
  );
  const refreshed: Array<string> = [];
  const authorized: Array<string | undefined> = [];
  const secrets = Secrets.of({
    getCredential: (kind: CredentialKind, email: string) => {
      const found = keyring.get(`${kind}:${email}`);
      return found === undefined
        ? Effect.fail(
            new MissingCredentialsError({ account: email, message: 'none' }),
          )
        : Effect.succeed(found);
    },
    setCredential: (kind: CredentialKind, email: string, credential: string) =>
      Effect.sync(() => {
        keyring.set(`${kind}:${email}`, credential);
      }),
  });
  const microsoft = {
    refresh: (app: MicrosoftApp, _email: string, refreshToken: string) =>
      Effect.sync(() => {
        refreshed.push(`${app.credential} ${app.clientId} ${refreshToken}`);
        return { accessToken: 'access', refreshToken: options.rotated };
      }),
  } as unknown as typeof MicrosoftAuth.Service;
  const fetch: GraphFetch = (_url, init) => {
    authorized.push(init.headers.authorization);
    return Promise.resolve(
      Response.json({ value: [] }, { status: options.status ?? 200 }),
    );
  };
  const provide = <A, E>(effect: Effect.Effect<A, E, Graph | Secrets>) =>
    Effect.runPromise(
      Effect.result(
        makeGraph(fetch).pipe(
          Effect.flatMap((graph) =>
            Effect.provideService(effect, Graph, graph),
          ),
          Effect.provideService(Secrets, secrets),
          Effect.provideService(MicrosoftAuth, microsoft),
        ),
      ),
    );
  return { keyring, refreshed, authorized, provide };
};

const clientFor = (target: Account) =>
  Graph.pipe(
    Effect.flatMap((graph) => graph.client(target)),
    Effect.flatMap((client) => client.list('/me/calendars')),
  );

describe('Graph', () => {
  it('trades the stored refresh token and keeps the rotated one', async () => {
    const graph = graphWith({ stored: 'stored', rotated: 'rotated' });

    const result = await graph.provide(clientFor(account));

    expect(Result.isSuccess(result)).toBe(true);
    expect(graph.refreshed).toEqual([`graph ${pimClientId} stored`]);
    expect(graph.authorized).toEqual(['Bearer access']);
    expect(graph.keyring.get('graph:me@example.com')).toBe('rotated');
  });

  it('refreshes with the client-id of the account', async () => {
    const graph = graphWith({ stored: 'stored', rotated: 'stored' });

    await graph.provide(
      clientFor({
        ...account,
        graph: {
          clientId: '00000000-0000-4000-8000-000000000002',
          hiddenCalendars: [],
        },
      }),
    );

    expect(graph.refreshed).toEqual([
      'graph 00000000-0000-4000-8000-000000000002 stored',
    ]);
  });

  it('needs a graph table', async () => {
    const { graph: _graph, ...withoutGraph } = account;
    const graph = graphWith({ stored: 'stored', rotated: 'stored' });

    const result = await graph.provide(clientFor(withoutGraph));

    expect(result).toMatchObject({
      failure: { _tag: 'GraphNotConfiguredError' },
    });
    expect(graph.refreshed).toEqual([]);
  });
});

describe('checkGraphAccounts', () => {
  it('reports each account with a graph table', async () => {
    const graph = graphWith({ stored: 'stored', rotated: 'stored' });
    const { graph: _graph, ...mailOnly } = {
      ...account,
      email: 'mail@example.com',
    };

    const result = await graph.provide(
      checkGraphAccounts([account, mailOnly], { verify: true }),
    );

    expect(result).toMatchObject({
      success: [{ service: 'graph', email: 'me@example.com', ok: true }],
    });
  });

  it('reports a sign-in Microsoft Graph rejects', async () => {
    const graph = graphWith({
      stored: 'stored',
      rotated: 'stored',
      status: 401,
    });

    const result = await graph.provide(
      checkGraphAccounts([account], { verify: true }),
    );

    expect(result).toMatchObject({
      success: [{ ok: false, state: 'unauthenticated' }],
    });
  });
});

describe('graphStatusFromError', () => {
  it('asks for a Graph login when the keyring has no refresh token', () => {
    const status = graphStatusFromError(
      'me@example.com',
      new MissingCredentialsError({
        account: 'me@example.com',
        message: 'none',
      }),
    );
    expect(status).toMatchObject({
      service: 'graph',
      ok: false,
      state: 'no-credentials',
    });
    expect(status.message).toContain(
      'pim login --account me@example.com --only graph',
    );
  });

  it('reports a rejected sign-in as unauthenticated', () => {
    for (const error of [
      new OAuthError({ message: 'expired' }),
      new GraphAuthError({ account: 'me@example.com', message: 'expired' }),
    ]) {
      expect(graphStatusFromError('me@example.com', error)).toMatchObject({
        state: 'unauthenticated',
        message: 'expired',
      });
    }
  });

  it('reports other failures as errors', () => {
    expect(
      graphStatusFromError(
        'me@example.com',
        new GraphError({ message: 'down' }),
      ).state,
    ).toBe('error');
  });
});
