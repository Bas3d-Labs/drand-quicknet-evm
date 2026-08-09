import { QUICKNET_ENDPOINTS } from './constants.js';
import { parseCompressedSignature } from './signature.js';
import type { QuicknetBeacon } from './types.js';

interface DrandBeaconResponse {
  round?: unknown;
  signature?: unknown;
}

export async function fetchBeacon(
  round: bigint,
  endpoints: readonly string[] = QUICKNET_ENDPOINTS,
): Promise<QuicknetBeacon> {
  if (endpoints.length === 0) {
    throw new Error('At least one Quicknet endpoint is required.');
  }

  const errors: Error[] = [];

  for (const endpoint of endpoints) {
    try {
      return await fetchBeaconFromEndpoint(
        endpoint,
        round,
      );
    } catch (error) {
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
): Promise<QuicknetBeacon> {
  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  const baseUrl = removeTrailingSlashes(endpoint);
  const url = `${baseUrl}/beacons/quicknet/rounds/${round}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Quicknet round ${round}: HTTP ${response.status}`);
  }

  const data = (await response.json()) as DrandBeaconResponse;
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