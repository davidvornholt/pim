import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { readAttachment } from './attachment';

const messageUid = 42;
const inboxMessage = { folder: 'INBOX', uid: messageUid, uidValidity: '111' };
const attachmentPart = '2';
const pdfContent = 'pdf bytes';
const largeSize = 50_000_000;
const attachmentStructure: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: attachmentPart,
      type: 'application/pdf',
      encoding: 'base64',
      disposition: 'attachment',
      dispositionParameters: { filename: 'invoice.pdf' },
      size: largeSize,
    },
  ],
};

const mailboxLock = (released: { value: boolean }) => () =>
  Promise.resolve({
    release: () => {
      released.value = true;
    },
  });

describe('readAttachment', () => {
  it('downloads only the selected decoded body part, whatever its size', async () => {
    const released = { value: false };
    const calls: Array<ReadonlyArray<unknown>> = [];
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: mailboxLock(released),
      fetchOne: () =>
        Promise.resolve({
          uid: messageUid,
          bodyStructure: attachmentStructure,
        }),
      download: (...args: ReadonlyArray<unknown>) => {
        calls.push(args);
        return Promise.resolve({
          meta: {
            expectedSize: 10_000_000,
            contentType: 'application/pdf',
            filename: 'invoice.pdf',
          },
          content: new Blob([pdfContent]).stream(),
        });
      },
    } as unknown as ImapFlow;

    const result = await Effect.runPromise(
      readAttachment(client, inboxMessage, attachmentPart),
    );

    expect(calls).toEqual([
      [String(messageUid), attachmentPart, { uid: true }],
    ]);
    expect(Buffer.from(result.content).toString()).toBe(pdfContent);
    expect(result.size).toBe(Buffer.byteLength(pdfContent));
    expect(released.value).toBe(true);
  });

  it('rejects an unknown part before downloading', async () => {
    let downloads = 0;
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: mailboxLock({ value: false }),
      fetchOne: () =>
        Promise.resolve({
          uid: messageUid,
          bodyStructure: attachmentStructure,
        }),
      download: () => {
        downloads += 1;
        return Promise.resolve({});
      },
    } as unknown as ImapFlow;

    const missing = await Effect.runPromise(
      Effect.flip(readAttachment(client, inboxMessage, '9')),
    );

    expect(missing._tag).toBe('AttachmentNotFoundError');
    expect(downloads).toBe(0);
  });
});

describe('readAttachment download results', () => {
  it('reports a missing attachment when ImapFlow returns no download', async () => {
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: mailboxLock({ value: false }),
      fetchOne: () =>
        Promise.resolve({
          uid: messageUid,
          bodyStructure: attachmentStructure,
        }),
      download: () => Promise.resolve({}),
    } as unknown as ImapFlow;

    const error = await Effect.runPromise(
      Effect.flip(readAttachment(client, inboxMessage, attachmentPart)),
    );

    expect(error._tag).toBe('AttachmentNotFoundError');
  });

  it('keeps the BODYSTRUCTURE type when downloaded MIME headers omit it', async () => {
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: mailboxLock({ value: false }),
      fetchOne: () =>
        Promise.resolve({
          uid: messageUid,
          bodyStructure: attachmentStructure,
        }),
      download: () =>
        Promise.resolve({
          meta: { expectedSize: Buffer.byteLength(pdfContent) },
          content: new Blob([pdfContent]).stream(),
        }),
    } as unknown as ImapFlow;

    const result = await Effect.runPromise(
      readAttachment(client, inboxMessage, attachmentPart),
    );

    expect(result.contentType).toBe('application/pdf');
  });
});

it.each([false, undefined])(
  'handles a vanished attachment message (%s) and releases its lock',
  async (missing) => {
    const released = { value: false };
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: mailboxLock(released),
      fetchOne: () => Promise.resolve(missing),
      download: () => {
        throw new Error('missing message must not download');
      },
    } as unknown as ImapFlow;
    const result = await Effect.runPromise(
      Effect.result(readAttachment(client, inboxMessage, attachmentPart)),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'MessageNotFoundError' },
    });
    expect(released.value).toBe(true);
  },
);

describe('readAttachment stale handles', () => {
  it('refuses to download from a message after its folder was rebuilt', async () => {
    const released = { value: false };
    let fetched = false;
    const client = {
      mailbox: { uidValidity: 222n },
      getMailboxLock: mailboxLock(released),
      fetchOne: () => {
        fetched = true;
        return Promise.resolve(false);
      },
    } as unknown as ImapFlow;
    const error = await Effect.runPromise(
      Effect.flip(readAttachment(client, inboxMessage, attachmentPart)),
    );
    expect(error._tag).toBe('StaleUidError');
    expect(fetched).toBe(false);
    expect(released.value).toBe(true);
  });
});
