import {
  checkBlockAnchor,
  type BlockAnchor,
} from '../../chain/block-anchor.js';

import type {
  SignerInclusionInspection,
} from '../../chain/inspect-signer-inclusions.js';

import {
  assertInspectionCompleted,
  createInspectionBracket,
  inspectionNeedsOpening,
  mergeBlockObservations,
  observeDurableNonce,
} from '../inspection-bracket.js';

import type {
  AnchoredNonceObservation,
} from '../transaction-journal.js';

import type {
  CoordinatorDiagnostics,
} from './coordinator-diagnostics.js';

import type {
  CoordinatorStateStore,
} from './coordinator-state.js';

import type {
  CheckSignerInclusionsOptions,
  InspectionOwner,
  OpenSignerInspectionOptions,
  RecoverSignerOptions,
  SignerInspection,
  SignerRecoveryResult,
} from './coordinator-types.js';

export interface InspectionOperationHandlers {
  readonly recoverOwned: (
    options: RecoverSignerOptions,
    owner: InspectionOwner,
    cycle?: number,
  ) => Promise<SignerRecoveryResult>;
  readonly checkInclusionsOwned: (
    options: CheckSignerInclusionsOptions,
    owner: InspectionOwner,
    cycle?: number,
  ) => Promise<SignerInclusionInspection>;
}

/**
 * Owns inspection handle creation, operation serialization, bracket opening,
 * durable observation admission, abandonment settlement, and completion checks.
 */
export class InspectionController {
  constructor(
    private readonly state: CoordinatorStateStore,
    private readonly diagnostics: CoordinatorDiagnostics,
  ) {}

  /**
   * Acquires ownership synchronously. The first owned operation performs
   * the selected opening read before its body. Once a bracket is opened,
   * finish requires a successful latest commit.
   * An unsuccessful bracket must be abandoned, preserving durable commits.
   */
  beginInspection(
    handlers: InspectionOperationHandlers,
    options?: OpenSignerInspectionOptions,
  ): SignerInspection {
    this.state.assertAvailable();
    this.state.assertPersistenceIdle();

    const owner: InspectionOwner = {
      bracket: options === undefined
        ? null
        : createInspectionBracket(options),
      activeOperation: null,
      abandonment: null,
      abandoning: false,
      cycle: undefined,
    };

    this.state.acquireInspectionOwner(owner);

    return Object.freeze({
      recover: (
        recoverOptions: RecoverSignerOptions,
        cycle?: number,
      ) => {
        const captured: RecoverSignerOptions = {
          publicClient: recoverOptions.publicClient,
          anchor: Object.freeze({
            blockNumber: recoverOptions.anchor.blockNumber,
            blockHash: recoverOptions.anchor.blockHash,
          }),
          maxBlockRange: recoverOptions.maxBlockRange,
          ...(recoverOptions.acceptance === undefined ? {} : {
            acceptance: structuredClone(recoverOptions.acceptance),
          }),
          ...(recoverOptions.attribution === undefined ? {} : {
            attribution: structuredClone(recoverOptions.attribution),
          }),
          ...(recoverOptions.acceptanceCommitment === undefined ? {} : {
            acceptanceCommitment: structuredClone(
              recoverOptions.acceptanceCommitment,
            ),
          }),
          ...(recoverOptions.attributionCommitment === undefined ? {} : {
            attributionCommitment: structuredClone(
              recoverOptions.attributionCommitment,
            ),
          }),
        };

        return this.runInspectionOperation(
          owner,
          () => handlers.recoverOwned(captured, owner, cycle),
          cycle,
        );
      },

      checkInclusions: (
        inclusionOptions: CheckSignerInclusionsOptions,
        cycle?: number,
      ) => {
        const maxReplacementBlockRange =
          inclusionOptions.maxReplacementBlockRange;

        const captured: CheckSignerInclusionsOptions = {
          publicClient: inclusionOptions.publicClient,
          head: Object.freeze({
            blockNumber: inclusionOptions.head.blockNumber,
            blockHash: inclusionOptions.head.blockHash,
          }),
          ...(maxReplacementBlockRange === undefined
            ? {}
            : { maxReplacementBlockRange }),
        };

        return this.runInspectionOperation(
          owner,
          () => handlers.checkInclusionsOwned(captured, owner, cycle),
          cycle,
        );
      },

      finish: () => this.finishInspection(owner),

      abandon: () => this.abandonInspection(owner),
    });
  }

  /**
   * Runs one operation in a dedicated inspection.
   */
  async runStandaloneInspection<T>(
    handlers: InspectionOperationHandlers,
    action: (inspection: SignerInspection) => Promise<T>,
  ): Promise<T> {
    const inspection = this.beginInspection(handlers);

    try {
      const result = await action(inspection);
      inspection.finish();
      return result;
    } catch (error) {
      await inspection.abandon();
      throw error;
    }
  }

  async openInspectionBracket(
    owner: InspectionOwner,
  ): Promise<Readonly<BlockAnchor> | null> {
    const bracket = owner.bracket!;

    if (!inspectionNeedsOpening(bracket)) {
      return null;
    }

    const changed = await checkBlockAnchor(
      bracket.publicClient,
      bracket.head,
      { operation: 'signer-inclusions' },
    );

    this.state.assertInspectionContinuing(owner);

    if (changed !== null) {
      this.failInspectionBracket(owner);
      return changed.observedAnchor;
    }

    bracket.advancePhase('durable');
    return null;
  }

  /**
   * Compare signer nonces observed at the same durable recovery anchor before
   * planning a journal change, including observations the planner would skip.
   */
  observeInspectionDurableNonce(
    owner: InspectionOwner,
    observation: AnchoredNonceObservation,
  ): boolean {
    const bracket = owner.bracket;

    if (bracket === null) {
      return true;
    }

    const nonce = observeDurableNonce(bracket, observation);

    if (nonce === null) {
      this.state.authorization.evidenceContradicted();
      this.failInspectionBracket(owner);
      return false;
    }

    if (bracket.durableNonce === undefined) {
      bracket.durableNonce = nonce;
    }

    return true;
  }

  admitDurableBlockObservations(
    owner: InspectionOwner,
    observations: readonly Readonly<BlockAnchor>[],
  ): boolean {
    const bracket = owner.bracket;

    // Standalone durable recovery has no enclosing latest-block interval.
    // Its observations must not seed a bracket opened later on this handle.
    if (bracket === null) {
      return true;
    }

    const merged = mergeBlockObservations(
      bracket.durableObservations,
      observations,
    );

    if (merged === null) {
      return false;
    }

    // No rollback is needed if persistence fails: the failed bracket cannot
    // continue, and abandonment discards this inspection's evidence entirely.
    bracket.durableObservations = merged;
    return true;
  }

  failInspectionBracket(owner: InspectionOwner): void {
    if (owner.bracket !== null) {
      owner.bracket.advancePhase('failed');
      this.state.authorization.bracketFailed();
    }
  }

  private async runInspectionOperation<T>(
    owner: InspectionOwner,
    operation: () => Promise<T>,
    cycle?: number,
  ): Promise<T> {
    this.state.assertAvailable(owner);

    if (owner.activeOperation !== null) {
      throw new Error('Signer inspection operation is already in progress.');
    }

    owner.cycle = cycle;

    // Register before execution so abandonment also covers queued work.
    const pending = Promise.resolve().then(() => {
      this.state.assertAvailable(owner);
      return operation();
    });

    owner.activeOperation = pending;

    try {
      return await pending;
    } finally {
      owner.activeOperation = null;
    }
  }

  private finishInspection(
    owner: InspectionOwner,
  ): void {
    this.state.assertInspectionOwner(owner);

    if (owner.abandoning) {
      throw new Error('Signer inspection is being abandoned.');
    }

    if (owner.activeOperation !== null) {
      throw new Error('Signer inspection operation is still running.');
    }

    this.state.assertNotOperating();
    this.state.assertInspectionPersistenceIdle();

    if (owner.bracket !== null) {
      assertInspectionCompleted(owner.bracket);
    }

    // Diagnostic only; preparation disputes require a later successful
    // preparation.
    if (
      owner.bracket !== null &&
      this.state.authorization.recoveryComplete &&
      this.state.authorization.inclusionChecksComplete
    ) {
      this.state.clearStoredFactDispute('recovery');
    }

    if (owner.bracket !== null) {
      owner.bracket.discardEvidence();
    }

    this.state.releaseInspectionOwner(owner);
    this.diagnostics.refresh(owner.cycle);
  }

  private async abandonInspection(
    owner: InspectionOwner,
  ): Promise<void> {
    this.state.assertInspectionOwner(owner);

    if (owner.abandonment !== null) {
      return owner.abandonment;
    }

    owner.abandoning = true;
    this.state.authorization.abandonmentRequested();

    const pending = owner.activeOperation;

    owner.abandonment = this.completeAbandonment(owner, pending);
    return owner.abandonment;
  }

  private async completeAbandonment(
    owner: InspectionOwner,
    pending: Promise<unknown> | null,
  ): Promise<void> {
    if (pending !== null) {
      try {
        await pending;
      } catch {
        // The operation's caller receives its failure. Abandonment must
        // release ownership after either settlement outcome.
      }
    }

    // Ownership cannot be replaced while abandonment awaits settlement.
    // Failure here is an internal lifecycle invariant violation.
    this.state.assertInspectionOwner(owner);

    this.state.authorization.abandonmentCompleted();

    if (owner.bracket !== null) {
      owner.bracket.discardEvidence();
    }

    this.state.releaseInspectionOwner(owner);
    this.diagnostics.refresh(owner.cycle);
  }
}
