import { Effect } from 'effect';
import { defaultSearchLimit } from '../features/mail/schemas/mail';
import { Imap } from '../features/mail/services/imap';
import { checkAccounts } from '../features/mail/services/status';
import { hasMail } from '../shared/accounts/account';
import { AccountConfig } from '../shared/accounts/config';
import type { CredentialKind } from '../shared/accounts/secrets';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import type { Program } from '../shared/command-program';
import { checkDavAccounts } from '../shared/dav/status';
import { checkGraphAccounts } from '../shared/graph/status';
import { stdinIsTerminal } from '../shared/terminal';
import { checkOut, writeAttachment } from './attachment-file';
import { calendarCommands } from './calendar-commands';
import { calendarWriteCommands } from './calendar-write-commands';
import { loginAccounts, loginSteps } from './cli-login';
import {
  type CommandEffect,
  configuredEmail,
  json,
  printed,
} from './command-support';
import { contactCommands } from './contact-commands';
import { contactWriteCommands } from './contact-write-commands';
import { draftCommands } from './draft-commands';
import { invitationCommands } from './invitation-commands';
import { messageCommands } from './message-commands';

const account = flag.text('email', 'Account email from "pim accounts"');
const optionalAccount = (description: string) =>
  flag.optionalText('email', description);
const messageFlags = {
  account,
  folder: flag.text('path', 'Folder from a search hit'),
  uid: flag.integer('n', 'Message uid from a search hit'),
} as const;

const selectedAccounts = (only: string | undefined) =>
  AccountConfig.pipe(
    Effect.flatMap((config) =>
      only === undefined
        ? Effect.succeed(config.accounts)
        : config.getAccount(only).pipe(Effect.map((found) => [found])),
    ),
  );

const accounts = defineCommand(
  {
    name: 'accounts',
    summary: 'List configured accounts',
    description:
      'Print each account from the account config with its defaults filled in: mail (IMAP), dav (calendars and contacts) and graph (Outlook calendars) appear only for the services the account has.',
    flags: {},
  },
  (): CommandEffect =>
    AccountConfig.pipe(Effect.map((config) => json(config.accounts))),
);

const status = defineCommand(
  {
    name: 'status',
    summary: 'Check that each account can log in',
    description:
      'Check that each account has credentials in the OS keyring and that it logs in to each service it configures: mail, calendars and contacts (dav), and Outlook calendars (graph). Exits 1 when any login is not ready; its message says what to do.',
    flags: {
      account: optionalAccount('Check only this account'),
      offline: flag.switch('Only check the keyring; do not connect'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const selected = yield* selectedAccounts(values.account);
      const options = { verify: !values.offline };
      const [mail, dav, graph] = yield* Effect.all(
        [
          checkAccounts(
            selected.filter(hasMail).map(({ email }) => email),
            options,
          ),
          checkDavAccounts(selected, options),
          checkGraphAccounts(selected, options),
        ],
        { concurrency: 'unbounded' },
      );
      const results = selected.flatMap(({ email }) =>
        [...mail, ...dav, ...graph].filter((result) => result.email === email),
      );
      return json(
        results,
        results.some((result) => !result.ok),
      );
    }),
);

const credentialKind = (
  only: string | undefined,
): Effect.Effect<CredentialKind | undefined, UsageError> =>
  only === undefined || only === 'mail' || only === 'dav' || only === 'graph'
    ? Effect.succeed(only)
    : Effect.fail(
        new UsageError({
          message: `pim login: --only must be mail, dav or graph, not "${only}"`,
        }),
      );

const login = defineCommand(
  {
    name: 'login',
    summary: 'Log in and store credentials in the OS keyring',
    description:
      'Log in to each service an account configures: prompt for the mail password (or app password), or sign in with Microsoft when mail has auth = "microsoft"; prompt for the dav password for calendars and contacts; and sign in with Microsoft in a browser on this computer for graph (Outlook calendars). Check each login against the server and store it in the OS keyring. Needs an interactive terminal: agents should ask the user to run it.',
    flags: {
      account: optionalAccount('Log in to only this account'),
      only: flag.optionalText(
        'mail|dav|graph',
        'Log in to only mail, only calendars and contacts, or only Outlook calendars',
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const only = yield* credentialKind(values.only);
      if (!stdinIsTerminal()) {
        return yield* new UsageError({
          message:
            'pim login needs an interactive terminal; ask the user to run it',
        });
      }
      const selected = yield* selectedAccounts(values.account);
      const steps = loginSteps(selected, only);
      if (steps.length === 0) {
        return yield* new UsageError({
          message:
            values.account === undefined
              ? `pim login --only ${only}: no account has a ${only} table in the account config`
              : `pim login --only ${only}: ${values.account} has no ${only} table in the account config`,
        });
      }
      const succeeded = yield* loginAccounts(steps);
      return printed(!succeeded);
    }),
);

const folders = defineCommand(
  {
    name: 'mail folders',
    summary: 'List the folders of an account',
    flags: { account },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const imap = yield* Imap;
      return json(yield* imap.listFolders(email));
    }),
);

const search = defineCommand(
  {
    name: 'mail search',
    summary: 'Search messages, newest first',
    description:
      'Search messages, newest first, across all accounts unless --account is given. Without --folder, each account searches its all-mail folder, or else every folder except Drafts, Junk, and Trash. A Microsoft mailbox also skips the folders it lists as unsubscribed, which include its calendar and contacts. Each hit has an account, folder, uid, and uidValidity. Accounts that fail are listed under "failures" beside the other hits.',
    flags: {
      account: optionalAccount('Search only this account'),
      query: flag.optionalText('text', 'Match subject, body, and addresses'),
      from: flag.optionalText('text', 'Match the sender'),
      subject: flag.optionalText('text', 'Match the subject'),
      since: flag.optionalText('YYYY-MM-DD', 'Only messages from this date on'),
      folder: flag.optionalText('path', 'Search only this folder'),
      subtree: flag.switch('With --folder, include its subfolders'),
      limit: flag.optionalInteger(
        'n',
        `Maximum hits across all accounts (default ${defaultSearchLimit})`,
      ),
    },
  },
  ({ account: only, folder, subtree, limit, ...criteria }): CommandEffect =>
    Effect.gen(function* () {
      if (subtree && folder === undefined) {
        return yield* new UsageError({
          message: 'pim mail search: --subtree needs --folder',
        });
      }
      const email =
        only === undefined ? undefined : yield* configuredEmail(only);
      const imap = yield* Imap;
      const result = yield* imap.search(email, {
        ...criteria,
        limit: limit ?? defaultSearchLimit,
        ...(folder === undefined
          ? {}
          : { folder, scope: subtree ? 'subtree' : 'folder' }),
      });
      return json(result);
    }),
);

const read = defineCommand(
  {
    name: 'mail read',
    summary: 'Read a message',
    description:
      'Print one message: headers, plain-text body, and attachments. Reading does not mark the message as read. Attachment sizes count encoded bytes, so they overstate the saved file. Save an attachment with "pim mail attachment" and its part.',
    flags: {
      ...messageFlags,
      html: flag.switch('Include the HTML body'),
    },
  },
  ({ html: includeHtml, ...handle }): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(handle.account);
      const imap = yield* Imap;
      const { html, ...message } = yield* imap.read(
        email,
        handle.folder,
        handle.uid,
      );
      return json({
        account: email,
        ...message,
        ...(includeHtml ? { html } : {}),
      });
    }),
);

const attachment = defineCommand(
  {
    name: 'mail attachment',
    summary: 'Save an attachment to a file',
    flags: {
      ...messageFlags,
      part: flag.text('part', 'Attachment part from "pim mail read"'),
      out: flag.text(
        'path',
        'File to write, or an existing directory to write into',
      ),
      force: flag.switch('Overwrite an existing file'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      yield* checkOut(values.out, values.force);
      const imap = yield* Imap;
      const file = yield* imap.readAttachment(
        email,
        values.folder,
        values.uid,
        values.part,
      );
      const path = yield* writeAttachment(file, values.out, values.force);
      const { content: _content, ...metadata } = file;
      return json({ ...metadata, size: file.content.byteLength, path });
    }),
);

export const program: Program<CommandEffect> = {
  name: 'pim',
  summary:
    'pim: search, read, move, and draft email and mark it read or unread; read and change calendar events and contacts; invite people to meetings; and answer invitations. It sends no mail itself; with --notify-attendees or --notify-organizer, the calendar server emails the attendees or the organizer.',
  footer: [
    'Run "pim <command> --help" for its options. Write --option=value when a value starts with "--".',
    'Commands print JSON on stdout. Errors print {"error": {"tag", "message"}} on stderr and exit 1, or 2 for invalid arguments.',
    'Accounts live in ~/.config/pim/accounts.toml (PIM_CONFIG overrides the path).',
  ].join('\n'),
  commands: [
    accounts,
    status,
    login,
    folders,
    search,
    read,
    attachment,
    ...messageCommands,
    ...draftCommands,
    ...calendarCommands,
    ...calendarWriteCommands,
    ...invitationCommands,
    ...contactCommands,
    ...contactWriteCommands,
  ],
};
