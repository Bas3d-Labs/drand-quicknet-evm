import {
  fetchBeacon,
  type QuicknetBeacon,
} from '@based-labs/drand-quicknet';

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_DELAY_MS = 250;

export interface FetchQuicknetBeaconWithRetryOptions {
  round: bigint;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>,
  signal?: AbortSignal;
}

export async function fetchQuicknetBeaconWithRetry(
  options: FetchQuicknetBeaconWithRetryOptions
): Promise<QuicknetBeacon> {
  const {
    round,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = sleepFor,
  } = options;

  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  validateMaxAttempts(maxAttempts);
  validateRetryDelay(retryDelayMs);

  let lastError: unknown;

  for(let attempt=1; attempt <= maxAttempts; attempt++) {
    options.signal?.throwIfAborted();

    try {
      let beacon: QuicknetBeacon;

      if (options.signal === undefined) {
        beacon = await fetchBeacon(round);
      } else {
        beacon = await fetchBeacon(round, undefined, {
          signal: options.signal,
        });
      }

      options.signal?.throwIfAborted();

      if (beacon.round !== round) {
        throw new Error(
          `Quicknet round mismatch: requested ${round}, received ${beacon.round}.`
        );
      }

      return beacon;
    } catch (error) {
      options.signal?.throwIfAborted();

      lastError = error;

      if (attempt === maxAttempts) {
        break;
      }

      await sleep(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to fetch Quicknet round ${round} after ${maxAttempts} attempts.`,
    {
      cause: lastError,
    },
  );
}

function validateMaxAttempts(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxAttempts must be a positive safe integer.');
  }
}

function validateRetryDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('retryDelayMs must be a non-negative safe integer.');
  }
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise(
    (resolve) => {
      setTimeout(resolve, milliseconds);
    }
  );
}