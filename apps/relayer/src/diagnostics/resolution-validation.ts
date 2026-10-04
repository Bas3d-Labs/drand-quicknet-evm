import { transactionType, type Hash } from 'viem';

import { isFixedHex } from '../shared/hex.js';

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

export function assertResolutionTransaction(
  attempt: {
    readonly transactionHash: Hash;
    readonly nonce: bigint;
  },
  evidence: ResolutionTransaction,
): void {
  const recorded = attempt.transactionHash.toLowerCase();

  if (evidence.outcome === 'replaced') {
    check(
      evidence.replacementTransactionHash.toLowerCase() !== recorded
    );
    check(evidence.nonceAtAnchor > attempt.nonce);
  } else {
    check(evidence.transactionHash.toLowerCase() === recorded);
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