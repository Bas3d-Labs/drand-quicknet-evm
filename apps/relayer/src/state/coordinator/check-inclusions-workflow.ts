import {
  blockAnchorsMatch,
  checkBlockAnchor,
} from '../../chain/block-anchor.js';

import {
  inspectSignerInclusions,
  type SignerInclusionInspection,
} from '../../chain/inspect-signer-inclusions.js';

import {
  createInspectionBracket,
  latestNonceIsConsistent,
  mergeBlockObservations,
  type InspectionBracket,
} from '../inspection-bracket.js';

import {
  planSignerInclusions,
} from '../plan-signer-inclusions.js';

import type {
  TransactionJournalSnapshot,
} from '../transaction-journal.js';

import type {
  WriteOutcome,
} from '../write-outcome.js';

import type {
  CoordinatorDiagnostics,
} from './coordinator-diagnostics.js';

import type {
  CoordinatorStateStore,
} from './coordinator-state.js';

import type {
  CheckSignerInclusionsOptions,
  InspectionOwner,
} from './coordinator-types.js';

import type {
  InspectionController,
} from './inspection-controller.js';

import type {
  JournalCommitEngine,
} from './journal-commit-engine.js';

export interface CheckInclusionsWorkflowDeps {
  readonly state: CoordinatorStateStore;
  readonly diagnostics: CoordinatorDiagnostics;
  readonly commit: JournalCommitEngine;
  readonly inspections: InspectionController;
}

/**
 * Persists a complete inclusion inspection without advancing either nonce
 * counter or removing retained attempts.
 */
export async function checkInclusionsWorkflow(
  deps: CheckInclusionsWorkflowDeps,
  options: CheckSignerInclusionsOptions,
  owner: InspectionOwner,
  cycle?: number,
): Promise<SignerInclusionInspection> {
  const { state, diagnostics, commit, inspections } = deps;

  state.assertAvailable(owner);
  state.assertPersistenceIdle();

  const current = state.persistence.current;

  if (current.kind !== 'present') {
    throw new Error(
      'Cannot check inclusions without an initialized journal.',
    );
  }

  state.authorization.inclusionCheckEntered();
  state.busy = true;

  try {
    let bracket: InspectionBracket;

    let result: SignerInclusionInspection;

    let next: TransactionJournalSnapshot;

    let outcome: WriteOutcome;

    try {
      if (owner.bracket === null) {
        owner.bracket = createInspectionBracket(options);
      }

      bracket = owner.bracket;

      if (
        bracket.publicClient !== options.publicClient ||
        !blockAnchorsMatch(bracket.head, options.head)
      ) {
        throw new Error(
          'Inclusion inspection does not match the selected head.',
        );
      }

      const changed = await inspections.openInspectionBracket(owner);

      if (changed !== null) {
        return {
          status: 'anchor-changed',
          observedAnchor: changed,
        };
      }

      if (
        bracket.durableAnchor !== undefined &&
        !state.authorization.recoveryComplete
      ) {
        throw new Error(
          'Fresh durable recovery must complete before latest inspection.',
        );
      }

      bracket.advancePhase('latest');

      const maxReplacementBlockRange = options.maxReplacementBlockRange;

      const inspectionOptions = {
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        head: options.head,
        ...(maxReplacementBlockRange === undefined
          ? {}
          : { maxReplacementBlockRange }),
      };

      result = await inspectSignerInclusions(inspectionOptions);

      if (result.status !== 'inspected') {
        inspections.failInspectionBracket(owner);

        if (
          result.status === 'nonce-behind-journal' ||
          result.status === 'inconsistent-observations'
        ) {
          state.authorization.evidenceContradicted();
        }

        return result;
      }

      // Keep the result uncommitted until the owner confirms that the selected
      // latest block still matches the hash checked before the inspection.
      bracket.advancePhase('closing');

      const closing = await checkBlockAnchor(
        options.publicClient,
        bracket.head,
        { operation: 'signer-inclusions' },
      );

      state.assertInspectionContinuing(owner);

      if (closing !== null) {
        inspections.failInspectionBracket(owner);
        return closing;
      }

      if (!latestNonceIsConsistent(bracket, result.observation.nonce)) {
        state.authorization.evidenceContradicted();
        inspections.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      // Check repeated heights within the latest pass as well as overlaps with
      // durable evidence. This runs after the closing check, before planning.
      const latestEvidence = mergeBlockObservations(
        bracket.durableObservations,
        result.observations,
      );

      if (latestEvidence === null) {
        state.authorization.evidenceContradicted();
        inspections.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      bracket.advancePhase('persisting');

      next = planSignerInclusions({
        identity: state.identity,
        snapshot: current.snapshot,
        inspection: result,
        unattributedActivity:
          state.blockers.has('unattributed-signer-activity'),
      });

      outcome = await commit.saveWrite(next, { kind: 'observation' });
    } catch (error) {
      state.authorization.inclusionCheckFailed();
      inspections.failInspectionBracket(owner);
      throw error;
    }

    if (outcome.status !== 'acknowledged') {
      state.authorization.inclusionCheckFailed();
      inspections.failInspectionBracket(owner);
      return commit.throwWriteFailure(outcome);
    }

    try {
      state.authorization.inclusionCheckCommitted(
        result.inclusionChecksComplete,
      );
      commit.applyCommittedWrite(cycle);

      const attempt = next.attempts.find(
        (candidate) => candidate.phase !== 'included',
      );

      if (
        state.authorization.recoveryComplete &&
        state.blockers.size === 0 &&
        attempt !== undefined &&
        result.broadcastAttemptId === attempt.attemptId &&
        next.lastObservation.nonce === attempt.nonce
      ) {
        state.authorization.grantInclusionPermit(attempt.attemptId);
      }

      // The durable permit was revoked on entry. Only the acknowledged latest
      // result above may grant a replacement permit before successful finish.
      bracket.advancePhase('completed');

      return result;
    } catch (error) {
      state.authorization.inclusionCheckFailed();
      inspections.failInspectionBracket(owner);
      return commit.throwCompletionFailure(error);
    }
  } finally {
    state.busy = false;
    diagnostics.refresh(cycle);
  }
}
