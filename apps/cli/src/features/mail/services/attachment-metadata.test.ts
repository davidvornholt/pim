import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { findAttachment, listAttachments } from './attachment-metadata';
import { readMessage } from './imap-ops';

const structure: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', size: 12 },
        {
          part: '1.2',
          type: 'text/html',
          id: 'root@example.com',
          size: 24,
        },
        {
          part: '1.3',
          type: 'text/calendar',
          parameters: { method: 'REQUEST' },
          size: 900,
        },
      ],
    },
    {
      part: '2',
      type: 'application/pdf',
      parameters: { name: 'fallback.pdf' },
      encoding: 'base64',
      disposition: 'attachment',
      dispositionParameters: { filename: 'invoice.pdf' },
      size: 50_000_000,
    },
    {
      part: '3',
      type: 'image/png',
      id: 'chart@example.com',
      disposition: 'inline',
      size: 456,
    },
    {
      part: '4',
      type: 'message/rfc822',
      disposition: 'attachment',
      dispositionParameters: { filename: 'forwarded.eml' },
      size: 789,
      childNodes: [{ part: '4.1', type: 'text/plain', size: 20 }],
    },
  ],
};

describe('message attachment metadata', () => {
  it('lists file, CID, calendar, and attached-message parts without body alternatives', () => {
    expect(listAttachments(structure)).toEqual([
      {
        part: '1.3',
        filename: null,
        contentType: 'text/calendar',
        size: 900,
        disposition: null,
        contentId: null,
      },
      {
        part: '2',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 50_000_000,
        disposition: 'attachment',
        contentId: null,
      },
      {
        part: '3',
        filename: null,
        contentType: 'image/png',
        size: 456,
        disposition: 'inline',
        contentId: 'chart@example.com',
      },
      {
        part: '4',
        filename: 'forwarded.eml',
        contentType: 'message/rfc822',
        size: 789,
        disposition: 'attachment',
        contentId: null,
      },
    ]);
  });

  it('finds the body of a message that is not multipart as part 1', () => {
    // How imapflow describes a message that is one PDF: without a part.
    const scan: MessageStructureObject = {
      type: 'application/pdf',
      parameters: { name: 'scan.pdf' },
      encoding: 'base64',
      size: 1234,
      disposition: 'attachment',
      dispositionParameters: { filename: 'scan.pdf' },
    };
    const attachment = {
      part: '1',
      filename: 'scan.pdf',
      contentType: 'application/pdf',
      size: 1234,
      disposition: 'attachment',
      contentId: null,
    };

    expect(listAttachments(scan)).toEqual([attachment]);
    expect(findAttachment(scan, '1')).toEqual(attachment);
    expect(listAttachments({ type: 'text/plain', size: 12 })).toEqual([]);
  });

  it('adds attachment metadata when reading a message', async () => {
    const messageUid = 42;
    const inboxMessage = {
      folder: 'INBOX',
      uid: messageUid,
      uidValidity: '111',
    };
    let released = false;
    const client = {
      mailbox: { uidValidity: 111n },
      getMailboxLock: () =>
        Promise.resolve({
          release: () => {
            released = true;
          },
        }),
      fetchOne: () =>
        Promise.resolve({
          uid: messageUid,
          source: Buffer.from(
            ['Subject: Example', '', 'Message body'].join('\r\n'),
          ),
          bodyStructure: structure,
        }),
    } as unknown as ImapFlow;

    const message = await Effect.runPromise(readMessage(client, inboxMessage));

    expect(message.attachments).toEqual(listAttachments(structure));
    expect(released).toBe(true);
  });
});
