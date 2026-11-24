import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  createRelayerLog,
  type ScopedRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  ACCOUNT,
  DURABLE,
  IDENTITY,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

import {
  FACT_IDENTITY,
  factAnchor,
  factObservation,
  searchFactFixture,
} from '../helpers/search-fact-fixture.js';

function createErrorSummary(secrets: readonly string[] = []) {
  return {
    scrubText: createScrubber({ rpcUrls: [], secrets }),
  };
}

function interceptLog(
  inner: ScopedRelayerLog,
  overrides: Partial<ScopedRelayerLog>,
): ScopedRelayerLog {
  return {
    ...inner,
    ...overrides,
    withContext: (context) =>
      interceptLog(inner.withContext(context), overrides),
    withErrorSummary: (policy) =>
      interceptLog(inner.withErrorSummary(policy), overrides),
  };
}

function sampleTransaction() {
  return {
    type: 'eip1559' as const,
    to: ACCOUNT.address,
    value: 0n,
    data: '0x' as const,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
}

async function captureRejection(
  promise: Promise<unknown>,
): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('SignerCoordinator preserved invariants', () => {
  it(
    'keeps status.open observable while excluding commands during gate-release and loggingFailed callbacks',
    async () => {
    const base = await fixture();
    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot: {
        ...base,
        lastObservation: base.baseline,
        nextNonce: 4n,
        durableNextNonce: 4n,
        attempts: [],
      },
    };

    const rpc = client(200n);
    rpc.getTransactionCount.mockResolvedValue(4);

    let coordinator!: SignerCoordinator;
    const rawProbes: Array<{
      readonly phase: 'released' | 'loggingFailed';
      readonly open: boolean;
      readonly revisionReadable: boolean;
      readonly beginInspectionError: string | null;
      readonly prepareAttemptPromise: Promise<unknown>;
      readonly observeReconciliationPromise: Promise<unknown>;
    }> = [];

    const captureSyncProbe = (phase: 'released' | 'loggingFailed') => {
      let beginInspectionError: string | null = null;
      try {
        coordinator.beginInspection();
      } catch (error) {
        beginInspectionError =
          error instanceof Error ? error.message : String(error);
      }

      // Trigger async entry points synchronously inside emit() so their
      // entry guards execute while emitting === true.
      const prepareAttemptPromise = coordinator.prepareAttempt({
        account: ACCOUNT,
        transaction: sampleTransaction(),
        workId: `reentrant:${phase}`,
      });
      const observeReconciliationPromise = coordinator.observeReconciliation(
        async () => undefined,
      );

      // Attach no-op rejection handlers to avoid unhandledRejection before
      // await.
      void prepareAttemptPromise.catch(() => {});
      void observeReconciliationPromise.catch(() => {});

      rawProbes.push({
        phase,
        open: coordinator.status.open,
        revisionReadable: coordinator.durableRecoveryRevision.length > 0,
        beginInspectionError,
        prepareAttemptPromise,
        observeReconciliationPromise,
      });
    };

    const baseLog = createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: { write() {} },
    });

    const log = interceptLog(baseLog, {
      signerGateReleased() {
        captureSyncProbe('released');
        throw new Error('simulated release log failure');
      },
      loggingFailed() {
        captureSyncProbe('loggingFailed');
      },
    });

    coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      store: {
        load: async () => visible,
        save: async (next) => {
          visible = { kind: 'present', snapshot: next };
        },
      },
      log,
      createErrorSummary,
    });

    const head = anchor(105n);
    const inspection = coordinator.beginInspection({
      publicClient: rpc.publicClient,
      head,
      durableAnchor: DURABLE,
    });

    await inspection.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 20n,
    }, 10);

    await inspection.checkInclusions({
      publicClient: rpc.publicClient,
      head,
    }, 10);

    expect(() => inspection.finish()).not.toThrow();

    const observations = await Promise.all(rawProbes.map(async (probe) => ({
      phase: probe.phase,
      open: probe.open,
      revisionReadable: probe.revisionReadable,
      beginInspectionError: probe.beginInspectionError,
      prepareAttemptError: await captureRejection(probe.prepareAttemptPromise),
      observeReconciliationError: await captureRejection(
        probe.observeReconciliationPromise,
      ),
    })));

    const inProgress = 'Signer coordinator operation is already in progress.';

    expect(observations).toEqual([
      {
        phase: 'released',
        open: true,
        revisionReadable: true,
        beginInspectionError: inProgress,
        prepareAttemptError: inProgress,
        observeReconciliationError: inProgress,
      },
      {
        phase: 'loggingFailed',
        open: true,
        revisionReadable: true,
        beginInspectionError: inProgress,
        prepareAttemptError: inProgress,
        observeReconciliationError: inProgress,
      },
    ]);

    expect(coordinator.status.open).toBe(true);
    const nextInspection = coordinator.beginInspection();
    nextInspection.finish();
  });

  it(
    'propagates logger errors from reportStoredFactConflict without containment or advancing deduplication',
    async () => {
    const initial = await searchFactFixture([4, 5]);
    const attempts = initial.attempts.map((attempt) => ({
      ...attempt,
      replacementSearch: {
        lowerBound: attempt.nonce === 4n
          ? factObservation(100n, 4n)
          : factObservation(120n, 5n),
        searchedThrough: null,
        exhausted: null,
      },
    }));

    let snapshot: TransactionJournalSnapshot = { ...initial, attempts };
    let failFirstConflictLog = true;

    const conflictCalls: string[] = [];
    const loggingFailedCalls: unknown[] = [];

    const baseLog = createRelayerLog({
      chainId: FACT_IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: { write() {} },
    });

    const log = interceptLog(baseLog, {
      storedFactNonceConflict() {
        conflictCalls.push('initial');
        if (failFirstConflictLog) {
          failFirstConflictLog = false;
          throw new Error('direct conflict sink failure');
        }
      },
      storedFactNonceConflictRepeated() {
        conflictCalls.push('repeated');
      },
      loggingFailed(fields) {
        loggingFailedCalls.push(fields);
      },
    });

    const coordinator = await SignerCoordinator.create({
      identity: FACT_IDENTITY,
      maxRetainedAttempts: 16,
      store: {
        load: async () => ({ kind: 'present', snapshot }),
        save: async (next) => {
          snapshot = next;
        },
      },
      log,
      createErrorSummary,
    });

    const publicClient = {
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: factAnchor(blockNumber).blockHash,
        parentHash: factAnchor(blockNumber - 1n).blockHash,
        transactions: [],
      })),
      getTransactionCount: vi.fn(
        async ({ blockNumber }: { blockNumber: bigint }) => (
          blockNumber === 100n ? 4 : 6
        ),
      ),
      getTransactionReceipt: vi.fn(
        async ({ hash }: { hash: `0x${string}` }) => {
          throw new TransactionReceiptNotFoundError({ hash });
        },
      ),
    } as unknown as PublicClient;

    // First conflict: logger throws directly (not contained by
    // emit / loggingFailed),
    // storedFactDispute is recorded, and deduplication key is NOT advanced.
    await expect(
      coordinator.recover({
        publicClient,
        anchor: factAnchor(120n),
        maxBlockRange: 50n,
      }, 21),
    ).rejects.toThrow('direct conflict sink failure');

    expect(loggingFailedCalls).toHaveLength(0);
    expect(coordinator.status.storedFactDispute).not.toBeNull();
    expect(coordinator.status.storedFactDispute?.origin).toBe('recovery');
    expect(conflictCalls).toEqual(['initial']);

    // Second identical conflict: still calls storedFactNonceConflict
    // (not Repeated)
    // because the first call threw before updating lastStoredFactConflict.
    const second = await coordinator.recover({
      publicClient,
      anchor: factAnchor(120n),
      maxBlockRange: 50n,
    }, 22);

    expect(second.status).toBe('inconsistent-observations');
    expect(conflictCalls).toEqual(['initial', 'initial']);

    // Third identical conflict: now deduplicated to
    // storedFactNonceConflictRepeated.
    const third = await coordinator.recover({
      publicClient,
      anchor: factAnchor(120n),
      maxBlockRange: 50n,
    }, 23);

    expect(third.status).toBe('inconsistent-observations');
    expect(conflictCalls).toEqual(['initial', 'initial', 'repeated']);
  });

  it(
    'keeps stored blockers and historical revision unchanged during completion-event emission',
    async () => {
    const initial = await fixture();
    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot: initial,
    };
    const rpc = client();

    let coordinator!: SignerCoordinator;
    let initialRevision = '';

    const duringCallback: {
      called: boolean;
      attemptsLength: number;
      hasExhaustedBlocker: boolean;
      revision: string;
      reentrantError: string | null;
    } = {
      called: false,
      attemptsLength: -1,
      hasExhaustedBlocker: false,
      revision: '',
      reentrantError: null,
    };

    const baseLog = createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: { write() {} },
    });

    const log = interceptLog(baseLog, {
      attemptOperatorAttributed(fields) {
        duringCallback.called = true;
        duringCallback.attemptsLength = coordinator.attempts.length;
        duringCallback.hasExhaustedBlocker =
          coordinator.status.blockers.includes('conflict-search-exhausted');
        duringCallback.revision = coordinator.durableRecoveryRevision;

        try {
          coordinator.beginInspection();
        } catch (error) {
          duringCallback.reentrantError =
            error instanceof Error ? error.message : String(error);
        }

        baseLog.attemptOperatorAttributed(fields);
      },
    });

    coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      store: {
        load: async () => visible,
        save: async (next) => {
          visible = { kind: 'present', snapshot: next };
        },
      },
      log,
      createErrorSummary,
    });

    initialRevision = coordinator.durableRecoveryRevision;
    expect(coordinator.status.blockers).toContain('conflict-search-exhausted');

    const result = await coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 20n,
      attribution: request(),
    }, 77);

    expect(result.status).toBe('operator-attribution-committed');
    expect(duringCallback).toEqual({
      called: true,
      attemptsLength: 0,
      hasExhaustedBlocker: true,
      revision: initialRevision,
      reentrantError: 'Signer inspection is already in progress.',
    });

    // After step 5 & 6 finish, exhaustion blocker is reconciled and
    // revision advances.
    expect(coordinator.status.blockers).not.toContain(
      'conflict-search-exhausted',
    );
    expect(coordinator.durableRecoveryRevision).not.toBe(initialRevision);
  });
});
