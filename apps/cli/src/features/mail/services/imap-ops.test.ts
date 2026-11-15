import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { Effect } from 'effect';
import type { ImapFlow } from 'imapflow';
import { readMessage } from './imap-ops';
import { buildReplyContent } from './reply-quote';

const frozenTime = new Date('2031-02-03T04:05:06.000Z');
const messageUid = 42;
const inboxMessage = { folder: 'INBOX', uid: messageUid, uidValidity: '111' };
const replyHtmlLineCount = 3;
const sourceFor = (
  dates: ReadonlyArray<string>,
  from = 'Original Sender <original@example.com>',
): Buffer => {
  const dateHeaders = dates.map((date) =>
    date === '' ? 'Date:' : `Date: ${date}`,
  );
  return Buffer.from(
    [
      ...dateHeaders,
      `From: ${from}`,
      'To: recipient@example.com',
      'Subject: Question',
      'Message-ID: <current@example.com>',
      '',
      'Original body',
    ].join('\r\n'),
  );
};
const readSource = (source: Buffer) => {
  const client = {
    mailbox: { uidValidity: 111n },
    getMailboxLock: () => Promise.resolve({ release: () => undefined }),
    fetchOne: () => Promise.resolve({ uid: messageUid, source }),
  } as unknown as ImapFlow;
  return Effect.runPromise(readMessage(client, inboxMessage));
};
const readDateCases = <
  TestCase extends { readonly dates: ReadonlyArray<string> },
>(
  cases: ReadonlyArray<TestCase>,
  from?: string,
) =>
  Promise.all(
    cases.map(async (testCase) => ({
      message: await readSource(sourceFor(testCase.dates, from)),
      testCase,
    })),
  );

afterEach(() => {
  setSystemTime();
});

describe('readMessage handle', () => {
  it('prints the uidValidity that reads the message again', async () => {
    const message = await readSource(
      sourceFor(['Tue, 14 Jul 2026 08:00:00 +0000']),
    );

    expect({
      folder: message.folder,
      uid: message.uid,
      uidValidity: message.uidValidity,
    }).toEqual(inboxMessage);
  });
});

describe('readMessage reply attribution dates', () => {
  it('carries raw Date semantics from MIME parsing into reply attribution', async () => {
    setSystemTime(frozenTime);
    const zoneBearingDate = 'Mon, 13 Jul 2026 10:30:00 +0200';
    const zoneBearingMessage = await readSource(sourceFor([zoneBearingDate]));
    const zoneBearingReply = buildReplyContent(
      'Reply',
      '<p>Reply</p>',
      zoneBearingMessage,
    );
    const zoneBearingAttribution = zoneBearingReply.text.split('\n').at(2);
    expect(zoneBearingMessage.date).toBe('2026-07-13T08:30:00.000Z');
    expect(zoneBearingMessage.attributionDate).toBe(zoneBearingDate);
    expect(zoneBearingAttribution?.startsWith('On ')).toBe(true);
    expect(
      zoneBearingAttribution?.endsWith(
        ', "Original Sender" <original@example.com> wrote:',
      ),
    ).toBe(true);
    expect(zoneBearingAttribution).not.toContain(zoneBearingDate);
    const literalCases = [
      {
        dates: ['Mon, 13 Jul 2026 10:30:00'],
        attributionDate: 'Mon, 13 Jul 2026 10:30:00',
        normalized: new Date('Mon, 13 Jul 2026 10:30:00').toISOString(),
        attribution:
          'On July 13, 2026 at 10:30, "Original Sender" <original@example.com> wrote:',
      },
      {
        dates: [],
        attributionDate: '',
        normalized: '',
        attribution: '"Original Sender" <original@example.com> wrote:',
      },
      {
        dates: [''],
        attributionDate: '',
        normalized: frozenTime.toISOString(),
        attribution: '"Original Sender" <original@example.com> wrote:',
      },
      {
        dates: ['A recent Tuesday'],
        attributionDate: 'A recent Tuesday',
        normalized: frozenTime.toISOString(),
        attribution:
          'On A recent Tuesday, "Original Sender" <original@example.com> wrote:',
      },
    ] as const;
    const results = await readDateCases(literalCases);
    for (const { message, testCase } of results) {
      const reply = buildReplyContent('Reply', '<p>Reply</p>', message);
      const attribution = reply.text.split('\n').at(2);
      expect(message.date).toBe(testCase.normalized);
      expect(message.attributionDate).toBe(testCase.attributionDate);
      expect(attribution).toBe(testCase.attribution);
    }
  });

  it('sanitizes the selected first raw Date before attribution', async () => {
    setSystemTime(frozenTime);
    const cases = [
      {
        dates: ['A recent Tuesday\r\n injected attribution line'],
        normalized: frozenTime.toISOString(),
        attributionDate: 'A recent Tuesday injected attribution line',
        attribution:
          'On A recent Tuesday injected attribution line, "Original Sender" <original@example.com> wrote:',
      },
      {
        dates: ['A recent Tuesday', 'Mon, 13 Jul 2026 10:30:00'],
        normalized: frozenTime.toISOString(),
        attributionDate: 'A recent Tuesday',
        attribution:
          'On A recent Tuesday, "Original Sender" <original@example.com> wrote:',
      },
      {
        dates: ['Mon, 13 Jul 2026 10:30:00', 'A recent Tuesday'],
        normalized: new Date('Mon, 13 Jul 2026 10:30:00').toISOString(),
        attributionDate: 'Mon, 13 Jul 2026 10:30:00',
        attribution:
          'On July 13, 2026 at 10:30, "Original Sender" <original@example.com> wrote:',
      },
      {
        dates: ['A recent Tuesday\r\r\n injected attribution line'],
        normalized: frozenTime.toISOString(),
        attributionDate: '',
        attribution: '"Original Sender" <original@example.com> wrote:',
      },
      {
        dates: [
          'A recent Tuesday\rFrom: Injected Sender <injected@example.com>',
        ],
        normalized: frozenTime.toISOString(),
        attributionDate: '',
        attribution: '"Original Sender" <original@example.com> wrote:',
      },
    ] as const;
    const results = await readDateCases(cases);
    for (const { message, testCase } of results) {
      const reply = buildReplyContent('Reply', '<p>Reply</p>', message);
      const attribution = reply.text.split('\n').at(2);
      expect(message.date).toBe(testCase.normalized);
      expect(message.attributionDate).toBe(testCase.attributionDate);
      expect(attribution).toBe(testCase.attribution);
      expect(reply.html).not.toContain('\r');
      expect(reply.html.split('\n')).toHaveLength(replyHtmlLineCount);
    }
  });
});

describe('readMessage reply attribution safety', () => {
  it('rejects control-bearing Date and From attribution values', async () => {
    setSystemTime(frozenTime);
    const controls = Array.from(
      '\u0000\u000b\u001b\u007f\u0085\u009f\u2028\u2029',
    );
    const controlCases = controls.map((control) => ({
      control,
      dates: [`A recent${control}Tuesday`],
    }));
    const controlResults = await readDateCases(controlCases);
    for (const { message, testCase } of controlResults) {
      const reply = buildReplyContent('Reply', '<p>Reply</p>', message);
      expect(message.attributionDate).toBe('');
      expect(reply.text.split('\n').at(2)).toBe(
        '"Original Sender" <original@example.com> wrote:',
      );
      expect(reply.html).not.toContain(testCase.control);
    }
    const encodedFrom =
      '=?UTF-8?B?T3JpZ2luYWwgU2VuZGVyDQpJbmplY3RlZCBhdHRyaWJ1dGlvbiBsaW5l?= <sender@example.com>';
    const senderCases = [
      {
        dates: ['A recent Tuesday'],
        attribution: 'On A recent Tuesday, the sender wrote:',
      },
      { dates: [], attribution: 'Previous message:' },
    ] as const;
    const senderResults = await readDateCases(senderCases, encodedFrom);
    for (const { message, testCase } of senderResults) {
      const reply = buildReplyContent('Reply', '<p>Reply</p>', message);
      expect(message.from).toContain('\r\n');
      expect(reply.text.split('\n').at(2)).toBe(testCase.attribution);
      expect(reply.text).not.toContain('Injected attribution line');
      expect(reply.html).not.toContain('Injected attribution line');
    }
  });
});

describe('readMessage plain text', () => {
  const htmlOnlySource = (textPart: string): Buffer =>
    Buffer.from(
      [
        'From: sender@example.com',
        'Subject: Newsletter',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        textPart,
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><h1>Hello</h1><p>First <b>line</b></p></body></html>',
        '--b--',
      ].join('\r\n'),
    );

  it('derives text from HTML when the text part is blank', async () => {
    const message = await readSource(htmlOnlySource(' '));
    expect(message.text).toContain('First line');
    expect(message.text).not.toContain('<');
    expect(message.html).toContain('<h1>Hello</h1>');
  });

  it('keeps a non-blank text part', async () => {
    const message = await readSource(htmlOnlySource('Plain version'));
    expect(message.text.trim()).toBe('Plain version');
  });
});

describe('missing IMAP messages', () => {
  it.each([false, undefined])(
    'returns a typed missing-message error for %s',
    async (missing) => {
      let released = false;
      const client = {
        mailbox: { uidValidity: 111n },
        getMailboxLock: () =>
          Promise.resolve({
            release: () => {
              released = true;
            },
          }),
        fetchOne: () => Promise.resolve(missing),
      } as unknown as ImapFlow;
      const result = await Effect.runPromise(
        Effect.result(readMessage(client, inboxMessage)),
      );
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'MessageNotFoundError' },
      });
      expect(released).toBe(true);
    },
  );
});

describe('stale message handles', () => {
  it('refuses to read a message after its folder was rebuilt', async () => {
    let fetched = false;
    const client = {
      mailbox: { uidValidity: 222n },
      getMailboxLock: () => Promise.resolve({ release: () => undefined }),
      fetchOne: () => {
        fetched = true;
        return Promise.resolve(false);
      },
    } as unknown as ImapFlow;
    const error = await Effect.runPromise(
      Effect.flip(readMessage(client, inboxMessage)),
    );
    expect(error._tag).toBe('StaleUidError');
    expect(fetched).toBe(false);
  });
});
