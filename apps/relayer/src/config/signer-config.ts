import {
  RelayerConfigError,
} from '../diagnostics/config-errors.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

export const DEFAULT_BROADCAST_RETRY_INITIAL_MS = 5_000;
export const DEFAULT_BROADCAST_RETRY_MAX_MS = 60_000;

const MAX_DELAY_MS = 2_147_483_647;

export interface BroadcastRetryConfig {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

type RetrySetting =
  | 'QUICKNET_BROADCAST_RETRY_INITIAL_MS'
  | 'QUICKNET_BROADCAST_RETRY_MAX_MS';

/**
 * Loads the delays used to space repeated broadcasts of a record
 * transaction.
 */
export function loadBroadcastRetryConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<BroadcastRetryConfig> {
  const initialDelayMs = parseDelay(
    env.QUICKNET_BROADCAST_RETRY_INITIAL_MS,
    'QUICKNET_BROADCAST_RETRY_INITIAL_MS',
    DEFAULT_BROADCAST_RETRY_INITIAL_MS,
  );

  const maxDelayMs = parseDelay(
    env.QUICKNET_BROADCAST_RETRY_MAX_MS,
    'QUICKNET_BROADCAST_RETRY_MAX_MS',
    DEFAULT_BROADCAST_RETRY_MAX_MS,
  );

  if (maxDelayMs < initialDelayMs) {
    throw new RelayerConfigError(
      'INVALID_BROADCAST_RETRY_RANGE',
      'QUICKNET_BROADCAST_RETRY_MAX_MS',
    );
  }

  return Object.freeze({
    initialDelayMs,
    maxDelayMs,
  });
}

function parseDelay(
  value: string | undefined,
  setting: RetrySetting,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!isDecimalInteger(value)) {
    throw new RelayerConfigError(
      'INVALID_BROADCAST_RETRY_DELAY',
      setting,
    );
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_DELAY_MS
  ) {
    throw new RelayerConfigError(
      'INVALID_BROADCAST_RETRY_DELAY',
      setting,
    );
  }

  return parsed;
}