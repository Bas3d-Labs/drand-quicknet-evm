import type {
  Address,
  Hash,
  Hex,
} from 'viem';

import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

export interface JournalIdentity {
  readonly chainId: number;
  readonly signer: Address;
}

/**
 * Nonce observed at the explicit anchor block.
 * 
 * Pending nonce counts must never populate this structure or decide
 * whether an attempt is resolved.
 */
export interface AnchoredNonceObservation {
  readonly anchor: Readonly<BlockAnchor>;
  readonly nonce: bigint;
}

export interface ReplacementSearch {
  /**
   * Preserved observation establishing that the recorded nonce had
   * not been consumed at this block.
   * 
   * Its nonce must be <= the attempt nonce. Newer observations must
   * not overwrite this lower bound.
   */
  readonly lowerBound: AnchoredNonceObservation;

  /**
   * Last fully searched block, inclusive.
   * 
   * Null means no blocks after lowerBound.anchor have been searched. 
   * Resume at lowerBound.anchor.blockNumber + 1 or 
   * searchedThrough + 1.
   * 
   * The reconciler must validate the saved boundary against the
   * canonical chain before skipping previously searched blocks.
   */
  readonly searchedThrough: Readonly<BlockAnchor> | null;
}

export interface JournalSignedTransaction {
  readonly transactionHash: Hash;

  /**
   * Signed bytes retained for recovery and rebroadcasting.
   * Never include them in diagnostics.
   */
  readonly signedTransaction: Hex;
}

/**
 * Records an inclusion checked against an observed chain head. Recovery
 * rechecks it before allowing further preparation. Durable reconciliation
 * determines when the record can be removed.
 */
export type JournalInclusionObservation = {
  readonly inclusion: Readonly<BlockAnchor>;
  readonly observedAt: Readonly<BlockAnchor>;
} & (
  | {
      readonly outcome: 'success' | 'reverted';
      readonly transactionHash: Hash;
    }
  | {
      readonly outcome: 'replaced';

      /** Identifies a transaction outside this attempt's signedTransactions. */
      readonly replacementTransactionHash: Hash;

      /** Signer nonce observed at observedAt. */
      readonly nonceAtAnchor: bigint;
    }
);

/** 
 * Retains the signed transactions allocated to one nonce until its
 * outcome is durably accounted for.
 */
export type JournalAttempt = {
  readonly attemptId: string;
  readonly nonce: bigint;
  readonly createdAt: string;

  /**
   * Original signed transaction and any subsequent fee replacements
   * for this attempt's nonce.
   */
  readonly signedTransactions: readonly [
    JournalSignedTransaction,
    ...JournalSignedTransaction[],
  ];

  readonly replacementSearch: ReplacementSearch | null;
} & (
  | {
      readonly phase: 'signed';
      readonly inclusion: null;
    }
  | {
      readonly phase: 'broadcast-may-have-occurred';
      readonly inclusion: null;
    }
  | {
      readonly phase: 'included';
      readonly inclusion: JournalInclusionObservation;
    }
);

export interface TransactionJournalSnapshot {
  readonly version: 1;
  readonly identity: JournalIdentity;

  /** Starting observation established when nonce state is initialized. */
  readonly baseline: AnchoredNonceObservation;

  /** Most recently retained verified signer nonce observation. */
  readonly lastObservation: AnchoredNonceObservation;

  /**
   * Next nonce available for allocation.
   * Advances when a new signed attempt is durably recorded.
   */
  readonly nextNonce: bigint;

  /**
   * First nonce not yet durably accounted for. Advances when the
   * durably resolved prefix is removed.
   */
  readonly durableNextNonce: bigint;

  /** Retained attempts ordered by increasing nonce. */
  readonly attempts: readonly JournalAttempt[];
}

export type TransactionJournalRead =
  | {
      readonly kind: 'missing';
    }
  | {
      readonly kind: 'present';
      readonly snapshot: TransactionJournalSnapshot;
    };

/**
 * Persistence boundary for one chain and signer.
 * 
 * Requires exclusive signer ownership. The coordinator owns transitions,
 * recovery, blockers, and the signer gate.
 */
export interface TransactionJournalStore {
  /**
   * Returns missing only when no journal exists.
   * 
   * Malformed, unsupported, or identity-mismatched state must reject.
   * Neither missing state nor a successful read authorizes signing.
   */
  load(): Promise<TransactionJournalRead>;

  /**
   * Resolves only after the complete snapshot is durably committed.
   * 
   * A rejection does not establish whether the write committed. The
   * coordinator must retain its previous committed state and pending
   * snapshot until persistence is confirmed through a successful save.
   * 
   * Retrying the same snapshot must be safe. Every successful save
   * must establish durability, even when the stored contents already
   * match the requested snapshot.
   */
  save(snapshot: TransactionJournalSnapshot): Promise<void>;
}