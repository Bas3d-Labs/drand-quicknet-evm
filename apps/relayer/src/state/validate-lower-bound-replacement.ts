import {
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  MAX_LOWER_BOUND_PROBES,
  type LowerBoundRepairResult,
} from '../chain/repair-search-lower-bound.js';

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

type RequiredReplacement = Extract<
  LowerBoundRepairResult,
  { status: 'search-lower-bound-replacement-required' }
>;

/** Revalidates captured repair evidence against the currently committed journal. */
export function validateLowerBoundReplacement(
  snapshot: TransactionJournalSnapshot,
  input: RequiredReplacement,
): RequiredReplacement | null {
  const inspection = structuredClone(input);
  const oldest = snapshot.attempts[0];
  if (
    oldest === undefined ||
    oldest.attemptId !== inspection.attemptId ||
    oldest.replacementSearch === null ||
    !validObservation(inspection.observation)
  ) {
    return null;
  }

  const search = oldest.replacementSearch;
  const durable = inspection.observation;
  const evidence = inspection.replacement;
  const trigger = evidence.trigger;
  if (
    durable.nonce < snapshot.durableNextNonce ||
    durable.nonce <= oldest.nonce ||
    !validObservation(trigger.lowerBound) ||
    !sameObservation(trigger.lowerBound, search.lowerBound) ||
    !validAnchor(trigger.durableAnchor) ||
    !blockAnchorsMatch(trigger.durableAnchor, durable.anchor) ||
    !validAnchor(trigger.observedLower) ||
    trigger.observedLower.blockNumber !== search.lowerBound.anchor.blockNumber ||
    blockAnchorsMatch(trigger.observedLower, search.lowerBound.anchor) ||
    search.lowerBound.anchor.blockNumber >= durable.anchor.blockNumber ||
    !validAnchor(evidence.opening) ||
    !blockAnchorsMatch(evidence.opening, durable.anchor) ||
    !validAnchor(evidence.closing) ||
    !blockAnchorsMatch(evidence.closing, durable.anchor) ||
    !validObservation(evidence.replacement)
  ) {
    return null;
  }

  // Repair must not bypass guards that would precede it in a fresh inspection.
  let firstContradictedAttempt: string | undefined;
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
      } else if (firstContradictedAttempt === undefined) {
        firstContradictedAttempt = attempt.attemptId;
      }
    }
  }
  if (
    firstContradictedAttempt !== undefined &&
    firstContradictedAttempt !== oldest.attemptId
  ) {
    return null;
  }

  if (
    !Array.isArray(evidence.probes) ||
    evidence.probes.length === 0 ||
    evidence.probes.length > MAX_LOWER_BOUND_PROBES
  ) {
    return null;
  }

  for (const [index, probe] of evidence.probes.entries()) {
    const expectedHeight = search.lowerBound.anchor.blockNumber - BigInt(index);
    if (
      probe.status !== 'verified' ||
      !validObservation(probe.observation) ||
      !isFixedHex(probe.parentHash, 32) ||
      probe.observation.anchor.blockNumber !== expectedHeight ||
      probe.observation.nonce > durable.nonce
    ) {
      return null;
    }

    const previous = evidence.probes[index - 1];
    if (previous === undefined) {
      if (!blockAnchorsMatch(probe.observation.anchor, trigger.observedLower)) {
        return null;
      }
    } else if (
      probe.observation.nonce > previous.observation.nonce ||
      probe.observation.anchor.blockHash.toLowerCase() !== previous.parentHash.toLowerCase()
    ) {
      return null;
    }

    if (index === evidence.probes.length - 1) {
      if (
        probe.observation.nonce > oldest.nonce ||
        !sameObservation(probe.observation, evidence.replacement)
      ) {
        return null;
      }
    } else if (probe.observation.nonce <= oldest.nonce) {
      // The reader must stop at the first usable candidate.
      return null;
    }
  }

  const invalidation = evidence.invalidatedFact;
  if (search.exhausted === null) {
    if (invalidation !== null) {
      return null;
    }
  } else if (
    invalidation === null ||
    !validObservation(invalidation.fact) ||
    !sameObservation(invalidation.fact, search.exhausted) ||
    !validAnchor(invalidation.observedAnchor) ||
    invalidation.observedAnchor.blockNumber !== search.exhausted.anchor.blockNumber ||
    blockAnchorsMatch(invalidation.observedAnchor, search.exhausted.anchor)
  ) {
    return null;
  }

  if (!Array.isArray(inspection.observations)) {
    return null;
  }
  const observed = new Map<bigint, Readonly<BlockAnchor>>();
  for (const header of inspection.observations) {
    if (!validAnchor(header) || header.blockNumber > durable.anchor.blockNumber) {
      return null;
    }
    const previous = observed.get(header.blockNumber);
    if (previous !== undefined && !blockAnchorsMatch(previous, header)) {
      return null;
    }
    observed.set(header.blockNumber, header);
  }

  const requiredHeaders = [
    trigger.observedLower,
    evidence.opening,
    evidence.closing,
    ...evidence.probes.map((probe) => probe.observation.anchor),
  ];
  if (invalidation !== null) {
    requiredHeaders.push(invalidation.observedAnchor);
  }
  for (const header of requiredHeaders) {
    const recorded = observed.get(header.blockNumber);
    if (recorded === undefined || !blockAnchorsMatch(recorded, header)) {
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
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT256;
}

function sameObservation(
  first: AnchoredNonceObservation,
  second: AnchoredNonceObservation,
): boolean {
  return first.nonce === second.nonce && blockAnchorsMatch(first.anchor, second.anchor);
}

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
}
