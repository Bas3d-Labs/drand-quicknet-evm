import type {
  PublicClient,
} from 'viem';

import type {
  BlockAnchor,
} from './block-anchor.js';

import {
  reconcileAttemptReceipt,
  type AttemptReceiptResult,
} from './reconcile-attempt-receipt.js';

import {
  readAnchoredNonce,
} from './read-anchored-nonce.js';

import {
  searchAttemptReplacement,
  type ReplacementSearchResult,
} from './search-attempt-replacement.js';

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
      status: 'anchor-changed';
      observedAnchor: Readonly<BlockAnchor>;
    }
  | {
      status: 'nonce-behind-journal' | 'no-attempt';
      observation: AnchoredNonceObservation;
    }
  | {
      status: 'inconsistent-observations';
      observation: AnchoredNonceObservation;
    }
  | {
      status: 'resolution-available';
      observation: AnchoredNonceObservation;
      evidence: AttemptResolutionEvidence;
    }
  | {
      status: 'unresolved';
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
 * Returns observations for the coordinator to apply.
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
      return receipt;
    }
  }

  const nonce = await readAnchoredNonce({
    publicClient,
    signer: snapshot.identity.signer,
    anchor,
  });

  if (nonce.status === 'anchor-changed') {
    return nonce;
  }

  const { observation } = nonce;

  if (observation.nonce < snapshot.durableNextNonce) {
    return {
      status: 'nonce-behind-journal',
      observation,
    };
  }

  if (attempt === undefined || receipt === null) {
    return {
      status: 'no-attempt',
      observation,
    };
  }

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
      observation,
      receipt,
      search: null,
    };
  }

  let replacementSearch = attempt.replacementSearch;

  if (
    replacementSearch === null &&
    snapshot.lastObservation.nonce <= attempt.nonce
  ) {
    replacementSearch = {
      lowerBound: snapshot.lastObservation,
      searchedThrough: null,
    };
  }

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
    return search;
  }

  if (search.status === 'replacement-found') {
    return {
      status: 'resolution-available',
      observation,
      evidence: search.evidence,
    };
  }

  // Finding our hash does not establish success or revert. The next 
  // recovery pass starts with another receipt lookup, without an unbounded
  // polling loop.
  return {
    status: 'unresolved',
    observation,
    receipt,
    search,
  };
}
