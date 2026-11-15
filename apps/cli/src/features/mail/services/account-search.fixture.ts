import type { SearchOptions } from '../schemas/mail';
import type { MailboxSearchHit } from './imap-search';
import { copyFingerprint } from './search-copies';

export const searchOptions: SearchOptions = {
  scope: 'all',
  query: 'invoice',
  limit: 2,
};

export const mailboxHit = (
  uid: number,
  messageId: string,
  receivedAt: string,
): MailboxSearchHit => ({
  hit: {
    uid,
    uidValidity: '111',
    folder: 'INBOX',
    from: 'sender@example.com',
    to: 'me@example.com',
    subject: messageId,
    date: receivedAt,
  },
  mailboxCopyKey: messageId,
  // Copies of one message share what the sender wrote, whenever they arrive.
  copyKey: copyFingerprint({
    messageId,
    sentAt: '2026-07-01T08:00:00.000Z',
    subject: messageId,
    from: 'sender@example.com',
  }),
  receivedAt,
});
