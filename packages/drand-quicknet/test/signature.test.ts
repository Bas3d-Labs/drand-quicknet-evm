import {
  describe,
  expect,
  expectTypeOf,
  it,
} from 'vitest';

import {
  parseCompressedSignature,
} from '../src/signature.js';

import type {
  CompressedSignature,
} from '../src/types.js';
import { QUICKNET_VECTORS } from './fixtures.js';

const VECTOR = QUICKNET_VECTORS.round20791007;
const beacon = {
  round: VECTOR.round,
  signature: parseCompressedSignature(
    VECTOR.compressedSignature,
  ),
};

describe('parseCompressedSignature', () => {
  it('accepts a valid 48-byte compressed signature', () => {
    const signature = 'ab'.repeat(48);

    expect(parseCompressedSignature(signature)).toBe(
      `0x${signature}`,
    );
  });

  it('returns a CompressedSignature', () => {
    const signature = parseCompressedSignature(
      VECTOR.compressedSignature,
    );

    expectTypeOf(signature).toEqualTypeOf<CompressedSignature>();
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
    expect(() =>
      parseCompressedSignature(undefined),
    ).toThrow(TypeError);

    expect(() =>
      parseCompressedSignature(undefined),
    ).toThrow(
      'Invalid compressed Quicknet signature: expected a string',
    );
  });

  it('rejects a signature shorter than 48 bytes', () => {
    const signature = 'ab'.repeat(47);

    expect(() =>
      parseCompressedSignature(signature),
    ).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects a signature longer than 48 bytes', () => {
    const signature = 'ab'.repeat(49);

    expect(() =>
      parseCompressedSignature(signature),
    ).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects non-hex characters', () => {
    const signature =
      `${'ab'.repeat(47)}ag`;

    expect(() =>
      parseCompressedSignature(signature),
    ).toThrow(
      'Invalid compressed Quicknet signature: contains non-hex characters',
    );
  });

  it('rejects a 0x-prefixed signature', () => {
    const signature =
      `0x${'ab'.repeat(48)}`;

    expect(() =>
      parseCompressedSignature(signature),
    ).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects an empty string', () => {
    expect(() =>
      parseCompressedSignature(''),
    ).toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('does not perform elliptic-curve validation', () => {
    const signature = '00'.repeat(48);

    expect(
      parseCompressedSignature(signature),
    ).toBe(
      `0x${signature}`,
    );
  });
});
