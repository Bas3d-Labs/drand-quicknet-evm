import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';
import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';
import {
  JournalPersistence,
} from '../../src/state/journal-persistence.js';
import {
  SignerRestartRequiredError,
} from '../../src/state/signer-restart-required-error.js';
import type {
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';
import type {
  BootstrapSignerWorkflowDeps,
} from '../../src/state/coordinator/bootstrap-signer-workflow.js';
import type {
  BroadcastAttemptWorkflowDeps,
} from '../../src/state/coordinator/broadcast-attempt-workflow.js';
import type {
  CheckInclusionsWorkflowDeps,
} from '../../src/state/coordinator/check-inclusions-workflow.js';
import {
  CoordinatorDiagnostics,
} from '../../src/state/coordinator/coordinator-diagnostics.js';
import {
  CoordinatorStateStore,
} from '../../src/state/coordinator/coordinator-state.js';
import {
  JournalCommitEngine,
} from '../../src/state/coordinator/journal-commit-engine.js';
import type {
  PrepareAttemptWorkflowDeps,
} from '../../src/state/coordinator/prepare-attempt-workflow.js';
import type {
  RecoverSignerWorkflowDeps,
} from '../../src/state/coordinator/recover-signer-workflow.js';
import {
  IDENTITY,
  anchor,
} from '../helpers/operator-attribution-fixture.js';

function createErrorSummary() {
  return {
    scrubText: createScrubber({ rpcUrls: [], secrets: [] }),
  };
}

function createBaselineSnapshot(
  chainId = IDENTITY.chainId,
): TransactionJournalSnapshot {
  const baseline = {
    nonce: 0n,
    anchor: anchor(10n),
  };
  return {
    version: 1,
    identity: {
      ...IDENTITY,
      chainId,
    },
    baseline,
    lastObservation: baseline,
    nextNonce: 0n,
    durableNextNonce: 0n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [],
  };
}

async function createAuthorityHarness(options?: {
  saveImpl?: (snapshot: TransactionJournalSnapshot) => Promise<void>;
}) {
  const savedSnapshots: TransactionJournalSnapshot[] = [];
  let saveImpl =
    options?.saveImpl ??
    (async (_snapshot: TransactionJournalSnapshot) => undefined);

  const store: TransactionJournalStore = {
    load: async () => ({ kind: 'missing' }),
    save: async (snapshot) => {
      savedSnapshots.push(snapshot);
      await saveImpl(snapshot);
    },
  };
  const persistence = await JournalPersistence.create({
    identity: IDENTITY,
    store,
    initial: { kind: 'missing' },
  });
  const state = new CoordinatorStateStore(persistence, IDENTITY, 4);
  const log = createRelayerLog({
    chainId: IDENTITY.chainId,
    errorSummary: createErrorSummary(),
    destination: { write() {} },
  }).withContext({ signer: IDENTITY.signer });
  const diagnostics = new CoordinatorDiagnostics(
    state.createDiagnosticsCapability(),
    log,
    () => 1_700_000_000_000,
    createErrorSummary,
  );
  return {
    state,
    diagnostics,
    savedSnapshots,
    setSaveImpl(
      next: (snapshot: TransactionJournalSnapshot) => Promise<void>,
    ) {
      saveImpl = next;
    },
  };
}

/**
 * Compile-time pin: removing `private` from any CoordinatorStateStore field
 * or internal mutator fails typecheck with an unused @ts-expect-error.
 */
function assertPrivateStateStoreBoundaries(
  store: CoordinatorStateStore,
): void {
  // @ts-expect-error authorization is private
  void store.authorization;
  // @ts-expect-error blockers is private
  void store.blockers;
  // @ts-expect-error persistence is private
  void store.persistence;
  // @ts-expect-error busy is private
  void store.busy;
  // @ts-expect-error emitting is private
  void store.emitting;
  // @ts-expect-error reconciliationObservationActive is private
  void store.reconciliationObservationActive;
  // @ts-expect-error inspectionOwner is private
  void store.inspectionOwner;
  // @ts-expect-error pendingWrite is private
  void store.pendingWrite;
  // @ts-expect-error restartRequired is private
  void store.restartRequired;
  // @ts-expect-error committedDurableRecoveryRevision is private
  void store.committedDurableRecoveryRevision;
  // @ts-expect-error storedFactDispute is private
  void store.storedFactDispute;
  // @ts-expect-error requirePendingWrite is private
  void store.requirePendingWrite;
  // @ts-expect-error isPendingWrite is private
  void store.isPendingWrite;
  // @ts-expect-error stagePendingWrite is private
  void store.stagePendingWrite;
  // @ts-expect-error discardPendingWrite is private
  void store.discardPendingWrite;
  // @ts-expect-error completePendingWrite is private
  void store.completePendingWrite;
  // @ts-expect-error latchRestartRequired is private
  void store.latchRestartRequired;
  // @ts-expect-error acquireInspectionOwner is private
  void store.acquireInspectionOwner;
  // @ts-expect-error releaseInspectionOwner is private
  void store.releaseInspectionOwner;
  // @ts-expect-error runBusy is private
  void store.runBusy;
  // @ts-expect-error runEmitting is private
  void store.runEmitting;
}

/**
 * Compile-time pin: workflow dependency interfaces must not expose
 * persistence, commit-state mutators, or unrestricted commit-engine methods.
 */
function assertWorkflowDependencyBoundaries(
  prepareDeps: PrepareAttemptWorkflowDeps,
  broadcastDeps: BroadcastAttemptWorkflowDeps,
  bootstrapDeps: BootstrapSignerWorkflowDeps,
  recoverDeps: RecoverSignerWorkflowDeps,
  inclusionsDeps: CheckInclusionsWorkflowDeps,
): void {
  // @ts-expect-error prepare workflow cannot access persistence
  void prepareDeps.state.persistence;
  // @ts-expect-error prepare workflow cannot stage pending writes
  void prepareDeps.state.stagePendingWrite;
  // @ts-expect-error prepare workflow cannot complete pending writes
  void prepareDeps.state.completePendingWrite;
  // @ts-expect-error prepare workflow cannot discard pending writes
  void prepareDeps.state.discardPendingWrite;
  // @ts-expect-error prepare workflow cannot latch restart required
  void prepareDeps.state.latchRestartRequired;
  // @ts-expect-error prepare workflow cannot read pending metadata
  void prepareDeps.state.requirePendingWrite;
  // @ts-expect-error prepare workflow cannot apply writes without save
  void prepareDeps.commit.applyCommittedWrite;
  // @ts-expect-error prepare workflow cannot complete writes without save
  void prepareDeps.commit.completeCommittedWrite;
  // @ts-expect-error prepare workflow cannot retry persistence
  void prepareDeps.commit.retryPersistence;
  // @ts-expect-error prepare workflow cannot trigger completion failure
  void prepareDeps.commit.throwCompletionFailure;

  // @ts-expect-error broadcast workflow cannot complete pending writes
  void broadcastDeps.state.completePendingWrite;
  // @ts-expect-error broadcast workflow cannot access persistence
  void broadcastDeps.state.persistence;
  // @ts-expect-error broadcast workflow cannot complete without save
  void broadcastDeps.commit.completeCommittedWrite;

  // @ts-expect-error bootstrap workflow cannot stage pending writes
  void bootstrapDeps.state.stagePendingWrite;
  // @ts-expect-error recover workflow cannot access persistence
  void recoverDeps.state.persistence;
  // @ts-expect-error recover workflow cannot discard pending writes
  void recoverDeps.state.discardPendingWrite;
  // @ts-expect-error inclusions workflow cannot apply without save
  void inclusionsDeps.commit.applyCommittedWrite;
}

// Keep compile-time pin functions referenced without executing them.
void assertPrivateStateStoreBoundaries;
void assertWorkflowDependencyBoundaries;

describe('Coordinator exclusive mutation authority', () => {
  it(
    'detaches input aliases and freezes retained completion metadata',
    async () => {
      const { state } = await createAuthorityHarness();
      const commitCap = state.createCommitEngineCapability();

      expect(() => state.createCommitEngineCapability()).toThrow(
        'Commit engine capability has already been issued.',
      );

      const mutablePrepared: { kind: 'prepared' | 'broadcast' } = {
        kind: 'prepared',
      };
      commitCap.stagePendingWrite(mutablePrepared);
      mutablePrepared.kind = 'broadcast';

      const pending = commitCap.requirePendingWrite();
      expect(pending.kind).toBe('prepared');
      expect(Object.isFrozen(pending)).toBe(true);
      expect(() => {
        if (pending.kind === 'prepared' || pending.kind === 'broadcast') {
          // @ts-expect-error retained metadata is readonly
          pending.kind = 'broadcast';
        }
      }).toThrow(TypeError);
      expect(commitCap.requirePendingWrite().kind).toBe('prepared');

      commitCap.discardPendingWrite();

      const resetEvent = {
        signer: IDENTITY.signer,
        attemptId: 'attempt-1',
        nonce: 0n,
        reason: 'searched-through-changed' as
          | 'searched-through-changed'
          | 'exhaustion-anchor-changed',
        expectedBlock: 10n,
        expectedBlockHash: anchor(10n).blockHash,
        observedBlock: 10n,
        observedBlockHash: anchor(11n).blockHash,
        durableBlock: 10n,
        durableBlockHash: anchor(11n).blockHash,
      };
      commitCap.stagePendingWrite({
        kind: 'search-reset',
        event: resetEvent,
      });
      resetEvent.reason = 'exhaustion-anchor-changed';

      const nested = commitCap.requirePendingWrite();
      expect(nested.kind).toBe('search-reset');
      if (nested.kind !== 'search-reset') {
        throw new Error('Expected search-reset completion.');
      }
      expect(nested.event.reason).toBe('searched-through-changed');
      expect(Object.isFrozen(nested)).toBe(true);
      expect(Object.isFrozen(nested.event)).toBe(true);
      expect(() => {
        // @ts-expect-error nested completion metadata is deeply readonly
        nested.event.reason = 'exhaustion-anchor-changed';
      }).toThrow(TypeError);
      expect(nested.event.reason).toBe('searched-through-changed');
    },
  );

  it(
    'freezes workflow capabilities and hides commit-state mutators at runtime',
    async () => {
      const { state, diagnostics } = await createAuthorityHarness();
      const commit = new JournalCommitEngine(
        state.createCommitEngineCapability(),
        diagnostics,
      );
      const workflowCommit = commit.createWorkflowHandle();
      const workflowStates = [
        state.createPrepareWorkflowCapability(),
        state.createBroadcastWorkflowCapability(),
        state.createRecoverWorkflowCapability(),
        state.createCheckInclusionsWorkflowCapability(),
      ];

      const forbiddenStateKeys = [
        'persistence',
        'stagePendingWrite',
        'discardPendingWrite',
        'completePendingWrite',
        'latchRestartRequired',
        'requirePendingWrite',
        'isPendingWrite',
        'acquireInspectionOwner',
        'releaseInspectionOwner',
      ];
      for (const capability of workflowStates) {
        expect(Object.isFrozen(capability)).toBe(true);
        expect(Object.isFrozen(capability.authorization)).toBe(true);
        for (const key of forbiddenStateKeys) {
          expect(key in capability).toBe(false);
        }
      }

      expect(Object.isFrozen(workflowCommit)).toBe(true);
      expect(Object.keys(workflowCommit)).toEqual(['saveWrite']);
      for (const key of [
        'applyCommittedWrite',
        'completeCommittedWrite',
        'retryPersistence',
        'throwCompletionFailure',
      ]) {
        expect(key in workflowCommit).toBe(false);
      }
    },
  );

  it(
    'gates completion on acknowledged saves and preserves retry identity',
    async () => {
      const {
        state,
        diagnostics,
        savedSnapshots,
        setSaveImpl,
      } = await createAuthorityHarness();
      const commit = new JournalCommitEngine(
        state.createCommitEngineCapability(),
        diagnostics,
      );
      const workflowCommit = commit.createWorkflowHandle();

      // 1. not-written: metadata is cleared automatically; no completion token.
      const invalidSnapshot = createBaselineSnapshot(IDENTITY.chainId + 1);
      const notWritten = await workflowCommit.saveWrite(
        invalidSnapshot,
        { kind: 'prepared' },
      );
      expect(notWritten.status).toBe('not-written');
      expect(Object.isFrozen(notWritten)).toBe(true);
      expect('apply' in notWritten).toBe(false);
      expect('complete' in notWritten).toBe(false);
      expect('failCompletion' in notWritten).toBe(false);
      expect(state.hasPendingWrite).toBe(false);

      // 2. uncertain: metadata is retained; no completion token; retry keeps
      //    exact verified snapshot reference identity (===).
      setSaveImpl(async () => {
        throw new Error('simulated disk failure');
      });
      const validSnapshot = createBaselineSnapshot();
      const uncertain = await workflowCommit.saveWrite(
        validSnapshot,
        { kind: 'bootstrap' },
      );
      expect(uncertain.status).toBe('uncertain');
      expect(Object.isFrozen(uncertain)).toBe(true);
      expect('apply' in uncertain).toBe(false);
      expect('complete' in uncertain).toBe(false);
      expect('failCompletion' in uncertain).toBe(false);
      expect(state.hasPendingWrite).toBe(true);
      expect(savedSnapshots).toHaveLength(1);

      setSaveImpl(async () => undefined);
      await commit.retryPersistence();
      expect(state.hasPendingWrite).toBe(false);
      expect(savedSnapshots).toHaveLength(2);
      expect(savedSnapshots[1]).toBe(savedSnapshots[0]);

      // 3. acknowledged: minted completion token is frozen and one-shot only.
      const acknowledged = await workflowCommit.saveWrite(
        createBaselineSnapshot(),
        { kind: 'observation' },
      );
      expect(acknowledged.status).toBe('acknowledged');
      expect(Object.isFrozen(acknowledged)).toBe(true);
      if (acknowledged.status !== 'acknowledged') {
        throw new Error('Expected acknowledged outcome.');
      }

      acknowledged.apply();
      expect(state.hasPendingWrite).toBe(false);
      expect(() => acknowledged.apply()).toThrow(
        'Journal write completion was already applied.',
      );
      expect(() => acknowledged.complete()).toThrow(
        'Journal write completion was already applied.',
      );
    },
  );

  it(
    'makes failCompletion terminal for apply and complete on that handle',
    async () => {
      const { state, diagnostics } = await createAuthorityHarness();
      const commit = new JournalCommitEngine(
        state.createCommitEngineCapability(),
        diagnostics,
      );
      const workflowCommit = commit.createWorkflowHandle();

      const acknowledged = await workflowCommit.saveWrite(
        createBaselineSnapshot(),
        { kind: 'bootstrap' },
      );
      expect(acknowledged.status).toBe('acknowledged');
      if (acknowledged.status !== 'acknowledged') {
        throw new Error('Expected acknowledged outcome.');
      }

      expect(() =>
        acknowledged.failCompletion(new Error('completion failed')),
      ).toThrow(SignerRestartRequiredError);
      expect(state.hasPendingWrite).toBe(true);

      expect(() => acknowledged.apply()).toThrow(
        'Journal write completion has already failed.',
      );
      expect(() => acknowledged.complete()).toThrow(
        'Journal write completion has already failed.',
      );
      expect(state.hasPendingWrite).toBe(true);
    },
  );

  it(
    'binds failCompletion to its own write and preserves post-clear errors',
    async () => {
      const {
        state,
        diagnostics,
        setSaveImpl,
      } = await createAuthorityHarness();
      const commit = new JournalCommitEngine(
        state.createCommitEngineCapability(),
        diagnostics,
      );
      const workflowCommit = commit.createWorkflowHandle();

      // Write A completes and clears its own metadata.
      const sharedMeta = { kind: 'observation' as const };
      const writeA = await workflowCommit.saveWrite(
        createBaselineSnapshot(),
        sharedMeta,
      );
      expect(writeA.status).toBe('acknowledged');
      if (writeA.status !== 'acknowledged') {
        throw new Error('Expected acknowledged outcome for write A.');
      }
      writeA.apply();
      expect(state.hasPendingWrite).toBe(false);

      // Post-clear failure on A preserves original error without latching.
      const postClearError = new Error('post-clear callback error');
      let caughtPostClear: unknown;
      try {
        writeA.failCompletion(postClearError);
      } catch (error) {
        caughtPostClear = error;
      }
      expect(caughtPostClear).toBe(postClearError);
      expect(caughtPostClear).not.toBeInstanceOf(SignerRestartRequiredError);

      // Write B becomes uncertain with structurally identical metadata.
      setSaveImpl(async () => {
        throw new Error('simulated disk failure on write B');
      });
      const writeB = await workflowCommit.saveWrite(
        createBaselineSnapshot(),
        sharedMeta,
      );
      expect(writeB.status).toBe('uncertain');
      expect(state.hasPendingWrite).toBe(true);

      // Stale failCompletion on A must not latch restart for B.
      const staleError = new Error('stale handle failure');
      let caughtStale: unknown;
      try {
        writeA.failCompletion(staleError);
      } catch (error) {
        caughtStale = error;
      }
      expect(caughtStale).toBe(staleError);
      expect(caughtStale).not.toBeInstanceOf(SignerRestartRequiredError);
      expect(state.hasPendingWrite).toBe(true);

      // Write B's retry remains valid and clears B's pending metadata.
      setSaveImpl(async () => undefined);
      await commit.retryPersistence();
      expect(state.hasPendingWrite).toBe(false);
    },
  );
});
