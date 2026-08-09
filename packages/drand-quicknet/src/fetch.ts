import { parseCompressedSignature } from './signature.js';
import type { QuicknetBeacon } from './types.js';

interface DrandBeaconResponse {
  round?: unknown;
  signature?: unknown;
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