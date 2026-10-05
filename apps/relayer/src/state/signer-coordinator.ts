import type {
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  inspectSignerRecovery,
  type SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import type {
  ReplacementSearchResult,
} from '../chain/search-attempt-replacement.js';

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
  JournalIdentity,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface SignerCoordinatorOptions {
  readonly identity: JournalIdentity;
  readonly store: TransactionJournalStore;
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

export interface RecoverSignerOptions {
  readonly publicClient: PublicClient;
  readonly anchor: Readonly<BlockAnchor>;
  readonly maxBlockRange: bigint;
}

type ResolutionEvent =
  Parameters<ScopedRelayerLog['attemptResolved']>[0];

type PendingWrite =
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
    };

/**
 * Coordinates durable nonce observations and attempt resolution so restart
 * recovery and signer availability follow the same journal state.
 */
export class SignerCoordinator {
  private recoveryComplete = false;
  private busy = false;
  private emitting = false;

  private readonly blockers = new Set<CoordinatorBlocker>();
  private readonly episodeReasons = new Set<SignerBlocker>();

  private blockedSince: string | null = null;
  private previousPrimary: SignerBlocker | null = null;
  private pendingWrite: PendingWrite | undefined;
  private attemptLog: ScopedRelayerLog | undefined;

  private constructor(
    private readonly persistence: JournalPersistence,
    private readonly identity: JournalIdentity,
    private readonly log: ScopedRelayerLog,
    private readonly now: () => number,
  ) {}

  static async create(
    options: SignerCoordinatorOptions,
  ): Promise<SignerCoordinator> {
    const identity = Object.freeze({ ...options.identity });

    const persistence = await JournalPersistence.create({
      identity,
      store: options.store,
      initial: await options.store.load(),
    });

    const coordinator = new SignerCoordinator(
      persistence,
      identity,
      options.log.withContext({ signer: identity.signer }),
      options.now ?? Date.now,
    );

    const current = persistence.current;
    if (
      current.kind === 'present' &&
      current.snapshot.attempt !== null
    ) {
      const attempt = current.snapshot.attempt;

      coordinator.attemptLog = coordinator.log
        .withErrorSummary(
          options.createErrorSummary([attempt.signedTransaction]),
        )
        .withContext({ attemptId: attempt.attemptId });

      coordinator.blockedSince = attempt.createdAt;
    }
    
    coordinator.latchUnattributedActivity();
    coordinator.latchExhaustedSearch();
    coordinator.refresh();

    return coordinator;
  }

  get status() {
    const gate = evaluateSignerGate({
      persistence: this.persistence,
      recoveryComplete: this.recoveryComplete,
      blockers: this.blockers,
    });

    return Object.freeze({
      ...gate,
      open: gate.open && !this.busy,
      recoveryComplete: this.recoveryComplete,
      persistenceState: this.persistence.state,
      blockedSince: this.blockedSince,
    });
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
    if (current.kind !== 'present') {
      throw new Error('Cannot recover without an initialized journal.');
    }

    this.busy = true;
    this.recoveryComplete = false;

    try {
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

      let attempt = current.snapshot.attempt;
      let nextNonce = current.snapshot.nextNonce;

      let pending: PendingWrite = {
        kind: 'observation',
      };

      if (result.status === 'resolution-available') {
        if (attempt === null) {
          throw new Error('No recorded attempt is available to resolve.');
        }

        const resolution = snapshotResolutionEvidence(result.evidence);

        assertResolutionTransaction(attempt, resolution);

        pending = {
          kind: 'resolution',
          event: Object.freeze({
            signer: this.identity.signer,
            attemptId: attempt.attemptId,
            transactionHash: attempt.transactionHash,
            nonce: attempt.nonce,
            resolution,
          }),
        };

        nextNonce = attempt.nonce + 1n;
        attempt = null;
      } else if (attempt !== null) {
        let replacementSearch = attempt.replacementSearch;
        if (replacementSearch === null) {
          let lowerBound: AnchoredNonceObservation | undefined;

          if (lastObservation.nonce <= attempt.nonce) {
            lowerBound = lastObservation;
          } else if (
            current.snapshot.lastObservation.nonce <= attempt.nonce
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

        attempt = {
          ...attempt,
          replacementSearch,
        };
      }

      const next = validateJournalSnapshotStructure({
        ...current.snapshot,
        lastObservation,
        nextNonce,
        attempt,
      }, this.identity);

      this.pendingWrite = pending;

      await this.persistence.save(next);

      this.recoveryComplete = true;
      this.finishWrite(cycle);

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

    if (
      current.kind !== 'present' ||
      current.snapshot.attempt === null
    ) {
      throw new Error('No recorded attempt is available to resolve.');
    }

    const attempt = current.snapshot.attempt;
    const resolution = snapshotResolutionEvidence(evidence);

    assertResolutionTransaction(attempt, resolution);

    if (
      resolution.outcome === 'replaced' &&
      resolution.nonceAtAnchor > attempt.nonce + 1n
    ) {
      this.blockers.add('unattributed-signer-activity');
    }

    this.pendingWrite = {
      kind: 'resolution',
      event: Object.freeze({
        signer: this.identity.signer,
        attemptId: attempt.attemptId,
        transactionHash: attempt.transactionHash,
        nonce: attempt.nonce,
        resolution,
      }),
    };

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

    this.busy = true;

    try {
      await this.persistence.save({
        ...current.snapshot,
        nextNonce: attempt.nonce + 1n,
        attempt: null,
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
   * Saves a verified nonce observation for restart recovery and preserves a
   * starting point for replacement search before the nonce is consumed.
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

    if (next.lastObservation.nonce < next.nextNonce) {
      this.recoveryComplete = false;
      this.refresh(cycle);

      throw new Error(
        'Observed nonce is behind the journal. Recovery is required.'
      );
    }

    let attempt = next.attempt;

    if (
      attempt !== null &&
      attempt.replacementSearch === null
    ) {
      let lowerBound: AnchoredNonceObservation | undefined;

      if (next.lastObservation.nonce <= attempt.nonce) {
        lowerBound = next.lastObservation;
      } else if (
        current.snapshot.lastObservation.nonce <= attempt.nonce
      ) {
        lowerBound = current.snapshot.lastObservation;
      }

      if (lowerBound !== undefined) {
        attempt = Object.freeze({
          ...attempt,
          replacementSearch: Object.freeze({
            lowerBound,
            searchedThrough: null,
          }),
        });
      }
    }

    this.pendingWrite = {
      kind: 'observation',
    };

    this.busy = true;

    try {
      await this.persistence.save({
        ...next,
        attempt,
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

    if (
      current.kind !== 'present' ||
      current.snapshot.attempt === null
    ) {
      throw new Error('No record attempt is available for search progress.');
    }

    const attempt = current.snapshot.attempt;
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
      attempt: {
        ...attempt,
        replacementSearch: {
          lowerBound: search.lowerBound,
          searchedThrough: result.searchedThrough,
        },
      },
    }, this.identity);

    const savedObservation = current.snapshot.lastObservation;
    const through = next.attempt!.replacementSearch!.searchedThrough!;
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
    this.refresh(cycle);
  }

  private latchUnattributedActivity(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    let accountedNonce = current.snapshot.nextNonce;

    if (current.snapshot.attempt !== null) {
      accountedNonce += 1n;
    }

    if (current.snapshot.lastObservation.nonce > accountedNonce) {
      this.blockers.add('unattributed-signer-activity');
    }
  }

  private latchExhaustedSearch(): void {
    const current = this.persistence.current;

    if (current.kind !== 'present') {
      return;
    }

    const attempt = current.snapshot.attempt;
    const through = attempt?.replacementSearch?.searchedThrough;

    if (
      attempt !== null &&
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

  private refresh(cycle?: number): void {
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
        }), cycle);
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
      }), cycle);

      this.blockedSince = null;
      this.episodeReasons.clear();
    }

    if (status.open && this.pendingWrite === undefined) {
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
  ): void {
    const log = this.attemptLog ?? this.log;
    this.emitting = true;

    let failureLog = log;

    try {
      let scoped = log.withContext({
        operation: { name: 'reconcile-attempt' },
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