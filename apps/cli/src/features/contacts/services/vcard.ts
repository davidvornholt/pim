import { Effect } from 'effect';
import ICAL from 'ical.js';
import { ContactDataError } from '../errors/errors';
import type {
  ContactDetail,
  PostalAddress,
  TypedValue,
} from '../schemas/contacts';

export const parseVCard = (
  href: string,
  text: string,
): Effect.Effect<ICAL.Component, ContactDataError> =>
  Effect.try({
    try: () => new ICAL.Component(ICAL.parse(text)),
    catch: (cause) =>
      new ContactDataError({
        href,
        message: `${href} is not valid vCard data: ${String(cause)}`,
      }),
  }).pipe(
    Effect.filterOrFail(
      (component) => component.name === 'vcard',
      () =>
        new ContactDataError({
          href,
          message: `${href} holds no contact (VCARD)`,
        }),
    ),
  );

export const clean = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? undefined : text;
};

export const firstText = (
  card: ICAL.Component,
  name: string,
): string | undefined => clean(card.getFirstPropertyValue(name)?.toString());

// Structured values such as N, ORG, and ADR come back as arrays of parts,
// or as the one part itself, already unescaped, when there is only one.
export const parts = (
  card: ICAL.Component,
  name: string,
): ReadonlyArray<string> => {
  const value: unknown = card.getFirstPropertyValue(name);
  if (Array.isArray(value)) {
    return value.map((part) =>
      Array.isArray(part) ? part.join(' ') : String(part ?? ''),
    );
  }
  return typeof value === 'string' ? [value] : [];
};

export const joined = (
  values: ReadonlyArray<string>,
  separator: string,
): string | undefined =>
  clean(
    values
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .join(separator),
  );

// TYPE values that say how a value is encoded rather than what it is for.
const technicalTypes = new Set(['internet', 'pref', 'x400', 'voice']);

const typesOf = (property: ICAL.Property): ReadonlyArray<string> => {
  const raw: unknown = property.getParameter('type');
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((type) => (typeof type === 'string' ? type.split(',') : []))
    .map((type) => type.trim().toLowerCase())
    .filter((type) => type !== '');
};

export const technicalTypesOf = (
  property: ICAL.Property,
): ReadonlyArray<string> =>
  typesOf(property).filter((type) => technicalTypes.has(type));

const typeOf = (property: ICAL.Property): string | undefined => {
  const types = typesOf(property).filter((type) => !technicalTypes.has(type));
  return types.length === 0 ? undefined : types.join(',');
};

const uriScheme = /^(?:mailto|tel):/iu;

const typedValues = (
  card: ICAL.Component,
  name: string,
): ReadonlyArray<TypedValue> =>
  card.getAllProperties(name).flatMap((property) => {
    const value = clean(
      String(property.getFirstValue() ?? '').replace(uriScheme, ''),
    );
    const type = typeOf(property);
    return value === undefined
      ? []
      : [{ value, ...(type === undefined ? {} : { type }) }];
  });

const allTexts = (card: ICAL.Component, name: string): ReadonlyArray<string> =>
  card
    .getAllProperties(name)
    .flatMap((property) => property.getValues())
    .flatMap((value) => {
      const cleaned = clean(String(value ?? ''));
      return cleaned === undefined ? [] : [cleaned];
    });

const addressPartNames = [
  'poBox',
  'extended',
  'street',
  'locality',
  'region',
  'postalCode',
  'country',
] as const;

const addressesOf = (card: ICAL.Component): ReadonlyArray<PostalAddress> =>
  card.getAllProperties('adr').flatMap((property) => {
    const value: unknown = property.getFirstValue();
    const fields = Array.isArray(value) ? value : [];
    const address: Record<string, string> = {};
    addressPartNames.forEach((part, index) => {
      const field: unknown = fields[index];
      const cleaned = clean(Array.isArray(field) ? field.join(', ') : field);
      if (cleaned !== undefined && part !== 'poBox' && part !== 'extended') {
        address[part] = cleaned;
      }
    });
    const type = typeOf(property);
    return Object.keys(address).length === 0
      ? []
      : [{ ...(type === undefined ? {} : { type }), ...address }];
  });

// The name to show: FN, else the structured name, organization, or email.
export const displayName = (card: ICAL.Component): string => {
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] =
    parts(card, 'n');
  return (
    firstText(card, 'fn') ??
    joined([prefix, given, additional, family, suffix], ' ') ??
    joined(parts(card, 'org'), ', ') ??
    typedValues(card, 'email')[0]?.value ??
    ''
  );
};

export const organizationOf = (card: ICAL.Component): string | undefined =>
  joined(parts(card, 'org'), ', ');

export const emailsOf = (card: ICAL.Component): ReadonlyArray<string> =>
  typedValues(card, 'email').map(({ value }) => value);

export const phonesOf = (card: ICAL.Component): ReadonlyArray<string> =>
  typedValues(card, 'tel').map(({ value }) => value);

const optional = <K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };

export const contactDetail = (
  card: ICAL.Component,
  context: {
    readonly account: string;
    readonly href: string;
    readonly etag: string | undefined;
  },
): ContactDetail => {
  const [family, given] = parts(card, 'n');
  return {
    account: context.account,
    href: context.href,
    ...optional('etag', context.etag),
    ...optional('uid', firstText(card, 'uid')),
    name: displayName(card),
    ...optional('familyName', clean(family)),
    ...optional('givenName', clean(given)),
    ...optional('nickname', joined(allTexts(card, 'nickname'), ', ')),
    ...optional('organization', organizationOf(card)),
    ...optional('title', firstText(card, 'title')),
    emails: typedValues(card, 'email'),
    phones: typedValues(card, 'tel'),
    addresses: addressesOf(card),
    ...optional('birthday', firstText(card, 'bday')),
    urls: allTexts(card, 'url'),
    categories: allTexts(card, 'categories'),
    ...optional('note', firstText(card, 'note')),
  };
};
