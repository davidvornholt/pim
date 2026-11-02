import { Effect } from 'effect';
import type { ListResponse } from 'imapflow';
import type { MailAccount } from '../../../shared/accounts/account';
import { FolderNotFoundError } from '../errors/errors';
import type { SearchLocation } from '../schemas/mail';

const excludedAllMailSpecialUse = new Set([
  '\\Drafts',
  '\\Flagged',
  '\\Junk',
  '\\Trash',
]);

export const isSelectable = (folder: ListResponse): boolean =>
  folder.listed &&
  !folder.flags.has('\\Noselect') &&
  !folder.flags.has('\\NonExistent');

export const samePath = (left: string, right: string): boolean =>
  left === right ||
  (left.toUpperCase() === 'INBOX' && right.toUpperCase() === 'INBOX');

const isSameOrDescendant = (
  folder: ListResponse,
  root: ListResponse,
): boolean => {
  const folderSegments = [...folder.parent, folder.name];
  const rootSegments = [...root.parent, root.name];
  return (
    folderSegments.length >= rootSegments.length &&
    rootSegments.every((segment, index) =>
      index === 0
        ? samePath(folderSegments[index] ?? '', segment)
        : folderSegments[index] === segment,
    )
  );
};

// Exchange, which hosts the mailboxes that sign in with Microsoft, lists every
// mail folder as subscribed unless the user unsubscribed it, and its calendar,
// contacts, tasks, notes, and journal folders as unsubscribed. It returns the
// items of those as "Retrieval using the IMAP4 protocol failed" stubs, so a
// search of every folder skips the unsubscribed ones there.
export const skipsUnsubscribed = ({ mail }: MailAccount): boolean =>
  mail.auth === 'microsoft';

const allMailFolders = (
  folders: ReadonlyArray<ListResponse>,
  skipUnsubscribed: boolean,
): ReadonlyArray<string> => {
  const allFolder = folders.find(
    (folder) => folder.specialUse === '\\All' && isSelectable(folder),
  );
  if (allFolder !== undefined) {
    return [allFolder.path];
  }
  const excludedRoots = folders.filter((folder) =>
    excludedAllMailSpecialUse.has(folder.specialUse ?? ''),
  );
  return folders
    .filter(
      (folder) =>
        isSelectable(folder) &&
        (folder.subscribed === true || !skipUnsubscribed) &&
        !excludedRoots.some((root) => isSameOrDescendant(folder, root)),
    )
    .map((folder) => folder.path);
};

const subtreeFolders = (
  folders: ReadonlyArray<ListResponse>,
  requestedPath: string,
): Effect.Effect<ReadonlyArray<string>, FolderNotFoundError> => {
  const root = folders.find((folder) => samePath(folder.path, requestedPath));
  if (root === undefined) {
    return Effect.fail(
      new FolderNotFoundError({
        folder: requestedPath,
        message: `Folder "${requestedPath}" was not found.`,
      }),
    );
  }
  return Effect.succeed(
    folders
      .filter(
        (folder) => isSelectable(folder) && isSameOrDescendant(folder, root),
      )
      .map((folder) => folder.path),
  );
};

export const selectSearchFolders = (
  folders: ReadonlyArray<ListResponse>,
  location: Exclude<SearchLocation, { readonly scope: 'folder' }>,
  skipUnsubscribed: boolean,
): Effect.Effect<ReadonlyArray<string>, FolderNotFoundError> =>
  location.scope === 'all'
    ? Effect.succeed(allMailFolders(folders, skipUnsubscribed))
    : subtreeFolders(folders, location.folder);
