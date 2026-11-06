import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  discoveryRoutes,
  type FakeRoute,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import {
  type ContactTarget,
  createContact,
  deleteContact,
  updateContact,
} from './contacts-write';
import type { ContactChanges } from './vcard-write';

type Routes = Readonly<Record<string, FakeRoute>>;

const privileges = (name: string) =>
  `<d:current-user-privilege-set><d:privilege><d:${name}/></d:privilege></d:current-user-privilege-set>`;

const bookRoutes: Routes = {
  ...discoveryRoutes,
  'PROPFIND /addressbooks/me/': {
    body: multistatus(
      davResponse(
        '/addressbooks/me/contacts/',
        `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>${privileges('write')}`,
      ),
      davResponse(
        '/addressbooks/me/company/',
        `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Company</d:displayname>${privileges('read')}`,
      ),
    ),
  },
};

const newHref = /^\/addressbooks\/me\/contacts\/(?<uid>[0-9a-f-]{36})\.vcf$/u;

const ada = {
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: [],
  phones: [],
};

describe('createContact', () => {
  it('stores a new contact without replacing one', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      {
        ...bookRoutes,
        'PUT /addressbooks/me/contacts/*': {
          status: 201,
          // Unquoted, as Infomaniak sends it.
          headers: { etag: 'c1' },
        },
      },
      createContact(davAccount, {
        addressBook: 'Contacts',
        ...ada,
        emails: [{ value: 'ada@example.org', type: 'work' }],
      }),
    );
    const { uid } = newHref.exec(value.href)?.groups ?? {};
    expect(value).toMatchObject({
      href: expect.stringMatching(newHref),
      etag: '"c1"',
      uid: uid ?? 'no uid in the href',
      name: 'Ada Lovelace',
      emails: [{ value: 'ada@example.org', type: 'work' }],
    });
    const [put] = writeRequests(requests);
    expect(put?.headers.get('if-none-match')).toBe('*');
    expect(put?.headers.get('content-type')).toBe('text/vcard; charset=utf-8');
    expect(put?.body).toContain(`UID:${uid}`);
  });

  it('refuses an address book the user may only read', async () => {
    const { error, requests } = await failsOnFakeDav(
      bookRoutes,
      createContact(davAccount, { addressBook: 'Company', ...ada }),
    );
    expect(error._tag).toBe('ReadOnlyAddressBookError');
    expect(writeRequests(requests)).toEqual([]);
  });
});

const href = '/addressbooks/me/contacts/a.vcf';

const vcardOf = (...properties: ReadonlyArray<string>) =>
  ['BEGIN:VCARD', 'VERSION:3.0', ...properties, 'END:VCARD', ''].join('\r\n');

const stored = vcardOf(
  'UID:a',
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'EMAIL:ada@example.org',
);

// The contact at href, whose GET answers with these headers.
const contactRoutes = (
  vcard: string,
  headers: Readonly<Record<string, string>> = { etag: '"v1"' },
): Routes => ({
  [`GET ${href}`]: { status: 200, body: vcard, headers },
  [`PUT ${href}`]: { status: 204, headers: { etag: '"v2"' } },
  [`DELETE ${href}`]: { status: 204 },
});

const target: ContactTarget = { href, etag: '"v1"' };

const changes = (wanted: Partial<ContactChanges>): ContactChanges => ({
  addEmails: [],
  removeEmails: [],
  addPhones: [],
  removePhones: [],
  ...wanted,
});

describe('updateContact', () => {
  it('changes the version the caller read', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      contactRoutes(stored),
      updateContact(
        davAccount,
        target,
        changes({ addPhones: [{ value: '+49 170 1234567', type: 'cell' }] }),
      ),
    );
    expect(value).toMatchObject({
      etag: '"v2"',
      phones: [{ value: '+49 170 1234567', type: 'cell' }],
    });
    const [put] = writeRequests(requests);
    expect(put?.method).toBe('PUT');
    expect(put?.headers.get('if-match')).toBe('"v1"');
    expect(put?.body).toContain('TEL;TYPE=cell:+49 170 1234567');
  });

  const retitled = changes({ title: 'Analyst' });

  it.each([
    [
      'a contact that changed since it was read',
      contactRoutes(stored, { etag: '"v9"' }),
      retitled,
      'DavConflictError',
    ],
    [
      'a contact the server gives no etag for',
      contactRoutes(stored, {}),
      retitled,
      'ContactChangeError',
    ],
    [
      'a contact group',
      contactRoutes(vcardOf('FN:Team', 'X-ADDRESSBOOKSERVER-KIND:group')),
      retitled,
      'ContactChangeError',
    ],
    [
      'a vCard 2.1',
      contactRoutes(stored.replace('VERSION:3.0', 'VERSION:2.1')),
      retitled,
      'ContactChangeError',
    ],
    [
      'removing an address the contact lacks',
      contactRoutes(stored),
      changes({ removeEmails: ['nobody@example.org'] }),
      'ContactChangeError',
    ],
    [
      'a contact pim cannot read back',
      contactRoutes(vcardOf('UID:a', 'FN:Ada', 'BDAY:garbage')),
      retitled,
      'ContactDataError',
    ],
  ])('refuses %s', async (_name, routes, wanted, tag) => {
    const { error, requests } = await failsOnFakeDav(
      routes,
      updateContact(davAccount, target, wanted),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writeRequests(requests)).toEqual([]);
  });

  it('reports a change the server refused for its version', async () => {
    const { error } = await failsOnFakeDav(
      { ...contactRoutes(stored), [`PUT ${href}`]: { status: 412 } },
      updateContact(davAccount, target, changes({ title: 'Analyst' })),
    );
    expect(error._tag).toBe('DavConflictError');
  });
});

describe('deleteContact', () => {
  it('deletes the version the caller read', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      contactRoutes(stored),
      deleteContact(davAccount, target),
    );
    expect(value).toMatchObject({ href, name: 'Ada Lovelace' });
    expect(value).not.toHaveProperty('etag');
    const [deletion] = writeRequests(requests);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers.get('if-match')).toBe('"v1"');
  });

  it('refuses a contact group', async () => {
    const { error, requests } = await failsOnFakeDav(
      contactRoutes(vcardOf('FN:Team', 'KIND:individual', 'KIND: group ')),
      deleteContact(davAccount, target),
    );
    expect(error._tag).toBe('ContactChangeError');
    expect(writeRequests(requests)).toEqual([]);
  });

  it.each(['*', '"v1", "v2"'])(
    'refuses the etag %p, which names no single version',
    async (etag) => {
      const { error, requests } = await failsOnFakeDav(
        contactRoutes(stored, { etag }),
        deleteContact(davAccount, { href, etag }),
      );
      expect(error._tag).toBe('DavError');
      expect(writeRequests(requests)).toEqual([]);
    },
  );
});
