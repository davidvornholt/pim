import { Context, Effect, Layer } from 'effect';
import { mailAccount } from '../../../shared/accounts/account';
import { AccountConfig } from '../../../shared/accounts/config';
import { Secrets } from '../../../shared/accounts/secrets';
import { type MailError, SieveError } from '../errors/errors';
import type { SavedSieveScript, SieveScript } from '../schemas/mail';
import {
  logIn,
  makeSession,
  openWire,
  type SieveSession,
  saveScript,
  sievePort,
} from './managesieve';

// Sieve filters live on the IMAP host's ManageSieve port and use the mail
// login. Each call opens its own connection.
const makeSieve = Effect.gen(function* () {
  const config = yield* AccountConfig;
  const secrets = yield* Secrets;
  const withSession = <A>(
    email: string,
    use: (session: SieveSession) => Effect.Effect<A, SieveError>,
  ): Effect.Effect<A, MailError> =>
    Effect.gen(function* () {
      const account = yield* config
        .getAccount(email)
        .pipe(Effect.flatMap(mailAccount));
      if (account.mail.auth === 'microsoft') {
        return yield* new SieveError({
          message: `${account.email} signs in with Microsoft, whose mailboxes have no Sieve filters`,
        });
      }
      const password = yield* secrets.getCredential('mail', account.email);
      const wire = yield* openWire(account.mail.host, sievePort);
      yield* logIn(wire, account.mail.user, password);
      return yield* use(makeSession(wire));
    }).pipe(Effect.scoped);
  return {
    list: (
      email: string,
    ): Effect.Effect<ReadonlyArray<SieveScript>, MailError> =>
      withSession(email, (session) => session.listScripts),
    get: (email: string, name: string): Effect.Effect<string, MailError> =>
      withSession(email, (session) => session.getScript(name)),
    put: (
      email: string,
      name: string,
      script: string,
      activate: boolean,
    ): Effect.Effect<SavedSieveScript, MailError> =>
      withSession(email, (session) =>
        saveScript(session, name, script, activate),
      ),
  } as const;
});

export class Sieve extends Context.Service<
  Sieve,
  Effect.Success<typeof makeSieve>
>()('mail/Sieve') {
  static readonly layer = Layer.effect(Sieve, makeSieve).pipe(
    Layer.provide([AccountConfig.layer, Secrets.layer]),
  );
}
