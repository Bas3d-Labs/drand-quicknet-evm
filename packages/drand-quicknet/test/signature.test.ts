import { describe, expect, it } from 'vitest';
import { parseCompressedSignature } from '../src/signature.js';

describe('parseCompressedSignature', () => {
  it('accepts a valid 48-byte compressed signature', () => {
    const signature = 'ab'.repeat(48);

    expect(parseCompressedSignature(signature)).toBe(
      `0x${signature}`,
    );
  });

  it('normalizes uppercase hex to lowercase', () => {
    const signature = 'AB'.repeat(48);

    expect(parseCompressedSignature(signature)).toBe(
      `0x${'ab'.repeat(48)}`,
    );
  });

  it('accepts mixed-case hex', () => {
    const signature = 'aB'.repeat(48);

    expect(parseCompressedSignature(signature)).toBe(
      `0x${'ab'.repeat(48)}`,
    );
  });

  it('rejects a non-string value', () => {
    expect(() => parseCompressedSignature(undefined)).toThrow(
      TypeError,
    );

    expect(() => parseCompressedSignature(undefined)).toThrow(
      'Invalid compressed Quicknet signature: expected a string',
    );
  });

  it('rejects a signature shorter than 48 bytes', () => {
    const signature = 'ab'.repeat(47);

    expect(() => parseCompressedSignature(signature)).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects a signature longer than 48 bytes', () => {
    const signature = 'ab'.repeat(49);

    expect(() => parseCompressedSignature(signature)).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects non-hex characters', () => {
    const signature =
      `${'ab'.repeat(47)}ag`;

    expect(() => parseCompressedSignature(signature)).toThrow(
      'Invalid compressed Quicknet signature: contains non-hex characters',
    );
  });

  it('rejects a 0x-prefixed signature', () => {
    const signature = `0x${'ab'.repeat(48)}`;

    expect(() => parseCompressedSignature(signature)).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects an empty string', () => {
    expect(() => parseCompressedSignature('')).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });
});