import type {
  Address,
} from 'viem';

import {
  isWorkId,
} from '../execution/work-identity.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT64,
} from '../shared/uint.js';

export interface BeaconWorkIdentityOptions {
  readonly chainId: number;
  readonly registry: Address;
  readonly round: bigint;
}

/**
 * Identifies the work of storing one exact Quicknet round in a registry.
 * 
 * The version belongs to this adapter's identity format, not the journal.
 * Signer, fees, transaction hash, and submission method are excluded.
 * 
 * Witness and compressed submissions share this work identity even
 * though they have different transaction intent.
 * 
 * Chain ID keeps the identity self-describing outside its signer journal.
 */
export function createBeaconWorkId(
  options: BeaconWorkIdentityOptions,
): string {
  const {
    chainId,
    registry,
    round,
  } = options;

  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !isFixedHex(registry, 20) ||
    typeof round !== 'bigint' ||
    round <= 0n ||
    round > MAX_UINT64
  ) {
    throw new TypeError('Invalid beacon work identity input.');
  }

  const workId =
    `quicknet-round:v1:${chainId}:${registry.toLowerCase()}:${round}`;

  if (!isWorkId(workId)) {
    throw new TypeError('Invalid beacon work identity.');
  }

  return workId;
}