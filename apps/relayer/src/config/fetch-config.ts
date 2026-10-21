import {
  MAX_FETCH_TIMEOUT_MS,
} from '@based-labs/drand-quicknet';

import {
  RelayerConfigError,
} from '../diagnostics/config-errors.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/** Validates the per-endpoint deadline, including body consumption. */
export function validateFetchTimeoutMs(
  value: number,
): number {
  if (
    !isPositiveSafeInteger(value) ||
    value > MAX_FETCH_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_FETCH_TIMEOUT_MS}.`
    );
  }

  return value;
}

export function loadFetchTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = env.QUICKNET_FETCH_TIMEOUT_MS;
  if (value === undefined) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }

  if (!isDecimalInteger(value)) {
    throw new RelayerConfigError(
      'INVALID_FETCH_TIMEOUT',
      'QUICKNET_FETCH_TIMEOUT_MS',
    );
  }

  try {
    return validateFetchTimeoutMs(Number(value));
  } catch {
    throw new RelayerConfigError(
      'INVALID_FETCH_TIMEOUT',
      'QUICKNET_FETCH_TIMEOUT_MS',
    );
  }
}