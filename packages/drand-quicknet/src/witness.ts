import { bls12_381 } from '@noble/curves/bls12-381.js';

import { parseCompressedSignature } from './signature.js';

import type { CompressedSignature } from './types.js';

const COMPRESSED_SIGNATURE_BYTES = 48;
const LOW_LIMB_BITS = 256n;
const LOW_LIMB_MASK = (1n << LOW_LIMB_BITS) - 1n;

export interface SignatureWitness {
  // Most significant 128 bits of the signature y-coordinate.
  readonly yHi: bigint;

  // Least significant 256 bits of the signature y-coordinate.
  readonly yLo: bigint;
}

/**
 * Decompresses a canonical compressed Quicknet signature into its witness.
 *
 * Validates the encoding, curve membership, and prime-order subgroup.
 * Does not authenticate the signature against a round or public key.
 *
 * Throws if the supplied signature cannot produce a valid witness.
 */
export function createSignatureWitness(
  signature: CompressedSignature,
): SignatureWitness {
  if (typeof signature !== 'string') {
    throw new TypeError('Invalid compressed Quicknet signature: expected a string');
  }

  if (!signature.startsWith('0x')) {
    throw new Error('Invalid compressed Quicknet signature: expected a 0x prefix');
  }

  const normalized = parseCompressedSignature(signature.slice(2));
  const signatureBytes = new Uint8Array(COMPRESSED_SIGNATURE_BYTES);

  for (let index = 0; index < signatureBytes.length; index++) {
    const offset = 2 + index * 2;

    signatureBytes[index] = Number.parseInt(
      normalized.slice(offset, offset + 2),
      16,
    );
  }

  const firstByte = Number.parseInt(normalized.slice(2, 4), 16);

  // Require compressed encoding and reject the point-at-infinity flag.
  if ((firstByte & 0xc0) !== 0x80) {
    throw new Error('Invalid compressed Quicknet signature: invalid encoding flags');
  }

  const point = bls12_381.G1.Point.fromBytes(signatureBytes);

  // Explicitly require curve and subgroup validity.
  point.assertValidity();

  // Require exact canonical encoding, including x < p and the y sign.
  // Reject field-coordinate aliases even if decoding normalizes them.
  const canonicalBytes = point.toBytes(true);
  if (canonicalBytes.length !== signatureBytes.length) {
    throw new Error('Invalid compressed Quicknet signature: noncanonical encoding')
  }

  for (let index = 0; index < signatureBytes.length; index++) {
    if (canonicalBytes[index] !== signatureBytes[index]) {
      throw new Error('Invalid compressed Quicknet signature: noncanonical encoding');
    }
  }

  const { y } = point.toAffine();
  
  // y < p < 2^381, so yHi fits uint128.
  // The mask bounds yLo to uint256.
  return {
    yHi: y >> LOW_LIMB_BITS,
    yLo: y & LOW_LIMB_MASK,
  };
}