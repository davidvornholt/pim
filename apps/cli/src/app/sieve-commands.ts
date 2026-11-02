import { Effect } from 'effect';
import { Sieve } from '../features/mail/services/sieve';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { readPipedStdin } from '../shared/terminal';
import { type CommandEffect, configuredEmail, json } from './command-support';

const account = flag.text(
  'email',
  'Account whose mail server runs the filters',
);
const name = flag.text('name', 'Script name from "pim mail sieve list"');

const readScript = Effect.gen(function* () {
  const script = yield* readPipedStdin;
  if (script === undefined) {
    return yield* new UsageError({
      message: 'pipe the Sieve script on stdin, for example with a heredoc',
    });
  }
  if (script.trim() === '') {
    return yield* new UsageError({
      message: 'the Sieve script on stdin is empty',
    });
  }
  return script;
});

const list = defineCommand(
  {
    name: 'mail sieve list',
    summary: 'List the Sieve filter scripts of an account',
    description:
      'Print each script on the mail server with whether it is active. The server runs only the active script on incoming mail.',
    flags: { account },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const sieve = yield* Sieve;
      return json(yield* sieve.list(email));
    }),
);

const get = defineCommand(
  {
    name: 'mail sieve get',
    summary: 'Print a Sieve filter script',
    flags: { account, name },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const sieve = yield* Sieve;
      const script = yield* sieve.get(email, values.name);
      return json({ account: email, name: values.name, script });
    }),
);

const put = defineCommand(
  {
    name: 'mail sieve put',
    summary: 'Save a Sieve filter script',
    description:
      'Reads the whole script from stdin and replaces the script of that name, or creates it. The server checks the script first and keeps the old one if it is invalid. Prints whether the script is active and any warnings the server gave.',
    flags: {
      account,
      name,
      activate: flag.switch(
        'Make this the active script, which the server runs on incoming mail',
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const script = yield* readScript;
      const email = yield* configuredEmail(values.account);
      const sieve = yield* Sieve;
      const saved = yield* sieve.put(
        email,
        values.name,
        script,
        values.activate,
      );
      return json({ account: email, ...saved });
    }),
);

export const sieveCommands = [list, get, put] as const;
