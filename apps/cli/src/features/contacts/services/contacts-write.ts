import { Clock, Effect, Result } from 'effect';
import type ICAL from 'ical.js';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { Dav } from '../../../shared/dav/dav';
import { DavConflictError } from '../../../shared/errors/dav';
import {
  type AddressBookNotFoundError,
  ContactChangeError,
  type ContactDataError,
  ReadOnlyAddressBookError,
} from '../errors/errors';
import type { ContactDetail, TypedValue } from '../schemas/contacts';
import {
  createContactResource,
  deleteContactResource,
  fetchContact,
  listAddressBooks,
  replaceContactResource,
} from './carddav';
import { type ContactsError, findAddressBook, readContact } from './contacts';
import { clean, contactDetail, firstText, parseVCard } from './vcard';
import {
  applyContactChanges,
  type ContactChanges,
  type ContactText,
  newVCard,
} from './vcard-write';

export type ContactWriteError =
  | ContactsError
  | ContactDataError
  | AddressBookNotFoundError
  | ReadOnlyAddressBookError
  | ContactChangeError;

type StoredContact = {
  readonly account: string;
  readonly href: string;
  readonly etag: string | undefined;
  readonly vcard: string;
};

const detailOf = ({
  vcard,
  ...context
}: StoredContact): Effect.Effect<ContactDetail, ContactDataError> =>
  parseVCard(context.href, vcard).pipe(
    Effect.flatMap((card) =>
      readContact(context.href, () => contactDetail(card, context)),
    ),
  );

export type NewContactRequest = ContactText & {
  // An address book name or href from "pim contacts books".
  readonly addressBook: string;
  readonly emails: ReadonlyArray<TypedValue>;
  readonly phones: ReadonlyArray<TypedValue>;
};

export const createContact = (
  account: Account,
  request: NewContactRequest,
): Effect.Effect<ContactDetail, ContactWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const books = yield* listAddressBooks(client);
    const { addressBook: wanted, ...contact } = request;
    const book = yield* findAddressBook(account.email, books, wanted);
    if (book.writable === false) {
      return yield* new ReadOnlyAddressBookError({
        addressBook: book.href,
        message: `${account.email} may only read the address book "${book.name}"; choose one with "writable": true from "pim contacts books"`,
      });
    }
    const uid = crypto.randomUUID();
    const folder = book.href.endsWith('/') ? book.href : `${book.href}/`;
    const href = `${folder}${uid}.vcf`;
    const vcard = newVCard({ ...contact, uid }, yield* Clock.currentTimeMillis);
    const etag = yield* createContactResource(client, href, vcard);
    return yield* detailOf({ account: account.email, href, etag, vcard });
  });

export type ContactTarget = {
  readonly href: string;
  // The etag from "pim contacts get"; pim changes only that version.
  readonly etag: string;
};

// Contact groups list their members by UID, and contact apps keep them in
// sync; pim changes single contacts only.
const isGroup = (card: ICAL.Component): boolean =>
  ['kind', 'x-addressbookserver-kind'].some((name) =>
    card
      .getAllProperties(name)
      .some((kind) => clean(kind.getFirstValue())?.toLowerCase() === 'group'),
  );

// The contact at the target's href, provided it is still the version the
// caller read.
const changeableContact = (
  client: DavClient,
  target: ContactTarget,
): Effect.Effect<
  { readonly vcard: string; readonly card: ICAL.Component },
  ContactWriteError
> =>
  Effect.gen(function* () {
    const { href } = target;
    const resource = yield* fetchContact(client, href);
    if (resource.etag === undefined) {
      return yield* new ContactChangeError({
        href,
        message: `The server gave no etag for ${href}, so pim cannot make sure it changes the version you read`,
      });
    }
    if (resource.etag !== target.etag) {
      return yield* new DavConflictError({
        href,
        message: `${href} changed since you read it: its etag is now ${resource.etag}. Run "pim contacts get" again and check that the change still applies`,
      });
    }
    const card = yield* parseVCard(href, resource.vcard);
    if (yield* readContact(href, () => isGroup(card))) {
      return yield* new ContactChangeError({
        href,
        message: `${href} is a contact group, which pim does not change; the user can change it in a contacts app`,
      });
    }
    return { vcard: resource.vcard, card };
  });

const supportedVersions = new Set(['3.0', '4.0']);

export const updateContact = (
  account: Account,
  target: ContactTarget,
  changes: ContactChanges,
): Effect.Effect<ContactDetail, ContactWriteError, Dav> =>
  Effect.gen(function* () {
    const { href, etag } = target;
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const { vcard: stored, card } = yield* changeableContact(client, target);
    const version = yield* readContact(href, () => firstText(card, 'version'));
    if (!supportedVersions.has(version ?? '')) {
      return yield* new ContactChangeError({
        href,
        message: `${href} is a vCard ${version ?? 'without a version'}; pim changes vCard 3.0 and 4.0 only`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const applied = yield* readContact(href, () =>
      applyContactChanges(stored, changes, now),
    );
    if (Result.isFailure(applied)) {
      return yield* new ContactChangeError({ href, message: applied.failure });
    }
    const vcard = applied.success;
    const detail = (newEtag: string | undefined) =>
      detailOf({ account: account.email, href, etag: newEtag, vcard });
    // Reading the result before the write makes a contact pim cannot read
    // fail before it changes anything.
    yield* detail(undefined);
    return yield* detail(
      yield* replaceContactResource(client, href, vcard, etag),
    );
  });

export const deleteContact = (
  account: Account,
  target: ContactTarget,
): Effect.Effect<ContactDetail, ContactWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const { vcard } = yield* changeableContact(client, target);
    const detail = yield* detailOf({
      account: account.email,
      href: target.href,
      etag: undefined,
      vcard,
    });
    yield* deleteContactResource(client, target.href, target.etag);
    return detail;
  });
