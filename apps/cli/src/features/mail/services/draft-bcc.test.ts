import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Account } from '../../../shared/accounts/account';
import type { UpdateDraftInput } from '../schemas/mail';
import { replaceDraft } from './draft';

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
const existingBcc = 'hidden@example.com';
const reindexedUidValidity = 222n;
const draftSource = Buffer.from(
  [
    'From: sender@example.com',
    'To: recipient@example.com',
    `Bcc: ${existingBcc}`,
    'Subject: Original',
    '',
    'Original body',
  ].join('\r\n'),
);
const draftFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: null, subscribed: true },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', subscribed: true },
];
const input: UpdateDraftInput = {
  account: account.email,
  folder: 'Drafts',
  uid: 7,
  uidValidity: '111',
  to: 'recipient@example.com',
  subject: 'Updated',
  text: 'Updated body',
};

const clientWith = (appended: Array<Buffer>, uidValidity = 111n): ImapFlow =>
  ({
    capabilities: new Map([['UIDPLUS', true]]),
    enabled: new Set(),
    list: () => Promise.resolve(draftFolders),
    append: (_folder: string, raw: Buffer) => {
      appended.push(raw);
      return Promise.resolve({ uid: 42, uidValidity: 111n });
    },
    getMailboxLock: () => Promise.resolve({ release: () => undefined }),
    mailbox: { uidValidity },
    fetchOne: () => Promise.resolve({ uid: input.uid, source: draftSource }),
    messageDelete: () => Promise.resolve(true),
  }) as unknown as ImapFlow;

const parseReplacement = async (update: UpdateDraftInput) => {
  const appended: Array<Buffer> = [];
  await Effect.runPromise(replaceDraft(clientWith(appended), account, update));
  const [raw] = appended;
  if (raw === undefined) {
    throw new Error('expected one appended draft');
  }
  return await simpleParser(raw);
};

describe('draft Bcc lifecycle', () => {
  it('preserves existing Bcc recipients when an update omits bcc', async () => {
    const parsed = await parseReplacement(input);
    const parsedBcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;

    expect(parsedBcc?.text).toBe(existingBcc);
  });

  it('removes existing Bcc recipients when an update passes an empty bcc', async () => {
    const parsed = await parseReplacement({ ...input, bcc: '' });

    expect(parsed.bcc).toBeUndefined();
  });

  it('does not append a replacement for a stale draft handle', async () => {
    const appended: Array<Buffer> = [];
    const error = await Effect.runPromise(
      Effect.flip(
        replaceDraft(
          clientWith(appended, reindexedUidValidity),
          account,
          input,
        ),
      ),
    );

    expect(error._tag).toBe('StaleUidError');
    expect(appended).toHaveLength(0);
  });

  it('keeps replacement and deletion under one mailbox lock', async () => {
    const events: Array<string> = [];
    const mailbox = { uidValidity: 111n };
    const client = {
      capabilities: new Map([['UIDPLUS', true]]),
      enabled: new Set(),
      list: () => Promise.resolve(draftFolders),
      getMailboxLock: () => {
        events.push('lock');
        return Promise.resolve({
          release: () => {
            events.push('release');
            mailbox.uidValidity = reindexedUidValidity;
          },
        });
      },
      mailbox,
      fetchOne: () => {
        events.push('fetch');
        return Promise.resolve({ uid: input.uid, source: draftSource });
      },
      append: () => {
        events.push('append');
        return Promise.resolve({ uid: 42, uidValidity: 111n });
      },
      messageDelete: () => {
        events.push('delete');
        return Promise.resolve(true);
      },
    } as unknown as ImapFlow;

    await Effect.runPromise(
      replaceDraft(client, account, { ...input, uidValidity: '111' }),
    );

    expect(events).toEqual([
      'lock',
      'fetch',
      'append',
      'fetch',
      'delete',
      'release',
    ]);
  });
});
