import type { ImapFlow } from 'imapflow';

// Without UIDPLUS, imapflow ends every expunge in a plain EXPUNGE, which also
// removes every other message marked \Deleted in the folder. IMAP4rev2
// includes UIDPLUS.
export const canExpungeByUid = (client: ImapFlow): boolean =>
  client.capabilities.has('UIDPLUS') ||
  client.enabled.has('IMAP4REV2') ||
  (client.capabilities.has('IMAP4rev2') &&
    !client.capabilities.has('IMAP4rev1'));
