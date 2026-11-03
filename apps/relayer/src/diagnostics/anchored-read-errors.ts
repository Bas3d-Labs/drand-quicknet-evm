import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

export type AnchoredReadOperation =
  | 'signer-bootstrap'
  | 'signer-recovery'
  | 'signer-inclusions'
  | 'nonce-sync';

export interface AnchoredReadScope {
  readonly operation?: AnchoredReadOperation;
  readonly finality?:
    | Readonly<{ type: 'safe' | 'finalized' }>
    | Readonly<{
        type: 'confirmations';
        confirmations: bigint;
      }>;
}

export interface AnchoredReadScopeDetails {
  operation?: AnchoredReadOperation;
  finality?:
    | { type: 'safe' | 'finalized' }
    | {
        type: 'confirmations';
        confirmations: string;
      };
}

export interface AnchoredReadContext extends AnchoredReadScope {
  method:
    | 'eth_getBlockByNumber'
    | 'eth_getTransactionCount';
  blockNumber: bigint;
  expectedBlockHash?: string;
  durationMs: number;
}

export interface AnchoredReadDetails extends AnchoredReadScopeDetails {
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
 * Captures optional metadata before asynchronous work.
 * Invalid optional fields are omitted independently.
 */
export function captureAnchoredReadScope(
  input?: AnchoredReadScope,
): Readonly<AnchoredReadScope> {
  const captured: {
    operation?: AnchoredReadOperation;
    finality?: NonNullable<AnchoredReadScope['finality']>;
  } = {};

  if (input === undefined) {
    return Object.freeze(captured);
  }

  try {
    const operation = own(input, 'operation');

    if (
      operation === 'signer-bootstrap' ||
      operation === 'signer-recovery' ||
      operation === 'signer-inclusions' ||
      operation === 'nonce-sync'
    ) {
      captured.operation = operation;
    }
  } catch {
    // Optional diagnostic metadata must not affect execution.
  }

  try {
    const finality = own(input, 'finality');

    if (typeof finality === 'object' && finality !== null) {
      const type = own(finality, 'type');

      if (type === 'safe' || type === 'finalized') {
        captured.finality = Object.freeze({ type });
      } else if (type === 'confirmations') {
        const confirmations = own(finality, 'confirmations');

        if (
          typeof confirmations === 'bigint' &&
          confirmations >= 0n &&
          confirmations <= MAX_UINT256
        ) {
          captured.finality = Object.freeze({
            type,
            confirmations,
          });
        }
      }
    }
  } catch {
    // Preserve independently valid operation metadata.
  }

  return Object.freeze(captured);
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

    const scope = captureAnchoredReadScope(context);

    if (scope.operation !== undefined) {
      details.operation = scope.operation;
    }

    if (scope.finality !== undefined) {
      if (scope.finality.type === 'confirmations') {
        details.finality = Object.freeze({
          type: 'confirmations',
          confirmations: scope.finality.confirmations.toString(),
        });
      } else {
        details.finality = Object.freeze({
          type: scope.finality.type,
        });
      }
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

  const copy: AnchoredReadDetails = { ...details };

  if (details.finality !== undefined) {
    copy.finality = { ...details.finality };
  }

  return copy;
}