import {
  blockAnchorsMatch,
} from '../../chain/block-anchor.js';

import {
  inspectSignerRecovery,
  type SignerRecoveryInspection,
} from '../../chain/inspect-signer-recovery.js';

import {
  validateAcceptanceRequest,
} from '../operator-acceptance.js';

import {
  journalSnapshotDigest,
  validateAttributionRequest,
} from '../operator-attribution.js';

import {
  planSignerRecovery,
  type SignerRecoveryPlan,
} from '../plan-signer-recovery.js';

import {
  describeWriteCompletion,
} from '../write-completion.js';

import type {
  WriteOutcome,
} from '../write-outcome.js';

import {
  bootstrapSignerWorkflow,
  type BootstrapSignerWorkflowDeps,
} from './bootstrap-signer-workflow.js';

import type {
  InspectionOwner,
  RecoverSignerOptions,
  SignerRecoveryResult,
} from './coordinator-types.js';

export type RecoverSignerWorkflowDeps = BootstrapSignerWorkflowDeps;

/**
 * Reconciles the signer against a durable block and saves the resulting
 * observation, resolution, or search progress together.
 */
export async function recoverSignerWorkflow(
  deps: RecoverSignerWorkflowDeps,
  options: RecoverSignerOptions,
  owner: InspectionOwner,
  cycle?: number,
): Promise<SignerRecoveryResult> {
  const { state, diagnostics, commit, inspections } = deps;

  state.assertAvailable(owner);

  const { maxBlockRange } = options;

  if (
    typeof maxBlockRange !== 'bigint' ||
    maxBlockRange <= 0n ||
    maxBlockRange >= (1n << 256n)
  ) {
    throw new TypeError('Invalid signer recovery input.');
  }

  state.assertPersistenceIdle();

  const current = state.persistence.current;

  if (options.attribution !== undefined) {
    validateAttributionRequest(options.attribution);
  }

  if (options.acceptance !== undefined) {
    validateAcceptanceRequest(options.acceptance);

    if (
      options.attribution !== undefined ||
      options.attributionCommitment !== undefined
    ) {
      throw new TypeError('Conflicting operator recovery requests.');
    }
  }

  const acceptanceCommitment = options.acceptanceCommitment;

  if (acceptanceCommitment !== undefined) {
    if (
      options.attribution !== undefined ||
      options.attributionCommitment !== undefined
    ) {
      throw new TypeError('Conflicting operator recovery requests.');
    }

    if (
      options.acceptance === undefined ||
      current.kind !== 'present' ||
      journalSnapshotDigest(current.snapshot) !==
        acceptanceCommitment.snapshotDigest
    ) {
      return {
        status: 'operator-ticket-refused',
        reason: 'snapshot-changed',
      };
    }
  }

  const commitment = options.attributionCommitment;

  if (commitment !== undefined && (
    options.attribution === undefined ||
    current.kind !== 'present' ||
    journalSnapshotDigest(current.snapshot) !== commitment.snapshotDigest
  )) {
    return {
      status: 'operator-ticket-refused',
      reason: 'snapshot-changed',
    };
  }

  state.authorization.recoveryStarted();
  state.busy = true;

  try {
    try {
      if (owner.bracket !== null) {
        const bracket = owner.bracket;

        if (
          bracket.publicClient !== options.publicClient ||
          bracket.durableAnchor === undefined ||
          !blockAnchorsMatch(bracket.durableAnchor, options.anchor)
        ) {
          throw new Error('Recovery does not match the inspection anchors.');
        }

        const changed = await inspections.openInspectionBracket(owner);

        if (changed !== null) {
          return {
            status: 'anchor-changed',
            observedAnchor: changed,
          };
        }
      }

      if (current.kind === 'missing') {
        if (options.acceptance !== undefined) {
          throw new Error('Operator acceptance requires a retained attempt.');
        }

        if (options.attribution !== undefined) {
          throw new Error('Operator attribution requires a retained attempt.');
        }
      }
    } catch (error) {
      state.authorization.recoveryFailed();
      inspections.failInspectionBracket(owner);
      throw error;
    }

    if (current.kind === 'missing') {
      return await bootstrapSignerWorkflow(deps, options, owner, cycle);
    }

    let result: SignerRecoveryInspection;

    let plan: SignerRecoveryPlan;

    let outcome: WriteOutcome;

    try {
      result = await inspectSignerRecovery({
        publicClient: options.publicClient,
        snapshot: current.snapshot,
        anchor: options.anchor,
        maxBlockRange: options.maxBlockRange,
        ...(options.acceptance === undefined ? {} : {
          acceptanceAttemptId: options.acceptance.attemptId,
        }),
        ...(options.attribution === undefined ? {} : {
          hint: options.attribution.hint,
        }),
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

      plan = planSignerRecovery({
        identity: state.identity,
        snapshot: current.snapshot,
        inspection: result,
        ...(options.acceptance === undefined ? {} : {
          acceptance: options.acceptance,
        }),
        ...(options.attribution === undefined ? {} : {
          attribution: options.attribution,
        }),
        unattributedActivity:
          state.blockers.has('unattributed-signer-activity'),
      });

      if (plan.kind === 'inconsistent-observations') {
        state.authorization.evidenceContradicted();
        inspections.failInspectionBracket(owner);

        const detail = plan.detail;

        diagnostics.reportStoredFactConflict(detail, 'recovery', cycle);

        if (!('observation' in result)) {
          throw new Error(
            'A conflicting recovery plan requires an observation.',
          );
        }

        return {
          status: 'inconsistent-observations',
          observation: result.observation,
          detail,
        };
      }

      // Admit only after nonce validation and planning. A preservation-only
      // skip still carries valid evidence, even though recovery stays
      // incomplete.
      if (
        (
          plan.kind === 'persist' ||
          plan.reason === 'preserved-higher-observation'
        ) &&
        'observations' in result &&
        !inspections.admitDurableBlockObservations(owner, result.observations)
      ) {
        inspections.failInspectionBracket(owner);
        return {
          status: 'inconsistent-observations',
          observation: result.observation,
        };
      }

      if (plan.kind === 'unchanged') {
        inspections.failInspectionBracket(owner);

        if (result.status === 'operator-acceptance-available') {
          let reason: 'ledger-capacity-reached' | 'stale-evidence' =
            'stale-evidence';

          if (plan.reason === 'ledger-capacity-reached') {
            reason = plan.reason;
          }

          return {
            status: 'operator-acceptance-refused',
            observation: result.observation,
            reason,
          };
        }

        if (result.status === 'operator-attribution-available') {
          let reason: 'ledger-capacity-reached' | 'stale-evidence' =
            'stale-evidence';

          if (plan.reason === 'ledger-capacity-reached') {
            reason = plan.reason;
          }

          return {
            status: 'operator-hint-refused',
            observation: result.observation,
            reason,
          };
        }

        return result;
      }

      // Ticketed apply may commit only the exact attribution previewed earlier.
      // In particular, a newly available ordinary resolution is not that
      // proposal.
      if (commitment !== undefined && (
        plan.completion.kind !== 'operator-attribution' ||
        plan.completion.outcome.proposalDigest !== commitment.proposalDigest ||
        !blockAnchorsMatch(
          plan.completion.outcome.replacement.inclusion,
          commitment.inclusion,
        ) ||
        !blockAnchorsMatch(
          plan.completion.outcome.durable.anchor,
          commitment.durable.anchor,
        ) ||
        plan.completion.outcome.durable.nonce !== commitment.durable.nonce
      )) {
        inspections.failInspectionBracket(owner);

        return {
          status: 'operator-ticket-refused',
          reason: 'proposal-changed',
        };
      }

      // Ticketed acceptance must not substitute an ordinary resolution or
      // repair.
      if (acceptanceCommitment !== undefined && (
        plan.completion.kind !== 'operator-acceptance' ||
        plan.completion.outcome.proposalDigest !==
          acceptanceCommitment.proposalDigest ||
        !blockAnchorsMatch(
          plan.completion.outcome.durable.anchor,
          acceptanceCommitment.durable.anchor,
        ) ||
        plan.completion.outcome.durable.nonce !==
          acceptanceCommitment.durable.nonce
      )) {
        inspections.failInspectionBracket(owner);

        return {
          status: 'operator-ticket-refused',
          reason: 'proposal-changed',
        };
      }

      diagnostics.clearStoredFactConflictDeduplication();

      outcome = await commit.saveWrite(plan.snapshot, plan.completion);
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
      // Construction must not throw for planner output: this is after
      // acknowledgement.
      const { terminalCorrection } = describeWriteCompletion(
        plan.completion,
        state.identity.signer,
      );

      state.authorization.recoveryCommitted(terminalCorrection);
      commit.applyCommittedWrite(cycle);
      if (terminalCorrection) {
        inspections.failInspectionBracket(owner);
      }

      if (plan.completion.kind === 'operator-acceptance') {
        return {
          status: 'operator-acceptance-committed',
          requestId: plan.completion.outcome.requestId,
        };
      }

      if (plan.completion.kind === 'operator-attribution') {
        return {
          status: 'operator-attribution-committed',
          requestId: plan.completion.outcome.requestId,
        };
      }

      const inspectedAttempt = current.snapshot.attempts[0];

      if (
        result.status === 'unresolved' &&
        inspectedAttempt !== undefined &&
        inspectedAttempt.phase !== 'included' &&
        result.observation.nonce === inspectedAttempt.nonce &&
        result.search === null &&
        state.blockers.size === 0 &&
        (
          result.receipt.status === 'receipt-not-found' ||
          result.receipt.status === 'fork-served-receipt'
        )
      ) {
        state.authorization.grantRecoveryPermit(inspectedAttempt.attemptId);
      }

      return result;
    } catch (error) {
      state.authorization.recoveryFailed();
      inspections.failInspectionBracket(owner);
      return commit.throwCompletionFailure(error);
    }
  } finally {
    state.busy = false;
    diagnostics.refresh(cycle);
  }
}
