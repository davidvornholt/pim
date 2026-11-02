import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { markMessages, moveMessages } from './message-changes';

const account = 'test@example.com';
const uidValidity = '111';

type Folder = {
  readonly path: string;
  readonly specialUse?: string;
  readonly noselect?: boolean;
};

const defaultFolders: ReadonlyArray<Folder> = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: 'INBOX.GitHub' },
  { path: 'Archive', noselect: true },
  { path: 'Trash', specialUse: '\\Trash' },
];

type ClientOptions = {
  readonly folders?: ReadonlyArray<Folder>;
  readonly found?: ReadonlyArray<number>;
  readonly uidValidity?: bigint;
  readonly result?: false;
};

// Records each mailbox lock and change as an event.
const fakeClient = (
  events: Array<string>,
  options: ClientOptions = {},
): ImapFlow =>
  ({
    list: () =>
      Promise.resolve(
        (options.folders ?? defaultFolders).map((folder) => ({
          path: folder.path,
          name: folder.path.split('.').at(-1),
          specialUse: folder.specialUse,
          listed: true,
          flags: new Set(folder.noselect === true ? ['\\Noselect'] : []),
        })),
      ),
    getMailboxLock: (folder: string) => {
      events.push(`lock:${folder}`);
      return Promise.resolve({ release: () => undefined });
    },
    mailbox: { uidValidity: options.uidValidity ?? BigInt(uidValidity) },
    fetchAll: (uids: ReadonlyArray<number>) =>
      Promise.resolve(
        (options.found ?? uids).map((uid) => ({ uid, flags: new Set() })),
      ),
    messageMove: (uids: ReadonlyArray<number>, destination: string) => {
      events.push(`move:${uids.join(',')}:${destination}`);
      return Promise.resolve(
        options.result ?? {
          path: 'INBOX',
          destination,
          uidValidity: 222n,
          uidMap: new Map(uids.map((uid) => [uid, uid + 100])),
        },
      );
    },
    messageFlagsAdd: (uids: ReadonlyArray<number>, flags: Array<string>) => {
      events.push(`add:${uids.join(',')}:${flags.join(',')}`);
      return Promise.resolve(options.result ?? true);
    },
    messageFlagsRemove: (uids: ReadonlyArray<number>, flags: Array<string>) => {
      events.push(`remove:${uids.join(',')}:${flags.join(',')}`);
      return Promise.resolve(options.result ?? true);
    },
  }) as unknown as ImapFlow;

const batch = (uids: ReadonlyArray<number>, folder = 'INBOX') => ({
  account,
  folder,
  uidValidity,
  uids,
});

const folderDestination = (folder: string) =>
  ({ kind: 'folder', folder }) as const;

describe('moveMessages', () => {
  it('moves each unique uid in one command and maps its new uid', async () => {
    const events: Array<string> = [];
    const result = await Effect.runPromise(
      moveMessages(
        fakeClient(events),
        batch([7, 9, 7]),
        folderDestination('INBOX.GitHub'),
      ),
    );

    expect(events).toEqual(['lock:INBOX', 'move:7,9:INBOX.GitHub']);
    expect(result).toEqual({
      account,
      folder: 'INBOX',
      uidValidity,
      uids: [7, 9],
      to: { folder: 'INBOX.GitHub', uidValidity: '222' },
      moved: [
        { uid: 7, newUid: 107 },
        { uid: 9, newUid: 109 },
      ],
    });
  });

  it('moves to the folder marked as trash', async () => {
    const events: Array<string> = [];
    const result = await Effect.runPromise(
      moveMessages(fakeClient(events), batch([7]), { kind: 'trash' }),
    );

    expect(events).toEqual(['lock:INBOX', 'move:7:Trash']);
    expect(result.to.folder).toBe('Trash');
  });
});

describe('moveMessages destination', () => {
  it('refuses when the account has no trash folder', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        moveMessages(
          fakeClient([], { folders: [{ path: 'INBOX' }] }),
          batch([7]),
          { kind: 'trash' },
        ),
      ),
    );

    expect(error._tag).toBe('MessageChangeError');
  });

  it.each(['Elsewhere', 'Archive'])(
    'refuses the missing or unselectable destination %s',
    async (folder) => {
      const events: Array<string> = [];
      const error = await Effect.runPromise(
        Effect.flip(
          moveMessages(
            fakeClient(events),
            batch([7]),
            folderDestination(folder),
          ),
        ),
      );

      expect(error._tag).toBe('FolderNotFoundError');
      expect(events).toEqual([]);
    },
  );

  it('refuses to move messages into their own folder', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        moveMessages(
          fakeClient([]),
          batch([7], 'inbox'),
          folderDestination('INBOX'),
        ),
      ),
    );

    expect(error._tag).toBe('MessageChangeError');
    expect(error.message).toContain('already in "INBOX"');
  });
});

describe('moveMessages batch checks', () => {
  it('moves nothing when any uid is missing', async () => {
    const events: Array<string> = [];
    const error = await Effect.runPromise(
      Effect.flip(
        moveMessages(fakeClient(events, { found: [7] }), batch([7, 8, 9]), {
          kind: 'trash',
        }),
      ),
    );

    expect(error._tag).toBe('MessageChangeError');
    expect(error.message).toContain('uids 8, 9 not found in "INBOX"');
    expect(events).toEqual(['lock:INBOX']);
  });

  it('moves nothing after the folder was reindexed', async () => {
    const events: Array<string> = [];
    const error = await Effect.runPromise(
      Effect.flip(
        moveMessages(fakeClient(events, { uidValidity: 333n }), batch([7]), {
          kind: 'trash',
        }),
      ),
    );

    expect(error._tag).toBe('StaleUidError');
    expect(events).toEqual(['lock:INBOX']);
  });

  it('reports a move the server rejected', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        moveMessages(fakeClient([], { result: false }), batch([7]), {
          kind: 'trash',
        }),
      ),
    );

    expect(error._tag).toBe('ImapError');
  });

  it.each([{ size: 0 }, { size: 501 }])(
    'refuses a batch of $size uids',
    async ({ size }) => {
      const events: Array<string> = [];
      const uids = Array.from({ length: size }, (_, index) => index + 1);
      const error = await Effect.runPromise(
        Effect.flip(
          moveMessages(fakeClient(events), batch(uids), { kind: 'trash' }),
        ),
      );

      expect(error._tag).toBe('MessageChangeError');
      expect(events).toEqual([]);
    },
  );
});

describe('markMessages', () => {
  it('adds \\Seen to mark messages as read', async () => {
    const events: Array<string> = [];
    const result = await Effect.runPromise(
      markMessages(fakeClient(events), batch([7, 9]), true),
    );

    expect(events).toEqual(['lock:INBOX', 'add:7,9:\\Seen']);
    expect(result).toEqual({ ...batch([7, 9]), read: true });
  });

  it('removes \\Seen to mark messages as unread', async () => {
    const events: Array<string> = [];
    await Effect.runPromise(
      markMessages(fakeClient(events), batch([7]), false),
    );

    expect(events).toEqual(['lock:INBOX', 'remove:7:\\Seen']);
  });

  it('marks nothing when any uid is missing', async () => {
    const events: Array<string> = [];
    const error = await Effect.runPromise(
      Effect.flip(
        markMessages(fakeClient(events, { found: [] }), batch([7]), true),
      ),
    );

    expect(error._tag).toBe('MessageChangeError');
    expect(events).toEqual(['lock:INBOX']);
  });

  it('reports an update the server rejected', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        markMessages(fakeClient([], { result: false }), batch([7]), true),
      ),
    );

    expect(error._tag).toBe('ImapError');
  });
});
