import { Effect } from 'effect';
import type {
  MessageBatch,
  MoveDestination,
} from '../features/mail/schemas/mail';
import { Imap } from '../features/mail/services/imap';
import {
  defineCommand,
  type FlagValues,
  flag,
  UsageError,
} from '../shared/command-line';
import { type CommandEffect, configuredEmail, json } from './command-support';

const batchFlags = {
  account: flag.text('email', 'Account the messages belong to'),
  folder: flag.text('path', 'Folder from the search hits'),
  uidValidity: flag.text('id', 'uidValidity from the search hits'),
  uid: flag.integers('n', 'Message uid; repeat for up to 500 messages'),
} as const;

const batchOf = (values: FlagValues<typeof batchFlags>) =>
  configuredEmail(values.account).pipe(
    Effect.map(
      (account): MessageBatch => ({
        account,
        folder: values.folder,
        uidValidity: values.uidValidity,
        uids: values.uid,
      }),
    ),
  );

const destinationOf = (
  to: string | undefined,
  trash: boolean,
): Effect.Effect<MoveDestination, UsageError> => {
  if (trash === (to !== undefined)) {
    return Effect.fail(
      new UsageError({ message: 'pim mail move: pass either --to or --trash' }),
    );
  }
  return Effect.succeed(
    to === undefined ? { kind: 'trash' } : { kind: 'folder', folder: to },
  );
};

const move = defineCommand(
  {
    name: 'mail move',
    summary: 'Move messages to another folder or the trash',
    description:
      'Move messages from one folder to another folder of the same account, or with --trash to its trash folder, where the mail client deletes them later. Prints each uid with its new uid in the destination folder, or null when the server does not report it.',
    flags: {
      ...batchFlags,
      to: flag.optionalText('path', 'Folder from "pim mail folders"'),
      trash: flag.switch("Move to the account's trash folder"),
    },
  },
  ({ to, trash, ...values }): CommandEffect =>
    Effect.gen(function* () {
      const destination = yield* destinationOf(to, trash);
      const batch = yield* batchOf(values);
      const imap = yield* Imap;
      return json(yield* imap.moveMessages(batch, destination));
    }),
);

const mark = defineCommand(
  {
    name: 'mail mark',
    summary: 'Mark messages as read or unread',
    flags: {
      ...batchFlags,
      read: flag.switch('Mark the messages as read'),
      unread: flag.switch('Mark the messages as unread'),
    },
  },
  ({ read, unread, ...values }): CommandEffect =>
    Effect.gen(function* () {
      if (read === unread) {
        return yield* new UsageError({
          message: 'pim mail mark: pass either --read or --unread',
        });
      }
      const batch = yield* batchOf(values);
      const imap = yield* Imap;
      return json(yield* imap.markMessages(batch, read));
    }),
);

export const messageCommands = [move, mark];
