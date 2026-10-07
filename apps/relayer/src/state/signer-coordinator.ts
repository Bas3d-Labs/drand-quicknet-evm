import {
  randomUUID,
} from 'node:crypto';

import type {
  Hash,
  LocalAccount,
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  getBlockAnchor,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  inspectSignerInclusions,
  type SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import {
  inspectSignerRecovery,
  type SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import {
  readAnchoredNonce,
  type AnchoredNonceResult,
} from '../chain/read-anchored-nonce.js';

import type {
  ReplacementSearchResult,
} from '../chain/search-attempt-replacement.js';

import {
  signPreparedTransaction,
  type PreparedRelayerTransaction,
} from '../chain/sign-prepared-transaction.js';

import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import type {
  AttemptResolutionEvidence,
} from '../diagnostics/transaction-evidence.js';

import {
  snapshotResolutionEvidence,
  assertResolutionTransaction,
} from '../diagnostics/resolution-validation.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  JournalPersistence,
} from './journal-persistence.js';

import {
  evaluateSignerGate,
  BLOCKER_PRECEDENCE,
  type CoordinatorBlocker,
  type SignerBlocker,
} from './signer-gate.js';

import type {
  AnchoredNonceObservation,
  JournalAttempt,
  JournalIdentity,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
  readonly maxRetainedAttempts: number;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly now?: () => number;
}

export interface RecordSearchProgressOptions {
  readonly attemptId: string;
  readonly observation: AnchoredNonceObservation;
  readonly result: Extract<
    ReplacementSearchResult,
    { status: 'not-found' }
  >;
}

export interface SignerBootstrapAuthorization {
  readonly expectedNonce: bigint;

  /** 
   * Operator confirms no signed or broadcast transactions 
   * remain unaccounted for. 
   */
  readonly confirmNoUntrackedTransactions: true;
}

export interface RecoverSignerOptions {
  readonly publicClient: PublicClient;
  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;

  /**
   * Explicit first-use authorization, considered only when the journal
   * is missing.
   */
  readonly bootstrap?: SignerBootstrapAuthorization;
}

type ResolutionEvent =
  Parameters<ScopedRelayerLog['attemptResolved']>[0];

type PendingWrite =
  | {
      kind: 'bootstrap';
    }
  | {
      kind: 'resolution';
      event: ResolutionEvent;
    }
  | {
      kind: 'observation';
    }
  | {
      kind: 'search-progress';
      exhausted: boolean;
    }
  | {
      kind: 'prepared';
    }
  | {
      kind: 'broadcast';
    };

export interface PrepareAttemptOptions {
  readonly account: LocalAccount;
  readonly transaction: PreparedRelayerTransaction;
}

export interface PreparedAttempt {
  readonly attemptId: string;
  readonly transactionHash: Hash;
  readonly nonce: bigint;
}

type SignerEventOperation =
  | 'prepare-attempt'
  | 'broadcast-attempt'
  | 'reconcile-attempt';

export interface BroadcastAttemptOptions {
  readonly publicClient: PublicClient;
  readonly attemptId: string;
}

export type BroadcastAttemptResult = PreparedAttempt & {
  readonly status: 'acknowledged';
};

export interface AttemptSummary {
  readonly attemptId: string;
  readonly nonce: bigint;
  readonly phase: JournalAttempt['phase'];

  /** Original transaction hash followed by any fee replacement hashes. */
  readonly transactionHashes: readonly [Hash, ...Hash[]];
}

export interface CheckSignerInclusionOptions {
  readonly publicClient: PublicClient;
  readonly head: Readonly<BlockAnchor>;
}

/**
 * Coordinates durable nonce observations and attempt resolution so restart
 * recovery and signer availability follow the same journal state.
 */
export class SignerCoordinator {
  private recoveryComplete = false;
  private inclusionChecksComplete = false;
  private busy = false;
  private emitting = false;
  private broadcastPermit: string | undefined;

  private readonly blockers = new Set<CoordinatorBlocker>();
  private readonly episodeReasons = new Set<SignerBlocker>();

  private blockedSince: string | null = null;
  private previousPrimary: SignerBlocker | null = null;
  private pendingWrite: PendingWrite | undefined;
  private attemptLog: ScopedRelayerLog | undefined;

  private constructor(
    private readonly persistence: JournalPersistence,
    private readonly identity: JournalIdentity,
    private readonly maxRetainedAttempts: number,
    private readonly log: ScopedRelayerLog,
    private readonly now: () => number,
    private readonly createErrorSummary: ErrorSummaryFactory,
  ) {}

  static async create(
    options: SignerCoordinatorOptions,
  ): Promise<SignerCoordinator> {
    const maxRetainedAttempts = options.maxRetainedAttempts;

    if (
      !Number.isSafeInteger(maxRetainedAttempts) ||
      maxRetainedAttempts <= 0
    ) {
      throw new TypeError('Invalid retained attempt capacity.');
    }

    const identity = Object.freeze({ ...options.identity });

    const persistence = await JournalPersistence.create({
      identity,
      store: options.store,
      initial: await options.store.load(),
    });

    const coordinator = new SignerCoordinator(
      persistence,
      identity,
      maxRetainedAttempts,
      options.log.withContext({ signer: identity.signer }),
      options.now ?? Date.now,
      options.createErrorSummary,
    );

    const current = persistence.current;
    if (current.kind === 'present') {
      const attempts = current.snapshot.attempts;
      const first = attempts[0];

      if (first !== undefined) {
        const signedTransactions = attempts.flatMap((attempt) => 
          attempt.signedTransactions.map(
            (transaction) => transaction.signedTransaction
          ),
        );

        try {
          coordinator.attemptLog = coordinator.log.withErrorSummary(
            options.createErrorSummary(signedTransactions),
          );
        } catch {
          throw new Error('Could not configure signed attempt diagnostics.');
        }

        coordinator.blockedSince = first.createdAt;
      }
    }
    
    coordinator.latchUnattributedActivity();
    coordinator.latchExhaustedSearch();
    coordinator.refresh();

    return coordinator;
  }

  get attempts(): readonly AttemptSummary[] {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return Object.freeze([]);
    }
    
    return Object.freeze(current.snapshot.attempts.map((attempt) => {
      const [first, ...remaining] = attempt.signedTransactions;

      const transactionHashes: readonly [Hash, ...Hash[]] = Object.freeze([
        first.transactionHash,
        ...remaining.map((transaction) => transaction.transactionHash),
      ]);

      return Object.freeze({
        attemptId: attempt.attemptId,
        nonce: attempt.nonce,
        phase: attempt.phase,
        transactionHashes,
      });
    }));
  }

  /**
   * Determine whether the oldest unresolved attempt was a one-use
   * broadcast permit.
   */
  get canBroadcast(): boolean {
    const current = this.persistence.current;

    if (
      this.busy ||
      this.emitting ||
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle' ||
      current.kind !== 'present'
    ) {
      return false;
    }

    const attempt = current.snapshot.attempts.find(
      (candidate) => candidate.phase !== 'included'
    );

    if (attempt === undefined) {
      return false;
    }

    return (
      this.recoveryComplete &&
      this.broadcastPermit === attempt.attemptId &&
      this.blockers.size === 0 &&
      current.snapshot.lastObservation.nonce === attempt.nonce
    );
  }

  get status() {
    const gate = evaluateSignerGate({
      persistence: this.persistence,
      recoveryComplete: this.recoveryComplete,
      inclusionChecksComplete: this.inclusionChecksComplete,
      maxRetainedAttempts: this.maxRetainedAttempts,
      blockers: this.blockers,
    });

    return Object.freeze({
      ...gate,
      open: gate.open && !this.busy,
      recoveryComplete: this.recoveryComplete,
      inclusionChecksComplete: this.inclusionChecksComplete,
      persistenceState: this.persistence.state,
      blockedSince: this.blockedSince,
    });
  }

  /**
   * Signs and durably appends the next allocated transaction. Retained
   * attempts remain available for recovery and diagnostics.
   */
  async prepareAttempt(
    options: PrepareAttemptOptions,
    cycle?: number,
  ): Promise<PreparedAttempt> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (
      !this.status.open ||
      current.kind !== 'present'
    ) {
      throw new Error(
        'The signer gate must be open before preparing an attempt.'
      );
    }

    const previousAttemptLog = this.attemptLog;
    const previousBlockedSince = this.blockedSince;
    const previousInclusionChecksComplete = this.inclusionChecksComplete;

    this.broadcastPermit = undefined;
    this.busy = true;

    try {
      const attemptId = randomUUID();
      const createdAt = this.timestamp();

      const signed = await signPreparedTransaction({
        identity: this.identity,
        nonce: current.snapshot.nextNonce,
        account: options.account,
        transaction: options.transaction,
      });

      const signedTransactions = [
        ...current.snapshot.attempts.flatMap((attempt) => 
          attempt.signedTransactions.map(
            (transaction) => transaction.signedTransaction,
          ),
        ),
        signed.signedTransaction,
      ];

      // Install protection for both retained and newly signed bytes before
      // persistence can fail. Queue-wide diagnostics have no one attemptId.
      try {
        this.attemptLog = this.log.withErrorSummary(
          this.createErrorSummary(signedTransactions)
        );
      } catch {
        throw new Error('Could not configure signed attempt diagnostics.');
      }

      const attempt: JournalAttempt = {
        attemptId,
        nonce: signed.nonce,
        createdAt,
        signedTransactions: [{
          transactionHash: signed.transactionHash,
          signedTransaction: signed.signedTransaction,
        }],
        phase: 'signed',
        inclusion: null,
        replacementSearch: {
          lowerBound: current.snapshot.lastObservation,
          searchedThrough: null,
        },
      };

      const next = validateJournalSnapshotStructure({
        ...current.snapshot,
        nextNonce: current.snapshot.nextNonce + 1n,
        attempts: [
          ...current.snapshot.attempts,
          attempt,
        ],
      }, this.identity);

      this.blockedSince ??= createdAt;
      this.inclusionChecksComplete = false;
      this.pendingWrite = { kind: 'prepared' };

      await this.persistence.save(next);

      this.finishWrite(cycle);
      this.broadcastPermit = attemptId;

      return Object.freeze({
        attemptId,
        transactionHash: signed.transactionHash,
        nonce: signed.nonce,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        // No retained write: restore the previously committed queue's
        // diagnostic policy and inclusion authorization.
        this.pendingWrite = undefined;
        this.attemptLog = previousAttemptLog;
        this.blockedSince = previousBlockedSince;
        this.inclusionChecksComplete = previousInclusionChecksComplete;
      } else {
        // Preserve the expanded diagnostic policy through every retry.
        this.recoveryComplete = false;
        this.inclusionChecksComplete = false;
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle, 'prepare-attempt');
    }
  }

  /**
   * Broadcasts the latest recorded signed transaction for the oldest
   * unresolved attempt after durably marking that broadcast may occur.
   */
  async broadcastAttempt(
    options: BroadcastAttemptOptions,
    cycle?: number,
  ): Promise<BroadcastAttemptResult> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error('Broadcast does not match a recorded attempt.');
    }

    const attemptIndex = current.snapshot.attempts.findIndex(
      (candidate) => candidate.phase !== 'included',
    );

    const attempt = current.snapshot.attempts[attemptIndex];

    if (
      attempt === undefined ||
      options.attemptId !== attempt.attemptId
    ) {
      throw new Error('Broadcast does not match a recorded attempt.');
    }

    if (!this.canBroadcast) {
      throw new Error('Fresh reconciliation is required before broadcasting.');
    }

    const transaction =
      attempt.signedTransactions[attempt.signedTransactions.length - 1]!;

    const publicClient = options.publicClient;

    this.broadcastPermit = undefined;
    this.recoveryComplete = false;
    this.inclusionChecksComplete = false;
    this.busy = true;

    try {
      if (attempt.phase === 'signed') {
        this.pendingWrite = { kind: 'broadcast' };

        await this.persistence.save({
          ...current.snapshot,
          attempts: current.snapshot.attempts.map((candidate, index) => 
            index === attemptIndex
              ? {
                  ...candidate,
                  phase: 'broadcast-may-have-occurred',
                  inclusion: null,
                }
              : candidate,
          ),
        });

        // Keep exclusive ownership through the RPC call. finishWrite
        // would release it before the broadcast outcome is known.
        this.pendingWrite = undefined;
      }

      let returnedHash: unknown;

      try {
        returnedHash = await publicClient.request({
          method: 'eth_sendRawTransaction',
          params: [transaction.signedTransaction],
        }, {
          retryCount: 0,
        });
      } catch {
        throw new Error(
          'Transaction broadcast outcome is uncertain. Reconciliation is required.'
        );
      }

      if (
        !isFixedHex(returnedHash, 32) ||
        returnedHash.toLowerCase() !== transaction.transactionHash.toLowerCase()
      ) {
        throw new Error(
          'RPC returned an unexpected transaction hash. Reconciliation is required.'
        );
      }

      return Object.freeze({
        status: 'acknowledged',
        attemptId: attempt.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: attempt.nonce,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle, 'broadcast-attempt');
    }
  }

  /**
   * Reconciles the signer against a durable block and saves the resulting
   * observation, resolution, or search progress together. Keeps other
   * coordinator operations out until inspection and persistence finish.
   * A failed write must be retried before a fresh recovery pass can proceed.
   */
  async recover(
    options: RecoverSignerOptions,
    cycle?: number,
  ): Promise<SignerRecoveryInspection> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    this.broadcastPermit = undefined;
    this.busy = true;
    this.recoveryComplete = false;
    this.inclusionChecksComplete = false;

    try {
      if (current.kind === 'missing') {
        const result = await this.readBootstrapObservation(options);
        if (result.status === 'anchor-changed') {
          return result;
        }

        const { observation } = result;

        this.pendingWrite = {
          kind: 'bootstrap',
        };

        await this.persistence.save({
          version: 1,
          identity: this.identity,
          baseline: observation,
          lastObservation: observation,
          nextNonce: observation.nonce,
          durableNextNonce: observation.nonce,
          attempts: [],
        });

        this.recoveryComplete = true;
        this.finishWrite(cycle);

        return {
          status: 'no-attempt',
          observation,
        };
      }
      
      const result = await inspectSignerRecovery({
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        anchor: options.anchor,
        maxBlockRange: options.maxBlockRange,
      });

      if (
        result.status === 'anchor-changed' ||
        result.status === 'nonce-behind-journal' ||
        result.status === 'inconsistent-observations'
      ) {
        return result;
      }

      if (
        result.status === 'unresolved' &&
        (
          result.search?.status === 'boundary-changed' ||
          result.search?.status === 'anchor-behind-search'
        )
      ) {
        return result;
      }

      let lastObservation = result.observation;

      if (
        this.blockers.has('unattributed-signer-activity') &&
        current.snapshot.lastObservation.nonce > lastObservation.nonce
      ) {
        // Resolving the attempt must not erase evidence of other activity.
        // Search progress belongs to the newly inspected anchor though.
        if (result.status !== 'resolution-available') {
          return result;
        }

        lastObservation = current.snapshot.lastObservation;
      }

      const oldest = current.snapshot.attempts[0];

      let attempts = current.snapshot.attempts;
      let durableNextNonce = current.snapshot.durableNextNonce;

      let pending: PendingWrite = {
        kind: 'observation',
      };

      if (result.status === 'resolution-available') {
        if (oldest === undefined) {
          throw new Error('No recorded attempt is available to resolve.');
        }

        const resolution = snapshotResolutionEvidence(result.evidence);

        assertResolutionTransaction(oldest, resolution);

        pending = {
          kind: 'resolution',
          event: Object.freeze({
            signer: this.identity.signer,
            attemptId: oldest.attemptId,
            transactionHash: resolution.outcome === 'replaced'
              ? oldest.signedTransactions[0].transactionHash
              : resolution.transactionHash,
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
          } else if (
            current.snapshot.lastObservation.nonce <= oldest.nonce
          ) {
            lowerBound = current.snapshot.lastObservation;
          }

          if (lowerBound !== undefined) {
            replacementSearch = {
              lowerBound,
              searchedThrough: null,
            };
          }
        }

        if (
          result.status === 'unresolved' &&
          result.search?.status === 'not-found' &&
          result.search.scannedBlocks > 0n
        ) {
          if (replacementSearch === null) {
            throw new Error('Search progress requires a recorded lower bound.');
          }

          replacementSearch = {
            ...replacementSearch,
            searchedThrough: result.search.searchedThrough,
          };

          pending = {
            kind: 'search-progress',
            exhausted: result.search.remainingBlocks === 0n,
          };
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
        ...current.snapshot,
        lastObservation,
        durableNextNonce,
        attempts,
      }, this.identity);

      this.pendingWrite = pending;

      await this.persistence.save(next);

      this.recoveryComplete = true;
      this.finishWrite(cycle);

      const inspectedAttempt = current.snapshot.attempts[0];

      if (
        result.status === 'unresolved' &&
        inspectedAttempt !== undefined &&
        inspectedAttempt.phase !== 'included' &&
        result.observation.nonce === inspectedAttempt.nonce &&
        result.search === null &&
        this.blockers.size === 0 &&
        (
          result.receipt.status === 'receipt-not-found' ||
          result.receipt.status === 'fork-served-receipt'
        )
      ) {
        this.broadcastPermit = inspectedAttempt.attemptId;
      }

      return result;
    } catch (error) {
      this.recoveryComplete = false;

      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle);
    }
  }

  completeRecovery(cycle?: number): void {
    this.assertAvailable();

    if (this.persistence.current.kind === 'missing') {
      throw new Error(
        'Cannot complete recovery without an initialized journal'
      );
    }

    this.recoveryComplete = true;
    this.refresh(cycle);
  }

  /**
   * Records a decision made by reconciliation.
   */
  block(reason: CoordinatorBlocker, cycle?: number): void {
    this.assertAvailable();

    if (
      reason !== 'unattributed-signer-activity' &&
      reason !== 'conflict-search-exhausted'
    ) {
      throw new TypeError('Invalid coordinator blocker.');
    }

    this.blockers.add(reason);
    this.refresh(cycle);
  }

  /**
   * Durably accounts for the oldest retained attempt.
   */
  async resolveAttempt(
    evidence: AttemptResolutionEvidence,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error('No recorded attempt is available to resolve.');
    }

    const attempt = current.snapshot.attempts[0];
    if (attempt === undefined) {
      throw new Error('No record attempt is available to resolve.');
    }

    const resolution = snapshotResolutionEvidence(evidence);

    assertResolutionTransaction(attempt, resolution);

    let lastObservation = current.snapshot.lastObservation;

    if (
      resolution.outcome === 'replaced' &&
      resolution.nonceAtAnchor > lastObservation.nonce
    ) {
      lastObservation = Object.freeze({
        anchor: resolution.anchor,
        nonce: resolution.nonceAtAnchor,
      });
    }

    this.pendingWrite = {
      kind: 'resolution',
      event: Object.freeze({
        signer: this.identity.signer,
        attemptId: attempt.attemptId,
        transactionHash: resolution.outcome === 'replaced'
          ? attempt.signedTransactions[0].transactionHash
          : resolution.transactionHash,
        nonce: attempt.nonce,
        resolution,
      }),
    };

    this.broadcastPermit = undefined;
    this.inclusionChecksComplete = false;
    this.busy = true;

    try {
      await this.persistence.save({
        ...current.snapshot,
        durableNextNonce: attempt.nonce + 1n,
        attempts: current.snapshot.attempts.slice(1),
        lastObservation,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  /** 
   * Saves a verified nonce observation without advancing either nonce
   * counter or resolving retained attempts.
   * 
   * Missing replacement-search lower bounds are established independently
   * for each attempt. Existing lower bounds are preserved.
   */
  async recordObservation(
    observation: AnchoredNonceObservation,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;
    if (current.kind !== 'present') {
      throw new Error(
        'Cannot record an observation without an initialized journal.'
      );
    }

    if (this.blockers.has('unattributed-signer-activity')) {
      throw new Error(
        'Cannot overwrite the observation of unattributed signer activity.'
      );
    }

    const next = validateJournalSnapshotStructure({
      ...current.snapshot,
      lastObservation: observation,
    }, this.identity);

    // A nonce observation alone cannot authorize preparation using
    // previously recorded inclusion observations.
    this.inclusionChecksComplete = false;

    if (next.lastObservation.nonce < next.durableNextNonce) {
      this.recoveryComplete = false;
      this.refresh(cycle);

      throw new Error(
        'Observed nonce is behind the journal. Recovery is required.'
      );
    }
    
    const attempts = next.attempts.map((attempt): JournalAttempt => {
      if (attempt.replacementSearch !== null) {
        return attempt;
      }

      let lowerBound: AnchoredNonceObservation | undefined;

      if (next.lastObservation.nonce <= attempt.nonce) {
        lowerBound = next.lastObservation;
      } else if (
        current.snapshot.lastObservation.nonce <= attempt.nonce
      ) {
        lowerBound = current.snapshot.lastObservation;
      }

      if (lowerBound === undefined) {
        return attempt;
      }

      return Object.freeze({
        ...attempt,
        replacementSearch: Object.freeze({
          lowerBound,
          searchedThrough: null,
        }),
      });
    });

    this.pendingWrite = {
      kind: 'observation',
    };

    this.busy = true;

    try {
      await this.persistence.save({
        ...next,
        attempts,
      });
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  /**
   * Persists a complete inclusion inspection without advancing either nonce
   * counter or removing retained attempts.
   * 
   * Inclusion authorization becomes available only after persistence
   * succeeds. Retrying a failed write requires another inspetion before
   * preparation can resume.
   */
  async checkInclusions(
    options: CheckSignerInclusionOptions,
    cycle?: number,
  ): Promise<SignerInclusionInspection> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error(
        'Cannot check inclusions without an initialized journal.'
      )
    }

    this.broadcastPermit = undefined;
    this.inclusionChecksComplete = false;
    this.busy = true;

    try {
      const result = await inspectSignerInclusions({
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        head: options.head,
      });

      if (result.status !== 'inspected') {
        if (
          result.status === 'nonce-behind-journal' ||
          result.status === 'inconsistent-observations'
        ) {
          this.recoveryComplete = false;
        }

        return result;
      }

      // Preserve previously recorded evidence of unattributed activity.
      // A lower observation cannot clear that condition.
      const lastObservation =
        this.blockers.has('unattributed-signer-activity') &&
        current.snapshot.lastObservation.nonce > result.observation.nonce
          ? current.snapshot.lastObservation
          : result.observation;

      const next = validateJournalSnapshotStructure({
        ...current.snapshot,
        lastObservation,
        attempts: result.attempts,
      }, this.identity);

      this.pendingWrite = {
        kind: 'observation',
      };

      await this.persistence.save(next);

      this.inclusionChecksComplete = result.inclusionChecksComplete;
      this.finishWrite(cycle);

      return result;
    } catch (error) {
      this.inclusionChecksComplete = false;

      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      throw error;
    } finally {
      this.busy = false;
      this.refresh(cycle);
    }
  }

  /**
   * Reads the operator-approved starting nonce for a missing journal. Latest
   * and pending counts can veto adoption, but only the anchored observation
   * becomes the persisted baseline.
   */
  private async readBootstrapObservation(
    options: RecoverSignerOptions,
  ): Promise<AnchoredNonceResult> {
    if (options.bootstrap === undefined) {
      throw new Error(
        'Cannot recover without an initialized journal or explicit bootstrap authorization'
      );
    }

    if (this.blockers.size !== 0) {
      throw new Error('Cannot bootstrap while coordinator blockers remain.');
    }

    const {
      publicClient,
      maxBlockRange,
    } = options;

    const {
      expectedNonce,
      confirmNoUntrackedTransactions,
    } = options.bootstrap;

    if (
      confirmNoUntrackedTransactions !== true ||
      typeof expectedNonce !== 'bigint' ||
      expectedNonce < 0n ||
      expectedNonce >= (1n << 256n)
    ) {
      throw new TypeError('Invalid signer bootstrap authorization.');
    }

    if (
      typeof maxBlockRange !== 'bigint' ||
      maxBlockRange <= 0n ||
      maxBlockRange >= (1n << 256n)
    ) {
      throw new TypeError('Invalid signer recovery input.');
    }

    const result = await readAnchoredNonce({
      publicClient,
      signer: this.identity.signer,
      anchor: options.anchor,
    });

    if (result.status === 'anchor-changed') {
      return result;
    }

    const { observation } = result;

    if (observation.nonce !== expectedNonce) {
      throw new Error(
        'The anchored nonce does not match the authorized baseline.'
      );
    }

    for (const blockTag of ['latest', 'pending'] as const) {
      const nonce = await publicClient.getTransactionCount({
        address: this.identity.signer,
        blockTag,
      });

      if (
        typeof nonce !== 'number' ||
        !Number.isSafeInteger(nonce) ||
        nonce < 0
      ) {
        throw new TypeError('Invalid bootstrap nonce response.');
      }

      if (BigInt(nonce) !== observation.nonce) {
        throw new Error('Signer nonce counts do not match the bootstrap baselines.');
      }
    }

    const closingAnchor = await getBlockAnchor(
      publicClient,
      observation.anchor.blockNumber,
    );

    if (!blockAnchorsMatch(observation.anchor, closingAnchor)) {
      return {
        status: 'anchor-changed',
        observedAnchor: Object.freeze(closingAnchor),
      };
    }

    return result;
  }

  /**
   * Saves the boundary reached by a checked replacement search so a later
   * cycle or restart can continue without rescanning completed blocks.
   * A fully searched range without a match remains an unresolved conflict.
   */
  async recordSearchProgress(
    options: RecordSearchProgressOptions,
    cycle?: number,
  ): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite !== undefined ||
      this.persistence.state !== 'idle'
    ) {
      throw new Error('A pending journal write must be retried first.');
    }

    const current = this.persistence.current;

    if (current.kind !== 'present') {
      throw new Error('No record attempt is available for search progress.');
    }

    const attemptIndex = current.snapshot.attempts.findIndex(
      (attempt) => attempt.phase !== 'included'
    );

    if (attemptIndex === -1) {
      throw new Error('No unresolved attempt is available for search progress.');
    }

    const attempt = current.snapshot.attempts[attemptIndex]!;
    const search = attempt.replacementSearch;

    if (
      options.attemptId !== attempt.attemptId ||
      search === null
    ) {
      throw new TypeError('Search progress does not match the recorded attempt.');
    }

    const {
      result,
      observation,
    } = options;

    if (result.status !== 'not-found') {
      throw new TypeError('Invalid replacement search progress.');
    }

    const next = validateJournalSnapshotStructure({
      ...current.snapshot,
      lastObservation: observation,
      attempts: current.snapshot.attempts.map((candidate, index) =>
        index === attemptIndex
          ? {
              ...candidate,
              replacementSearch: {
                lowerBound: search.lowerBound,
                searchedThrough: result.searchedThrough,
              },
            }
          : candidate,
      ),
    }, this.identity);

    const savedObservation = current.snapshot.lastObservation;
    const through =
      next.attempts[attemptIndex]!.replacementSearch!.searchedThrough!;
    const previous = search.searchedThrough ?? search.lowerBound.anchor;

    const scanned = through.blockNumber - previous.blockNumber;
    const remaining =
      next.lastObservation.anchor.blockNumber - through.blockNumber;

    if (
      !blockAnchorsMatch(
        next.lastObservation.anchor,
        savedObservation.anchor,
      ) ||
      next.lastObservation.nonce !== savedObservation.nonce ||
      next.lastObservation.nonce <= attempt.nonce ||
      scanned < 0n ||
      remaining < 0n ||
      result.scannedBlocks !== scanned ||
      result.remainingBlocks !== remaining
    ) {
      throw new TypeError('Invalid replacement search progress.');
    }

    if (
      remaining === 0n &&
      !blockAnchorsMatch(through, next.lastObservation.anchor)
    ) {
      throw new TypeError('Invalid replacement search progress.');
    }

    if (scanned === 0n) {
      if (!blockAnchorsMatch(previous, through)) {
        throw new TypeError('Invalid replacement search progress.');
      }

      return;
    }

    this.pendingWrite = {
      kind: 'search-progress',
      exhausted: remaining === 0n,
    };

    this.busy = true;

    try {
      await this.persistence.save(next);
    } catch (error) {
      if (this.persistence.state === 'idle') {
        this.pendingWrite = undefined;
      }

      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  private finishWrite(cycle?: number): void {
    const pending = this.pendingWrite!;

    if (pending.kind === 'resolution') {
      this.blockers.delete('conflict-search-exhausted');

      // Keep the gate closed and the attempt policy alive through
      // this emission.
      this.emit(
        (log) => log.attemptResolved(pending.event),
        cycle,
      );
    } else if (pending.kind === 'search-progress') {
      if (pending.exhausted) {
        this.blockers.add('conflict-search-exhausted');
      } else {
        this.blockers.delete('conflict-search-exhausted');
      }
    }

    this.pendingWrite = undefined;
    this.busy = false;

    this.latchUnattributedActivity();
    this.latchExhaustedSearch();

    let operation: SignerEventOperation = 'reconcile-attempt';

    if (pending.kind === 'prepared') {
      operation = 'prepare-attempt';
    } else if (pending.kind === 'broadcast') {
      operation = 'broadcast-attempt';
    }

    this.refresh(cycle, operation);
  }

  private latchUnattributedActivity(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    if (
      current.snapshot.lastObservation.nonce >
      current.snapshot.nextNonce
    ) {
      this.blockers.add('unattributed-signer-activity');
    }
  }

  private latchExhaustedSearch(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    const attempt = current.snapshot.attempts.find(
      (candidate) => candidate.phase !== 'included',
    );

    if (attempt === undefined) {
      return;
    }

    const through = attempt.replacementSearch?.searchedThrough;

    if (
      through !== null &&
      through !== undefined &&
      current.snapshot.lastObservation.nonce > attempt.nonce &&
      blockAnchorsMatch(
        through,
        current.snapshot.lastObservation.anchor,
      )
    ) {
      this.blockers.add('conflict-search-exhausted');
    }
  }

  /**
   * Retries the retained journal snapshot after a persistence failure,
   * then applies the corresponding observation or resolution transition.
   */
  async retryPersistence(cycle?: number): Promise<void> {
    this.assertAvailable();

    if (
      this.pendingWrite === undefined ||
      this.persistence.state !== 'failed'
    ) {
      throw new Error('No failed journal write is available to retry.');
    }

    this.busy = true;

    try {
      await this.persistence.retry();
    } catch (error) {
      this.busy = false;
      this.refresh(cycle);

      throw error;
    }

    this.finishWrite(cycle);
  }

  private refresh(
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    const status = this.status;

    if (status.blockers.length > 0) {
      if (this.blockedSince === null) {
        this.blockedSince = this.timestamp();
      }

      for (const reason of status.blockers) {
        this.episodeReasons.add(reason);
      }

      if (status.primaryReason !== this.previousPrimary) {
        this.emit((log) => log.signerBlocked({
          signer: this.identity.signer,
          reason: status.primaryReason!,
          blockers: status.blockers,
          blockedSince: this.blockedSince!,
        }), cycle, operation);
      }
    }

    this.previousPrimary = status.primaryReason;

    if (status.open && this.blockedSince !== null) {
      const blockedSince = this.blockedSince;

      const cleared = BLOCKER_PRECEDENCE.filter(
        (reason) => this.episodeReasons.has(reason)
      );

      this.emit((log) => log.signerGateReleased({
        signer: this.identity.signer,
        cleared,
        blockedSince,
      }), cycle, operation);

      this.blockedSince = null;
      this.episodeReasons.clear();
    }

    const current = this.persistence.current;

    if (
      status.open &&
      this.pendingWrite === undefined &&
      current.kind === 'present' &&
      current.snapshot.attempts.length === 0
    ) {
      this.attemptLog = undefined;
    }
  }

  private assertAvailable(): void {
    if (this.busy || this.emitting) {
      throw new Error('Signer coordinator operation is already in progress.');
    }
  }

  private emit(
    action: (log: ScopedRelayerLog) => void,
    cycle?: number,
    operation: SignerEventOperation = 'reconcile-attempt',
  ): void {
    const log = this.attemptLog ?? this.log;
    this.emitting = true;

    let failureLog = log;

    try {
      let scoped = log.withContext({
        operation: { name: operation },
      });

      if (cycle !== undefined) {
        scoped = scoped.withContext({ cycle });
      }

      failureLog = scoped;
      action(scoped);
    } catch (error) {
      try {
        failureLog.loggingFailed({ error });
      } catch {
        // Diagnostics must not interrupt recovery.
      }
    } finally {
      this.emitting = false;
    }
  }

  private timestamp(): string {
    try {
      const value = this.now();

      if (
        Number.isFinite(value) &&
        value >= 0 &&
        value < 253402300800000
      ) {
        return new Date(value).toISOString();
      } 
    } catch {
        // A diagnostic clock must not interrupt recovery.
    }

    return new Date().toISOString();
  }
}