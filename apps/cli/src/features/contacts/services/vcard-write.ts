import { Result } from 'effect';
import ICAL from 'ical.js';
import type { TypedValue } from '../schemas/contacts';
import { clean, firstText, joined, parts, technicalTypesOf } from './vcard';

const productId = '-//pim//EN';
// New contacts are vCard 3.0, which every CardDAV server and client reads.
const newCardTemplate = 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n';
const nameFieldCount = 5;

// The text fields pim writes. An empty value removes the field.
export type ContactText = {
  readonly name?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly organization?: string;
  readonly title?: string;
  readonly note?: string;
};

export type NewContact = ContactText & {
  readonly uid: string;
  readonly emails: ReadonlyArray<TypedValue>;
  readonly phones: ReadonlyArray<TypedValue>;
};

export type ContactChanges = ContactText & {
  readonly addEmails: ReadonlyArray<TypedValue>;
  readonly removeEmails: ReadonlyArray<string>;
  readonly addPhones: ReadonlyArray<TypedValue>;
  readonly removePhones: ReadonlyArray<string>;
};

const fractionalSeconds = /\.\d+Z$/u;
const mailtoScheme = /^mailto:/iu;
const nonDigits = /\D/gu;

const timestamp = (ms: number): string =>
  new Date(ms).toISOString().replace(fractionalSeconds, 'Z');

const emailKey = (value: string): string =>
  value.replace(mailtoScheme, '').trim().toLowerCase();

const phoneKey = (value: string): string => value.replace(nonDigits, '');

const textValue = (property: ICAL.Property): string =>
  String(property.getFirstValue() ?? '');

// Replaces the property rather than its value, so parameters that describe
// the old text go with it. ORG is a structured value of one part here.
const setText = (card: ICAL.Component, name: string, value: string): void => {
  card.removeAllProperties(name);
  if (value !== '') {
    card.addPropertyWithValue(name, name === 'org' ? [value] : value);
  }
};

const textProperties = {
  organization: 'org',
  title: 'title',
  note: 'note',
} as const;

const setTexts = (card: ICAL.Component, text: ContactText): void => {
  for (const [field, name] of Object.entries(textProperties)) {
    const value = text[field as keyof typeof textProperties];
    if (value !== undefined) {
      setText(card, name, value);
    }
  }
};

// The name contact apps show when FN is missing: the structured name, else
// the organization.
const derivedName = (card: ICAL.Component): string | undefined => {
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] =
    parts(card, 'n');
  return (
    joined([prefix, given, additional, family, suffix], ' ') ??
    joined(parts(card, 'org'), ', ')
  );
};

// Changes the family and given parts of N and keeps the others as stored.
const setNameParts = (card: ICAL.Component, text: ContactText): void => {
  const value: unknown = card.getFirstPropertyValue('n');
  // A one-part value comes back as that part.
  const stored: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value];
  const name: Array<unknown> = Array.from(
    { length: Math.max(nameFieldCount, stored.length) },
    (_, index) => stored[index] ?? '',
  );
  name[0] = text.familyName ?? name[0];
  name[1] = text.givenName ?? name[1];
  card.updatePropertyWithValue('n', name);
};

const groupOf = (property: ICAL.Property): string | undefined => {
  const group: unknown = property.getParameter('group');
  return typeof group === 'string' ? group.toLowerCase() : undefined;
};

// Removes the labels Apple keeps in the group of the property, such as
// item1.X-ABLabel for item1.EMAIL, unless the group holds something else.
const removeLabels = (card: ICAL.Component, property: ICAL.Property): void => {
  const group = groupOf(property);
  if (group === undefined) {
    return;
  }
  const rest = card
    .getAllProperties()
    .filter((other) => other !== property && groupOf(other) === group);
  if (rest.every((other) => other.name === 'x-ablabel')) {
    for (const label of rest) {
      card.removeProperty(label);
    }
  }
};

// Removes every property whose value has the key of one of the values.
// Fails with the first value the contact lacks.
const removeValues = (
  card: ICAL.Component,
  name: string,
  values: ReadonlyArray<string>,
  key: (value: string) => string,
): Result.Result<void, string> => {
  const properties = card.getAllProperties(name);
  const missing = values.find(
    (value) =>
      !properties.some((property) => key(textValue(property)) === key(value)),
  );
  if (missing !== undefined) {
    return Result.fail(missing);
  }
  const keys = new Set(values.map(key));
  for (const property of properties) {
    if (keys.has(key(textValue(property)))) {
      removeLabels(card, property);
      card.removeProperty(property);
    }
  }
  return Result.void;
};

type StoredProperty = { readonly text: string; readonly jCal: string };

type EditedCard = {
  readonly card: ICAL.Component;
  readonly stored: Map<ICAL.Property, StoredProperty>;
};

const fold = /\r\n[ \t]/gu;

// An unfolded stored line, matching only where this split and ical.js read it
// alike. ical.js also accepts a stray quote, as in X-FOO=a"b, so every value
// must be quoted whole or hold no quote. Past the first of several values,
// ical.js ends the parameter at ; or : even in quotes and can fail at =, so
// those values must hold none of them.
const storedLine =
  /^(?:[^";:.]+\.)?(?<name>[^";:.]+)(?<parameters>(?:;[^";:=]+=(?:"[^"]*"|[^";:,]*)(?:,(?:"[^";:=]*"|[^";:,=]*))*)*):(?<value>.*)$/su;
const storedParameter = /;(?<name>[^=]+)=(?:"[^"]*"|[^";])*/gu;

const withTypes = (
  text: string,
  types: ReadonlyArray<string>,
): string | undefined => {
  const { name, parameters, value } =
    storedLine.exec(text.replace(fold, ''))?.groups ?? {};
  if (name === undefined || parameters === undefined || value === undefined) {
    return undefined;
  }
  const kept = parameters.replace(
    storedParameter,
    (parameter, parameterName: string) =>
      parameterName.toUpperCase() === 'TYPE' ? '' : parameter,
  );
  return ICAL.helpers.foldline(
    `${name}${kept};TYPE=${types.join(',')}:${value}`,
  );
};

// TYPE values such as pref stay, because they say nothing about what the value
// is for. The property leaves its labeled group, because Apple shows a label
// over the type. The stored text is patched because ical.js would also change
// the rest of the line: it adds a backslash to a value such as +123\;456 and
// keeps only the last of a repeated parameter.
const setType = (
  { card, stored }: EditedCard,
  property: ICAL.Property,
  type: string,
): void => {
  const types = [
    ...new Set([...technicalTypesOf(property), ...type.split(',')]),
  ];
  property.setParameter('type', types);
  removeLabels(card, property);
  property.removeParameter('group');
  const original = stored.get(property);
  const text = original && withTypes(original.text, types);
  if (text !== undefined) {
    stored.set(property, { text, jCal: JSON.stringify(property.toJSON()) });
  }
};

const addValues = (
  edited: EditedCard,
  name: string,
  values: ReadonlyArray<TypedValue>,
  key: (value: string) => string,
): void => {
  for (const { value, type } of values) {
    const holding = edited.card
      .getAllProperties(name)
      .filter((property) => key(textValue(property)) === key(value));
    const properties =
      holding.length > 0
        ? holding
        : [edited.card.addPropertyWithValue(name, value)];
    if (type !== undefined) {
      for (const property of properties) {
        setType(edited, property, type);
      }
    }
  }
};

export const newVCard = (contact: NewContact, nowMs: number): string => {
  const card = new ICAL.Component(ICAL.parse(newCardTemplate));
  card.addPropertyWithValue('prodid', productId);
  card.addPropertyWithValue('uid', contact.uid);
  card.addPropertyWithValue('n', [
    contact.familyName ?? '',
    contact.givenName ?? '',
    '',
    '',
    '',
  ]);
  setTexts(card, contact);
  card.addPropertyWithValue(
    'fn',
    clean(contact.name) ?? derivedName(card) ?? '',
  );
  const edited = { card, stored: new Map() };
  addValues(edited, 'email', contact.emails, emailKey);
  addValues(edited, 'tel', contact.phones, phoneKey);
  card.addPropertyWithValue('rev', timestamp(nowMs));
  return card.toString();
};

const lineBreak = /\r?\n/u;
const continuation = /^[ \t]/u;

// The content lines of a vCard as stored, each with its folded
// continuation lines.
const contentLines = (text: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const line of text.split(lineBreak)) {
    const last = lines.length - 1;
    if (continuation.test(line) && last >= 0) {
      lines[last] = `${lines[last]}\r\n${line}`;
    } else if (line.trim() !== '') {
      lines.push(line);
    }
  }
  return lines;
};

// The stored text of each property ical.js read from the vCard, provided
// the lines and properties pair up one to one.
const storedProperties = (
  text: string,
  card: ICAL.Component,
): Map<ICAL.Property, StoredProperty> | undefined => {
  const lines = contentLines(text);
  const inner = lines.slice(1, -1);
  const properties = card.getAllProperties();
  const isCard =
    lines[0]?.trim().toUpperCase() === 'BEGIN:VCARD' &&
    lines.at(-1)?.trim().toUpperCase() === 'END:VCARD';
  return isCard && inner.length === properties.length
    ? new Map(
        properties.map((property, index) => [
          property,
          { text: inner[index] ?? '', jCal: JSON.stringify(property.toJSON()) },
        ]),
      )
    : undefined;
};

// Whether ical.js writes the property as stored, apart from the case of its
// name, group, and parameter names. N is changed in place, so this tells
// whether the parts pim keeps survive the change; ical.js merges repeated
// parameters and reads N:A,B as two parts.
const writtenAsStored = (
  property: ICAL.Property,
  stored: ReadonlyMap<ICAL.Property, StoredProperty>,
): boolean =>
  stored.get(property)?.text.replace(fold, '').toLowerCase() ===
  property.toICALString().toLowerCase();

// ical.js does not write every vCard back as it read it: it drops
// VALUE=uri from vCard 4 phone numbers and the escape from a one-part
// value such as ORG:A\;B. So a property whose JSON still matches its entry
// keeps the stored text there, and only other changed and new properties are
// written by ical.js.
const serialize = (
  card: ICAL.Component,
  stored: ReadonlyMap<ICAL.Property, StoredProperty>,
): string =>
  [
    'BEGIN:VCARD',
    ...card.getAllProperties().map((property) => {
      const original = stored.get(property);
      return original?.jCal === JSON.stringify(property.toJSON())
        ? original.text
        : ICAL.helpers.foldline(property.toICALString());
    }),
    'END:VCARD',
    '',
  ].join('\r\n');

// The vCard text with the changes applied, or the reason pim does not make
// them. FN follows the structured name and organization when it was made
// from them, as contact apps do.
export const applyContactChanges = (
  vcard: string,
  changes: ContactChanges,
  nowMs: number,
): Result.Result<string, string> => {
  const card = new ICAL.Component(ICAL.parse(vcard));
  const stored = storedProperties(vcard, card);
  if (stored === undefined) {
    return Result.fail(
      'pim could not match the stored vCard lines to its properties, so it leaves the contact alone',
    );
  }
  const before = { name: firstText(card, 'fn'), derived: derivedName(card) };
  const removedEmails = removeValues(
    card,
    'email',
    changes.removeEmails,
    emailKey,
  );
  if (Result.isFailure(removedEmails)) {
    return Result.fail(
      `${removedEmails.failure} is not an email address of this contact`,
    );
  }
  const removedPhones = removeValues(
    card,
    'tel',
    changes.removePhones,
    phoneKey,
  );
  if (Result.isFailure(removedPhones)) {
    return Result.fail(
      `${removedPhones.failure} is not a phone number of this contact`,
    );
  }
  addValues({ card, stored }, 'email', changes.addEmails, emailKey);
  addValues({ card, stored }, 'tel', changes.addPhones, phoneKey);
  if (changes.givenName !== undefined || changes.familyName !== undefined) {
    const nameProperty = card.getFirstProperty('n');
    if (nameProperty !== null && !writtenAsStored(nameProperty, stored)) {
      return Result.fail(
        'pim cannot change the name parts without rewriting the rest of the stored N line, so it leaves the contact alone; the user can change the name in a contacts app',
      );
    }
    setNameParts(card, changes);
  }
  setTexts(card, changes);
  const followsName =
    before.name === undefined || before.name === before.derived;
  const name =
    clean(changes.name) ?? (followsName ? derivedName(card) : before.name);
  if (name === undefined) {
    return Result.fail(
      'the contact would have no name; pass --name, --given-name, --family-name, or --organization',
    );
  }
  if (name !== before.name) {
    setText(card, 'fn', name);
  }
  card.removeAllProperties('rev');
  card.addPropertyWithValue('rev', timestamp(nowMs));
  return Result.succeed(serialize(card, stored));
};
