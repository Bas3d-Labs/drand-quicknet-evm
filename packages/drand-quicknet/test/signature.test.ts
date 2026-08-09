import {
  describe,
  expect,
  expectTypeOf,
  it,
} from 'vitest';

import {
  decompressSignature,
  parseCompressedSignature,
} from '../src/signature.js';

import type {
  CompressedSignature,
  UncompressedSignature,
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

describe('decompressSignature', () => {
  it('decompresses a known Quicknet signature exactly', () => {
    const compressed = parseCompressedSignature(
      VECTOR.compressedSignature,
    );

    expect(
      decompressSignature(compressed),
    ).toBe(VECTOR.uncompressedSignature);
  });

  it('returns an UncompressedSignature', () => {
    const compressed = parseCompressedSignature(
      VECTOR.compressedSignature,
    );

    const uncompressed =
      decompressSignature(compressed);

    expectTypeOf(
      uncompressed,
    ).toEqualTypeOf<UncompressedSignature>();
  });

  it('returns exactly 96 bytes', () => {
    const compressed = parseCompressedSignature(
      VECTOR.compressedSignature,
    );

    const uncompressed =
      decompressSignature(compressed);

    const hex = uncompressed.slice(2);

    expect(hex.length).toBe(96 * 2);
  });

  it('returns lowercase 0x-prefixed hex', () => {
    const compressed = parseCompressedSignature(
      VECTOR.compressedSignature.toUpperCase(),
    );

    const uncompressed =
      decompressSignature(compressed);

    expect(
      uncompressed.startsWith('0x'),
    ).toBe(true);

    expect(uncompressed).toBe(
      uncompressed.toLowerCase(),
    );
  });

  it('rejects an invalid compressed point', () => {
    const compressed =
      parseCompressedSignature(
        '00'.repeat(48),
      );

    expect(() =>
      decompressSignature(compressed),
    ).toThrow();
  });

  it('rejects an out-of-range compressed point encoding', () => {
    const compressed =
      parseCompressedSignature(
        'ff'.repeat(48),
      );

    expect(() =>
      decompressSignature(compressed),
    ).toThrow();
  });
});