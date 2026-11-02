import { afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { logIn, openWire } from './managesieve';

type Answer = (command: string) => ReadonlyArray<string> | 'close';

const greeting = '"SASL" ""\r\n"STARTTLS"\r\nOK\r\n';
const servers: Array<Bun.TCPSocketListener<undefined>> = [];

// A plaintext ManageSieve server on localhost: it writes the greeting in the
// given chunks, then answers each command with chunks or by hanging up.
const serve = (greetingChunks: ReadonlyArray<string>, answer: Answer) => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: async (socket) => {
        for (const chunk of greetingChunks) {
          socket.write(chunk);
          // Separate writes, so the client sees the reply split up.
          // biome-ignore lint/performance/noAwaitInLoops: the chunks must arrive in order, one at a time.
          await Bun.sleep(10);
        }
      },
      data: (socket, data) => {
        const reply = answer(data.toString());
        if (reply === 'close') {
          socket.end();
          return;
        }
        socket.write(reply.join(''));
      },
    },
  });
  servers.push(server);
  return server.port;
};

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const logInTo = (port: number) =>
  Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        openWire('127.0.0.1', port).pipe(
          Effect.flatMap((wire) => logIn(wire, 'me', 'hunter2')),
        ),
      ),
    ),
  );

describe('ManageSieve connection', () => {
  it('reads a reply split across packets', async () => {
    const port = serve(['"SASL" ""\r\n"STAR', 'TTLS"\r\nO', 'K\r\n'], () => [
      'NO "Not today."\r\n',
    ]);
    const error = await logInTo(port);

    expect(error.message).toBe('STARTTLS failed: Not today.');
  });

  it('refuses replies the server sent ahead of TLS', async () => {
    const port = serve([greeting], () => [
      'OK "Begin TLS."\r\n',
      'OK "Injected."\r\n',
    ]);
    const error = await logInTo(port);

    expect(error.message).toBe(
      'the ManageSieve server sent data before TLS started',
    );
  });

  it('reports a server that hangs up', async () => {
    const port = serve([greeting], () => 'close');
    const error = await logInTo(port);

    expect(error.message).toBe(
      'the ManageSieve server 127.0.0.1 closed the connection',
    );
  });
});
