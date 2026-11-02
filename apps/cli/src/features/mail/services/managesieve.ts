import net from 'node:net';
import tls from 'node:tls';
import { Duration, Effect, type Scope } from 'effect';
import { SieveError } from '../errors/errors';
import type { SavedSieveScript, SieveScript } from '../schemas/mail';
import { literal, parseReply, type SieveReply } from './managesieve-reply';

// The ManageSieve port from RFC 5804.
export const sievePort = 4190;
const replyTimeoutSeconds = 30;
const replyTimeout = Duration.seconds(replyTimeoutSeconds);

// One ManageSieve connection. Commands run one at a time, so each reply
// answers the command sent before it.
export type SieveWire = {
  readonly send: (command: string) => Effect.Effect<void, SieveError>;
  readonly reply: Effect.Effect<SieveReply, SieveError>;
  // Switches the connection to TLS once the server accepted STARTTLS.
  readonly startTls: Effect.Effect<void, SieveError>;
};

type Waiter = (outcome: Effect.Effect<SieveReply, SieveError>) => void;

const failure = (message: string) => new SieveError({ message });

// Tracks the socket, buffered input, and the waiting reply, and swaps the
// plain socket for a TLS one on STARTTLS.
const makeConnection = (host: string, port: number) => {
  const plain = net.connect({ host, port });
  let socket: net.Socket = plain;
  let input = new Uint8Array(0);
  let waiter: Waiter | undefined;
  let broken: SieveError | undefined;

  const settle = () => {
    if (waiter === undefined) {
      return;
    }
    const resume = waiter;
    if (broken !== undefined) {
      waiter = undefined;
      resume(Effect.fail(broken));
      return;
    }
    const parsed = parseReply(input);
    if (parsed.kind === 'incomplete') {
      return;
    }
    waiter = undefined;
    if (parsed.kind === 'malformed') {
      broken = failure(
        `the ManageSieve server sent a malformed reply: ${parsed.reason}`,
      );
      resume(Effect.fail(broken));
      return;
    }
    input = input.subarray(parsed.length);
    resume(Effect.succeed(parsed.reply));
  };
  const onData = (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    settle();
  };
  const onError = (error: Error) => {
    broken ??= failure(
      `ManageSieve connection to ${host}:${port} failed: ${error.message}`,
    );
    settle();
  };
  const onClose = () => {
    broken ??= failure(`the ManageSieve server ${host} closed the connection`);
    settle();
  };
  const listen = (target: net.Socket) => {
    target.on('data', onData).on('error', onError).on('close', onClose);
  };
  listen(socket);

  const reply = Effect.callback<SieveReply, SieveError>((resume) => {
    waiter = resume;
    settle();
    return Effect.sync(() => {
      waiter = undefined;
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: replyTimeout,
      orElse: () =>
        Effect.fail(failure(`the ManageSieve server ${host} did not answer`)),
    }),
  );

  const send = (command: string) =>
    broken === undefined
      ? Effect.sync(() => {
          socket.write(command);
        })
      : Effect.fail(broken);

  // Bytes buffered before the handshake would be read as if they came over
  // TLS, so a plaintext attacker could inject replies; refuse them.
  const startTls = Effect.suspend(() => {
    if (input.length > 0) {
      return Effect.fail(
        failure('the ManageSieve server sent data before TLS started'),
      );
    }
    // The plain socket keeps its error and close listeners, since TLS runs
    // over it; only its data now arrives decrypted through the TLS socket.
    socket.off('data', onData);
    const secure = tls.connect({ socket, host, servername: host });
    socket = secure;
    listen(secure);
    return Effect.callback<void, SieveError>((resume) => {
      const onHandshakeError = (error: Error) => {
        resume(
          Effect.fail(
            failure(`TLS with ${host}:${port} failed: ${error.message}`),
          ),
        );
      };
      const onSecure = () => {
        secure.off('error', onHandshakeError);
        resume(Effect.void);
      };
      secure.once('error', onHandshakeError).once('secureConnect', onSecure);
      return Effect.sync(() => {
        secure.off('error', onHandshakeError).off('secureConnect', onSecure);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: replyTimeout,
        orElse: () => Effect.fail(failure(`TLS with ${host} timed out`)),
      }),
    );
  });

  const wire: SieveWire = { send, reply, startTls };
  return {
    wire,
    close: () => {
      socket.destroy();
      plain.destroy();
    },
  };
};

export const openWire = (
  host: string,
  port: number,
): Effect.Effect<SieveWire, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeConnection(host, port)),
    (connection) => Effect.sync(connection.close),
  ).pipe(Effect.map((connection) => connection.wire));

const exchange = (wire: SieveWire, command: string) =>
  wire.send(`${command}\r\n`).pipe(Effect.andThen(wire.reply));

// The server's explanation, which may span lines and end in a line break.
const reason = (reply: SieveReply) => reply.text?.trim() || reply.status;

const requireOk =
  (action: string) =>
  (reply: SieveReply): Effect.Effect<SieveReply, SieveError> =>
    reply.status === 'OK'
      ? Effect.succeed(reply)
      : Effect.fail(failure(`${action} failed: ${reason(reply)}`));

const run = (wire: SieveWire, command: string, action: string) =>
  exchange(wire, command).pipe(Effect.flatMap(requireOk(action)));

const capabilities = (reply: SieveReply): ReadonlyMap<string, string> =>
  new Map(
    reply.lines.map(([key = '', value = '']) => [key.toUpperCase(), value]),
  );

// Redacts in order, so list a secret before any that may occur inside it.
const redact = (text: string, secrets: ReadonlyArray<string>) =>
  secrets
    .filter((secret) => secret !== '')
    .reduce((rest, secret) => rest.replaceAll(secret, '[redacted]'), text);

// Logs in with SASL PLAIN, only after STARTTLS, so the password never
// crosses the network in cleartext.
export const logIn = (
  wire: SieveWire,
  user: string,
  password: string,
): Effect.Effect<void, SieveError> =>
  Effect.gen(function* () {
    const greeting = yield* wire.reply.pipe(
      Effect.flatMap(requireOk('ManageSieve greeting')),
    );
    if (!capabilities(greeting).has('STARTTLS')) {
      return yield* failure(
        'the ManageSieve server does not offer STARTTLS, so pim will not send the password',
      );
    }
    yield* run(wire, 'STARTTLS', 'STARTTLS');
    yield* wire.startTls;
    const secured = yield* wire.reply.pipe(
      Effect.flatMap(requireOk('STARTTLS')),
    );
    const mechanisms = (capabilities(secured).get('SASL') ?? '')
      .toUpperCase()
      .split(' ');
    if (!mechanisms.includes('PLAIN')) {
      return yield* failure(
        'the ManageSieve server offers no password login (SASL PLAIN)',
      );
    }
    const token = Buffer.from(`\0${user}\0${password}`).toString('base64');
    // pim prints these errors, and a server may echo the credentials in them.
    const hide = (text: string) => redact(text, [token, password]);
    const answer = yield* exchange(
      wire,
      `AUTHENTICATE "PLAIN" ${literal(token)}`,
    ).pipe(Effect.mapError((error) => failure(hide(error.message))));
    if (answer.status !== 'OK') {
      return yield* failure(
        `the ManageSieve server rejected the login: ${hide(reason(answer))}. If the mail password changed, ask the user to run "pim login".`,
      );
    }
  });

export const makeSession = (wire: SieveWire) => ({
  listScripts: run(wire, 'LISTSCRIPTS', 'list Sieve scripts').pipe(
    Effect.map(
      (reply): ReadonlyArray<SieveScript> =>
        reply.lines.map(([name = '', state]) => ({
          name,
          active: state?.toUpperCase() === 'ACTIVE',
        })),
    ),
  ),
  getScript: (name: string) =>
    run(wire, `GETSCRIPT ${literal(name)}`, `get Sieve script "${name}"`).pipe(
      Effect.map((reply) => reply.lines[0]?.[0] ?? ''),
    ),
  // Resolves to the server's warnings about a script it accepted, if any.
  putScript: (name: string, script: string) =>
    run(
      wire,
      `PUTSCRIPT ${literal(name)} ${literal(script)}`,
      `save Sieve script "${name}"`,
    ).pipe(
      Effect.map((reply) => (reply.code === 'WARNINGS' ? reply.text : null)),
    ),
  setActive: (name: string) =>
    run(wire, `SETACTIVE ${literal(name)}`, `activate Sieve script "${name}"`),
});

export type SieveSession = ReturnType<typeof makeSession>;

export const saveScript = (
  session: SieveSession,
  name: string,
  script: string,
  activate: boolean,
): Effect.Effect<SavedSieveScript, SieveError> =>
  Effect.gen(function* () {
    const warnings = yield* session.putScript(name, script);
    if (activate) {
      yield* session.setActive(name);
    }
    const scripts = yield* session.listScripts;
    const active = scripts.some((saved) => saved.name === name && saved.active);
    return { name, active, warnings };
  });
