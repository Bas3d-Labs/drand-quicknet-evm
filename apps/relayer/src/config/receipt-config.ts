import {
  RelayerConfigError,
} from '../diagnostics/config-errors.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

export const DEFAULT_RECEIPT_TIMEOUT_MS = 30_000;

const MAX_RECEIPT_TIMEOUT_MS = 2_147_483_647;

/**
 * Validates the receipt-wait timeout supplied by programmatic callers.
 * Zero is rejected so callers cannot disable the bound.
 */
export function validateReceiptTimeoutMs(
  value: number,
): number {
  if (
    !isPositiveSafeInteger(value) ||
    value > MAX_RECEIPT_TIMEOUT_MS
  ) {
    throw new TypeError('Invalid receipt timeout.');
  }

  return value;
}

export function loadReceiptTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = env.QUICKNET_RECEIPT_TIMEOUT_MS;
  if (value === undefined) {
    return DEFAULT_RECEIPT_TIMEOUT_MS;
  }

  if (!isDecimalInteger(value)) {
    throw new RelayerConfigError(
      'INVALID_RECEIPT_TIMEOUT',
      'QUICKNET_RECEIPT_TIMEOUT_MS',
    );
  }

  try {
    return validateReceiptTimeoutMs(Number(value));
  } catch {
    throw new RelayerConfigError(
      'INVALID_RECEIPT_TIMEOUT',
      'QUICKNET_RECEIPT_TIMEOUT_MS',
    );
  }
}