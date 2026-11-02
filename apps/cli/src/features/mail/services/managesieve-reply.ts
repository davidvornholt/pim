// Parses ManageSieve (RFC 5804) server replies. A reply is any number of data
// lines followed by one OK, NO, or BYE line. Lines hold atoms, quoted strings,
// and literals ({N} or {N+}, then CRLF and N octets); a status line may carry
// a parenthesized response code and a human-readable string.

export type SieveStatus = 'OK' | 'NO' | 'BYE';

export type SieveReply = {
  // Each data line as its atoms and strings, in order.
  readonly lines: ReadonlyArray<ReadonlyArray<string>>;
  readonly status: SieveStatus;
  // The response code's first atom, such as WARNINGS or NONEXISTENT.
  readonly code: string | null;
  readonly text: string | null;
};

export type ReplyParse =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | {
      readonly kind: 'reply';
      readonly reply: SieveReply;
      // Octets the reply took from the start of the input.
      readonly length: number;
    };

type Token =
  | { readonly kind: 'atom' | 'string'; readonly value: string }
  | { readonly kind: 'code'; readonly tokens: ReadonlyArray<Token> };

const cr = 0x0d;
const lf = 0x0a;
const space = 0x20;
const quote = 0x22;
const backslash = 0x5c;
const openBrace = 0x7b;
const closeBrace = 0x7d;
const openParen = 0x28;
const closeParen = 0x29;

const decoder = new TextDecoder();
const statuses: ReadonlyArray<string> = ['OK', 'NO', 'BYE'];
const isStatus = (word: string): word is SieveStatus => statuses.includes(word);
const literalHeader = /^(?<size>\d+)\+?$/u;
const lineBreakLength = 2;

// Thrown inside the parser and caught by parseReply: without a reason, the
// input ended before the reply did; with one, the reply breaks the grammar.
class ParseStop {
  readonly reason: string | undefined;
  constructor(reason?: string) {
    this.reason = reason;
  }
}
const incomplete = () => new ParseStop();
const malformed = (reason: string) => new ParseStop(reason);

type Cursor = { readonly bytes: Uint8Array; at: number };

const peek = (cursor: Cursor): number => {
  const byte = cursor.bytes[cursor.at];
  if (byte === undefined) {
    throw incomplete();
  }
  return byte;
};

const readQuoted = (cursor: Cursor): string => {
  cursor.at += 1;
  const octets: Array<number> = [];
  for (;;) {
    const byte = peek(cursor);
    cursor.at += 1;
    if (byte === quote) {
      return decoder.decode(Uint8Array.from(octets));
    }
    if (byte === cr || byte === lf) {
      throw malformed('line break inside a quoted string');
    }
    octets.push(byte === backslash ? peek(cursor) : byte);
    if (byte === backslash) {
      cursor.at += 1;
    }
  }
};

const readLiteral = (cursor: Cursor): string => {
  const close = cursor.bytes.indexOf(closeBrace, cursor.at);
  if (close === -1) {
    throw incomplete();
  }
  const header = decoder.decode(cursor.bytes.subarray(cursor.at + 1, close));
  const size = literalHeader.exec(header)?.groups?.size;
  if (size === undefined) {
    throw malformed(`bad literal header {${header}}`);
  }
  const start = close + 1 + lineBreakLength;
  if (cursor.bytes.length < start) {
    throw incomplete();
  }
  if (cursor.bytes[close + 1] !== cr || cursor.bytes[start - 1] !== lf) {
    throw malformed('literal header without CRLF');
  }
  const end = start + Number(size);
  if (cursor.bytes.length < end) {
    throw incomplete();
  }
  cursor.at = end;
  return decoder.decode(cursor.bytes.subarray(start, end));
};

const atomEnds = new Set([space, cr, lf, openParen, closeParen]);

const readAtom = (cursor: Cursor): string => {
  const start = cursor.at;
  while (!atomEnds.has(peek(cursor))) {
    cursor.at += 1;
  }
  return decoder.decode(cursor.bytes.subarray(start, cursor.at));
};

const readToken = (cursor: Cursor): Token => {
  const byte = peek(cursor);
  if (byte === quote) {
    return { kind: 'string', value: readQuoted(cursor) };
  }
  if (byte === openBrace) {
    return { kind: 'string', value: readLiteral(cursor) };
  }
  if (byte === openParen) {
    cursor.at += 1;
    const tokens = readTokens(cursor, closeParen);
    cursor.at += 1;
    return { kind: 'code', tokens };
  }
  return { kind: 'atom', value: readAtom(cursor) };
};

// Reads space-separated tokens up to `end` (CR or a closing parenthesis),
// leaving the cursor on it.
const readTokens = (cursor: Cursor, end: number): Array<Token> => {
  const tokens: Array<Token> = [];
  for (;;) {
    const byte = peek(cursor);
    if (byte === end) {
      return tokens;
    }
    if (byte === space) {
      cursor.at += 1;
    } else if (byte === cr || byte === lf || byte === closeParen) {
      throw malformed('unbalanced parentheses or bare line break');
    } else {
      tokens.push(readToken(cursor));
    }
  }
};

const readLine = (cursor: Cursor): Array<Token> => {
  const tokens = readTokens(cursor, cr);
  cursor.at += 1;
  if (peek(cursor) !== lf) {
    throw malformed('CR without LF');
  }
  cursor.at += 1;
  return tokens;
};

const text = (token: Token): string =>
  token.kind === 'code' ? token.tokens.map(text).join(' ') : token.value;

const statusLine = (
  status: SieveStatus,
  rest: ReadonlyArray<Token>,
  lines: ReadonlyArray<ReadonlyArray<string>>,
): SieveReply => {
  const [first, second] = rest;
  const code = first?.kind === 'code' ? first : undefined;
  const message = code === undefined ? first : second;
  const [codeAtom] = code?.tokens ?? [];
  return {
    lines,
    status,
    code: codeAtom === undefined ? null : text(codeAtom).toUpperCase(),
    text: message === undefined ? null : text(message),
  };
};

export const parseReply = (bytes: Uint8Array): ReplyParse => {
  const cursor: Cursor = { bytes, at: 0 };
  const lines: Array<ReadonlyArray<string>> = [];
  try {
    for (;;) {
      const [first, ...rest] = readLine(cursor);
      const status = first?.kind === 'atom' ? first.value.toUpperCase() : '';
      if (isStatus(status)) {
        return {
          kind: 'reply',
          reply: statusLine(status, rest, lines),
          length: cursor.at,
        };
      }
      lines.push(first === undefined ? [] : [first, ...rest].map(text));
    }
  } catch (error) {
    if (!(error instanceof ParseStop)) {
      throw error;
    }
    return error.reason === undefined
      ? { kind: 'incomplete' }
      : { kind: 'malformed', reason: error.reason };
  }
};

const encoder = new TextEncoder();

// Encodes a string argument as a non-synchronizing literal, which every
// ManageSieve server accepts and which needs no quoting rules.
export const literal = (value: string): string =>
  `{${encoder.encode(value).byteLength}+}\r\n${value}`;
