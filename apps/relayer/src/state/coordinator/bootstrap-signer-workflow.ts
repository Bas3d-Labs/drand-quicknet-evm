import {
  inspectSignerBootstrap,
} from '../../chain/inspect-signer-bootstrap.js';

import type {
  AnchoredNonceObservation,
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
  InspectionOwner,
  RecoverSignerOptions,
  SignerRecoveryResult,
} from './coordinator-types.js';

import type {
  InspectionController,
} from './inspection-controller.js';

import type {
  JournalCommitEngine,
} from './journal-commit-engine.js';

export interface BootstrapSignerWorkflowDeps {
  readonly state: CoordinatorStateStore;
  readonly diagnostics: CoordinatorDiagnostics;
  readonly commit: JournalCommitEngine;
  readonly inspections: InspectionController;
}

/**
 * Establishes the first durable nonce baseline.
 */
export async function bootstrapSignerWorkflow(
  deps: BootstrapSignerWorkflowDeps,
  options: RecoverSignerOptions,
  owner: InspectionOwner,
  cycle?: number,
): Promise<SignerRecoveryResult> {
  const { state, diagnostics, commit, inspections } = deps;

  let observation: AnchoredNonceObservation;

  let outcome: WriteOutcome;

  try {
    if (state.blockers.size !== 0) {
      throw new Error('Cannot bootstrap while coordinator blockers remain.');
    }

    const result = await inspectSignerBootstrap({
      publicClient: options.publicClient,
      signer: state.identity.signer,
      anchor: options.anchor,
    });

    if (
      'observation' in result &&
      !inspections.observeInspectionDurableNonce(owner, result.observation)
    ) {
      return {
        status: 'inconsistent-observations',
        observation: result.observation,
      };
    }

    if (result.status === 'bootstrap-deferred') {
      inspections.failInspectionBracket(owner);
      diagnostics.reportBootstrapDeferred(result, cycle);

      return result;
    }

    if (result.status === 'anchor-changed') {
      inspections.failInspectionBracket(owner);
      return result;
    }

    diagnostics.clearBootstrapDeferralDeduplication();

    observation = result.observation;

    outcome = await commit.saveWrite({
      version: 1,
      identity: state.identity,
      baseline: observation,
      lastObservation: observation,
      nextNonce: observation.nonce,
      durableNextNonce: observation.nonce,
      repairs: [],
      ledger: {
        outcomes: [],
        obligations: [],
      },
      attempts: [],
    }, { kind: 'bootstrap' });
  } catch (error) {
    state.authorization.recoveryFailed();
    inspections.failInspectionBracket(owner);
    throw error;
  }

  if (outcome.status !== 'acknowledged') {
    state.authorization.recoveryFailed();
    inspections.failInspectionBracket(owner);
    return commit.throwWriteFailure(outcome);
  }

  try {
    state.authorization.bootstrapCommitted();
    commit.applyCommittedWrite(cycle);

    return {
      status: 'no-attempt',
      observations: Object.freeze([]),
      observation,
    };
  } catch (error) {
    state.authorization.recoveryFailed();
    inspections.failInspectionBracket(owner);
    return commit.throwCompletionFailure(error);
  }
}
