import { Effect, Stream } from 'effect';
import type { FetchMessageObject, FetchQueryObject, ImapFlow } from 'imapflow';
import { ImapError } from '../errors/errors';
import type { SearchHit, SearchOptions } from '../schemas/mail';
import { imapError, listMailboxes } from './imap-ops';
import { buildSearchQuery } from './imap-query';
import { uidSets } from './imap-uid-sets';
import { lockMailbox } from './mailbox-lock';
import { copyFingerprint, withoutCopies } from './search-copies';
import { selectSearchFolders } from './search-folders';

export type MailboxSearchHit = {
  readonly hit: Omit<SearchHit, 'account'>;
  // Matches the hit's copies in other folders of the account.
  readonly mailboxCopyKey: string;
  // Matches the hit's copies in other accounts.
  readonly copyKey: string;
  readonly receivedAt: string;
};

const joinAddresses = (
  list: ReadonlyArray<{ readonly address?: string }> | undefined,
): string =>
  (list ?? [])
    .map((entry) => entry.address)
    .filter((address): address is string => address !== undefined)
    .join(', ');

const toIsoDate = (value: Date | string | undefined): string =>
  value instanceof Date ? value.toISOString() : (value ?? '');

const toCandidate = (
  message: FetchMessageObject,
  folder: string,
  uidValidity: string,
): MailboxSearchHit => {
  const { envelope } = message;
  const from = joinAddresses(envelope?.from);
  const subject = envelope?.subject ?? '';
  const copyKey = copyFingerprint({
    messageId: envelope?.messageId ?? '',
    sentAt: toIsoDate(envelope?.date),
    subject,
    from,
  });
  return {
    hit: {
      uid: message.uid,
      uidValidity,
      folder,
      from,
      to: joinAddresses(envelope?.to),
      subject,
      date: toIsoDate(envelope?.date ?? message.internalDate),
    },
    mailboxCopyKey: message.emailId ?? copyKey,
    copyKey,
    receivedAt: toIsoDate(message.internalDate ?? envelope?.date),
  };
};

type DatedUid = {
  readonly uid: number;
  readonly receivedAt: string;
};

const newestUidFirst = (left: DatedUid, right: DatedUid): number =>
  right.receivedAt.localeCompare(left.receivedAt) || right.uid - left.uid;

// Fetch one UID set at a time, so no command line grows with the match count.
const fetchByUid = (
  client: ImapFlow,
  uids: ReadonlyArray<number>,
  query: FetchQueryObject,
  label: string,
): Effect.Effect<ReadonlyArray<FetchMessageObject>, ImapError> =>
  Stream.fromIterable(uidSets(uids)).pipe(
    Stream.flatMap((set) =>
      Stream.fromAsyncIterable(
        client.fetch(set, query, { uid: true }),
        imapError(label),
      ),
    ),
    Stream.runCollect,
  );

// UID order is not date order: migrated, appended, and moved messages get new
// UIDs whatever their date. When a folder has more matches than the limit,
// fetch only the internal date of every match and keep the newest. Exchange
// Online and Gmail do not support IMAP SORT, so the client ranks.
const newestUids = (
  client: ImapFlow,
  folder: string,
  uids: ReadonlyArray<number>,
  limit: number,
): Effect.Effect<ReadonlyArray<number>, ImapError> =>
  uids.length <= limit
    ? Effect.succeed(uids)
    : fetchByUid(
        client,
        uids,
        { uid: true, internalDate: true },
        `fetch dates of search results from ${folder}`,
      ).pipe(
        Effect.map((messages) =>
          messages
            .map(({ uid, internalDate }) => ({
              uid,
              receivedAt: toIsoDate(internalDate),
            }))
            .sort(newestUidFirst)
            .slice(0, limit)
            .map(({ uid }) => uid),
        ),
      );

const nonAsciiText = /\P{ASCII}/u;

// imapflow resolves a search the server rejected to false instead of throwing.
// Exchange Online rejects non-ASCII search text: it answers BAD to the quoted
// UTF-8 string imapflow sends, and NO [BADCHARSET (US-ASCII)] to a literal.
const rejectedSearchMessage = (
  folder: string,
  options: SearchOptions,
): string => {
  const hasNonAsciiText = [options.query, options.from, options.subject].some(
    (text) => text !== undefined && nonAsciiText.test(text),
  );
  const hint = hasNonAsciiText
    ? ' Some servers, such as Exchange Online, search only ASCII text. Retry without accented or other non-ASCII characters.'
    : '';
  return `search ${folder} failed: the server rejected the search.${hint}`;
};

const searchOneFolder = (
  client: ImapFlow,
  folder: string,
  options: SearchOptions,
): Effect.Effect<ReadonlyArray<MailboxSearchHit>, ImapError> =>
  Effect.gen(function* () {
    yield* lockMailbox(client, folder);
    const uidValidity =
      client.mailbox === false
        ? yield* Effect.fail(
            new ImapError({
              message: `search ${folder} failed: UIDVALIDITY is unavailable after selecting the mailbox`,
            }),
          )
        : client.mailbox.uidValidity.toString();
    const found = yield* Effect.tryPromise({
      try: () => client.search(buildSearchQuery(options), { uid: true }),
      catch: imapError(`search ${folder}`),
    });
    const uids =
      found === false || found === undefined
        ? yield* Effect.fail(
            new ImapError({ message: rejectedSearchMessage(folder, options) }),
          )
        : found;
    if (uids.length === 0) {
      return [];
    }
    const selected = yield* newestUids(client, folder, uids, options.limit);
    const messages = yield* fetchByUid(
      client,
      selected,
      { uid: true, envelope: true, internalDate: true },
      `fetch search results from ${folder}`,
    );
    return messages.map((message) => toCandidate(message, folder, uidValidity));
  }).pipe(Effect.scoped);

const newestFirst = (left: MailboxSearchHit, right: MailboxSearchHit): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  right.hit.uid - left.hit.uid ||
  left.hit.folder.localeCompare(right.hit.folder);

const foldersForSearch = (
  client: ImapFlow,
  options: SearchOptions,
  skipUnsubscribed: boolean,
) =>
  options.scope === 'folder'
    ? Effect.succeed([options.folder])
    : Effect.flatMap(listMailboxes(client), (folders) =>
        selectSearchFolders(folders, options, skipUnsubscribed),
      );

export const searchMailboxes = (
  client: ImapFlow,
  options: SearchOptions,
  skipUnsubscribed: boolean,
) =>
  Effect.gen(function* () {
    const folders = yield* foldersForSearch(client, options, skipUnsubscribed);
    const matches = yield* Effect.forEach(folders, (folder) =>
      searchOneFolder(client, folder, options),
    );
    const sorted = matches.flat().sort(newestFirst);
    const candidates =
      options.scope === 'folder'
        ? sorted
        : withoutCopies(
            sorted,
            ({ mailboxCopyKey }) => mailboxCopyKey,
            ({ hit: { folder } }) => folder,
          );
    return candidates.slice(0, options.limit);
  });
