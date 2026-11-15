import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow, ListResponse } from 'imapflow';
import { searchMailboxes } from './imap-search';
import { fakeClient, listedFolder, message } from './imap-search.fixture';

const oldUid = 3;
const oldestUid = 4;

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
