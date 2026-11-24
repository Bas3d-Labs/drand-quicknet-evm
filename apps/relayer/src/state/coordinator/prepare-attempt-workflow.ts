import {
  randomUUID,
} from 'node:crypto';

import {
  signPreparedTransaction,
  type SignedRelayerTransaction,
} from '../../chain/sign-prepared-transaction.js';

import {
  isWorkId,
} from '../../execution/work-identity.js';

import {
  planAttemptPreparation,
} from '../plan-attempt-preparation.js';

import {
  findStoredFactNonceConflict,
  StoredFactNonceConflictError,
} from '../stored-fact-nonce-conflict.js';

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
  PrepareAttemptOptions,
  PrepareAttemptResult,
} from './coordinator-types.js';

import type {
  JournalCommitEngine,
} from './journal-commit-engine.js';

export interface PrepareAttemptWorkflowDeps {
  readonly state: CoordinatorStateStore;
  readonly diagnostics: CoordinatorDiagnostics;
  readonly commit: JournalCommitEngine;
}

/**
 * Signs and durably appends the next allocated transaction. Retained
 * attempts remain available for recovery and diagnostics.
 */
export async function prepareAttemptWorkflow(
  deps: PrepareAttemptWorkflowDeps,
  options: PrepareAttemptOptions,
  cycle?: number,
): Promise<PrepareAttemptResult> {
  const { state, diagnostics, commit } = deps;

  state.assertAvailable();
  state.assertPersistenceIdle();

  const current = state.persistence.current;

  if (
    !state.selectStatus(diagnostics.blockedSince).open ||
    current.kind !== 'present'
  ) {
    throw new Error(
      'The signer gate must be open before preparing an attempt.',
    );
  }

  const workId = options.workId;
  if (!isWorkId(workId)) {
    throw new TypeError('Invalid work identity.');
  }

  const retained = current.snapshot.attempts.find(
    (attempt) => attempt.workId === workId,
  );

  if (retained !== undefined) {
    // No state changed. This result neither grants nor consumes
    // broadcast authorization.
    return Object.freeze({
      status: 'already-retained',
      attemptId: retained.attemptId,
      workId,
    });
  }

  const attemptId = randomUUID();

  const detail = findStoredFactNonceConflict([
    ...current.snapshot.attempts,
    {
      attemptId,
      replacementSearch: {
        lowerBound: current.snapshot.lastObservation,
        searchedThrough: null,
        exhausted: null,
      },
    },
  ], current.snapshot.attempts);

  if (detail !== null) {
    state.authorization.storedFactConflictBeforeSigning();
    diagnostics.reportStoredFactConflict(detail, 'preparation', cycle);
    diagnostics.refresh(cycle, 'prepare-attempt');
    throw new StoredFactNonceConflictError(detail);
  }

  const previousDiagnostics = diagnostics.snapshotPreparationState();

  const previousInclusionChecksComplete =
    state.authorization.inclusionChecksComplete;

  state.authorization.preparationStarted();
  state.busy = true;

  try {
    let signed: SignedRelayerTransaction;

    let outcome: WriteOutcome;

    try {
      const createdAt = diagnostics.timestamp();

      signed = await signPreparedTransaction({
        identity: state.identity,
        nonce: current.snapshot.nextNonce,
        account: options.account,
        transaction: options.transaction,
      });

      diagnostics.expandSignedAttemptLog(
        current.snapshot.attempts,
        signed.signedTransaction,
      );

      const next = planAttemptPreparation({
        identity: state.identity,
        snapshot: current.snapshot,
        attemptId,
        workId,
        createdAt,
        signed,
      });

      diagnostics.seedBlockedSince(createdAt);
      state.authorization.preparationAboutToSave();
      outcome = await commit.saveWrite(next, { kind: 'prepared' });
    } catch (error) {
      // Signing, diagnostics or planning failed before a save outcome existed.
      diagnostics.restorePreparationState(previousDiagnostics);
      state.authorization.preparationRolledBack(
        previousInclusionChecksComplete,
      );
      throw error;
    }

    switch (outcome.status) {
      case 'not-written':
        state.pendingWrite = undefined;
        diagnostics.restorePreparationState(previousDiagnostics);
        state.authorization.preparationRolledBack(
          previousInclusionChecksComplete,
        );
        throw outcome.error;

      case 'uncertain':
        state.authorization.preparationReachedStorageWithoutCompletion();
        throw outcome.error;

      case 'acknowledged':
        break;

      default:
        outcome satisfies never;
    }

    try {
      commit.applyCommittedWrite(cycle);
      state.authorization.grantPreparationPermit(attemptId);

      // Diagnostic only: a retained lookup or failed preparation does not
      // clear it.
      if (state.storedFactDispute?.origin === 'preparation') {
        state.storedFactDispute = null;
      }

      return Object.freeze({
        status: 'prepared',
        attemptId,
        transactionHash: signed.transactionHash,
        nonce: signed.nonce,
      });
    } catch (error) {
      // Acknowledgement is permanent even when completion cannot finish.
      state.authorization.preparationReachedStorageWithoutCompletion();
      return commit.throwCompletionFailure(error);
    }
  } finally {
    state.busy = false;
    diagnostics.refresh(cycle, 'prepare-attempt');
  }
}
