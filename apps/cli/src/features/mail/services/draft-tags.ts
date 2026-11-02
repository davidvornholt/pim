import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { DraftError, ImapError, type StaleUidError } from '../errors/errors';
import type { TagDraftsInput, TagDraftsResult } from '../schemas/mail';
import { requireDraftsFolder } from './draft';
import { listFolders } from './imap-ops';
import { lockMailbox } from './mailbox-lock';
import { requireCurrentUidValidity } from './uid-validity';

// IMAP keywords use the visible ASCII atom grammar. Submission keywords are
// rejected case-insensitively because some servers and clients send messages
// carrying them; tagging must never send mail.
const keywordPattern = /^[\u0021-\u007e]+$/u;
const atomSpecials = /["%()*\\\]{]/u;
const submissionKeywords = new Set(['$submitpending', '$submitted']);

export const requireSafeKeyword = (
  keyword: string,
): Effect.Effect<string, DraftError> => {
  if (keyword.startsWith('\\')) {
    return Effect.fail(
      new DraftError({
        message: `"${keyword}" is a system flag; tag drafts with a keyword such as $label1`,
      }),
    );
  }
  if (!keywordPattern.test(keyword) || atomSpecials.test(keyword)) {
    return Effect.fail(
      new DraftError({
        message: `"${keyword}" is not a valid IMAP keyword; use visible ASCII without spaces or any of: " % ( ) * \\ ] {`,
      }),
    );
  }
  if (submissionKeywords.has(keyword.toLowerCase())) {
    return Effect.fail(
      new DraftError({
        message: `refusing keyword "${keyword}": submission keywords can make a server send the draft`,
      }),
    );
  }
  return Effect.succeed(keyword);
};

const requireSupportedKeyword = (
  client: ImapFlow,
  folder: string,
  keyword: string,
): Effect.Effect<string, DraftError> => {
  const permanentFlags =
    client.mailbox === false ? undefined : client.mailbox.permanentFlags;
  if (permanentFlags === undefined || permanentFlags.has('\\*')) {
    return Effect.succeed(keyword);
  }
  const advertised = [...permanentFlags].find(
    (flag) => flag.toLowerCase() === keyword.toLowerCase(),
  );
  if (advertised !== undefined) {
    return Effect.succeed(advertised);
  }
  return Effect.fail(
    new DraftError({
      message: `the IMAP server does not allow keyword "${keyword}" in "${folder}"`,
    }),
  );
};

const requireAllDrafts = (
  client: ImapFlow,
  folder: string,
  uids: ReadonlyArray<number>,
): Effect.Effect<void, DraftError | ImapError> =>
  Effect.gen(function* () {
    const messages = yield* Effect.tryPromise({
      try: () => client.fetchAll([...uids], { uid: true }, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `look up drafts in "${folder}" failed: ${String(cause)}`,
        }),
    });
    const found = new Set(messages.map((message) => message.uid));
    const missing = uids.filter((uid) => !found.has(uid));
    if (missing.length > 0) {
      return yield* Effect.fail(
        new DraftError({
          message: `refusing to tag drafts because uids ${missing.join(', ')} were not found in "${folder}"; search the drafts folder again`,
        }),
      );
    }
  });

const requireAllTagged = (
  client: ImapFlow,
  folder: string,
  uids: ReadonlyArray<number>,
  keyword: string,
): Effect.Effect<void, ImapError> =>
  Effect.gen(function* () {
    const messages = yield* Effect.tryPromise({
      try: () =>
        client.fetchAll([...uids], { uid: true, flags: true }, { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `verify tagged drafts in "${folder}" failed: ${String(cause)}`,
        }),
    });
    const byUid = new Map(messages.map((message) => [message.uid, message]));
    const missing = uids.filter((uid) => !byUid.has(uid));
    const untagged = uids.filter((uid) => {
      const message = byUid.get(uid);
      return (
        message !== undefined &&
        ![...(message.flags ?? [])].some(
          (flag) => flag.toLowerCase() === keyword.toLowerCase(),
        )
      );
    });
    if (missing.length === 0 && untagged.length === 0) {
      return;
    }
    const details = [
      missing.length > 0 ? `missing uids ${missing.join(', ')}` : undefined,
      untagged.length > 0
        ? `keyword absent from uids ${untagged.join(', ')}`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    return yield* Effect.fail(
      new ImapError({
        message: `tag drafts in "${folder}" was incomplete after the server update: ${details.join('; ')}`,
      }),
    );
  });

export const tagDrafts = (
  client: ImapFlow,
  input: TagDraftsInput,
): Effect.Effect<TagDraftsResult, DraftError | ImapError | StaleUidError> =>
  Effect.gen(function* () {
    const { account, folder, uidValidity } = input;
    const keyword = yield* requireSafeKeyword(input.keyword);
    const uids = [...new Set(input.uids)];
    if (uids.length === 0) {
      return yield* Effect.fail(
        new DraftError({ message: 'at least one draft uid is required' }),
      );
    }
    const folders = yield* listFolders(client);
    const draftsFolder = yield* requireDraftsFolder(folders, folder);
    yield* lockMailbox(client, draftsFolder);
    yield* requireCurrentUidValidity(
      client,
      draftsFolder,
      uidValidity,
      'tag drafts',
    );
    const storedKeyword = yield* requireSupportedKeyword(
      client,
      draftsFolder,
      keyword,
    );
    yield* requireAllDrafts(client, draftsFolder, uids);
    const updated = yield* Effect.tryPromise({
      try: () => client.messageFlagsAdd(uids, [storedKeyword], { uid: true }),
      catch: (cause) =>
        new ImapError({
          message: `tag drafts in "${draftsFolder}" failed: ${String(cause)}`,
        }),
    });
    if (!updated) {
      return yield* Effect.fail(
        new ImapError({
          message: `tag drafts in "${draftsFolder}" failed: server rejected the update`,
        }),
      );
    }
    yield* requireAllTagged(client, draftsFolder, uids, storedKeyword);
    return {
      account,
      folder: draftsFolder,
      uidValidity,
      uids,
      keyword: storedKeyword,
    };
  }).pipe(Effect.scoped);
