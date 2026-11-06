import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import {
  applyContactChanges,
  type ContactChanges,
  newVCard,
} from './vcard-write';

const now = Date.UTC(2026, 9, 28, 9, 15, 0, 123);

const lines = (text: string) => text.trimEnd().split('\r\n');

const cardOf = (...properties: ReadonlyArray<string>) =>
  ['BEGIN:VCARD', 'VERSION:3.0', ...properties, 'END:VCARD', ''].join('\r\n');

const noChanges: ContactChanges = {
  addEmails: [],
  removeEmails: [],
  addPhones: [],
  removePhones: [],
};

// The vCard lines after the changes, or the reason they were refused.
const changed = (
  vcard: string,
  changes: Partial<ContactChanges>,
): ReadonlyArray<string> | string => {
  const applied = applyContactChanges(vcard, { ...noChanges, ...changes }, now);
  return Result.isSuccess(applied) ? lines(applied.success) : applied.failure;
};

describe('newVCard', () => {
  it('writes a vCard 3.0 with the name built from its parts', () => {
    const text = newVCard(
      {
        uid: 'u1',
        givenName: 'Ada',
        familyName: 'Lovelace',
        organization: 'Analytical; Engines',
        emails: [{ value: 'ada@example.org' }, { value: 'ADA@example.org' }],
        phones: [{ value: '+49 170 1234567' }],
      },
      now,
    );
    expect(lines(text)).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//pim//EN',
      'UID:u1',
      'N:Lovelace;Ada;;;',
      'ORG:Analytical\\; Engines',
      'FN:Ada Lovelace',
      'EMAIL:ada@example.org',
      'TEL:+49 170 1234567',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('writes the types passed with the values', () => {
    const text = newVCard(
      {
        uid: 'u1',
        name: 'Ada',
        emails: [
          { value: 'ada@example.org' },
          { value: 'ADA@example.org', type: 'work' },
        ],
        phones: [{ value: '+49 170 1234567', type: 'cell,home' }],
      },
      now,
    );
    expect(lines(text)).toEqual(
      expect.arrayContaining([
        'EMAIL;TYPE=work:ada@example.org',
        'TEL;TYPE=cell,home:+49 170 1234567',
      ]),
    );
  });

  it('prefers the given name to show', () => {
    const text = newVCard(
      { uid: 'u1', name: 'Dr. Ada', emails: [], phones: [] },
      now,
    );
    expect(lines(text)).toContain('FN:Dr. Ada');
  });
});

const appleCard = cardOf(
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'item1.EMAIL;type=INTERNET;type=pref:ada@example.org',
  'item1.X-ABLabel:_$!<Work>!$_',
  'item2.EMAIL:other@example.org',
  'item2.X-ABLabel:home',
  'item3.EMAIL:shared@example.org',
  'item3.TEL:+1 555 0100',
  'item3.X-ABLabel:office',
  'item4.EMAIL:old@example.org',
  'item4.X-ABLabel:old',
  'item4.X-Custom:keep',
  'TEL;type=CELL:+49 (170) 123-4567',
  'REV:20200101T000000Z',
);

describe('applyContactChanges', () => {
  it('removes values with their labels and keeps other lines as stored', () => {
    expect(
      changed(appleCard, {
        addEmails: [
          { value: 'new@example.org' },
          { value: 'OTHER@example.org' },
        ],
        removeEmails: [
          'ADA@example.org',
          'shared@example.org',
          'old@example.org',
        ],
        removePhones: ['+491701234567'],
      }),
    ).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ada Lovelace',
      'N:Lovelace;Ada;;;',
      'item2.EMAIL:other@example.org',
      'item2.X-ABLabel:home',
      'item3.TEL:+1 555 0100',
      'item3.X-ABLabel:office',
      'item4.X-ABLabel:old',
      'item4.X-Custom:keep',
      'EMAIL:new@example.org',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('keeps properties it does not change as stored', () => {
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Cy',
      'ORG:Solo\\;Org',
      'TEL;VALUE=uri;TYPE="voice,cell":tel:+49-170-1234567',
      'BDAY:--0415',
      `NOTE:${'long '.repeat(20)}`,
      ' folded',
      'END:VCARD',
    ];
    expect(changed(v4.join('\n'), { title: 'Analyst' })).toEqual([
      ...v4.slice(0, -1),
      'TITLE:Analyst',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('keeps the name in step with the parts it was built from', () => {
    expect(changed(appleCard, { familyName: 'King' })).toEqual(
      expect.arrayContaining(['FN:Ada King', 'N:King;Ada;;;']),
    );
  });

  it('keeps a name that was not built from the parts', () => {
    const card = cardOf('FN:Countess', 'N:Lovelace;Ada;;Lady;');
    expect(changed(card, { givenName: 'Augusta' })).toEqual(
      expect.arrayContaining(['FN:Countess', 'N:Lovelace;Augusta;;Lady;']),
    );
    expect(changed(card, { name: 'Ada' })).toContain('FN:Ada');
  });

  it('removes text fields given as empty', () => {
    const card = cardOf('FN:Ada', 'ORG:Engines', 'TITLE:Analyst', 'NOTE:x');
    expect(changed(card, { organization: '', title: '', note: '' })).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ada',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it.each(['N;X-A=1;X-A=2:Lovelace;Ada;;;', 'N:Lovelace,Byron'])(
    'refuses to change the name parts of %p, which it cannot write back as stored',
    (line) => {
      expect(changed(cardOf('FN:Ada', line), { givenName: 'Augusta' })).toBe(
        'pim cannot change the name parts without rewriting the rest of the stored N line, so it leaves the contact alone; the user can change the name in a contacts app',
      );
    },
  );

  it.each([
    [
      { removeEmails: ['nobody@example.org'] },
      'nobody@example.org is not an email address of this contact',
    ],
    [
      { removePhones: ['+1 555'] },
      '+1 555 is not a phone number of this contact',
    ],
    [
      { givenName: '', familyName: '' },
      'the contact would have no name; pass --name, --given-name, --family-name, or --organization',
    ],
  ])('refuses %p', (changes, reason) => {
    expect(changed(appleCard, changes)).toBe(reason);
  });
});

describe('applyContactChanges with types', () => {
  it('sets the type of a value the contact has and drops its label', () => {
    expect(
      changed(appleCard, {
        addEmails: [
          { value: 'ADA@example.org', type: 'home' },
          { value: 'shared@example.org', type: 'work' },
          { value: 'old@example.org', type: 'work' },
        ],
        addPhones: [{ value: '+491701234567', type: 'work' }],
      }),
    ).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ada Lovelace',
      'N:Lovelace;Ada;;;',
      'EMAIL;TYPE=internet,pref,home:ada@example.org',
      'item2.EMAIL:other@example.org',
      'item2.X-ABLabel:home',
      'EMAIL;TYPE=work:shared@example.org',
      'item3.TEL:+1 555 0100',
      'item3.X-ABLabel:office',
      'EMAIL;TYPE=work:old@example.org',
      'item4.X-ABLabel:old',
      'item4.X-Custom:keep',
      'TEL;TYPE=work:+49 (170) 123-4567',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('keeps a stored value as it is without a type', () => {
    expect(
      changed(appleCard, { addPhones: [{ value: '+491701234567' }] }),
    ).toContain('TEL;type=CELL:+49 (170) 123-4567');
  });

  it.each([
    [
      'VERSION:4.0',
      'TEL;VALUE=uri;TYPE="voice,cell":tel:+49-170-1234567',
      'TEL;VALUE=uri;TYPE=voice,work:tel:+49-170-1234567',
    ],
    [
      'VERSION:4.0',
      'TEL;VALUE=text;TYPE=cell:+49 170 1234567',
      'TEL;VALUE=text;TYPE=work:+49 170 1234567',
    ],
    [
      'VERSION:3.0',
      'TEL;VALUE=uri:tel:+49-170-1234567',
      'TEL;VALUE=uri;TYPE=work:tel:+49-170-1234567',
    ],
  ])('keeps the value type of %s %s', (version, line, written) => {
    const card = ['BEGIN:VCARD', version, 'FN:Ada', line, 'END:VCARD'].join(
      '\r\n',
    );
    expect(
      changed(card, {
        addPhones: [{ value: '+491701234567', type: 'work' }],
      }),
    ).toContain(written);
  });
});

describe('applyContactChanges with the type of a stored line', () => {
  it.each([
    [
      'TEL;VALUE=text;TYPE=home:+123\\;456',
      { addPhones: [{ value: '+123456', type: 'work' }] },
      'TEL;VALUE=text;TYPE=work:+123\\;456',
    ],
    [
      'EMAIL;TYPE=HOME;X-FOO=one;X-FOO=two:a@example.org',
      { addEmails: [{ value: 'a@example.org', type: 'work' }] },
      'EMAIL;X-FOO=one;X-FOO=two;TYPE=work:a@example.org',
    ],
    [
      'EMAIL;X-FOO="a:b":a@example.org',
      { addEmails: [{ value: 'a@example.org', type: 'work' }] },
      'EMAIL;X-FOO="a:b";TYPE=work:a@example.org',
    ],
    [
      'EMAIL;X-FOO="a;type=b";Type=pref;type=CELL:a@example.org',
      { addEmails: [{ value: 'a@example.org', type: 'work' }] },
      'EMAIL;X-FOO="a;type=b";TYPE=pref,work:a@example.org',
    ],
    [
      'EMAIL;TY\r\n PE=HOME:a@\r\n\texample.org',
      { addEmails: [{ value: 'a@example.org', type: 'work' }] },
      'EMAIL;TYPE=work:a@example.org',
    ],
    [
      'email;x-foo=^n:a@example.org',
      {
        addEmails: [
          { value: 'a@example.org', type: 'home' },
          { value: 'A@example.org', type: 'work' },
        ],
      },
      'email;x-foo=^n;TYPE=work:a@example.org',
    ],
    // ical.js reads a stray quote that a quote-aware split cannot place, so it
    // writes such a line, with the quote encoded as RFC 6868 says.
    [
      'EMAIL;X-FOO=a"b;TYPE=home:a@example.org',
      { addEmails: [{ value: 'a@example.org', type: 'work' }] },
      "EMAIL;X-FOO=a^'b;TYPE=work:a@example.org",
    ],
  ])('changes only the type parameters of %s', (line, changes, written) => {
    expect(changed(cardOf('FN:Ada', line), changes)).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ada',
      written,
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('folds a stored line again after changing its type', () => {
    const parameter = `X-FOO=${'x'.repeat(70)}`;
    expect(
      changed(cardOf('FN:Ada', `EMAIL;${parameter}:a@example.org`), {
        addEmails: [{ value: 'a@example.org', type: 'work' }],
      }),
    ).toEqual(
      expect.arrayContaining([
        `EMAIL;${parameter.slice(0, 69)}`,
        ` ${parameter.slice(69)};TYPE=work:a@example.org`,
      ]),
    );
  });
});
