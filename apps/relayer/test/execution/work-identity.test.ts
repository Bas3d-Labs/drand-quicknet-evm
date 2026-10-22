import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  isWorkId,
  MAX_WORK_ID_LENGTH,
} from '../../src/execution/work-identity.js';

describe('work identity validation', () => {
  it.each([
    [undefined],
    [null],
    [false],
    [123],
    [123n],
    [{}],
    [[]],
    [new String('work')],
  ])('rejects non-string input: %p', (value) => {
    expect(isWorkId(value)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isWorkId('')).toBe(false);
  });

  it('accepts a one-code-unit identity', () => {
    expect(isWorkId('x')).toBe(true);
  });

  it('enforces the fixed 256-code-unit limit', () => {
    expect(MAX_WORK_ID_LENGTH).toBe(256);
    expect(isWorkId('x'.repeat(256))).toBe(true);
    expect(isWorkId('x'.repeat(257))).toBe(false);
  });

  it('counts astral characters as two UTF-16 code units', () => {
    const atLimit = '😀'.repeat(128);
    const overLimit = atLimit + 'x';

    expect(atLimit.length).toBe(256);
    expect([...atLimit]).toHaveLength(128);
    expect(isWorkId(atLimit)).toBe(true);

    expect(overLimit.length).toBe(257);
    expect([...overLimit]).toHaveLength(129);
    expect(isWorkId(overLimit)).toBe(false);
  });

  it('rejects every C0 control character', () => {
    for (let code = 0x00; code <= 0x1f; code += 1) {
      const control = String.fromCharCode(code);

      expect(
        isWorkId(`before${control}after`),
        `C0 code unit 0x${code.toString(16)}`,
      ).toBe(false);
    }

    expect(isWorkId('x'.repeat(255) + '\n')).toBe(false);
  });

  it('rejects DEL and every C1 control character', () => {
    for (let code = 0x7f; code <= 0x9f; code += 1) {
      const control = String.fromCharCode(code);

      expect(
        isWorkId(`before${control}after`),
        `DEL/C1 code unit 0x${code.toString(16)}`,
      ).toBe(false);
    }
  });

  it.each([
    ['first', '\nwork'],
    ['middle', 'wo\nrk'],
    ['last', 'work\n'],
  ])('rejects a control character in the %s position', (_position, value) => {
    expect(isWorkId(value)).toBe(false);
  });

  it.each([
    0x20,
    0x7e,
    0xa0,
  ])('accepts allowed code units adjacent to the forbidden ranges: %i', (code) => {
    expect(isWorkId(String.fromCharCode(code))).toBe(true);
  });

  it('leaves spaces and adapter syntax to the adapter', () => {
    expect(isWorkId('   ')).toBe(true);
    expect(isWorkId(' Work:Example ')).toBe(true);
    expect(isWorkId('another-adapter:v2:opaque-key')).toBe(true);
  });

  it.each([
    '\ud800',
    '\udfff',
    'before\ud800after',
    'before\udfffafter',
    '\ud800\ud800',
    '\udfff\ud800',
  ])('rejects malformed UTF-16: %j', (value) => {
    expect(isWorkId(value)).toBe(false);
  });

  it('accepts paired surrogates without normalizing work identities', () => {
    const paired = 'work:\ud83d\ude00';
    const composed = 'work:\u00e9';
    const decomposed = 'work:e\u0301';

    expect(isWorkId(paired)).toBe(true);
    expect(isWorkId(composed)).toBe(true);
    expect(isWorkId(decomposed)).toBe(true);

    expect(composed).not.toBe(decomposed);
    expect(JSON.parse(JSON.stringify(paired))).toBe(paired);
    expect(JSON.parse(JSON.stringify(composed))).toBe(composed);
    expect(JSON.parse(JSON.stringify(decomposed))).toBe(decomposed);
  });

  it('reaches the maximum serialized work-ID size with valid BMP characters', () => {
    const value = '\u0800'.repeat(MAX_WORK_ID_LENGTH);

    expect(MAX_WORK_ID_LENGTH).toBe(256);
    expect(value.length).toBe(MAX_WORK_ID_LENGTH);
    expect(isWorkId(value)).toBe(true);

    // Three UTF-8 bytes per UTF-16 code unit, plus JSON's two quotes.
    expect(Buffer.byteLength(value, 'utf8')).toBe(768);
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(770);
  });

  it.each(['"', '\\'])(
    'keeps escaped ASCII within the serialized work-ID budget: %j',
    (character) => {
      const value = character.repeat(MAX_WORK_ID_LENGTH);

      expect(isWorkId(value)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(
        MAX_WORK_ID_LENGTH * 2 + 2,
      );
    },
  );
});