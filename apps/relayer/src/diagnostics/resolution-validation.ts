import {
  type Hash
} from 'viem';

import {
  isFixedHex
} from '../shared/hex.js';

import type {
  AttemptResolutionEvidence,
} from './transaction-evidence.js';

export function snapshotResolutionEvidence(
  input: unknown,
): AttemptResolutionEvidence {
  const anchor = block(field(input, 'anchor'));
  const inclusion = block(field(input, 'inclusion'));

  check(inclusion.blockNumber <= anchor.blockNumber);

  if (inclusion.blockNumber === anchor.blockNumber) {
    check(
      inclusion.blockHash.toLowerCase() ===
      anchor.blockHash.toLowerCase()
    );
  }

  const outcome = field(input, 'outcome');
  if (outcome === 'success' || outcome === 'reverted') {
    return Object.freeze({
      outcome,
      anchor,
      inclusion,
      transactionHash: hash(field(input, 'transactionHash')),
    });
  }

  check(outcome === 'replaced');

  return Object.freeze({
    outcome,
    anchor,
    inclusion,
    replacementTransactionHash: hash(
      field(input, 'replacementTransactionHash'),
    ),
    nonceAtAnchor: uint(field(input, 'nonceAtAnchor')),
  });
}

type ResolutionTransaction =
  | {
      readonly outcome: 'success' | 'reverted';
      readonly transactionHash: Hash;
    }
  | {
      readonly outcome: 'replaced';
      readonly replacementTransactionHash: Hash;
      readonly nonceAtAnchor: bigint;
    };

/**
 * Matches resolution evidence against every signed transaction retained
 * for this nonce. Any recorded fee replacement remains our transaction.
 */
export function assertResolutionTransaction(
  attempt: {
    readonly nonce: bigint;
    readonly signedTransactions: readonly {
      readonly transactionHash: Hash;
    }[];
  },
  evidence: ResolutionTransaction,
): void {
  check(attempt.signedTransactions.length > 0);

  const containsHash = (transactionHash: Hash): boolean =>
    attempt.signedTransactions.some((transaction) =>
      transaction.transactionHash.toLowerCase() ===
      transactionHash.toLowerCase()
    );

  if (evidence.outcome === 'replaced') {
    check(!containsHash(evidence.replacementTransactionHash));
    check(evidence.nonceAtAnchor > attempt.nonce);
  } else {
    check(containsHash(evidence.transactionHash));
  }
}

function block(input: unknown) {
  return Object.freeze({
    blockNumber: uint(field(input, 'blockNumber')),
    blockHash: hash(field(input, 'blockHash')),
  });
}

function hash(input: unknown): Hash {
  check(isFixedHex(input, 32));
  return input;
}

function uint(input: unknown): bigint {
  check(
    typeof input === 'bigint' &&
    input >= 0n &&
    input < (1n << 256n),
  );

  return input;
}

function field(input: unknown, key: string): unknown {
  check(
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input)
  );

  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);

    check(
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value')
    );

    return descriptor.value;
  } catch {
    throw new TypeError('Invalid attempt resolution evidence.');
  }
}

function check(condition: unknown): asserts condition {
  if (!condition) {
    throw new TypeError('Invalid attempt resolution evidence.');
  }
}