import { describe, expect, it } from 'bun:test';
import { typedValue } from './contact-write-commands';

describe('typedValue', () => {
  it.each([
    ['work:ana@example.org', { value: 'ana@example.org', type: 'work' }],
    [
      'WORK,Home:ana@example.org',
      { value: 'ana@example.org', type: 'work,home' },
    ],
    ['x-mobile2: +49 170', { value: '+49 170', type: 'x-mobile2' }],
    ['ana@example.org', { value: 'ana@example.org' }],
    ['+49 170', { value: '+49 170' }],
    ['MAILTO:ana@example.org', { value: 'MAILTO:ana@example.org' }],
    ['tel:+49170', { value: 'tel:+49170' }],
    [
      'work:mailto:ana@example.org',
      { value: 'mailto:ana@example.org', type: 'work' },
    ],
  ])('reads %p', (given, expected) => {
    expect(typedValue(given)).toEqual(expected);
  });
});
