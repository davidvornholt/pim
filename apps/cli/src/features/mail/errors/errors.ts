import { Schema } from 'effect';
import type {
  ConfigError,
  KeyringError,
  MailNotConfiguredError,
  MissingCredentialsError,
  OAuthError,
  UnknownAccountError,
} from '../../../shared/errors/accounts';

export class ImapError extends Schema.TaggedError<ImapError>()('ImapError', {
  message: Schema.String,
}) {}

export class SearchInputError extends Schema.TaggedError<SearchInputError>()(
  'SearchInputError',
  {
    message: Schema.String,
  },
) {}

export class SearchAccountsError extends Schema.TaggedError<SearchAccountsError>()(
  'SearchAccountsError',
  {
    message: Schema.String,
  },
) {}

export class AccountSearchTimeoutError extends Schema.TaggedError<AccountSearchTimeoutError>()(
  'AccountSearchTimeoutError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

export class FolderNotFoundError extends Schema.TaggedError<FolderNotFoundError>()(
  'FolderNotFoundError',
  {
    folder: Schema.String,
    message: Schema.String,
  },
) {}

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  'MessageNotFoundError',
  {
    folder: Schema.String,
    uid: Schema.Number,
    message: Schema.String,
  },
) {}

export class AttachmentNotFoundError extends Schema.TaggedError<AttachmentNotFoundError>()(
  'AttachmentNotFoundError',
  {
    folder: Schema.String,
    uid: Schema.Number,
    part: Schema.String,
    message: Schema.String,
  },
) {}

// The message carries no iCalendar data, so it is no invitation.
export class NoCalendarDataError extends Schema.TaggedError<NoCalendarDataError>()(
  'NoCalendarDataError',
  {
    folder: Schema.String,
    uid: Schema.Number,
    message: Schema.String,
  },
) {}

export class DraftError extends Schema.TaggedError<DraftError>()('DraftError', {
  message: Schema.String,
}) {}

export class MessageChangeError extends Schema.TaggedError<MessageChangeError>()(
  'MessageChangeError',
  {
    message: Schema.String,
  },
) {}

// A ManageSieve connection, login, or command failed, or the server rejected
// a script; the message carries the server's reason.
export class SieveError extends Schema.TaggedError<SieveError>()('SieveError', {
  message: Schema.String,
}) {}

export class StaleUidError extends Schema.TaggedError<StaleUidError>()(
  'StaleUidError',
  {
    folder: Schema.String,
    message: Schema.String,
  },
) {}

export type MailError =
  | ConfigError
  | UnknownAccountError
  | MailNotConfiguredError
  | MissingCredentialsError
  | KeyringError
  | ImapError
  | OAuthError
  | SearchInputError
  | SearchAccountsError
  | AccountSearchTimeoutError
  | FolderNotFoundError
  | MessageNotFoundError
  | AttachmentNotFoundError
  | NoCalendarDataError
  | DraftError
  | MessageChangeError
  | SieveError
  | StaleUidError;
