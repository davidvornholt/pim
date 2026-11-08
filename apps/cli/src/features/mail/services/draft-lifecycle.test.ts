import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import type { Account } from '../../../shared/accounts/account';
import { removeDraft, replaceDraft } from './draft';

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

const draftFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: null, subscribed: true },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', subscribed: true },
];

const targetUid = 7;
const uidValidity = '111';
const draftHandle = (uid: number) => ({
  account: account.email,
  folder: 'Drafts',
  uid,
  uidValidity,
});
const draftSource = Buffer.from(
  'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Original\r\n\r\nOriginal body',
);

describe('replaceDraft', () => {
  const fakeClient = (
    events: Array<string>,
    options: { readonly deleteResult?: boolean } = {},
  ): ImapFlow =>
    ({
      capabilities: new Map([['UIDPLUS', true]]),
      enabled: new Set(),
      list: () => Promise.resolve(draftFolders),
      append: (_folder: string, _raw: Buffer, flags: ReadonlyArray<string>) => {
        events.push(`append:${[...flags].join(',')}`);
        return Promise.resolve({ uid: 42, uidValidity: 111n });
      },
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      mailbox: { uidValidity: 111n },
      fetchOne: () =>
        Promise.resolve({
          uid: targetUid,
          source: draftSource,
        }),
      messageDelete: () => {
        events.push('delete');
        return Promise.resolve(options.deleteResult ?? true);
      },
    }) as unknown as ImapFlow;

  const input = {
    ...draftHandle(targetUid),
    to: 'recipient@example.com',
    subject: 'Updated',
    text: 'Updated body',
  };

  it('appends a \\Seen replacement before deleting the old draft and returns its uidValidity', async () => {
    const events: Array<string> = [];
    const location = await Effect.runPromise(
      replaceDraft(fakeClient(events), account, input),
    );

    expect(events).toEqual(['append:\\Draft,\\Seen', 'delete']);
    expect(location).toEqual({ folder: 'Drafts', uid: 42, uidValidity: '111' });
  });

  it('keeps the appended replacement and reports its uid when the delete fails', async () => {
    const events: Array<string> = [];
    const error = await Effect.runPromise(
      Effect.flip(
        replaceDraft(
          fakeClient(events, { deleteResult: false }),
          account,
          input,
        ),
      ),
    );

    expect(events).toContain('append:\\Draft,\\Seen');
    expect(error._tag).toBe('ImapError');
    expect(error.message).toContain('saved as uid 42');
  });

  it('fails without deleting the original when imapflow reports that nothing was appended', async () => {
    const events: Array<string> = [];
    const client = {
      ...fakeClient(events),
      append: () => {
        events.push('append');
        return Promise.resolve(false);
      },
    } as unknown as ImapFlow;

    const error = await Effect.runPromise(
      Effect.flip(replaceDraft(client, account, input)),
    );

    expect(error._tag).toBe('ImapError');
    expect(events).toEqual(['append']);
  });

  it('maps a non-UIDPLUS append with no uid/uidValidity to null handles', async () => {
    const client = {
      capabilities: new Map([['UIDPLUS', true]]),
      enabled: new Set(),
      list: () => Promise.resolve(draftFolders),
      append: () => Promise.resolve({ destination: 'Drafts' }),
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      mailbox: { uidValidity: 111n },
      fetchOne: () =>
        Promise.resolve({
          uid: targetUid,
          source: draftSource,
        }),
      messageDelete: () => Promise.resolve(true),
    } as unknown as ImapFlow;

    const location = await Effect.runPromise(
      replaceDraft(client, account, input),
    );

    expect(location).toEqual({
      folder: 'Drafts',
      uid: null,
      uidValidity: null,
    });
  });
});

describe('removeDraft', () => {
  it.each([false, undefined])(
    'fails without deleting and releases the lock when the target draft is missing (%s)',
    async (missing) => {
      const events: Array<string> = [];
      const client = {
        capabilities: new Map([['UIDPLUS', true]]),
        enabled: new Set(),
        list: () => Promise.resolve(draftFolders),
        getMailboxLock: () =>
          Promise.resolve({ release: () => events.push('release') }),
        mailbox: { uidValidity: 111n },
        fetchOne: () => Promise.resolve(missing),
        messageDelete: () => {
          events.push('delete');
          return Promise.resolve(true);
        },
      } as unknown as ImapFlow;

      const missingUid = 999;
      const error = await Effect.runPromise(
        Effect.flip(removeDraft(client, draftHandle(missingUid))),
      );

      expect(error._tag).toBe('MessageNotFoundError');
      expect(events).toEqual(['release']);
    },
  );

  it('refuses to expunge, without deleting, when the folder uidValidity no longer matches the handle', async () => {
    const events: Array<string> = [];
    const client = {
      capabilities: new Map([['UIDPLUS', true]]),
      enabled: new Set(),
      list: () => Promise.resolve(draftFolders),
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      mailbox: { uidValidity: 222n },
      fetchOne: () => Promise.resolve({ uid: targetUid }),
      messageDelete: () => {
        events.push('delete');
        return Promise.resolve(true);
      },
    } as unknown as ImapFlow;

    const error = await Effect.runPromise(
      Effect.flip(removeDraft(client, draftHandle(targetUid))),
    );

    expect(error._tag).toBe('StaleUidError');
    expect(events).toEqual([]);
  });

  it('expunges when the folder uidValidity still matches the handle', async () => {
    const events: Array<string> = [];
    const client = {
      capabilities: new Map([['UIDPLUS', true]]),
      enabled: new Set(),
      list: () => Promise.resolve(draftFolders),
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      mailbox: { uidValidity: 111n },
      fetchOne: () => Promise.resolve({ uid: targetUid }),
      messageDelete: () => {
        events.push('delete');
        return Promise.resolve(true);
      },
    } as unknown as ImapFlow;

    await Effect.runPromise(removeDraft(client, draftHandle(targetUid)));

    expect(events).toEqual(['delete']);
  });
});

describe('draft deletion on a server without UID EXPUNGE', () => {
  // Without UIDPLUS, imapflow's messageDelete ends in a plain EXPUNGE, which
  // also removes every other message marked \Deleted in the drafts folder.
  const clientWithout = (
    events: Array<string>,
    capabilities: ReadonlyArray<string>,
    enabled: ReadonlyArray<string> = [],
  ): ImapFlow =>
    ({
      capabilities: new Map(capabilities.map((name) => [name, true])),
      enabled: new Set(enabled),
      list: () => Promise.resolve(draftFolders),
      append: () => {
        events.push('append');
        return Promise.resolve({ uid: 42, uidValidity: 111n });
      },
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      mailbox: { uidValidity: 111n },
      fetchOne: () => Promise.resolve({ uid: targetUid, source: draftSource }),
      messageDelete: () => {
        events.push('delete');
        return Promise.resolve(true);
      },
    }) as unknown as ImapFlow;

  const replacement = {
    ...draftHandle(targetUid),
    to: 'recipient@example.com',
    subject: 'Updated',
    text: 'Updated body',
  };
  const operations = [
    [
      'removeDraft',
      (client: ImapFlow) => removeDraft(client, draftHandle(targetUid)),
    ],
    [
      'replaceDraft',
      (client: ImapFlow) => replaceDraft(client, account, replacement),
    ],
  ] as const;

  it.each(operations)(
    '%s refuses before writing anything when the server lacks UIDPLUS, even with MOVE',
    async (_name, operation) => {
      const events: Array<string> = [];
      const error = await Effect.runPromise(
        Effect.flip(operation(clientWithout(events, ['IMAP4rev1', 'MOVE']))),
      );

      expect(error._tag).toBe('DraftError');
      expect(error.message).toContain('UIDPLUS');
      expect(events).toEqual([]);
    },
  );

  it.each(operations)(
    '%s deletes on an IMAP4rev2 session, which always has UID EXPUNGE',
    async (_name, operation) => {
      const events: Array<string> = [];
      await Effect.runPromise(
        operation(
          clientWithout(events, ['IMAP4rev1', 'IMAP4rev2'], ['IMAP4REV2']),
        ),
      );

      expect(events).toContain('delete');
    },
  );
});
