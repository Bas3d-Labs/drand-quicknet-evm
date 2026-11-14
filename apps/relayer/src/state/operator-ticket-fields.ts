import type {
  Hash,
} from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

export function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireValid(typeof input === 'object' && input !== null && !Array.isArray(input));
  requireValid(Object.keys(input).length === keys.length);

  for (const key of keys) {
    requireValid(Object.hasOwn(input, key));
  }

  return input as Record<string, unknown>;
}

export function decimal(
  input: unknown,
): bigint {
  requireValid(typeof input === 'string' && input.length <= 78);
  requireValid(isDecimalInteger(input));

  const result = BigInt(input);

  requireValid(result >= 0n && result <= MAX_UINT256 && result.toString() === input);

  return result;
}

export function hash(
  input: unknown,
): Hash {
  requireValid(isFixedHex(input, 32));
  requireValid(input === input.toLowerCase());

  return input;
}

export function anchor(
  input: unknown,
): Readonly<BlockAnchor> {
  const value = fields(input, ['blockNumber', 'blockHash']);

  return Object.freeze({
    blockNumber: decimal(value.blockNumber),
    blockHash: hash(value.blockHash),
  });
}

export function requireValid(
  value: unknown,
): asserts value {
  if (!value) {
    throw new TypeError();
  }
}
