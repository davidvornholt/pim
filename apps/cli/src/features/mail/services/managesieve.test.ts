import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { logIn, makeSession, type SieveWire, saveScript } from './managesieve';
import { parseReply } from './managesieve-reply';

const greeting = '"IMPLEMENTATION" "Test"\r\n"SASL" ""\r\n"STARTTLS"\r\nOK\r\n';
const secured = '"IMPLEMENTATION" "Test"\r\n"SASL" "PLAIN LOGIN"\r\nOK\r\n';
const password = 'hunter2';

// Answers each reply from the script in order and records what pim sent,
// with <TLS> where the connection switched to TLS.
const fakeWire = (replies: ReadonlyArray<string>) => {
  const sent: Array<string> = [];
  const queue = [...replies];
  const wire: SieveWire = {
    send: (command) =>
      Effect.sync(() => {
        sent.push(command);
      }),
    reply: Effect.suspend(() => {
      const parsed = parseReply(new TextEncoder().encode(queue.shift() ?? ''));
      return parsed.kind === 'reply'
        ? Effect.succeed(parsed.reply)
        : Effect.die(new Error(`no scripted reply: ${parsed.kind}`));
    }),
    startTls: Effect.sync(() => {
      sent.push('<TLS>');
    }),
  };
  return { wire, sent };
};

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect));

describe('logIn', () => {
  it('starts TLS before it sends the password', async () => {
    const { wire, sent } = fakeWire([greeting, 'OK\r\n', secured, 'OK\r\n']);
    await Effect.runPromise(logIn(wire, 'me@example.com', password));

    const token = Buffer.from(`\0me@example.com\0${password}`).toString(
      'base64',
    );
    expect(sent).toEqual([
      'STARTTLS\r\n',
      '<TLS>',
      `AUTHENTICATE "PLAIN" {${token.length}+}\r\n${token}\r\n`,
    ]);
  });

  it('sends nothing when the server offers no STARTTLS', async () => {
    const { wire, sent } = fakeWire(['"SASL" "PLAIN"\r\nOK\r\n']);
    const error = await failureOf(logIn(wire, 'me@example.com', password));

    expect(error.message).toContain('does not offer STARTTLS');
    expect(sent).toEqual([]);
  });

  it('refuses a server without password login after TLS', async () => {
    const { wire, sent } = fakeWire([
      greeting,
      'OK\r\n',
      '"SASL" "EXTERNAL"\r\nOK\r\n',
    ]);
    const error = await failureOf(logIn(wire, 'me@example.com', password));

    expect(error.message).toContain('SASL PLAIN');
    expect(sent).toEqual(['STARTTLS\r\n', '<TLS>']);
  });

  it('points to "pim login" when the server rejects the password', async () => {
    const { wire } = fakeWire([
      greeting,
      'OK\r\n',
      secured,
      'NO "Authentication failed."\r\n',
    ]);
    const error = await failureOf(logIn(wire, 'me@example.com', password));

    expect(error._tag).toBe('SieveError');
    expect(error.message).toContain('Authentication failed.');
    expect(error.message).toContain('pim login');
    expect(error.message).not.toContain(password);
  });
});

describe('Sieve session', () => {
  it('lists scripts with the active one marked', async () => {
    const { wire, sent } = fakeWire([
      '"managesieve" ACTIVE\r\n"old"\r\nOK\r\n',
    ]);
    const scripts = await Effect.runPromise(makeSession(wire).listScripts);

    expect(sent).toEqual(['LISTSCRIPTS\r\n']);
    expect(scripts).toEqual([
      { name: 'managesieve', active: true },
      { name: 'old', active: false },
    ]);
  });

  it('gets a script sent as a literal', async () => {
    const { wire, sent } = fakeWire(['{5}\r\nkeep;\r\nOK\r\n']);
    const script = await Effect.runPromise(makeSession(wire).getScript('a'));

    expect(sent).toEqual(['GETSCRIPT {1+}\r\na\r\n']);
    expect(script).toBe('keep;');
  });

  it('reports a command the server refused with its reason', async () => {
    const { wire } = fakeWire(['NO (NONEXISTENT) "There is no script."\r\n']);
    const error = await failureOf(makeSession(wire).getScript('missing'));

    expect(error.message).toBe(
      'get Sieve script "missing" failed: There is no script.',
    );
  });
});

describe('saveScript', () => {
  it('saves, activates, and reports the warnings', async () => {
    const { wire, sent } = fakeWire([
      'OK (WARNINGS) "line 1: unused"\r\n',
      'OK\r\n',
      '"filters" ACTIVE\r\n"old"\r\nOK\r\n',
    ]);
    const saved = await Effect.runPromise(
      saveScript(makeSession(wire), 'filters', 'keep;', true),
    );

    expect(sent).toEqual([
      'PUTSCRIPT {7+}\r\nfilters {5+}\r\nkeep;\r\n',
      'SETACTIVE {7+}\r\nfilters\r\n',
      'LISTSCRIPTS\r\n',
    ]);
    expect(saved).toEqual({
      name: 'filters',
      active: true,
      warnings: 'line 1: unused',
    });
  });

  it('leaves the active script alone unless asked', async () => {
    const { wire, sent } = fakeWire(['OK\r\n', '"filters"\r\nOK\r\n']);
    const saved = await Effect.runPromise(
      saveScript(makeSession(wire), 'filters', 'keep;', false),
    );

    expect(sent).toEqual([
      'PUTSCRIPT {7+}\r\nfilters {5+}\r\nkeep;\r\n',
      'LISTSCRIPTS\r\n',
    ]);
    expect(saved).toEqual({ name: 'filters', active: false, warnings: null });
  });

  it('stops when the server rejects the script', async () => {
    const { wire, sent } = fakeWire(['NO "line 1: unknown command"\r\n']);
    const error = await failureOf(
      saveScript(makeSession(wire), 'filters', 'kep;', true),
    );

    expect(error.message).toBe(
      'save Sieve script "filters" failed: line 1: unknown command',
    );
    expect(sent).toHaveLength(1);
  });
});
