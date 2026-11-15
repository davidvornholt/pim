import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlow,
  ListResponse,
} from 'imapflow';
import { searchMailboxes } from './imap-search';

type MailboxMessages = ReadonlyMap<string, ReadonlyArray<FetchMessageObject>>;

const listedFolder = (path: string, specialUse?: string): ListResponse => ({
  path,
  pathAsListed: path,
  name: path,
  delimiter: '/',
  parent: [],
  parentPath: '',
  flags: new Set(),
  specialUse,
  listed: true,
  subscribed: true,
});

const uidsInSet = (set: string): ReadonlySet<number> =>
  new Set(
    set.split(',').flatMap((range) => {
      const [first = 0, last = first] = range.split(':').map(Number);
      return Array.from(
        { length: last - first + 1 },
        (_, index) => first + index,
      );
    }),
  );

const fetchedItems = (query: FetchQueryObject): string =>
  Object.keys(query).join(',');

const fakeClient = (
  folders: ReadonlyArray<ListResponse>,
  messages: MailboxMessages,
  events: Array<string>,
): ImapFlow => {
  let selectedFolder = '';
  return {
    list: () => {
      events.push('list');
      return Promise.resolve([...folders]);
    },
    getMailboxLock: (folder: string) => {
      selectedFolder = folder;
      events.push(`lock:${folder}`);
      return Promise.resolve({
        release: () => events.push(`release:${folder}`),
      });
    },
    mailbox: { uidValidity: 111n },
    search: () =>
      Promise.resolve(
        (messages.get(selectedFolder) ?? []).map(({ uid }) => uid),
      ),
    fetch: (set: string, query: FetchQueryObject) => {
      events.push(`fetch:${set} ${fetchedItems(query)}`);
      return (async function* () {
        await Promise.resolve();
        const selectedUids = uidsInSet(set);
        for (const { envelope, ...message } of messages.get(selectedFolder) ??
          []) {
          if (selectedUids.has(message.uid)) {
            yield query.envelope === true ? { ...message, envelope } : message;
          }
        }
      })();
    },
  } as unknown as ImapFlow;
};

const oldUid = 3;
const oldestUid = 4;

// date is when the message arrived; sentAt is its Date header, which copies
// in other folders share.
const message = (
  uid: number,
  date: string,
  messageId: string,
  { emailId, sentAt = date }: { emailId?: string; sentAt?: string } = {},
): FetchMessageObject => ({
  seq: uid,
  uid,
  emailId,
  internalDate: new Date(date),
  envelope: {
    date: new Date(sentAt),
    messageId,
    subject: messageId,
  },
});

describe('searchMailboxes in one folder', () => {
  it('searches an exact folder without listing mailboxes', async () => {
    const events: Array<string> = [];
    const client = fakeClient(
      [],
      new Map([
        ['INBOX', [message(1, '2026-07-13T08:00:00Z', '<one@example.com>')]],
      ]),
      events,
    );
    const hits = await Effect.runPromise(
      searchMailboxes(
        client,
        {
          scope: 'folder',
          folder: 'INBOX',
          query: 'one',
          limit: 20,
        },
        false,
      ),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.hit).toMatchObject({
      folder: 'INBOX',
      uid: 1,
      uidValidity: '111',
    });
    expect(events).toEqual([
      'lock:INBOX',
      'fetch:1 uid,envelope,internalDate',
      'release:INBOX',
    ]);
  });

  it('returns the newest matches by date when UID order differs', async () => {
    // Migrated mail can give the newest messages the lowest UIDs.
    const events: Array<string> = [];
    const client = fakeClient(
      [],
      new Map([
        [
          'INBOX',
          [
            message(1, '2026-09-16T15:23:32Z', '<newest@example.com>'),
            message(2, '2026-09-15T13:01:12Z', '<newer@example.com>'),
            message(oldUid, '2026-04-10T10:11:57Z', '<old@example.com>'),
            message(oldestUid, '2026-03-17T16:37:42Z', '<oldest@example.com>'),
          ],
        ],
      ]),
      events,
    );
    const hits = await Effect.runPromise(
      searchMailboxes(
        client,
        { scope: 'folder', folder: 'INBOX', limit: 2 },
        false,
      ),
    );
    expect(hits.map(({ hit: { uid, subject } }) => ({ uid, subject }))).toEqual(
      [
        { uid: 1, subject: '<newest@example.com>' },
        { uid: 2, subject: '<newer@example.com>' },
      ],
    );
    expect(events).toEqual([
      'lock:INBOX',
      'fetch:1:4 uid,internalDate',
      'fetch:1:2 uid,envelope,internalDate',
      'release:INBOX',
    ]);
  });
});

describe('searchMailboxes across folders', () => {
  it('merges, deduplicates, sorts, and limits fallback folder results', async () => {
    const events: Array<string> = [];
    const folders = [
      listedFolder('INBOX', '\\Inbox'),
      listedFolder('Archive', '\\Archive'),
      listedFolder('Sent', '\\Sent'),
    ];
    const sentUid = 3;
    const client = fakeClient(
      folders,
      new Map([
        ['INBOX', [message(1, '2026-07-12T08:00:00Z', '<same@example.com>')]],
        ['Archive', [message(2, '2026-07-14T08:00:00Z', '<new@example.com>')]],
        [
          'Sent',
          [
            message(sentUid, '2026-07-13T08:00:00Z', '<same@example.com>', {
              sentAt: '2026-07-12T08:00:00Z',
            }),
          ],
        ],
      ]),
      events,
    );
    const hits = await Effect.runPromise(
      searchMailboxes(client, { scope: 'all', query: 'mail', limit: 2 }, false),
    );
    expect(hits.map(({ hit: { folder, uid } }) => ({ folder, uid }))).toEqual([
      { folder: 'Archive', uid: 2 },
      { folder: 'Sent', uid: sentUid },
    ]);
    expect(events).toEqual([
      'list',
      'lock:INBOX',
      'fetch:1 uid,envelope,internalDate',
      'release:INBOX',
      'lock:Archive',
      'fetch:2 uid,envelope,internalDate',
      'release:Archive',
      'lock:Sent',
      `fetch:${sentUid} uid,envelope,internalDate`,
      'release:Sent',
    ]);
  });

  it('preserves case-distinct IMAP email IDs', async () => {
    const folders = [
      listedFolder('INBOX', '\\Inbox'),
      listedFolder('Archive', '\\Archive'),
    ];
    const client = fakeClient(
      folders,
      new Map([
        [
          'INBOX',
          [
            message(1, '2026-07-15T08:00:00Z', '<same@example.com>', {
              emailId: 'ObjectId',
            }),
          ],
        ],
        [
          'Archive',
          [
            message(2, '2026-07-16T08:00:00Z', '<same@example.com>', {
              emailId: 'objectid',
            }),
          ],
        ],
      ]),
      [],
    );

    const hits = await Effect.runPromise(
      searchMailboxes(
        client,
        { scope: 'all', query: 'mail', limit: 20 },
        false,
      ),
    );

    expect(hits.map(({ hit: { uid } }) => uid)).toEqual([2, 1]);
  });
});

describe('searchMailboxes with a reused Message-ID', () => {
  it('keeps different messages in one folder that share a Message-ID', async () => {
    // Some senders reuse one Message-ID for every message, as for invoices.
    const client = fakeClient(
      [listedFolder('INBOX', '\\Inbox'), listedFolder('Archive', '\\Archive')],
      new Map([
        [
          'INBOX',
          [
            message(10, '2026-11-14T12:00:00Z', '<reused@example.com>'),
            message(11, '2026-11-15T12:00:00Z', '<reused@example.com>'),
          ],
        ],
        [
          'Archive',
          [
            message(12, '2026-11-16T12:00:00Z', '<reused@example.com>', {
              sentAt: '2026-11-14T12:00:00Z',
            }),
          ],
        ],
      ]),
      [],
    );

    const hits = await Effect.runPromise(
      searchMailboxes(
        client,
        { scope: 'all', query: 'invoice', limit: 20 },
        false,
      ),
    );

    // Archive uid 12 is a copy of INBOX uid 10, so only one of them is listed.
    expect(hits.map(({ hit: { folder, uid } }) => ({ folder, uid }))).toEqual([
      { folder: 'Archive', uid: 12 },
      { folder: 'INBOX', uid: 11 },
    ]);
  });
});

describe('searchMailboxes when the server rejects the search', () => {
  const rejectingClient = (
    folders: ReadonlyArray<ListResponse>,
    events: Array<string>,
    result: false | undefined = false,
  ): ImapFlow => {
    const client = fakeClient(folders, new Map(), events);
    client.search = (() => Promise.resolve(result)) as ImapFlow['search'];
    client.fetch = () => {
      throw new Error('a rejected search must not fetch');
    };
    return client;
  };

  it.each([false, undefined])(
    'fails instead of reporting no matches (%s)',
    async (result) => {
      const events: Array<string> = [];
      const error = await Effect.runPromise(
        Effect.flip(
          searchMailboxes(
            rejectingClient([], events, result),
            {
              scope: 'folder',
              folder: 'INBOX',
              query: 'missing',
              limit: 20,
            },
            false,
          ),
        ),
      );
      expect(error).toMatchObject({
        _tag: 'ImapError',
        message: 'search INBOX failed: the server rejected the search.',
      });
      expect(events).toEqual(['lock:INBOX', 'release:INBOX']);
    },
  );

  it.each([
    { query: 'André' },
    { from: 'Schönberg' },
    { subject: 'Übersetzung' },
  ])('names the ASCII limit for non-ASCII text (%o)', async (criteria) => {
    const error = await Effect.runPromise(
      Effect.flip(
        searchMailboxes(
          rejectingClient([], []),
          {
            scope: 'folder',
            folder: 'INBOX',
            ...criteria,
            limit: 20,
          },
          false,
        ),
      ),
    );
    expect(error.message).toBe(
      'search INBOX failed: the server rejected the search. Some servers, such as Exchange Online, search only ASCII text. Retry without accented or other non-ASCII characters.',
    );
  });

  it('stops at the first rejected folder', async () => {
    // Exchange Online drops the connection after repeated rejected commands.
    const events: Array<string> = [];
    const client = rejectingClient(
      [listedFolder('INBOX', '\\Inbox'), listedFolder('Sent', '\\Sent')],
      events,
    );
    const error = await Effect.runPromise(
      Effect.flip(
        searchMailboxes(
          client,
          { scope: 'all', query: 'André', limit: 20 },
          false,
        ),
      ),
    );
    expect(error.message).toStartWith(
      'search INBOX failed: the server rejected the search.',
    );
    expect(events).toEqual(['list', 'lock:INBOX', 'release:INBOX']);
  });
});
