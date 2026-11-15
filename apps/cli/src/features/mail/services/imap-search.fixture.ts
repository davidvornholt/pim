import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlow,
  ListResponse,
} from 'imapflow';

type MailboxMessages = ReadonlyMap<string, ReadonlyArray<FetchMessageObject>>;

export const listedFolder = (
  path: string,
  specialUse?: string,
): ListResponse => ({
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

export const fakeClient = (
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

// date is when the message arrived; sentAt is its Date header, which copies
// in other folders share.
export const message = (
  uid: number,
  date: string,
  messageId: string,
  {
    emailId,
    sentAt = date,
    subject = messageId,
    from = 'sender@example.com',
  }: {
    emailId?: string;
    sentAt?: string;
    subject?: string;
    from?: string;
  } = {},
): FetchMessageObject => ({
  seq: uid,
  uid,
  emailId,
  internalDate: new Date(date),
  envelope: {
    date: new Date(sentAt),
    messageId,
    subject,
    from: [{ address: from }],
  },
});
