import {
  join,
  resolve,
} from 'node:path';

import type {
  PublicClient,
} from 'viem';

import {
  blockAnchorsMatch,
  getBlockAnchor,
} from '../chain/block-anchor.js';

import {
  getChainHeads,
} from '../chain/chain-heads.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import {
  inspectSignerRecovery,
  type SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

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
  FileTransactionJournalStore,
} from './file-transaction-journal-store.js';

import {
  DEFAULT_JOURNAL_BOUNDS,
} from './journal-bounds.js';

import {
  captureJournalIdentity,
  journalFilename,
} from './journal-identity.js';

import {
  journalJson,
} from './journal-ledger-validation.js';

import {
  journalSnapshotDigest,
  supersedesNoMatch,
  validateAttributionRequest,
  type OperatorAttributionRequest,
} from './operator-attribution.js';

import {
  planSignerRecovery,
} from './plan-signer-recovery.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from './service-lock.js';

import {
  SignerCoordinator,
} from './signer-coordinator.js';

import {
  evaluateSignerGate,
  type CoordinatorBlocker,
  type SignerBlocker,
} from './signer-gate.js';

import type {
  AnchoredNonceObservation,
  JournalIdentity,
  OperatorAttributedOutcome,
} from './transaction-journal.js';

import {
  encodeJournalSnapshot,
} from './transaction-journal-serialization.js';

import {
  decodeAttributionTicket,
  ticketForOutcome,
  ticketMatchesOutcome,
  type AttributionTicket,
} from './attribution-ticket.js';

interface AttributionOptions {
  readonly publicClient: PublicClient;
  readonly identity: JournalIdentity;
  readonly finality: FinalityPolicy;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export type AttributeTransactionOptions = AttributionOptions & (
  | {
      readonly mode: 'dry-run';
      readonly request: OperatorAttributionRequest;
    }
  | {
      readonly mode: 'apply';
      readonly ticket: AttributionTicket;
    }
);

export type AttributionRefusalReason =
  | SignerRecoveryInspection['status']
  | Extract<SignerRecoveryInspection, { status: 'operator-hint-refused' }>['reason']
  | 'configuration-mismatch'
  | 'journal-missing'
  | 'request-conflict'
  | 'snapshot-changed'
  | 'chain-mismatch'
  | 'ticket-anchor-not-durable'
  | 'proposal-unavailable'
  | 'proposal-changed'
  | 'bootstrap-deferred';

export type AttributionResult =
  | {
      readonly status: 'ordinary-resolution-available';
      readonly evidence: AttemptResolutionEvidence;
    }
  | {
      readonly status: 'preview';
      readonly ticket: AttributionTicket;
      readonly preview: {
        readonly removedAttemptId: string;
        readonly previousDurableNextNonce: bigint;
        readonly durableNextNonce: bigint;
        readonly lastObservation: AnchoredNonceObservation;
        readonly outcome: OperatorAttributedOutcome;
        readonly supersededNoMatch: boolean;
        readonly blockers: readonly SignerBlocker[];
      };
    }
  | {
      readonly status: 'committed' | 'already-recorded';
      readonly outcome: OperatorAttributedOutcome;
    }
  | {
      readonly status: 'attempt-already-attributed';
      readonly requestedRequestId: string;
      readonly outcome: OperatorAttributedOutcome;
    }
  | {
      readonly status: 'refused';
      readonly reason: AttributionRefusalReason;
    };

/** Dry-run never opens a writable store. Apply owns the inherited service lock. */
export async function attributeTransaction(
  options: AttributeTransactionOptions,
): Promise<AttributionResult> {
  const identity = captureJournalIdentity(options.identity);

  const finality = structuredClone(options.finality);

  const env = {
    ...(options.env ?? process.env),
  };

  if (env.QUICKNET_STATE_DIR !== undefined && env.QUICKNET_STATE_DIR.trim().length === 0) {
    throw new TypeError('Invalid operator attribution state directory.');
  }

  const { publicClient, signal } = options;

  let ticket: AttributionTicket | undefined;

  let request: OperatorAttributionRequest;

  if (options.mode === 'apply') {
    ticket = decodeAttributionTicket(journalJson(options.ticket));
    request = {
      requestId: ticket.requestId,
      operator: ticket.operator,
      at: ticket.at,
      finality,
      hint: {
        attemptId: ticket.attemptId,
        transactionHash: ticket.hintHash,
        blockNumber: ticket.inclusion.blockNumber,
      },
    };

    if (
      identity.chainId !== ticket.identity.chainId ||
      identity.signer.toLowerCase() !== ticket.identity.signer.toLowerCase() ||
      journalJson(finality) !== journalJson(ticket.finality)
    ) {
      return refused('configuration-mismatch');
    }
  } else {
    request = structuredClone(options.request);

    if (journalJson(request.finality) !== journalJson(finality)) {
      return refused('configuration-mismatch');
    }
  }

  validateAttributionRequest(request);
  signal?.throwIfAborted();

  const ownership = options.mode === 'apply'
    ? assertServiceLockHeld({
      env,
    })
    : undefined;

  const stateDirectory = ownership?.stateDirectory ?? resolve(env.QUICKNET_STATE_DIR ?? './state');

  env.QUICKNET_STATE_DIR = stateDirectory;

  function verifyOwnership(): void {
    const current = assertServiceLockHeld({
      env,
    });

    if (
      ownership === undefined ||
      current.stateDirectory !== ownership.stateDirectory ||
      current.dev !== ownership.dev ||
      current.ino !== ownership.ino
    ) {
      throw new ServiceLockNotHeldError('descriptor');
    }
  }

  const storeOptions = {
    filePath: join(stateDirectory, journalFilename(identity)),
    identity,
    bounds: DEFAULT_JOURNAL_BOUNDS,
  };

  const initial = await FileTransactionJournalStore.read(storeOptions);

  signal?.throwIfAborted();

  if (initial.kind === 'missing') {
    return refused('journal-missing');
  }

  const snapshot = initial.snapshot;

  // The proposal commits to the encoded identity, including its spelling.
  // Refuse a ticket whose address merely compares equal case-insensitively.
  if (ticket !== undefined && journalJson(ticket.identity) !== journalJson(snapshot.identity)) {
    return refused('configuration-mismatch');
  }

  const existingRequest = snapshot.ledger.outcomes.find((row) => row.requestId === request.requestId);

  const existingAttempt = snapshot.ledger.outcomes.find((row) => row.attemptId === request.hint.attemptId);

  if (existingRequest !== undefined) {
    if (ticket === undefined || !ticketMatchesOutcome(ticket, snapshot.identity, existingRequest)) {
      return refused('request-conflict');
    }

    verifyOwnership();

    return {
      status: 'already-recorded',
      outcome: existingRequest,
    };
  }

  if (existingAttempt !== undefined) {
    return {
      status: 'attempt-already-attributed',
      requestedRequestId: request.requestId,
      outcome: existingAttempt,
    };
  }

  if (ticket !== undefined && ticket.snapshotDigest !== journalSnapshotDigest(snapshot)) {
    return refused('snapshot-changed');
  }

  if (await publicClient.getChainId() !== identity.chainId) {
    return refused('chain-mismatch');
  }

  signal?.throwIfAborted();

  const heads = await getChainHeads({
    publicClient,
    finality,
  });

  const durableHeight = ticket?.durable.anchor.blockNumber ?? heads.durableBlock;

  if (durableHeight > heads.durableBlock) {
    return refused('ticket-anchor-not-durable');
  }

  const anchor = await getBlockAnchor(
    publicClient,
    durableHeight,
    ticket?.durable.anchor.blockHash,
    {
      operation: 'signer-recovery',
      finality,
    },
  );

  signal?.throwIfAborted();

  if (ticket !== undefined && !blockAnchorsMatch(anchor, ticket.durable.anchor)) {
    return refused('anchor-changed');
  }

  if (ticket === undefined) {
    const inspection = await inspectSignerRecovery({
      publicClient,
      snapshot,
      anchor,
      maxBlockRange: 1n,
      hint: request.hint,
    });

    signal?.throwIfAborted();

    if (inspection.status === 'resolution-available') {
      return {
        status: 'ordinary-resolution-available',
        evidence: inspection.evidence,
      };
    }

    if (inspection.status !== 'operator-attribution-available') {
      if (inspection.status === 'operator-hint-refused') {
        return refused(inspection.reason);
      }

      return refused(inspection.status);
    }

    const plan = planSignerRecovery({
      identity,
      snapshot,
      inspection,
      attribution: request,
      unattributedActivity: snapshot.lastObservation.nonce > snapshot.nextNonce,
    });

    if (plan.kind !== 'persist' || plan.completion.kind !== 'operator-attribution') {
      return refused('proposal-unavailable');
    }

    // Exercise the real encoder and whole-journal byte cap, internally only.
    await encodeJournalSnapshot(plan.snapshot, identity);

    const outcome = plan.completion.outcome;

    const blockers = new Set<CoordinatorBlocker>();

    if (snapshot.lastObservation.nonce > snapshot.nextNonce) {
      blockers.add('unattributed-signer-activity');
    }

    if (plan.snapshot.attempts.some((attempt) =>
      attempt.replacementSearch !== null &&
      attempt.replacementSearch.exhausted !== null
    )) {
      blockers.add('conflict-search-exhausted');
    }

    const gate = evaluateSignerGate({
      persistence: {
        state: 'idle',
        current: {
          kind: 'present',
          snapshot: plan.snapshot,
        },
      },
      recoveryComplete: false,
      inclusionChecksComplete: false,
      maxRetainedAttempts: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts,
      blockers,
    });

    return {
      status: 'preview',
      ticket: ticketForOutcome(snapshot.identity, outcome),
      preview: {
        removedAttemptId: outcome.attemptId,
        previousDurableNextNonce: snapshot.durableNextNonce,
        durableNextNonce: plan.snapshot.durableNextNonce,
        lastObservation: plan.snapshot.lastObservation,
        outcome,
        supersededNoMatch: supersedesNoMatch(outcome),
        blockers: gate.blockers,
      },
    };
  }

  // Opening a file store can rewrite storage. Defer it until the coordinator
  // has verified the fresh proposal against the ticket, immediately before save.
  let writable: FileTransactionJournalStore | undefined;

  let openingStarted = false;

  let preWriteFailure: { readonly error: unknown } | undefined;

  const coordinator = await SignerCoordinator.create({
    identity,
    maxRetainedAttempts: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts,
    log: options.log,
    createErrorSummary: options.createErrorSummary,
    store: {
      load: async () => initial,
      async save(next) {
        verifyOwnership();

        if (writable === undefined) {
          try {
            if (!openingStarted) {
              signal?.throwIfAborted();
            }

            const current = await FileTransactionJournalStore.read(storeOptions);

            if (
              current.kind !== 'present' ||
              journalSnapshotDigest(current.snapshot) !== ticket.snapshotDigest
            ) {
              throw new Error('Operator attribution journal changed.');
            }

            verifyOwnership();

            if (!openingStarted) {
              signal?.throwIfAborted();
            }
          } catch (error) {
            // Preserve a failed pre-opening condition rather than retrying it
            // as a save failure. Cancellation is checked only before opening starts.
            preWriteFailure = {
              error,
            };
            throw error;
          }

          openingStarted = true;
          writable = await FileTransactionJournalStore.open(storeOptions);
        }

        verifyOwnership();
        await writable.save(next);
      },
    },
  });

  try {
    const result = await coordinator.recover({
      publicClient,
      anchor,
      maxBlockRange: 1n,
      attribution: request,
      attributionCommitment: {
        snapshotDigest: ticket.snapshotDigest,
        proposalDigest: ticket.proposalDigest,
        inclusion: ticket.inclusion,
        durable: ticket.durable,
      },
    });

    if (result.status !== 'operator-attribution-committed') {
      if (result.status === 'operator-ticket-refused' || result.status === 'operator-hint-refused') {
        return refused(result.reason);
      }

      return refused(result.status);
    }
  } catch (error) {
    if (preWriteFailure !== undefined) {
      throw preWriteFailure.error;
    }

    if (coordinator.status.persistenceState !== 'failed') {
      throw error;
    }

    // Retry only the coordinator's retained exact write, never re-plan on failure.
    // Once persistence starts, cancellation cannot replace its actual outcome.
    verifyOwnership();
    await coordinator.retryPersistence();
  }

  const committed = coordinator.operatorOutcome(ticket.requestId);

  if (committed === undefined || !ticketMatchesOutcome(ticket, snapshot.identity, committed)) {
    throw new Error('Operator attribution acknowledgement was not confirmed.');
  }

  return {
    status: 'committed',
    outcome: committed,
  };
}

function refused(
  reason: AttributionRefusalReason,
): AttributionResult {
  return {
    status: 'refused',
    reason,
  };
}
