import type {
  Hash,
} from 'viem';

import {
  blockAnchorsMatch,
} from '../chain/block-anchor.js';

import type {
  SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import type {
  LowerBoundReplacementEvidence,
} from '../chain/repair-search-lower-bound.js';

import {
  assertResolutionTransaction,
  snapshotResolutionEvidence,
} from '../diagnostics/resolution-validation.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  finishOperatorOutcome,
  journalSnapshotDigest,
  type OperatorAttributionRequest,
} from './operator-attribution.js';

import {
  MAX_OPERATOR_OUTCOMES,
  type OperatorAttributedOutcome,
} from './transaction-journal.js';

import type {
  AnchoredNonceObservation,
  JournalIdentity,
  TransactionJournalSnapshot,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

import {
  validateUnconsumedBoundRebase,
  type RequiredUnconsumedRebase,
} from './validate-unconsumed-bound-rebase.js';

import {
  validateLowerBoundReplacement,
} from './validate-lower-bound-replacement.js';

export interface CommittedAttemptResolution {
  readonly signer: JournalIdentity['signer'];
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly nonce: bigint;
  readonly resolution: AttemptResolutionEvidence;
}

export type RecoveryWriteCompletion =
  | {
      readonly kind: 'operator-attribution';
      readonly outcome: OperatorAttributedOutcome;
    }
  | {
      readonly kind: 'search-unconsumed-bound-rebase';
      readonly event: {
        readonly signer: JournalIdentity['signer'];
        readonly attemptId: string;
        readonly nonce: bigint;
        readonly observation: AnchoredNonceObservation;
        readonly evidence: RequiredUnconsumedRebase['rebase'];
      };
    }
  | {
      readonly kind: 'search-lower-bound-replacement';
      readonly event: {
        readonly signer: JournalIdentity['signer'];
        readonly attemptId: string;
        readonly nonce: bigint;
        readonly oldLowerBound: AnchoredNonceObservation;
        readonly observedLower: LowerBoundReplacementEvidence['trigger']['observedLower'];
        readonly replacement: AnchoredNonceObservation;
        readonly durableObservation: AnchoredNonceObservation;
        readonly probeCount: number;
        readonly invalidatedFact: LowerBoundReplacementEvidence['invalidatedFact'];
      };
    }
  | {
      readonly kind: 'observation';
    }
  | {
      readonly kind: 'resolution';
      readonly event: CommittedAttemptResolution;
    }
  | {
      readonly kind: 'search-reset';
      readonly event: {
        readonly signer: JournalIdentity['signer'];
        readonly attemptId: string;
        readonly nonce: bigint;
        readonly reason: 'searched-through-changed' | 'exhaustion-anchor-changed';
        readonly expectedBlock: bigint;
        readonly expectedBlockHash: Hash;
        readonly observedBlock: bigint;
        readonly observedBlockHash: Hash;
        readonly durableBlock: bigint;
        readonly durableBlockHash: Hash;
      };
    }
  | {
      readonly kind: 'search-progress';
    };

export interface PlanSignerRecoveryOptions {
  readonly identity: JournalIdentity;
  readonly snapshot: TransactionJournalSnapshot;
  readonly inspection: SignerRecoveryInspection;
  readonly unattributedActivity: boolean;
  readonly attribution?: OperatorAttributionRequest;
}

export type SignerRecoveryPlan =
  | {
      readonly kind: 'unchanged';
      readonly reason:
        | 'inspection-not-committable'
        | 'preserved-higher-observation'
        | 'ledger-capacity-reached';
    }
  | {
      readonly kind: 'persist';
      readonly snapshot: TransactionJournalSnapshot;
      readonly completion: RecoveryWriteCompletion;
    };

/**
 * Plans a journal transition from an existing recovery inspection.
 */
export function planSignerRecovery(
  options: PlanSignerRecoveryOptions,
): SignerRecoveryPlan {
  const {
    identity,
    snapshot,
    inspection,
    unattributedActivity,
  } = options;

  if (
    inspection.status === 'operator-hint-refused' ||
    inspection.status === 'anchor-changed' ||
    inspection.status === 'anchor-behind-exhaustion' ||
    inspection.status === 'search-lower-bound-replacement-unavailable' ||
    inspection.status === 'nonce-behind-journal' ||
    inspection.status === 'inconsistent-observations'
  ) {
    return {
      kind: 'unchanged',
      reason: 'inspection-not-committable',
    };
  }

  if (inspection.status === 'operator-attribution-available') {
    const oldest = snapshot.attempts[0];
    const request = options.attribution;

    if (
      request === undefined ||
      oldest === undefined ||
      oldest.replacementSearch === null ||
      inspection.attemptId !== oldest.attemptId ||
      request.hint.attemptId !== oldest.attemptId ||
      request.hint.transactionHash.toLowerCase() !== inspection.transactionHash ||
      inspection.snapshotDigest !== journalSnapshotDigest(snapshot)
    ) {
      return { kind: 'unchanged', reason: 'inspection-not-committable' };
    }

    if (snapshot.ledger.outcomes.length >= MAX_OPERATOR_OUTCOMES) {
      return {
        kind: 'unchanged',
        reason: 'ledger-capacity-reached',
      };
    }

    const ordinary = planSignerRecovery({
      identity,
      snapshot,
      unattributedActivity,
      inspection: {
        status: 'resolution-available',
        observation: inspection.observation,
        observations: inspection.observations,
        evidence: {
          outcome: 'replaced',
          anchor: inspection.observation.anchor,
          inclusion: inspection.inclusion,
          replacementTransactionHash: inspection.transactionHash,
          nonceAtAnchor: inspection.observation.nonce,
        },
      },
    });

    if (ordinary.kind !== 'persist') {
      return ordinary;
    }

    const outcome = finishOperatorOutcome(snapshot, {
      kind: 'operator-attributed',
      requestId: request.requestId,
      snapshotDigest: inspection.snapshotDigest,
      operator: request.operator,
      at: request.at,
      attemptId: oldest.attemptId,
      workId: oldest.workId,
      nonce: oldest.nonce,
      candidateHashes: oldest.signedTransactions.map(
        (candidate) => candidate.transactionHash.toLowerCase() as Hash,
      ),
      durable: inspection.observation,
      finality: request.finality,
      lowerBound: oldest.replacementSearch.lowerBound,
      replacement: {
        transactionHash: inspection.transactionHash,
        inclusion: inspection.inclusion,
      },
      priorSearch: {
        searchedThrough: oldest.replacementSearch.searchedThrough,
        exhausted: oldest.replacementSearch.exhausted,
      },
    });

    return {
      kind: 'persist',
      snapshot: validateJournalSnapshotStructure({
        ...ordinary.snapshot,
        ledger: {
          outcomes: [...snapshot.ledger.outcomes, outcome],
          obligations: [],
        },
      }, identity),
      completion: Object.freeze({ kind: 'operator-attribution', outcome }),
    };
  }

  if (inspection.status === 'search-unconsumed-bound-rebase-required') {
    const validated = validateUnconsumedBoundRebase(snapshot, inspection);

    if (validated === null) {
      return {
        kind: 'unchanged',
        reason: 'inspection-not-committable',
      };
    }

    const oldest = snapshot.attempts[0]!;
    let lastObservation = validated.observation;

    if (
      unattributedActivity &&
      snapshot.lastObservation.nonce > lastObservation.nonce
    ) {
      lastObservation = snapshot.lastObservation;
    }

    const next = validateJournalSnapshotStructure({
      ...snapshot,
      lastObservation,
      attempts: [
        {
          ...oldest,
          replacementSearch: seedReplacementSearch(validated.observation),
        },
        ...snapshot.attempts.slice(1),
      ],
    }, identity);

    return {
      kind: 'persist',
      snapshot: next,
      completion: Object.freeze({
        kind: 'search-unconsumed-bound-rebase',
        event: Object.freeze({
          signer: identity.signer,
          attemptId: oldest.attemptId,
          nonce: oldest.nonce,
          observation: validated.observation,
          evidence: validated.rebase,
        }),
      }),
    };
  }

  if (inspection.status === 'search-lower-bound-replacement-required') {
    const validated = validateLowerBoundReplacement(snapshot, inspection);
    if (validated === null) {
      return {
        kind: 'unchanged',
        reason: 'inspection-not-committable',
      };
    }

    const oldest = snapshot.attempts[0]!;
    const evidence = validated.replacement;
    let lastObservation = validated.observation;
    if (
      unattributedActivity &&
      snapshot.lastObservation.nonce > lastObservation.nonce
    ) {
      lastObservation = snapshot.lastObservation;
    }

    const next = validateJournalSnapshotStructure({
      ...snapshot,
      lastObservation,
      attempts: [
        {
          ...oldest,
          replacementSearch: {
            lowerBound: evidence.replacement,
            searchedThrough: null,
            exhausted: null,
          },
        },
        ...snapshot.attempts.slice(1),
      ],
    }, identity);

    return {
      kind: 'persist',
      snapshot: next,
      completion: Object.freeze({
        kind: 'search-lower-bound-replacement',
        event: Object.freeze({
          signer: identity.signer,
          attemptId: oldest.attemptId,
          nonce: oldest.nonce,
          oldLowerBound: evidence.trigger.lowerBound,
          observedLower: evidence.trigger.observedLower,
          replacement: evidence.replacement,
          durableObservation: validated.observation,
          probeCount: evidence.probes.length,
          invalidatedFact: evidence.invalidatedFact,
        }),
      }),
    };
  }

  if (
    inspection.status === 'unresolved' &&
    (
      inspection.search?.status === 'boundary-changed' ||
      inspection.search?.status === 'anchor-behind-search'
    )
  ) {
    return {
      kind: 'unchanged',
      reason: 'inspection-not-committable',
    };
  }

  let lastObservation = inspection.observation;

  if (
    unattributedActivity &&
    snapshot.lastObservation.nonce > lastObservation.nonce
  ) {
    // Resolution and confirmed invalidation preserve the higher observation.
    if (
      inspection.status !== 'resolution-available' &&
      inspection.status !== 'search-reset-required'
    ) {
      return {
        kind: 'unchanged',
        reason: 'preserved-higher-observation',
      };
    }

    lastObservation = snapshot.lastObservation;
  }

  const oldest = snapshot.attempts[0];

  let attempts = snapshot.attempts;
  let durableNextNonce = snapshot.durableNextNonce;

  let completion: RecoveryWriteCompletion = {
    kind: 'observation',
  };

  if (inspection.status === 'search-reset-required') {
    const target = attempts.find((attempt) => attempt.attemptId === inspection.attemptId);
    if (
      target === undefined ||
      target.replacementSearch === null ||
      !blockAnchorsMatch(
        target.replacementSearch.lowerBound.anchor,
        inspection.reset.lowerBound.anchor,
      ) ||
      target.replacementSearch.lowerBound.nonce !== inspection.reset.lowerBound.nonce
    ) {
      throw new Error('Reset requires the retained validated lower bound.');
    }
    const lowerBound = target.replacementSearch.lowerBound;
    attempts = attempts.map((attempt) => {
      if (attempt.attemptId !== target.attemptId) {
        return attempt;
      }
      return {
        ...attempt,
        replacementSearch: {
          lowerBound,
          searchedThrough: null,
          exhausted: null,
        },
      };
    });
    completion = {
      kind: 'search-reset',
      event: Object.freeze({
        signer: identity.signer,
        attemptId: target.attemptId,
        nonce: target.nonce,
        reason: inspection.reset.reason,
        expectedBlock: inspection.reset.expected.blockNumber,
        expectedBlockHash: inspection.reset.expected.blockHash,
        observedBlock: inspection.reset.observed.blockNumber,
        observedBlockHash: inspection.reset.observed.blockHash,
        durableBlock: inspection.observation.anchor.blockNumber,
        durableBlockHash: inspection.observation.anchor.blockHash,
      }),
    };
  } else if (inspection.status === 'resolution-available') {
    if (oldest === undefined) {
      throw new Error('No recorded attempt is available to resolve.');
    }

    const resolution = snapshotResolutionEvidence(
      inspection.evidence,
    );

    assertResolutionTransaction(oldest, resolution);

    let transactionHash = oldest.signedTransactions[0].transactionHash;

    if (resolution.outcome !== 'replaced') {
      transactionHash = resolution.transactionHash;
    }

    completion = {
      kind: 'resolution',
      event: Object.freeze({
        signer: identity.signer,
        attemptId: oldest.attemptId,
        transactionHash,
        nonce: oldest.nonce,
        resolution,
      }),
    };

    durableNextNonce = oldest.nonce + 1n;
    attempts = attempts.slice(1);
  } else if (oldest !== undefined) {
    let replacementSearch = oldest.replacementSearch;

    if (replacementSearch === null) {
      let lowerBound: AnchoredNonceObservation | undefined;

      if (lastObservation.nonce <= oldest.nonce) {
        lowerBound = lastObservation;
      } else if (snapshot.lastObservation.nonce <= oldest.nonce) {
        lowerBound = snapshot.lastObservation;
      }

      if (lowerBound !== undefined) {
        replacementSearch = seedReplacementSearch(lowerBound);
      }
    }

    if (
      inspection.status === 'unresolved' &&
      inspection.search?.status === 'not-found' &&
      inspection.search.scannedBlocks > 0n
    ) {
      if (replacementSearch === null) {
        throw new Error(
          'Search progress requires a recorded lower bound.'
        );
      }

      replacementSearch = {
        ...replacementSearch,
        searchedThrough: inspection.search.searchedThrough,
      };

      if (inspection.search.remainingBlocks === 0n) {
        if (!blockAnchorsMatch(
          inspection.search.searchedThrough,
          inspection.observation.anchor,
        )) {
          throw new Error('Exhausted search must reach the selected anchor.');
        }

        replacementSearch = {
          ...replacementSearch,
          exhausted: {
            anchor: inspection.search.searchedThrough,
            nonce: inspection.observation.nonce,
          },
        };
      }

      completion = { kind: 'search-progress' };
    }

    attempts = [
      {
        ...oldest,
        replacementSearch,
      },
      ...attempts.slice(1),
    ];
  }

  const next = validateJournalSnapshotStructure({
    ...snapshot,
    lastObservation,
    durableNextNonce,
    attempts,
  }, identity);

  return {
    kind: 'persist',
    snapshot: next,
    completion,
  };
}

function seedReplacementSearch(lowerBound: AnchoredNonceObservation) {
  return {
    lowerBound,
    searchedThrough: null,
    exhausted: null,
  };
}
