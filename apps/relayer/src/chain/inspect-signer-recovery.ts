import type {
  PublicClient,
} from 'viem';

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
  searchAttemptReplacement,
  type ReplacementSearchResult,
} from './search-attempt-replacement.js';

type UnresolvedReceipt = Exclude<
  AttemptReceiptResult,
  { status: 'verified' | 'anchor-changed' }
>;

type UnresolvedSearch = Exclude<
  ReplacementSearchResult,
  { status: 'replacement-found' | 'anchor-changed' }
>;

export interface InspectSignerRecoveryOptions {
  readonly publicClient: PublicClient;

  /** An initialized snapshot already verified for the configured signer. */
  readonly snapshot: TransactionJournalSnapshot;

  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;
}

export type SignerRecoveryInspection =
  | {
      status: 'anchor-behind-exhaustion';
      anchor: Readonly<BlockAnchor>;
      exhausted: AnchoredNonceObservation;
    }
  | {
      status: 'exhaustion-anchor-changed';
      anchor: Readonly<BlockAnchor>;
      exhausted: AnchoredNonceObservation;
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

    // Until closed-bracket invalidation is supported, this contradiction
    // must not be overwritten by ordinary re-exhaustion.
    if (
      exhausted !== null &&
      anchor.blockNumber === exhausted.anchor.blockNumber &&
      !blockAnchorsMatch(anchor, exhausted.anchor)
    ) {
      return { status: 'exhaustion-anchor-changed', anchor, exhausted };
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

  if (receipt.status === 'verified') {
    if (!consumed) {
      return {
        status: 'inconsistent-observations',
        observation,
      };
    }

    return {
      status: 'resolution-available',
      observations: Object.freeze(observations),
      observation,
      evidence: receipt.evidence,
    };
  }

  if (receipt.status === 'included-not-durable' && consumed) {
    return {
      status: 'inconsistent-observations',
      observation,
    };
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
  });

  if (search.status === 'anchor-changed') {
    return {
      status: 'anchor-changed',
      observedAnchor: search.observedAnchor,
    };
  }

  observations.push(...search.observations.filter(
    (block) => block.blockNumber <= anchor.blockNumber,
  ));

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
