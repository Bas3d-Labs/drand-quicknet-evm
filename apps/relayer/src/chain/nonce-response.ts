import {
  isNonNegativeSafeInteger,
} from '../shared/integer.js';

export function parseNonceResponse(
  value: unknown,
): bigint {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TypeError('Invalid nonce response.');
  }

  return BigInt(value);
}