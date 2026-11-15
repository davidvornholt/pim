import { expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Account } from '../../../shared/accounts/account';
import { replaceDraft, writeDraft } from './draft';

const account: Account = {
  email: 'sender@example.com',
  name: 'Example Sender',
  mail: {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: 'sender@example.com',
    auth: 'password',
  },
};

const folders = [
  { path: 'INBOX', name: 'INBOX', specialUse: null, subscribed: true },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', subscribed: true },
];

const replySource = Buffer.from(
  [
    'From: Original Sender <original@example.com>',
    'To: sender@example.com',
    'Subject: Question',
    'Date: Mon, 13 Jul 2026 08:30:00 +0000',
    'Message-ID: <current@example.com>',
    'References: <first@example.com>',
    '',
    'Original body',
  ].join('\r\n'),
);

it('fails instead of reporting a saved draft when imapflow reports that nothing was appended', async () => {
  const client = {
    list: () => Promise.resolve(folders),
    append: () => Promise.resolve(false),
  } as unknown as ImapFlow;

  const error = await Effect.runPromise(
    Effect.flip(
      writeDraft(client, account, {
        account: account.email,
        to: 'original@example.com',
        subject: 'New thread',
        text: 'Fresh message.',
      }),
    ),
  );

  expect(error._tag).toBe('ImapError');
});

it('adds no threading headers without a reply source', async () => {
  const appended: Array<Buffer> = [];
  const client = {
    list: () => Promise.resolve(folders),
    append: (_folder: string, raw: Buffer) => {
      appended.push(raw);
      return Promise.resolve({ uid: 7, uidValidity: 111n });
    },
  } as unknown as ImapFlow;

  await Effect.runPromise(
    writeDraft(client, account, {
      account: account.email,
      to: 'original@example.com',
      subject: 'New thread',
      text: 'Fresh message.',
    }),
  );

  const [appendedRaw] = appended;
  if (appendedRaw === undefined) {
    throw new Error('expected one appended draft');
  }
  const parsed = await simpleParser(appendedRaw);
  expect(parsed.inReplyTo).toBeUndefined();
  expect(parsed.references).toBeUndefined();
});

it('fetches and quotes the reply source before appending the draft', async () => {
  const appended: Array<Buffer> = [];
  const client = {
    list: () => Promise.resolve(folders),
    mailbox: { uidValidity: 111n },
    getMailboxLock: () => Promise.resolve({ release: () => undefined }),
    fetchOne: () => Promise.resolve({ uid: 42, source: replySource }),
    append: (_folder: string, raw: Buffer) => {
      appended.push(raw);
      return Promise.resolve({ uid: 7, uidValidity: 111n });
    },
  } as unknown as ImapFlow;

  await Effect.runPromise(
    writeDraft(client, account, {
      account: account.email,
      to: 'original@example.com',
      subject: 'Re: Question',
      text: 'My answer.',
      replySource: { folder: 'INBOX', uid: 42, uidValidity: '111' },
    }),
  );

  expect(appended).toHaveLength(1);
  const [appendedRaw] = appended;
  if (appendedRaw === undefined) {
    return;
  }
  const parsed = await simpleParser(appendedRaw);
  expect(parsed.text).toContain('> Original body');
  expect(parsed.inReplyTo).toBe('<current@example.com>');
  expect(parsed.references).toEqual([
    '<first@example.com>',
    '<current@example.com>',
  ]);
});

it('does not append when the reply source no longer exists', async () => {
  let appendCalls = 0;
  const client = {
    list: () => Promise.resolve(folders),
    mailbox: { uidValidity: 111n },
    getMailboxLock: () => Promise.resolve({ release: () => undefined }),
    fetchOne: () => Promise.resolve(false),
    append: () => {
      appendCalls += 1;
      return Promise.resolve({ uid: 7 });
    },
  } as unknown as ImapFlow;

  const error = await Effect.runPromise(
    Effect.flip(
      writeDraft(client, account, {
        account: account.email,
        to: 'original@example.com',
        subject: 'Re: Question',
        text: 'My answer.',
        replySource: { folder: 'INBOX', uid: 999, uidValidity: '111' },
      }),
    ),
  );

  expect(error._tag).toBe('MessageNotFoundError');
  expect(appendCalls).toBe(0);
});

// Selecting a folder sets client.mailbox, as imapflow does when it takes the
// mailbox lock, so each folder reports its own UIDVALIDITY.
const rebuiltInboxClient = (appended: Array<Buffer>) => {
  const uidValidities = new Map([
    ['INBOX', 222n],
    ['Drafts', 333n],
  ]);
  const client = {
    capabilities: new Map([['UIDPLUS', true]]),
    enabled: new Set(),
    mailbox: false as false | { path: string; uidValidity: bigint },
    list: () => Promise.resolve(folders),
    getMailboxLock: (folder: string) => {
      client.mailbox = {
        path: folder,
        uidValidity: uidValidities.get(folder) ?? 1n,
      };
      return Promise.resolve({ release: () => undefined });
    },
    // After the rebuild, uid 42 names someone else's message.
    fetchOne: () =>
      Promise.resolve({
        uid: 42,
        source: Buffer.from(
          'From: Other Person <other@example.com>\r\nSubject: Unrelated\r\nMessage-ID: <unrelated@example.com>\r\n\r\nUnrelated private body',
        ),
      }),
    append: (_folder: string, raw: Buffer) => {
      appended.push(raw);
      return Promise.resolve({ uid: 8, uidValidity: 333n });
    },
    messageDelete: () => Promise.resolve(true),
  };
  return client as unknown as ImapFlow;
};

const staleReply = {
  account: account.email,
  to: 'original@example.com',
  subject: 'Re: Question',
  text: 'My answer.',
  replySource: { folder: 'INBOX', uid: 42, uidValidity: '111' },
};

it('refuses to save a reply whose source folder was rebuilt since the search', async () => {
  const appended: Array<Buffer> = [];
  const error = await Effect.runPromise(
    Effect.flip(writeDraft(rebuiltInboxClient(appended), account, staleReply)),
  );

  expect(error._tag).toBe('StaleUidError');
  expect(error.message).toContain('uidValidity 111 → 222');
  expect(appended).toHaveLength(0);
});

it('updates a reply that quotes its source when the source folder is unchanged', async () => {
  const appended: Array<Buffer> = [];
  await Effect.runPromise(
    replaceDraft(rebuiltInboxClient(appended), account, {
      ...staleReply,
      replySource: { folder: 'INBOX', uid: 42, uidValidity: '222' },
      folder: 'Drafts',
      uid: 7,
      uidValidity: '333',
    }),
  );

  const [appendedRaw] = appended;
  if (appendedRaw === undefined) {
    throw new Error('expected one appended draft');
  }
  const parsed = await simpleParser(appendedRaw);
  expect(parsed.text).toContain('> Unrelated private body');
  expect(parsed.inReplyTo).toBe('<unrelated@example.com>');
});

it('refuses to update a reply whose source folder was rebuilt since the search', async () => {
  const appended: Array<Buffer> = [];
  const error = await Effect.runPromise(
    Effect.flip(
      replaceDraft(rebuiltInboxClient(appended), account, {
        ...staleReply,
        folder: 'Drafts',
        uid: 7,
        uidValidity: '333',
      }),
    ),
  );

  expect(error._tag).toBe('StaleUidError');
  expect(appended).toHaveLength(0);
});
