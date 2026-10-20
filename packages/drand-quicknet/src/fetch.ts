import { QUICKNET_ENDPOINTS } from './constants.js';
import { parseCompressedSignature } from './signature.js';
import type { QuicknetBeacon } from './types.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export interface FetchBeaconOptions {
  signal?: AbortSignal;

  /** Deadline per endpoint, including response body consumption. */
  timeoutMs?: number;
}

interface DrandBeaconResponse {
  round?: unknown;
  signature?: unknown;
}

export async function fetchBeacon(
  round: bigint,
  endpoints: readonly string[] = QUICKNET_ENDPOINTS,
  options: FetchBeaconOptions = {},
): Promise<QuicknetBeacon> {
  options.signal?.throwIfAborted();
  validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (endpoints.length === 0) {
    throw new Error('At least one Quicknet endpoint is required.');
  }

  const errors: Error[] = [];

  for (const endpoint of endpoints) {
    try {
      return await fetchBeaconFromEndpoint(
        endpoint,
        round,
        options,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      errors.push(toError(error));
    }
  }

  throw new AggregateError(
    errors,
    `Failed to fetch Quicknet round ${round} from all endpoints.`
  );
}

export async function fetchBeaconFromEndpoint(
  endpoint: string,
  round: bigint,
  options: FetchBeaconOptions = {},
): Promise<QuicknetBeacon> {
  options.signal?.throwIfAborted();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  validateTimeout(timeoutMs);

  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  const baseUrl = removeTrailingSlashes(endpoint);
  const url = `${baseUrl}/beacons/quicknet/rounds/${round}`;

  const deadline = new AbortController();
  const signal = options.signal === undefined
    ? deadline.signal
    : AbortSignal.any([options.signal, deadline.signal]);

  const timer = setTimeout(() => {
    const error = new Error('Quicknet endpoint request timed out.');
    error.name = 'TimeoutError';
    deadline.abort(error);
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal });
    signal.throwIfAborted();

    if (!response.ok) {
      throw new Error(`Failed to fetch Quicknet round ${round}: HTTP ${response.status}`);
    }

    const data = (await response.json()) as DrandBeaconResponse;
    signal.throwIfAborted();

    if (
      typeof data.round !== 'number' ||
      !Number.isSafeInteger(data.round)
    ) {
      throw new Error('Invalid Quicknet response: invalid round');
    }

    const returnedRound = BigInt(data.round);

    if (returnedRound !== round) {
      throw new Error(`Quicknet round mismatch: requested ${round}, received ${returnedRound}`);
    }

    const signature = parseCompressedSignature(data.signature);

    return {
      round,
      signature,
    };
  } catch (error) {
    // Preserve caller cancellation even if fetch reports another error.
    options.signal?.throwIfAborted();
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateTimeout(
  value: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      'timeoutMs must be a positive safe integer no greater than 60000.'
    );
  }
}

function removeTrailingSlashes(
  value: string,
): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }

  return value.slice(0, end);
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}