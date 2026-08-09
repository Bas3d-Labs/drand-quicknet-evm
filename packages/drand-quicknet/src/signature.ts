import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import type { CompressedSignature, Hex, UncompressedSignature } from './types.js';
import { bls12_381 } from '@noble/curves/bls12-381.js';

const COMPRESSED_SIGNATURE_BYTES = 48;
const HEX_CHARACTERS = new Set(
  '0123456789abcdefABCDEF',
);

export function decompressSignature(
  signature: CompressedSignature,
): UncompressedSignature {
  const compressed = hexToBytes(signature.slice(2));
  const point = bls12_381.G1.Point.fromBytes(compressed);

  const uncompressed = point.toBytes(false);

  return `0x${bytesToHex(uncompressed)}` as UncompressedSignature;
}

export function parseCompressedSignature(
  signature: unknown,
): CompressedSignature {
  if (typeof signature !== 'string') {
    throw new TypeError('Invalid compressed Quicknet signature: expected a string');
  }

  const expectedLength = COMPRESSED_SIGNATURE_BYTES * 2;
  if (signature.length !== expectedLength) {
    throw new Error(
      `Invalid compressed Quicknet signature: expected ${COMPRESSED_SIGNATURE_BYTES} bytes.`
    );
  }

  if (!isHex(signature)) {
    throw new Error(
      'Invalid compressed Quicknet signature: contains non-hex characters',
    );
  }

  return `0x${signature.toLowerCase()}` as CompressedSignature;
}

function isHex(value: string): boolean {
  for (const character of value) {
    if (!HEX_CHARACTERS.has(character)) {
      return false;
    }
  }

  return true;
}