import type {
  PublicClient,
} from 'viem';

import type {
  AnchoredNonceObservation,
  TransactionJournalSnapshot,
} from '../state/transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from '../state/transaction-journal-validation.js';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  readSearchLowerBoundProbe,
  type SearchLowerBoundProbeResult,
} from './read-search-lower-bound-probe.js';

import type {
  ClosedLowerBoundMismatch,
} from './search-attempt-replacement.js';

export const MAX_LOWER_BOUND_PROBES = 8;

type VerifiedProbe = Extract<SearchLowerBoundProbeResult, { status: 'verified' }>;

export interface LowerBoundReplacementEvidence {
  readonly trigger: ClosedLowerBoundMismatch;
  readonly opening: Readonly<BlockAnchor>;
  readonly closing: Readonly<BlockAnchor>;
  readonly probes: readonly VerifiedProbe[];
  readonly replacement: AnchoredNonceObservation;
  readonly invalidatedFact: {
    readonly fact: AnchoredNonceObservation;
    readonly observedAnchor: Readonly<BlockAnchor>;
  } | null;
}

export type LowerBoundRepairResult =
  | {
      readonly status: 'search-lower-bound-replacement-required';
      readonly attemptId: string;
      readonly observation: AnchoredNonceObservation;
      readonly observations: readonly Readonly<BlockAnchor>[];
      readonly replacement: LowerBoundReplacementEvidence;
    }
  | {
      readonly status: 'search-lower-bound-replacement-unavailable';
      readonly reason: 'probe-budget-exhausted' | 'no-unconsumed-candidate';
      readonly observation: AnchoredNonceObservation;
    }
  | {
      readonly status: 'anchor-changed';
      readonly observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      readonly status: 'inconsistent-observations' | 'nonce-behind-journal';
      readonly observation: AnchoredNonceObservation;
    }
  | {
      readonly status: 'anchor-behind-exhaustion';
      readonly anchor: Readonly<BlockAnchor>;
      readonly exhausted: AnchoredNonceObservation;
    };

export interface RepairSearchLowerBoundOptions {
  readonly publicClient: PublicClient;
  readonly snapshot: TransactionJournalSnapshot;
  readonly observation: AnchoredNonceObservation;
  readonly trigger: ClosedLowerBoundMismatch;
  readonly observations: readonly Readonly<BlockAnchor>[];
}

/**
 * Establishes replacement evidence after a closed durable lower-bound mismatch.
 * It never writes, scans transactions, or resumes recovery. The owner must still
 * check the selected nonce and the planner must validate against committed state.
 */
export async function repairSearchLowerBound(
  options: RepairSearchLowerBoundOptions,
): Promise<LowerBoundRepairResult> {
  const publicClient = options.publicClient;
  const snapshot = validateJournalSnapshotStructure(
    options.snapshot,
    options.snapshot.identity,
  );
  const observation = copyObservation(options.observation);
  const anchor = observation.anchor;
  const trigger = Object.freeze({
    durableAnchor: copyAnchor(options.trigger.durableAnchor),
    lowerBound: copyObservation(options.trigger.lowerBound),
    observedLower: copyAnchor(options.trigger.observedLower),
  });
  const observations = options.observations.map(copyAnchor);
  const inconsistent = Object.freeze({
    status: 'inconsistent-observations' as const,
    observation,
  });
  const attempt = snapshot.attempts[0];

  if (observation.nonce < snapshot.durableNextNonce) {
    return Object.freeze({ status: 'nonce-behind-journal', observation });
  }

  if (attempt === undefined || attempt.replacementSearch === null) {
    return inconsistent;
  }

  const search = attempt.replacementSearch;
  if (
    observation.nonce <= attempt.nonce ||
    !blockAnchorsMatch(anchor, trigger.durableAnchor) ||
    !blockAnchorsMatch(search.lowerBound.anchor, trigger.lowerBound.anchor) ||
    search.lowerBound.nonce !== trigger.lowerBound.nonce ||
    trigger.observedLower.blockNumber !== search.lowerBound.anchor.blockNumber ||
    blockAnchorsMatch(trigger.observedLower, search.lowerBound.anchor) ||
    search.lowerBound.anchor.blockNumber >= anchor.blockNumber
  ) {
    return inconsistent;
  }

  for (const retained of snapshot.attempts) {
    const fact = retained.replacementSearch?.exhausted;
    if (
      fact !== undefined &&
      fact !== null &&
      fact.anchor.blockNumber > anchor.blockNumber
    ) {
      return Object.freeze({
        status: 'anchor-behind-exhaustion',
        anchor,
        exhausted: fact,
      });
    }
  }

  const scope = Object.freeze({ operation: 'signer-recovery' as const });
  const opening = Object.freeze(await getBlockAnchor(
    publicClient,
    anchor.blockNumber,
    anchor.blockHash,
    scope,
  ));
  if (!blockAnchorsMatch(opening, anchor)) {
    return Object.freeze({ status: 'anchor-changed', observedAnchor: opening });
  }

  // The trigger belongs to the same consistency set as receipt evidence and
  // repair reads. A new bracket cannot erase an earlier conflicting header.
  observations.push(trigger.observedLower, opening);
  const probes: VerifiedProbe[] = [];
  let height = search.lowerBound.anchor.blockNumber;
  let replacement: AnchoredNonceObservation | null = null;
  let unavailableReason: 'probe-budget-exhausted' | 'no-unconsumed-candidate' =
    'probe-budget-exhausted';

  for (let index = 0; index < MAX_LOWER_BOUND_PROBES; index += 1) {
    const probe = await readSearchLowerBoundProbe({
      publicClient,
      signer: snapshot.identity.signer,
      blockNumber: height,
      scope,
    });
    if (probe.status === 'anchor-changed') {
      return probe;
    }
    if (probe.status === 'inconsistent-observations') {
      return inconsistent;
    }

    const previous = probes.at(-1);
    if (probe.observation.nonce > observation.nonce) {
      return inconsistent;
    }
    if (previous === undefined) {
      if (!blockAnchorsMatch(probe.observation.anchor, trigger.observedLower)) {
        return inconsistent;
      }
    } else {
      if (
        probe.observation.nonce > previous.observation.nonce ||
        probe.observation.anchor.blockHash.toLowerCase() !== previous.parentHash.toLowerCase()
      ) {
        return inconsistent;
      }
    }

    probes.push(probe);
    observations.push(probe.observation.anchor);
    if (probe.observation.nonce <= attempt.nonce) {
      replacement = probe.observation;
      break;
    }
    if (height === 0n) {
      unavailableReason = 'no-unconsumed-candidate';
      break;
    }
    height -= 1n;
  }

  let invalidatedFact: LowerBoundReplacementEvidence['invalidatedFact'] = null;
  if (replacement !== null && search.exhausted !== null) {
    const fact = search.exhausted;
    let observedAnchor = opening;
    if (fact.anchor.blockNumber !== anchor.blockNumber) {
      observedAnchor = Object.freeze(await getBlockAnchor(
        publicClient,
        fact.anchor.blockNumber,
        fact.anchor.blockHash,
        scope,
      ));
    }
    observations.push(observedAnchor);
    invalidatedFact = Object.freeze({ fact, observedAnchor });
  }

  const closing = Object.freeze(await getBlockAnchor(
    publicClient,
    anchor.blockNumber,
    anchor.blockHash,
    scope,
  ));
  if (!blockAnchorsMatch(closing, anchor)) {
    return Object.freeze({ status: 'anchor-changed', observedAnchor: closing });
  }
  observations.push(closing);

  if (
    !consistentHeaders(observations) ||
    (invalidatedFact !== null && blockAnchorsMatch(
      invalidatedFact.fact.anchor,
      invalidatedFact.observedAnchor,
    ))
  ) {
    return inconsistent;
  }
  if (replacement === null) {
    return Object.freeze({
      status: 'search-lower-bound-replacement-unavailable',
      reason: unavailableReason,
      observation,
    });
  }

  return Object.freeze({
    status: 'search-lower-bound-replacement-required',
    attemptId: attempt.attemptId,
    observation,
    observations: Object.freeze(observations),
    replacement: Object.freeze({
      trigger,
      opening,
      closing,
      probes: Object.freeze(probes),
      replacement,
      invalidatedFact,
    }),
  });
}

function copyAnchor(anchor: Readonly<BlockAnchor>): Readonly<BlockAnchor> {
  return Object.freeze({
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
  });
}

function copyObservation(observation: AnchoredNonceObservation): AnchoredNonceObservation {
  return Object.freeze({
    anchor: copyAnchor(observation.anchor),
    nonce: observation.nonce,
  });
}

function consistentHeaders(observations: readonly Readonly<BlockAnchor>[]): boolean {
  const seen = new Map<bigint, Readonly<BlockAnchor>>();
  for (const observation of observations) {
    const previous = seen.get(observation.blockNumber);
    if (previous !== undefined && !blockAnchorsMatch(previous, observation)) {
      return false;
    }
    seen.set(observation.blockNumber, observation);
  }
  return true;
}
