import { Effect } from 'effect';
import type { DraftInput, MessageHandle } from '../features/mail/schemas/mail';
import { requireSafeKeyword } from '../features/mail/services/draft-tags';
import {
  draftingGuideFile,
  readDraftingGuide,
} from '../features/mail/services/drafting-guide';
import { Imap } from '../features/mail/services/imap';
import {
  defineCommand,
  type FlagValues,
  flag,
  UsageError,
} from '../shared/command-line';
import { readPipedStdin } from '../shared/terminal';
import {
  type CommandEffect,
  configuredEmail,
  FileError,
  json,
  statPath,
} from './command-support';

const account = flag.text('email', 'Account the draft belongs to');
const handleFlags = {
  account,
  folder: flag.text('path', 'Drafts folder from the draft handle'),
  uid: flag.integer('n', 'Draft uid from the draft handle'),
  uidValidity: flag.text('id', 'uidValidity from the draft handle'),
} as const;
// --reply-folder and --reply-uid go together; replyHandle checks the pair.
const composeFlags = {
  to: flag.text('addresses', 'Recipients, comma-separated'),
  cc: flag.optionalText('addresses', 'Cc recipients, comma-separated'),
  bcc: flag.optionalText('addresses', 'Bcc recipients, comma-separated'),
  subject: flag.optionalText('text', 'Subject line'),
  htmlFile: flag.optionalText(
    'path',
    'HTML body to send alongside the text (default: generated from the text, with its http and https URLs linked)',
  ),
  attach: flag.texts('path', 'File to attach; repeat for more files'),
  replyFolder: flag.optionalText('path', 'Folder of the message to reply to'),
  replyUid: flag.optionalInteger('n', 'Uid of the message to reply to'),
} as const;

const composeDescription =
  'Reads the plain-text body from stdin. With --reply-folder and --reply-uid, the draft quotes that message (same account) and threads under it; set --subject yourself, such as "Re: <original subject>".';

const requireFile = (path: string, option: string) =>
  Effect.gen(function* () {
    const stats = yield* statPath(path);
    if (stats?.isFile() !== true) {
      return yield* new UsageError({
        message: `${option} ${path} is not a readable file`,
      });
    }
  });

const replyHandle = (
  folder: string | undefined,
  uid: number | undefined,
): Effect.Effect<MessageHandle | undefined, UsageError> => {
  if (folder === undefined && uid === undefined) {
    return Effect.succeed(undefined);
  }
  return folder === undefined || uid === undefined
    ? Effect.fail(
        new UsageError({
          message: 'pass --reply-folder and --reply-uid together',
        }),
      )
    : Effect.succeed({ folder, uid });
};

const readHtmlFile = (path: string) =>
  requireFile(path, '--html-file').pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (cause) =>
          new FileError({
            message: `could not read ${path}: ${String(cause)}`,
          }),
      }),
    ),
  );

const readBody = Effect.gen(function* () {
  const body = yield* readPipedStdin;
  if (body === undefined) {
    return yield* new UsageError({
      message: 'pipe the draft body on stdin, for example with a heredoc',
    });
  }
  if (body.trim() === '') {
    return yield* new UsageError({
      message: 'the draft body on stdin is empty',
    });
  }
  return body;
});

// Validates every local input before any IMAP work, so a bad path never
// leaves a half-finished draft behind.
const draftContent = (
  email: string,
  values: FlagValues<typeof composeFlags>,
): Effect.Effect<DraftInput, UsageError | FileError> =>
  Effect.gen(function* () {
    const { htmlFile, attach } = values;
    const replySource = yield* replyHandle(values.replyFolder, values.replyUid);
    yield* Effect.forEach(attach, (path) => requireFile(path, '--attach'));
    const html =
      htmlFile === undefined ? undefined : yield* readHtmlFile(htmlFile);
    const text = yield* readBody;
    return {
      account: email,
      to: values.to,
      subject: values.subject ?? '',
      text,
      ...(html === undefined ? {} : { html }),
      ...(attach.length === 0 ? {} : { attachments: attach }),
      ...(values.cc === undefined ? {} : { cc: values.cc }),
      ...(values.bcc === undefined ? {} : { bcc: values.bcc }),
      ...(replySource === undefined ? {} : { replySource }),
    };
  });

const draftingGuide = defineCommand(
  {
    name: 'mail draft guide',
    summary: "Print the user's drafting guide",
    description: `Print the user's notes on how to write their drafts, such as their sign-off, from ${draftingGuideFile} in the folder of the account config. "guide" is null when the user has not written one.`,
    flags: {},
  },
  (): CommandEffect =>
    readDraftingGuide.pipe(Effect.map((guide) => json(guide))),
);

const saveDraft = defineCommand(
  {
    name: 'mail draft save',
    summary: 'Save a new draft (body on stdin)',
    description: `Save a new draft to the account's drafts folder and print its handle. ${composeDescription}`,
    flags: { account, ...composeFlags },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const input = yield* draftContent(email, values);
      const imap = yield* Imap;
      const location = yield* imap.saveDraft(input);
      return json({ account: email, ...location });
    }),
);

const updateDraft = defineCommand(
  {
    name: 'mail draft update',
    summary: 'Replace a draft (body on stdin)',
    description: `Replace a draft with new content and print the new handle; the old uid stops working. Every field is replaced, so pass all recipients and the subject again. Bcc is kept unless --bcc is given (--bcc '' removes it). ${composeDescription}`,
    flags: { ...handleFlags, ...composeFlags },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const input = yield* draftContent(email, values);
      const imap = yield* Imap;
      const location = yield* imap.updateDraft({
        ...input,
        folder: values.folder,
        uid: values.uid,
        uidValidity: values.uidValidity,
      });
      return json({ account: email, ...location });
    }),
);

const deleteDraft = defineCommand(
  {
    name: 'mail draft delete',
    summary: 'Delete a draft',
    description:
      'Permanently delete one draft. Only messages in the drafts folder can be deleted.',
    flags: handleFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const imap = yield* Imap;
      const handle = { ...values, account: email };
      yield* imap.deleteDraft(handle);
      return json({ deleted: handle });
    }),
);

const tagDrafts = defineCommand(
  {
    name: 'mail draft tag',
    summary: 'Add an IMAP keyword to drafts',
    description:
      'Add an IMAP keyword to drafts in one drafts folder, such as a mail client label ($label1 is "Important" in Thunderbird). Submission keywords such as $Submitted are refused.',
    flags: {
      account,
      folder: handleFlags.folder,
      uidValidity: handleFlags.uidValidity,
      uid: flag.integers('n', 'Draft uid; repeat for more drafts'),
      keyword: flag.text('keyword', 'IMAP keyword to add'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      // Checked again by tagDrafts; checking here reports a bad keyword as
      // an invalid argument before connecting.
      yield* requireSafeKeyword(values.keyword).pipe(
        Effect.mapError((error) => new UsageError({ message: error.message })),
      );
      const imap = yield* Imap;
      const result = yield* imap.tagDrafts({
        account: email,
        folder: values.folder,
        uidValidity: values.uidValidity,
        uids: values.uid,
        keyword: values.keyword,
      });
      return json(result);
    }),
);

export const draftCommands = [
  draftingGuide,
  saveDraft,
  updateDraft,
  deleteDraft,
  tagDrafts,
];
