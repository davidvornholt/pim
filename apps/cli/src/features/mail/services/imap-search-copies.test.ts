import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { FetchMessageObject } from 'imapflow';
import { searchMailboxes } from './imap-search';
import { fakeClient, listedFolder, message } from './imap-search.fixture';

describe('searchMailboxes with identical headers', () => {
  const searchInboxAndArchive = (
    inbox: ReadonlyArray<FetchMessageObject>,
    archive: ReadonlyArray<FetchMessageObject>,
  ) =>
    Effect.runPromise(
      searchMailboxes(
        fakeClient(
          [
            listedFolder('INBOX', '\\Inbox'),
            listedFolder('Archive', '\\Archive'),
          ],
          new Map([
            ['INBOX', inbox],
            ['Archive', archive],
          ]),
          [],
        ),
        { scope: 'all', query: 'invoice', limit: 20 },
        false,
      ),
    );
  const sentAt = '2026-11-14T12:00:00Z';

  it('keeps every message of one folder that shares headers with a copy elsewhere', async () => {
    const hits = await searchInboxAndArchive(
      [
        message(10, '2026-11-14T12:00:00Z', '<reused@example.com>', { sentAt }),
        message(11, '2026-11-15T12:00:00Z', '<reused@example.com>', { sentAt }),
      ],
      [message(12, '2026-11-16T12:00:00Z', '<reused@example.com>', { sentAt })],
    );

    // Archive uid 12 copies one of the INBOX messages, but nothing tells which,
    // so dropping either could hide the other.
    expect(hits.map(({ hit: { folder, uid } }) => ({ folder, uid }))).toEqual([
      { folder: 'Archive', uid: 12 },
      { folder: 'INBOX', uid: 11 },
      { folder: 'INBOX', uid: 10 },
    ]);
  });

  it('keeps messages in different folders whose subject or sender differs', async () => {
    const differentSubject = await searchInboxAndArchive(
      [message(1, sentAt, '<reused@example.com>', { subject: 'Invoice 1' })],
      [message(2, sentAt, '<reused@example.com>', { subject: 'Invoice 2' })],
    );
    const differentSender = await searchInboxAndArchive(
      [message(1, sentAt, '<reused@example.com>', { from: 'a@example.com' })],
      [message(2, sentAt, '<reused@example.com>', { from: 'b@example.com' })],
    );

    expect(differentSubject.map(({ hit: { uid } }) => uid)).toEqual([2, 1]);
    expect(differentSender.map(({ hit: { uid } }) => uid)).toEqual([2, 1]);
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
