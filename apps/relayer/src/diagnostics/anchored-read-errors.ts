import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

export interface AnchoredReadContext {
  method:
    | 'eth_getBlockByNumber'
    | 'eth_getTransactionCount';
  blockNumber: bigint;
  expectedBlockHash?: string;
  durationMs: number;
}

export interface AnchoredReadDetails {
  method:
    | 'eth_getBlockByNumber'
    | 'eth_getTransactionCount';
  blockNumber: string;
  expectedBlockHash?: string;
  durationMs: number;
}

const registered =
  new WeakMap<object, Readonly<AnchoredReadDetails>>();

function own(
  value: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return undefined;
  }

  return descriptor.value;
}

/**
 * Attaches diagnostic context without modifying or replacing the error.
 * Invalid context is omitted. Diagnostic capture must never throw.
 */
export function registerAnchoredReadFailure(
  error: unknown,
  context: AnchoredReadContext,
): void {
  try {
    if (typeof error !== 'object' || error === null) {
      return;
    }

    if (registered.has(error)) {
      return;
    }

    const method = own(context, 'method');
    const blockNumber = own(context, 'blockNumber');
    const expectedBlockHash = own(context, 'expectedBlockHash');
    const durationMs = own(context, 'durationMs');

    if (
      method !== 'eth_getBlockByNumber' &&
      method !== 'eth_getTransactionCount'
    ) {
      return;
    }

    if (
      typeof blockNumber !== 'bigint' ||
      blockNumber < 0n ||
      blockNumber > MAX_UINT256
    ) {
      return;
    }

    if (
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return;
    }

    if (
      expectedBlockHash !== undefined &&
      !isFixedHex(expectedBlockHash, 32)
    ) {
      return;
    }

    const details: AnchoredReadDetails = {
      method,
      blockNumber: blockNumber.toString(),
      durationMs,
    };

    if (typeof expectedBlockHash === 'string') {
      details.expectedBlockHash = expectedBlockHash;
    }

    registered.set(error, Object.freeze(details));
  } catch {
    // Diagnostic capture must not replace the original failure.
  }
}

export function anchoredReadDetails(
  error: unknown,
): AnchoredReadDetails | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const details = registered.get(error);

  if (details === undefined) {
    return undefined;
  }

  return { ...details };
}