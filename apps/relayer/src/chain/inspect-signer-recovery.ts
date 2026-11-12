import type {
  PublicClient,
} from 'viem';

import {
  inspectTransactionHint,
  type TransactionHint,
  type TransactionHintInspection,
} from './inspect-transaction-hint.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  AnchoredNonceObservation,
  TransactionJournalSnapshot,
} from '../state/transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from '../state/transaction-journal-validation.js';

import {
  blockAnchorsMatch,
  checkBlockAnchor,
  getBlockAnchor,
  type BlockAnchor,
} from './block-anchor.js';

import {
  readAnchoredNonce,
} from './read-anchored-nonce.js';

import {
  reconcileAttemptReceipt,
  type AttemptReceiptResult,
} from './reconcile-attempt-receipt.js';

import {
  resolveReplacementSearch,
} from './resolve-replacement-search.js';

import {
  repairSearchLowerBound,
  type LowerBoundRepairResult,
} from './repair-search-lower-bound.js';

import {
  searchAttemptReplacement,
  type ReplacementSearchResult,
  type SearchResetEvidence,
  type ClosedLowerBoundMismatch,
} from './search-attempt-replacement.js';

type UnresolvedReceipt = Exclude<
  AttemptReceiptResult,
  { status: 'verified' | 'anchor-changed' }
>;

type UnresolvedSearch = Exclude<
  ReplacementSearchResult,
  {
    status:
      | 'replacement-found'
      | 'anchor-changed'
      | 'search-reset-required'
      | 'search-lower-bound-changed';
  }
>;

export interface InspectSignerRecoveryOptions {
  readonly publicClient: PublicClient;

  /** An initialized snapshot already verified for the configured signer. */
  readonly snapshot: TransactionJournalSnapshot;

  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;
  readonly hint?: TransactionHint;
}

export type SignerRecoveryInspection =
  | TransactionHintInspection
  | LowerBoundRepairResult
  | {
      status: 'search-unconsumed-bound-rebase-required';
      attemptId: string;
      observation: AnchoredNonceObservation;
      readonly observations: readonly Readonly<BlockAnchor>[];
      rebase: {
        readonly opening: Readonly<BlockAnchor>;
        readonly closing: Readonly<BlockAnchor>;
        readonly lowerBound: AnchoredNonceObservation;
        readonly observedLower: Readonly<BlockAnchor>;
        readonly fact: AnchoredNonceObservation;
        readonly observedFact: Readonly<BlockAnchor>;
      };
    }
  | {
      status: 'anchor-behind-exhaustion';
      anchor: Readonly<BlockAnchor>;
      exhausted: AnchoredNonceObservation;
    }
  | {
      status: 'search-reset-required';
      attemptId: string;
      observation: AnchoredNonceObservation;
      readonly observations: readonly Readonly<BlockAnchor>[];
      reset: SearchResetEvidence;
    }
  | {
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      status: 'nonce-behind-journal';
      observation: AnchoredNonceObservation;
    }
  | {
      status: 'inconsistent-observations';
      observation: AnchoredNonceObservation;
    }
  | {
      status: 'no-attempt';
      observation: AnchoredNonceObservation;
      readonly observations: readonly Readonly<BlockAnchor>[];
    }
  | {
      status: 'resolution-available';
      readonly observations: readonly Readonly<BlockAnchor>[];
      observation: AnchoredNonceObservation;
      evidence: AttemptResolutionEvidence;
    }
  | {
      status: 'unresolved';
      readonly observations: readonly Readonly<BlockAnchor>[];
      observation: AnchoredNonceObservation;
      receipt: UnresolvedReceipt;
      search: UnresolvedSearch | null;
    };

/**
 * Checks the oldest retained attempt and signer nonce at a durable block 
 * to decide what recovery can do next. If the nonce was consumed but 
 * no durable receipt is available, searches a bounded range for the 
 * transaction that used it.
 * 
 * Eligible results carry block observations from successfully closed receipt
 * and search brackets, restricted to heights at or below the durable anchor.
 * The coordinator must still validate the nonce and planner disposition before
 * admitting them to an inspection's consistency evidence.
 */
export async function inspectSignerRecovery(
  options: InspectSignerRecoveryOptions,
): Promise<SignerRecoveryInspection> {
  const {
    publicClient,
    maxBlockRange,
  } = options;

  let hint: TransactionHint | undefined;

  if (options.hint !== undefined) {
    hint = structuredClone(options.hint);
  }

  const snapshot = validateJournalSnapshotStructure(
    options.snapshot,
    options.snapshot.identity,
  );

  const anchor = Object.freeze({
    blockNumber: options.anchor.blockNumber,
    blockHash: options.anchor.blockHash,
  });

  if (
    typeof anchor.blockNumber !== 'bigint' ||
    anchor.blockNumber < 0n ||
    !isFixedHex(anchor.blockHash, 32) ||
    typeof maxBlockRange !== 'bigint' ||
    maxBlockRange <= 0n ||
    maxBlockRange >= (1n << 256n)
  ) {
    throw new TypeError('Invalid signer recovery input.');
  }

  for (const retained of snapshot.attempts) {
    if (retained.replacementSearch === null) {
      continue;
    }

    const exhausted = retained.replacementSearch.exhausted;
    if (
      exhausted !== null &&
      anchor.blockNumber < exhausted.anchor.blockNumber
    ) {
      return { status: 'anchor-behind-exhaustion', anchor, exhausted };
    }
  }

  const attempt = snapshot.attempts[0];
  let receipt: AttemptReceiptResult | null = null;

  if (attempt !== undefined) {
    receipt = await reconcileAttemptReceipt({
      publicClient,
      transactionHashes: attempt.signedTransactions.map(
        (transaction) => transaction.transactionHash,
      ),
      anchor,
    });

    if (receipt.status === 'anchor-changed') {
      return {
        status: 'anchor-changed',
        observedAnchor: receipt.observedAnchor,
      };
    }
  }

  const nonce = await readAnchoredNonce({
    publicClient,
    signer: snapshot.identity.signer,
    anchor,
    scope: {
      operation: 'signer-recovery',
    },
  });

  if (nonce.status === 'anchor-changed') {
    return nonce;
  }

  const { observation } = nonce;

  for (const retained of snapshot.attempts) {
    if (retained.replacementSearch === null) {
      continue;
    }

    const exhausted = retained.replacementSearch.exhausted;
    if (
      exhausted !== null &&
      blockAnchorsMatch(anchor, exhausted.anchor) &&
      observation.nonce !== exhausted.nonce
    ) {
      return { status: 'inconsistent-observations', observation };
    }
  }

  if (observation.nonce < snapshot.durableNextNonce) {
    return {
      status: 'nonce-behind-journal',
      observation,
    };
  }

  if (hint !== undefined && hint.attemptId !== attempt?.attemptId) {
    return {
      status: 'operator-hint-refused',
      observation,
      reason: 'wrong-attempt',
    };
  }

  if (attempt === undefined || receipt === null) {
    return {
      status: 'no-attempt',
      observations: Object.freeze([]),
      observation,
    };
  }

  // Above-anchor receipt reads classify receipts but cannot establish durable
  // canonical evidence. Keep every eligible read, including repeated heights.
  const observations = receipt.observations.filter(
    (block) => block.blockNumber <= anchor.blockNumber,
  );

  const consumed = observation.nonce > attempt.nonce;

  // Incoherent receipt and nonce evidence cannot certify a reset either.
  if (
    (receipt.status === 'verified' && !consumed) ||
    (receipt.status === 'included-not-durable' && consumed)
  ) {
    return {
      status: 'inconsistent-observations',
      observation,
    };
  }

  // A known contradiction on any retained fact takes priority over ordinary
  // recovery. Its lower bound and closing durable anchor must still validate.
  const contradicted = snapshot.attempts.find((retained) => {
    const fact = retained.replacementSearch?.exhausted;
    
    return fact !== undefined &&
      fact !== null &&
      fact.anchor.blockNumber === anchor.blockNumber &&
      !blockAnchorsMatch(fact.anchor, anchor);
  });

  let confirmationTarget = contradicted;

  // Non-oldest facts below this anchor are deferred until their attempt is
  // inspected. The oldest fact must not coexist with a newly persisted nonce
  // observation that regresses below its established consumption.
  if (
    confirmationTarget === undefined &&
    !consumed &&
    attempt.replacementSearch !== null &&
    attempt.replacementSearch.exhausted !== null
  ) {
    confirmationTarget = attempt;
  }

  if (confirmationTarget !== undefined) {
    const search = confirmationTarget.replacementSearch!;
    const confirmation = await confirmExhaustionInvalidation({
      publicClient,
      observation,
      attemptId: confirmationTarget.attemptId,
      lowerBound: search.lowerBound,
      fact: search.exhausted!,
      allowUnconsumedRebase:
        !consumed && confirmationTarget.attemptId === attempt.attemptId,
      allowLowerBoundTrigger:
        consumed && confirmationTarget.attemptId === attempt.attemptId,
      observations,
    });

    if (confirmation.status === 'search-lower-bound-changed') {
      return repairSearchLowerBound({
        publicClient,
        snapshot,
        observation,
        trigger: confirmation.trigger,
        observations,
      });
    }

    return confirmation;
  }

  if (receipt.status === 'verified') {
    return {
      status: 'resolution-available',
      observations: Object.freeze(observations),
      observation,
      evidence: receipt.evidence,
    };
  }

  if (hint !== undefined) {
    return inspectTransactionHint({
      publicClient,
      snapshot,
      observation,
      observations,
      hint,
    });
  }

  if (!consumed) {
    return {
      status: 'unresolved',
      observations: Object.freeze(observations),
      observation,
      receipt,
      search: null,
    };
  }

  const replacementSearch = resolveReplacementSearch(
    attempt,
    snapshot.lastObservation,
  );

  const search = await searchAttemptReplacement({
    publicClient,
    signer: snapshot.identity.signer,
    attempt: {
      ...attempt,
      replacementSearch,
    },
    observation,
    maxBlockRange,
    confirmDurableSearch: true,
  });

  if (search.status === 'anchor-changed') {
    return {
      status: 'anchor-changed',
      observedAnchor: search.observedAnchor,
    };
  }

  if (search.status === 'search-lower-bound-changed') {
    if (attempt.replacementSearch === null) {
      // Repair requires a committed lower bound. A stale observation used to
      // synthesize a search cannot authorize replacement of stored state.
      return { status: 'inconsistent-observations', observation };
    }

    return repairSearchLowerBound({
      publicClient,
      snapshot,
      observation,
      trigger: search.trigger,
      observations: [...observations, ...search.observations],
    });
  }

  observations.push(...search.observations.filter(
    (block) => block.blockNumber <= anchor.blockNumber,
  ));

  if (search.status === 'search-reset-required') {
    return {
      status: 'search-reset-required',
      attemptId: attempt.attemptId,
      observation,
      observations: Object.freeze(observations),
      reset: search.reset,
    };
  }

  if (search.status === 'replacement-found') {
    return {
      status: 'resolution-available',
      observations: Object.freeze(observations),
      observation,
      evidence: search.evidence,
    };
  }

  // Finding our hash does not establish success or revert. The next 
  // recovery pass starts with another receipt lookup, without an unbounded
  // polling loop.
  return {
    status: 'unresolved',
    observations: Object.freeze(observations),
    observation,
    receipt,
    search,
  };
}


type ClosedLowerBoundTrigger = {
  readonly status: 'search-lower-bound-changed';
  readonly attemptId: string;
  readonly observation: AnchoredNonceObservation;
  readonly trigger: ClosedLowerBoundMismatch;
};

/**
 * Confirms a retained lower bound and exhaustion anchor without scanning or
 * requiring a consumed nonce. Only a closed bracket can certify a reset.
 */
async function confirmExhaustionInvalidation(options: {
  readonly publicClient: PublicClient;
  readonly observation: AnchoredNonceObservation;
  readonly attemptId: string;
  readonly lowerBound: AnchoredNonceObservation;
  readonly fact: AnchoredNonceObservation;
  readonly allowLowerBoundTrigger: boolean;
  readonly allowUnconsumedRebase: boolean;
  readonly observations: readonly Readonly<BlockAnchor>[];
}): Promise<SignerRecoveryInspection | ClosedLowerBoundTrigger> {
  const {
    publicClient,
    observation,
    lowerBound,
    fact
  } = options;
  
  const anchor = observation.anchor;
  const opening = Object.freeze(await getBlockAnchor(
    publicClient,
    anchor.blockNumber,
    anchor.blockHash,
    { operation: 'signer-recovery' },
  ));

  if (!blockAnchorsMatch(anchor, opening)) {
    return { status: 'anchor-changed', observedAnchor: opening };
  }

  const observedLower = Object.freeze(await getBlockAnchor(
    publicClient,
    lowerBound.anchor.blockNumber,
    lowerBound.anchor.blockHash,
    { operation: 'signer-recovery' },
  ));

  const lowerChanged = !blockAnchorsMatch(lowerBound.anchor, observedLower);

  if (lowerChanged) {
    if (options.allowLowerBoundTrigger) {
      const closing = await checkBlockAnchor(
        publicClient,
        anchor,
        { operation: 'signer-recovery' },
      );

      if (closing !== null) {
        return closing;
      }

      return {
        status: 'search-lower-bound-changed',
        attemptId: options.attemptId,
        observation,
        trigger: Object.freeze({
          durableAnchor: anchor,
          lowerBound,
          observedLower,
        }),
      };
    }

    // Only the oldest unconsumed attempt may continue to verify its fact
    // and close this bracket. Non-oldest confirmation still refuses here.
    if (!options.allowUnconsumedRebase) {
      return { status: 'inconsistent-observations', observation };
    }
  }

  let observedFact = opening;
  if (fact.anchor.blockNumber !== anchor.blockNumber) {
    observedFact = Object.freeze(await getBlockAnchor(
      publicClient,
      fact.anchor.blockNumber,
      fact.anchor.blockHash,
      { operation: 'signer-recovery' },
    ));
  }

  const closing = await checkBlockAnchor(
    publicClient,
    anchor,
    { operation: 'signer-recovery' },
  );

  if (closing !== null) {
    return closing;
  }

  if (blockAnchorsMatch(fact.anchor, observedFact)) {
    // The fact remains confirmed but the descendant nonce contradicts it.
    // Retain the blocker and refuse to persist the regressed observation.
    return { status: 'inconsistent-observations', observation };
  }

  if (lowerChanged) {
    return {
      status: 'search-unconsumed-bound-rebase-required',
      attemptId: options.attemptId,
      observation,
      observations: Object.freeze([
        ...options.observations,
        observedLower,
        observedFact,
      ]),
      // A null closing check verified this exact anchor.
      rebase: Object.freeze({
        opening,
        closing: Object.freeze({ ...anchor }),
        lowerBound,
        observedLower,
        fact,
        observedFact,
      }),
    };
  }

  return {
    status: 'search-reset-required',
    attemptId: options.attemptId,
    observation,
    observations: Object.freeze([
      ...options.observations,
      observedLower,
      observedFact,
    ]),
    reset: Object.freeze({
      reason: 'exhaustion-anchor-changed',
      expected: fact.anchor,
      observed: observedFact,
      lowerBound,
    }),
  };
}
