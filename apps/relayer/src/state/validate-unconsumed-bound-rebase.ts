import {
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import type {
  SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  MAX_UINT256,
} from '../shared/uint.js';

import type {
  AnchoredNonceObservation,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

export type RequiredUnconsumedRebase = Extract<
  SignerRecoveryInspection,
  { status: 'search-unconsumed-bound-rebase-required' }
>;

/**
 * Bind a closed unconsumed correction to the currently committed search.
 */
export function validateUnconsumedBoundRebase(
  snapshot: TransactionJournalSnapshot,
  input: RequiredUnconsumedRebase,
): RequiredUnconsumedRebase | null {
  const inspection = structuredClone(input);
  const oldest = snapshot.attempts[0];
  const search = oldest?.replacementSearch;

  if (
    oldest === undefined ||
    oldest.attemptId !== inspection.attemptId ||
    search === undefined ||
    search === null ||
    search.exhausted === null ||
    !validObservation(inspection.observation)
  ) {
    return null;
  }

  const durable = inspection.observation;
  const evidence = inspection.rebase;

  if (
    evidence === null ||
    evidence === undefined ||
    durable.nonce !== oldest.nonce ||
    durable.nonce < snapshot.durableNextNonce
  ) {
    return null;
  }

  if (
    !validObservation(evidence.lowerBound) ||
    !sameObservation(evidence.lowerBound, search.lowerBound) ||
    !validObservation(evidence.fact) ||
    !sameObservation(evidence.fact, search.exhausted) ||
    search.lowerBound.anchor.blockNumber >= durable.anchor.blockNumber ||
    search.exhausted.anchor.blockNumber > durable.anchor.blockNumber
  ) {
    return null;
  }

  if (
    !validAnchor(evidence.observedLower) ||
    evidence.observedLower.blockNumber !== search.lowerBound.anchor.blockNumber ||
    blockAnchorsMatch(evidence.observedLower, search.lowerBound.anchor)
  ) {
    return null;
  }

  if (
    !validAnchor(evidence.observedFact) ||
    evidence.observedFact.blockNumber !== search.exhausted.anchor.blockNumber ||
    blockAnchorsMatch(evidence.observedFact, search.exhausted.anchor)
  ) {
    return null;
  }

  // Endpoint shape is revalidated here; the inspector performs the closing read.
  if (
    !validAnchor(evidence.opening) ||
    !blockAnchorsMatch(evidence.opening, durable.anchor) ||
    !validAnchor(evidence.closing) ||
    !blockAnchorsMatch(evidence.closing, durable.anchor)
  ) {
    return null;
  }

  // Recheck the inspector's all-attempt guard and confirmation-target precedence.
  let firstContradicted: string | undefined;

  for (const attempt of snapshot.attempts) {
    const fact = attempt.replacementSearch?.exhausted;

    if (fact === undefined || fact === null) {
      continue;
    }

    if (fact.anchor.blockNumber > durable.anchor.blockNumber) {
      return null;
    }

    if (fact.anchor.blockNumber === durable.anchor.blockNumber) {
      if (blockAnchorsMatch(fact.anchor, durable.anchor)) {
        if (fact.nonce !== durable.nonce) {
          return null;
        }
      } else if (firstContradicted === undefined) {
        firstContradicted = attempt.attemptId;
      }
    }
  }

  if (
    firstContradicted !== undefined &&
    firstContradicted !== oldest.attemptId
  ) {
    return null;
  }

  if (!Array.isArray(inspection.observations)) {
    return null;
  }

  const observed = new Map<bigint, Readonly<BlockAnchor>>();

  for (const header of [
    ...inspection.observations,
    evidence.opening,
    evidence.closing,
  ]) {
    if (
      !validAnchor(header) ||
      header.blockNumber > durable.anchor.blockNumber
    ) {
      return null;
    }

    const previous = observed.get(header.blockNumber);

    if (
      previous !== undefined &&
      !blockAnchorsMatch(previous, header)
    ) {
      return null;
    }

    observed.set(header.blockNumber, header);
  }

  for (const header of [evidence.observedLower, evidence.observedFact]) {
    const recorded = observed.get(header.blockNumber);

    if (
      recorded === undefined ||
      !blockAnchorsMatch(recorded, header)
    ) {
      return null;
    }
  }

  freezeTree(inspection);

  return inspection;
}

function validAnchor(anchor: Readonly<BlockAnchor>): boolean {
  return anchor !== null &&
    anchor !== undefined &&
    validUint(anchor.blockNumber) &&
    isFixedHex(anchor.blockHash, 32);
}

function validObservation(observation: AnchoredNonceObservation): boolean {
  return observation !== null &&
    observation !== undefined &&
    validAnchor(observation.anchor) &&
    validUint(observation.nonce);
}

function validUint(value: bigint): boolean {
  return typeof value === 'bigint' &&
    value >= 0n &&
    value <= MAX_UINT256;
}

function sameObservation(
  first: AnchoredNonceObservation,
  second: AnchoredNonceObservation,
): boolean {
  return first.nonce === second.nonce &&
    blockAnchorsMatch(first.anchor, second.anchor);
}

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }

    Object.freeze(value);
  }
}
