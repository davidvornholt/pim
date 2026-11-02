import { Effect, Schema } from 'effect';
import type {
  CalendarDataError,
  CalendarNotConfiguredError,
  CalendarNotFoundError,
  EventChangeError,
  EventHasAttendeesError,
  InvitationError,
  ReadOnlyCalendarError,
  SchedulingUnsupportedError,
} from '../features/calendar/errors/errors';
import type {
  AddressBookNotFoundError,
  ContactChangeError,
  ContactDataError,
  ReadOnlyAddressBookError,
} from '../features/contacts/errors/errors';
import type { MailError } from '../features/mail/errors/errors';
import type { Imap } from '../features/mail/services/imap';
import type { Sieve } from '../features/mail/services/sieve';
import { AccountConfig } from '../shared/accounts/config';
import type { Secrets } from '../shared/accounts/secrets';
import type { UsageError } from '../shared/command-line';
import type { Dav, DavSessionError } from '../shared/dav/dav';
import type { AccountsError } from '../shared/errors/accounts';
import type {
  DavNotConfiguredError,
  DavRequestError,
} from '../shared/errors/dav';
import type { GraphRequestError } from '../shared/errors/graph';
import type { Graph, GraphSessionError } from '../shared/graph/graph';
import type { MicrosoftAuth } from '../shared/microsoft/auth';

export class FileError extends Schema.TaggedError<FileError>()('FileError', {
  message: Schema.String,
}) {}

// A command either returns JSON for stdout or has already written its own
// output. `failed` exits 1 without an error, as when an account is not ready.
export type Outcome =
  | { readonly _tag: 'Json'; readonly value: unknown; readonly failed: boolean }
  | { readonly _tag: 'Printed'; readonly failed: boolean };

export const json = (value: unknown, failed = false): Outcome => ({
  _tag: 'Json',
  value,
  failed,
});

export const printed = (failed: boolean): Outcome => ({
  _tag: 'Printed',
  failed,
});

export type CommandError =
  | MailError
  | DavSessionError
  | DavRequestError
  | DavNotConfiguredError
  | GraphSessionError
  | GraphRequestError
  | AccountsError
  | CalendarNotConfiguredError
  | CalendarDataError
  | CalendarNotFoundError
  | ReadOnlyCalendarError
  | EventHasAttendeesError
  | EventChangeError
  | SchedulingUnsupportedError
  | InvitationError
  | ContactDataError
  | AddressBookNotFoundError
  | ReadOnlyAddressBookError
  | ContactChangeError
  | UsageError
  | FileError;

export type CommandEffect = Effect.Effect<
  Outcome,
  CommandError,
  AccountConfig | Secrets | MicrosoftAuth | Imap | Sieve | Dav | Graph
>;

// Accounts match case-insensitively; services and the keyring use the
// configured spelling.
export const configuredEmail = (email: string) =>
  AccountConfig.pipe(
    Effect.flatMap((config) => config.getAccount(email)),
    Effect.map((account) => account.email),
  );

// Resolves to undefined when the path does not exist.
export const statPath = (path: string) =>
  Effect.promise(() =>
    Bun.file(path)
      .stat()
      .catch(() => undefined),
  );
