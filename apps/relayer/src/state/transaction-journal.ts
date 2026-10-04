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
   * Its nonce bust be <= the attempt nonce. Newer observations must
   * not overwrite this lower bound.
   */
  readonly lowerBound: AnchoredNonceObservation;

  /**
   * Last fully searched block, inclusive.
   * 
   * Null means no blocks after lowerBound have been searched. Result
   * at lowerBound.blockNumber + 1 or searchedThrough + 1.
   * 
   * The reconciler must validate the saved boundary against the
   * canonical chain before using it to skip previously searched blocks.
   */
  readonly searchedThrough: Readonly<BlockAnchor> | null;
}

export interface JournalAttempt {
  readonly attemptId: string;
  readonly nonce: bigint;
  readonly transactionHash: Hash;

  /**
   * Recovery material. Persist it, but never project it into events,
   * heartbeat snapshots, metrics, or error fields.
   */
  readonly signedTransaction: Hex;

  /** ISO timestamp retained across restarts for unresolved age. */
  readonly createdAt: string;

  readonly phase:
    | 'signed'
    | 'broadcast-may-have-occurred';

  /**
   * Null means no valid replacement-search lower bound is available.
   * It does not authorize inventing a range or clearing the attempt.
   */
  readonly replacementSearch: ReplacementSearch | null;
}

export interface TransactionJournalSnapshot {
  readonly version: 1;
  readonly identity: JournalIdentity;

  /** Explicit initialization observation. Never silently reconstructed. */
  readonly baseline: AnchoredNonceObservation;

  /** Latest validated observation, independent of the search lower bound. */
  readonly lastObservation: AnchoredNonceObservation;

  /**
   * Next nonce accounted for by this journal.
   * 
   * Initially baseline.nonce. While an attempt exists, its nonce equals
   * nextNonce. After evidence-backed resolution, advance to attempt.nonce + 1
   * in the same durable snapshot that removes the attempt.
   * 
   * Never advance this value merely to match a higher RPC nonce count.
   */
  readonly nextNonce: bigint;

  readonly attempt: JournalAttempt | null;
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
   * coordinator must retain its previous unresolved attempt and
   * persistence-failure latch until persistence is confirmed through
   * a successful save.
   * 
   * Retrying the same snapshot must be safe. Every successful save
   * must establish durability, even when the stored contents already
   * match the requested snapshot.
   */
  save(snapshot: TransactionJournalSnapshot): Promise<void>;
}