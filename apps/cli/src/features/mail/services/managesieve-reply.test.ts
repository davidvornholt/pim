import { describe, expect, it } from 'bun:test';
import { literal, parseReply } from './managesieve-reply';

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string) => parseReply(bytes(text));

describe('parseReply', () => {
  it('reads data lines and the status line with its code and text', () => {
    const reply =
      '"IMPLEMENTATION" "Dovecot"\r\n"SASL" "PLAIN"\r\nok (Warnings) "line 3: unused"\r\n';

    expect(parse(reply)).toEqual({
      kind: 'reply',
      reply: {
        lines: [
          ['IMPLEMENTATION', 'Dovecot'],
          ['SASL', 'PLAIN'],
        ],
        status: 'OK',
        code: 'WARNINGS',
        text: 'line 3: unused',
      },
      length: bytes(reply).byteLength,
    });
  });

  it('reads literals by byte length and quoted strings with escapes', () => {
    const script = 'require "fileinto";\r\n# Grüße\r\n';
    const parsed = parse(
      `{${bytes(script).byteLength}}\r\n${script}\r\n"say \\"hi\\"" ACTIVE\r\nOK\r\n`,
    );

    expect(parsed.kind === 'reply' && parsed.reply.lines).toEqual([
      [script],
      ['say "hi"', 'ACTIVE'],
    ]);
  });

  it('reads a status line without code or text', () => {
    const parsed = parse('NO\r\n');

    expect(parsed.kind === 'reply' && parsed.reply).toEqual({
      lines: [],
      status: 'NO',
      code: null,
      text: null,
    });
  });

  it('stops after the first reply and reports its length', () => {
    const first = 'NO (NONEXISTENT) "no such script"\r\n';
    const parsed = parse(`${first}OK\r\n`);

    expect(parsed).toMatchObject({
      kind: 'reply',
      reply: { code: 'NONEXISTENT' },
      length: first.length,
    });
  });

  it.each([
    '',
    '"SASL" "PLAIN"\r\n',
    'OK "partial',
    'OK\r',
    '{12}\r\nshort',
    '{12',
  ])('waits for more input after %j', (text) => {
    expect(parse(text)).toEqual({ kind: 'incomplete' });
  });

  it.each([
    ['OK\n', 'unbalanced parentheses or bare line break'],
    ['OK "a\r\nb"\r\n', 'line break inside a quoted string'],
    ['{x}\r\n', 'bad literal header {x}'],
    ['{2}ab\r\nOK\r\n', 'literal header without CRLF'],
    ['OK (WARNINGS\r\n', 'unbalanced parentheses or bare line break'],
    ['OK)\r\n', 'unbalanced parentheses or bare line break'],
  ])('rejects the malformed reply %j', (text, reason) => {
    expect(parse(text)).toEqual({ kind: 'malformed', reason });
  });
});

describe('literal', () => {
  it('prefixes a non-synchronizing literal with the UTF-8 byte length', () => {
    expect(literal('Grüße')).toBe('{7+}\r\nGrüße');
  });
});
