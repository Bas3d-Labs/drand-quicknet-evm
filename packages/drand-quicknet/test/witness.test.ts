import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createSignatureWitness,
  parseCompressedSignature,
} from '../src/index.js';

import type {
  CompressedSignature,
} from '../src/index.js';

interface PositiveVector {
  id: string;
  signature: string;
  uncompressed: string;
}

interface Corpus {
  positive: Record<string, PositiveVector>;
}

const fixture = new URL(
  '../../../contracts/test/fixtures/quicknet-kat.json',
  import.meta.url,
);

const corpus = JSON.parse(
  readFileSync(fixture, 'utf8'),
) as Corpus;

const FIELD_MODULUS = BigInt(
  '0x1a0111ea397fe69a4b1ba7b6434bacd7' +
  '64774b84f38512bf6730d2a0f6b0f6241e' +
  'abfffeb153ffffb9feffffffffaaab',
);

// Canonical 2·G and its representable x+p alias.
// This is a point-validation fixture, not a published Quicknet beacon.
const SMALL_X_POINT = {
  compressed:
    '0xa572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62a' +
    'e28f75bb8f1c7c42c39a8c5529bf0f4e',
  alias:
    '0xbf73ddd4c9cd4de0d32470a193f4f1e3fb9926b584ad13e4aac0ffabba099c4f' +
    '013b75ba40707c427d998c5529beb9f9',
  yHi: 0x166a9d8cabc673a322fda673779d8e38n,
  yLo: 0x22ba3ecb8670e461f73bb9021d5fd76a4c56d9d4cd16bd1bba86881979749d28n,
};

describe('createSignatureWitness', () => {
  it('matches the fixed coordinates for every positive KAT', () => {
    const vectors = Object.values(corpus.positive);

    expect(vectors).toHaveLength(12);

    for (const vector of vectors) {
      const signature = parseCompressedSignature(
        vector.signature.slice(2),
      );

      const witness = createSignatureWitness(signature);
      const coordinates = vector.uncompressed.slice(2);

      expect(coordinates.length, vector.id).toBe(192);

      expect(witness.yHi, vector.id).toBe(
        BigInt(`0x${coordinates.slice(96, 128)}`),
      );

      expect(witness.yLo, vector.id).toBe(
        BigInt(`0x${coordinates.slice(128, 192)}`),
      );
    }
  });

  it('selects the opposite root when the sign bit is flipped', () => {
    for (const vector of Object.values(corpus.positive)) {
      const rawSignature = vector.signature.slice(2);
      const firstByte = Number.parseInt(rawSignature.slice(0, 2), 16);

      const flippedSignature = parseCompressedSignature(
        (firstByte ^ 0x20).toString(16).padStart(2, '0') +
        rawSignature.slice(2),
      );

      const witness = createSignatureWitness(flippedSignature);
      const y = (witness.yHi << 256n) | witness.yLo;
      const originalY = BigInt(
        `0x${vector.uncompressed.slice(2 + 96)}`,
      );

      // A sign flip remains a valid point. Round authentication is separate.
      expect(y, vector.id).toBe(FIELD_MODULUS - originalY);
    }
  });

  it.each([
    ['missing prefix', '80' + '00'.repeat(47)],
    ['wrong length', '0x80'],
    ['non-hex input', '0x80' + 'gg'.repeat(47)],
    ['compression flag clear', '0x00' + '00'.repeat(47)],
    ['infinity', '0xc0' + '00'.repeat(47)],
    ['off-curve x=1', '0x80' + '00'.repeat(46) + '01'],
    ['non-subgroup x=0', '0x80' + '00'.repeat(47)],
    [
      'x equals field modulus',
      '0x9a0111ea397fe69a4b1ba7b6434bacd7' +
      '64774b84f38512bf6730d2a0f6b0f6241e' +
      'abfffeb153ffffb9feffffffffaaab',
    ],
  ])('rejects %s', (_name, signature) => {
    expect(() => createSignatureWitness(
      signature as CompressedSignature,
    )).toThrow();
  });

  it('rejects representable x+p aliases of valid KAT points', () => {
    const coordinateMask = (1n << 381n) - 1n;
    let checked = 0;

    for (const vector of Object.values(corpus.positive)) {
      const encoded = BigInt(vector.signature);
      const x = encoded & coordinateMask;
      const aliasX = x + FIELD_MODULUS;

      if (aliasX > coordinateMask) {
        continue;
      }

      // Preserve the compression, infinity, and sign bits.
      const flags = encoded & ~coordinateMask;
      const alias = parseCompressedSignature(
        (flags | aliasX).toString(16).padStart(96, '0'),
      );

      expect(
        () => createSignatureWitness(alias),
        vector.id,
      ).toThrow();

      checked++;
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('accepts canonical 2G and rejects its x+p alias', () => {
    const signature = parseCompressedSignature(
      SMALL_X_POINT.compressed.slice(2),
    );

    expect(createSignatureWitness(signature)).toEqual({
      yHi: SMALL_X_POINT.yHi,
      yLo: SMALL_X_POINT.yLo,
    });

    const alias = parseCompressedSignature(
      SMALL_X_POINT.alias.slice(2),
    );

    expect(() => createSignatureWitness(alias)).toThrow();
  });
});