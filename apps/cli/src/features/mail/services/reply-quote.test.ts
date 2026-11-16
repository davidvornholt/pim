import { describe, expect, it } from 'bun:test';
import type { FullMessage } from '../schemas/mail';
import { buildReplyContent } from './reply-quote';

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const localTimestamp = (value: string): string => {
  const date = new Date(value);
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const message: FullMessage = {
  uid: 42,
  folder: 'INBOX',
  from: 'Sender & Co <sender@example.com>',
  replyTo: '',
  to: 'recipient@example.com',
  cc: '',
  bcc: '',
  subject: 'Question',
  date: '2026-07-13T08:30:00.000Z',
  attributionDate: '2026-07-13T08:30:00.000Z',
  messageId: '<current@example.com>',
  inReplyTo: '<first@example.com>',
  references: ['<first@example.com>', '<current@example.com>'],
  text: 'Is 2 < 3?\nYes & no.',
  html: '<img src="https://example.com/tracking-pixel">',
  attachments: [],
};

describe('buildReplyContent', () => {
  it('quotes exact local timestamps in complete text and HTML', () => {
    const result = buildReplyContent('It is.', '<p>It is.</p>', message);
    const attribution = `On ${localTimestamp(message.attributionDate)}, Sender & Co <sender@example.com> wrote:`;

    expect(result.text).toBe(
      `It is.\n\n${attribution}\n> Is 2 < 3?\n> Yes & no.`,
    );
    expect(result.html).toBe(
      `<p>It is.</p>\n<p>On ${localTimestamp(message.attributionDate)}, Sender &amp; Co &lt;sender@example.com&gt; wrote:</p>\n<blockquote type="cite">Is 2 &lt; 3?<br>Yes &amp; no.</blockquote>`,
    );
    expect(result.inReplyTo).toBe('<current@example.com>');
    expect(result.references).toEqual([
      '<first@example.com>',
      '<current@example.com>',
    ]);
  });

  it('formats offsets, date crossings, local wall times, and DST boundaries exactly', () => {
    const dates = [
      '2026-07-13T08:30:00.000Z',
      '2026-07-13T00:30:00+02:00',
      '2026-03-29T00:30:00Z',
      '2026-03-29T01:30:00Z',
      '2026-10-25T00:30:00Z',
      '2026-10-25T01:30:00Z',
    ];

    for (const attributionDate of dates) {
      const result = buildReplyContent('It is.', '<p>It is.</p>', {
        ...message,
        attributionDate,
      });
      expect(result.text).toContain(
        `On ${localTimestamp(attributionDate)}, Sender & Co <sender@example.com> wrote:`,
      );
    }

    const localWallTime = buildReplyContent('It is.', '<p>It is.</p>', {
      ...message,
      attributionDate: '2026-07-13T08:30:00',
    });
    expect(localWallTime.text).toContain(
      'On July 13, 2026 at 08:30, Sender & Co <sender@example.com> wrote:',
    );
  });

  it('uses In-Reply-To as ancestry when References is absent', () => {
    const result = buildReplyContent('It is.', '<p>It is.</p>', {
      ...message,
      references: [],
    });

    expect(result.references).toEqual([
      '<first@example.com>',
      '<current@example.com>',
    ]);
  });

  it('covers every attribution branch and preserves an unrecognized date', () => {
    const fromOnly = buildReplyContent('Reply', '<p>Reply</p>', {
      ...message,
      attributionDate: '',
    });
    const dateOnly = buildReplyContent('Reply', '<p>Reply</p>', {
      ...message,
      from: '',
    });
    const neither = buildReplyContent('Reply', '<p>Reply</p>', {
      ...message,
      attributionDate: '',
      from: '',
    });
    const result = buildReplyContent('It is.', '<p>It is.</p>', {
      ...message,
      attributionDate: 'A recent Tuesday',
    });

    expect(fromOnly.text).toBe(
      'Reply\n\nSender & Co <sender@example.com> wrote:\n> Is 2 < 3?\n> Yes & no.',
    );
    expect(dateOnly.text).toBe(
      `Reply\n\nOn ${localTimestamp(message.attributionDate)}, the sender wrote:\n> Is 2 < 3?\n> Yes & no.`,
    );
    expect(neither.text).toBe(
      'Reply\n\nPrevious message:\n> Is 2 < 3?\n> Yes & no.',
    );
    expect(result.text).toBe(
      'It is.\n\nOn A recent Tuesday, Sender & Co <sender@example.com> wrote:\n> Is 2 < 3?\n> Yes & no.',
    );
    expect(result.html).toBe(
      '<p>It is.</p>\n<p>On A recent Tuesday, Sender &amp; Co &lt;sender@example.com&gt; wrote:</p>\n<blockquote type="cite">Is 2 &lt; 3?<br>Yes &amp; no.</blockquote>',
    );
    expect(result.html).not.toContain('tracking-pixel');
  });
});
