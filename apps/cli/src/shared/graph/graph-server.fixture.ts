import { Effect } from 'effect';
import type { Account } from '../accounts/account';
import { pimClientId } from './app';
import { type GraphFetch, makeGraphClient } from './client';
import { Graph } from './graph';

const notFoundCode = 404;

export type GraphRequest = {
  readonly url: string;
  readonly prefer: string | undefined;
  // Only on writes.
  readonly method?: string;
  readonly body?: unknown;
  readonly ifMatch?: string;
};

// An answer with another status than 200, and without a body when it has
// none.
export class GraphReply {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    this.status = status;
    this.body = body;
  }
}

// The JSON body of an answer, a reply, or replies in turn, the last of
// which repeats. Microsoft Graph answers no request with a JSON array.
export type GraphRoute = unknown;

// An account that reads Outlook calendars from the fake Microsoft Graph.
export const graphAccount: Account = {
  email: 'me@example.com',
  name: 'Me',
  graph: { clientId: pimClientId, hiddenCalendars: [] },
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Like Microsoft Graph, keeps only the selected fields of an item, of the
// items in a collection, and of the expanded items, which Microsoft Graph
// gives the fields selected for their parent.
const selectFields = (
  body: unknown,
  fields: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): unknown => {
  if (!isRecord(body)) {
    return body;
  }
  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) => {
      if ((key === 'value' || expanded.has(key)) && Array.isArray(value)) {
        return [
          [key, value.map((item) => selectFields(item, fields, expanded))],
        ];
      }
      return fields.has(key) || key.startsWith('@odata.') ? [[key, value]] : [];
    }),
  );
};

const writeOf = (init: Parameters<GraphFetch>[1]): Partial<GraphRequest> => ({
  method: init.method,
  ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }),
  ...(init.headers['if-match'] === undefined
    ? {}
    : { ifMatch: init.headers['if-match'] }),
});

const responseOf = (
  answer: unknown,
  select: string | null,
  expand: string | null,
): Response => {
  if (answer === undefined) {
    return Response.json(
      { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
      { status: notFoundCode },
    );
  }
  if (answer instanceof GraphReply) {
    return answer.body === undefined
      ? new Response(null, { status: answer.status })
      : Response.json(answer.body, { status: answer.status });
  }
  return Response.json(
    select === null
      ? answer
      : selectFields(
          answer,
          new Set(select.split(',')),
          new Set(expand?.split(',')),
        ),
  );
};

// A Microsoft Graph that answers each path, without /v1.0, from a table, and
// records every request. A read answers from its path, and a path with
// $skiptoken=<token> from "<path>?$skiptoken=<token>"; a write answers from
// "<METHOD> <path>". Anything else gets 404. An answer keeps only the fields
// in $select.
export const fakeGraph = (routes: Readonly<Record<string, GraphRoute>>) => {
  const requests: Array<GraphRequest> = [];
  const answered = new Map<string, number>();
  const answerFor = (key: string): unknown => {
    const route = routes[key];
    if (!Array.isArray(route)) {
      return route;
    }
    const count = answered.get(key) ?? 0;
    answered.set(key, count + 1);
    return route[Math.min(count, route.length - 1)];
  };
  const fetch: GraphFetch = (url, init) => {
    const reads = init.method === 'GET';
    requests.push({
      url,
      prefer: init.headers.prefer,
      ...(reads ? {} : writeOf(init)),
    });
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/v1.0', '');
    const token = searchParams.get('$skiptoken');
    const key = reads ? path : `${init.method} ${path}`;
    return Promise.resolve(
      responseOf(
        answerFor(token === null ? key : `${key}?$skiptoken=${token}`),
        searchParams.get('$select'),
        searchParams.get('$expand'),
      ),
    );
  };
  const client = makeGraphClient(
    { account: graphAccount.email, accessToken: 'access' },
    fetch,
  );
  return {
    requests,
    client,
    graph: Graph.of({
      client: () => Effect.succeed(client),
      clientWith: () => client,
    }),
  };
};

// Runs the effect against a fake Microsoft Graph.
export const onFakeGraph = <A, E, R>(
  routes: Readonly<Record<string, GraphRoute>>,
  effect: Effect.Effect<A, E, R>,
) => {
  const { requests, graph } = fakeGraph(routes);
  return {
    requests,
    effect: effect.pipe(Effect.provideService(Graph, graph)),
  };
};
