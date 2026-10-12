import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

vi.mock('../../src/chain/inspect-nonce-sync.js', () => ({
  inspectNonceSync: vi.fn(),
}));

vi.mock('../../src/state/file-transaction-journal-store.js', () => ({
  FileTransactionJournalStore: {
    read: vi.fn(),
    open: vi.fn(),
  },
}));

vi.mock('../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

import {
  inspectNonceSync,
} from '../../src/chain/inspect-nonce-sync.js';

import {
  syncNonce,
} from '../../src/cli/sync-nonce.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  planNonceSync,
} from '../../src/state/plan-nonce-sync.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import {
  validateJournalSnapshotStructure,
} from '../../src/state/transaction-journal-validation.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const AT = '2026-10-12T12:00:00.000Z';

const OWNERSHIP = {
  stateDirectory: '/verified-state',
  dev: 1n,
  ino: 2n,
};

const JOURNAL =
  `/verified-state/transaction-journal-${IDENTITY.chainId}-${IDENTITY.signer}.json`;

function observation(blockNumber: bigint, nonce: bigint) {
  return {
    anchor: {
      blockNumber,
      blockHash: HASH,
    },
    nonce,
  };
}

const OBSERVATION = observation(110n, 8n);

function fixture(): TransactionJournalSnapshot {
  return validateJournalSnapshotStructure({
    version: 1,
    identity: IDENTITY,
    baseline: observation(90n, 2n),
    lastObservation: observation(100n, 8n),
    nextNonce: 4n,
    durableNextNonce: 4n,
    repairs: [{
      kind: 'sync-nonce',
      at: '2026-10-11T12:00:00.000Z',
      previousNextNonce: 2n,
      nextNonce: 4n,
      observation: observation(95n, 4n),
    }],
    attempts: [],
  }, IDENTITY);
}

function present(
  snapshot: TransactionJournalSnapshot,
): TransactionJournalRead {
  return {
    kind: 'present',
    snapshot,
  };
}

function setup(apply = false) {
  const snapshot = fixture();

  const load = vi.fn<TransactionJournalStore['load']>()
    .mockResolvedValue(present(snapshot));

  const save = vi.fn<TransactionJournalStore['save']>()
    .mockResolvedValue(undefined);

  // Only load/save are used after opening. The real file-store behavior
  // is covered by its own filesystem tests.
  const store = {
    load,
    save,
  } as unknown as FileTransactionJournalStore;

  vi.mocked(assertServiceLockHeld).mockReturnValue(OWNERSHIP);

  vi.mocked(FileTransactionJournalStore.read)
    .mockResolvedValue(present(snapshot));

  vi.mocked(FileTransactionJournalStore.open)
    .mockResolvedValue(store);

  vi.mocked(inspectNonceSync).mockResolvedValue({
    status: 'observed',
    observation: OBSERVATION,
    latestNonce: 8n,
    pendingNonce: 8n,
  });

  const options = {
    publicClient: {} as PublicClient,
    identity: { ...IDENTITY },
    finality: { type: 'safe' as const },
    apply,
    env: {
      QUICKNET_STATE_DIR: '/configured-state',
    },
    now: () => new Date(AT),
  };

  return {
    options,
    snapshot,
    load,
    save,
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve,
  };
}

describe('syncNonce', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requires ownership before reading state or inspecting RPC', async () => {
    const t = setup();
    const failure = new ServiceLockNotHeldError('descriptor');

    vi.mocked(assertServiceLockHeld).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(syncNonce(t.options)).rejects.toBe(failure);

    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(inspectNonceSync).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('refuses a missing journal without initializing it', async () => {
    const t = setup(true);

    vi.mocked(FileTransactionJournalStore.read)
      .mockResolvedValueOnce({ kind: 'missing' });

    expect(await syncNonce(t.options)).toEqual({
      status: 'refused',
      reason: 'journal-missing',
    });

    expect(inspectNonceSync).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)(
    'refuses a retained %s attempt before RPC inspection',
    async (phase) => {
      const t = setup(true);

      // The mocked reader stands in for the validated storage boundary.
      // This branch must reject retained work before invoking the planner.
      const snapshot = validateJournalSnapshotStructure({
        ...t.snapshot,
        nextNonce: 5n,
        attempts: [{
          attemptId: '11111111-1111-4111-8111-111111111111',
          nonce: 4n,
          createdAt: '2026-10-12T11:00:00.000Z',
          signedTransactions: [{
            transactionHash: HASH,
            signedTransaction: `0x${'ab'.repeat(64)}`,
          }],
          phase,
          replacementSearch: null,
          inclusion: phase === 'included'
            ? {
                outcome: 'success',
                transactionHash: HASH,
                inclusion: {
                  blockNumber: 101n,
                  blockHash: HASH,
                },
                observedAt: {
                  blockNumber: 105n,
                  blockHash: HASH,
                },
              }
            : null,
        }],
      }, IDENTITY);

      vi.mocked(FileTransactionJournalStore.read)
        .mockResolvedValueOnce(present(snapshot));

      expect(await syncNonce(t.options)).toEqual({
        status: 'refused',
        reason: 'retained-attempts',
      });

      expect(inspectNonceSync).not.toHaveBeenCalled();
      expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('previews a repair using the verified directory without opening a writer', async () => {
    const t = setup();

    const expected = planNonceSync({
      snapshot: t.snapshot,
      identity: IDENTITY,
      observation: OBSERVATION,
      latestNonce: 8n,
      pendingNonce: 8n,
      at: AT,
    });

    expect(await syncNonce(t.options)).toEqual(expected);

    expect(FileTransactionJournalStore.read)
      .toHaveBeenCalledExactlyOnceWith({
        filePath: JOURNAL,
        identity: IDENTITY,
      });

    expect(inspectNonceSync).toHaveBeenCalledExactlyOnceWith({
      publicClient: t.options.publicClient,
      identity: IDENTITY,
      finality: { type: 'safe' },
    });

    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
    expect(t.options.env.QUICKNET_STATE_DIR).toBe('/configured-state');
  });

  it.each([false, true])(
    'does not open a writer when already synchronized; apply: %s',
    async (apply) => {
      const t = setup(apply);

      const snapshot = validateJournalSnapshotStructure({
        ...t.snapshot,
        nextNonce: 8n,
        durableNextNonce: 8n,
      }, IDENTITY);

      vi.mocked(FileTransactionJournalStore.read)
        .mockResolvedValueOnce(present(snapshot));

      expect(await syncNonce(t.options)).toEqual({
        status: 'already-synchronized',
      });

      expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it.each(['latest', 'pending'] as const)(
    'defers a %s nonce mismatch without opening a writer',
    async (tag) => {
      const t = setup(true);

      vi.mocked(inspectNonceSync).mockResolvedValueOnce({
        status: 'observed',
        observation: OBSERVATION,
        latestNonce: tag === 'latest' ? 9n : 8n,
        pendingNonce: tag === 'pending' ? 9n : 8n,
      });

      expect(await syncNonce(t.options)).toEqual({
        status: 'deferred',
        reason: 'nonce-count-mismatch',
      });

      expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('defers an anchor change without opening a writer', async () => {
    const t = setup(true);

    vi.mocked(inspectNonceSync).mockResolvedValueOnce({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 110n,
        blockHash: `0x${'bb'.repeat(32)}`,
      },
    });

    expect(await syncNonce(t.options)).toEqual({
      status: 'deferred',
      reason: 'anchor-changed',
    });

    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('preserves planner refusal without opening a writer', async () => {
    const t = setup(true);

    vi.mocked(inspectNonceSync).mockResolvedValueOnce({
      status: 'observed',
      observation: observation(110n, 6n),
      latestNonce: 6n,
      pendingNonce: 6n,
    });

    expect(await syncNonce(t.options)).toEqual({
      status: 'refused',
      reason: 'nonce-regression',
    });

    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it.each(['before-open', 'before-save'] as const)(
    'refuses a changed snapshot at %s',
    async (stage) => {
      const t = setup(true);

      const changed = validateJournalSnapshotStructure({
        ...t.snapshot,
        lastObservation: observation(101n, 8n),
      }, IDENTITY);

      if (stage === 'before-open') {
        vi.mocked(FileTransactionJournalStore.read)
          .mockResolvedValueOnce(present(t.snapshot))
          .mockResolvedValueOnce(present(changed));
      } else {
        t.load.mockResolvedValueOnce(present(changed));
      }

      expect(await syncNonce(t.options)).toEqual({
        status: 'refused',
        reason: 'journal-changed',
      });

      expect(FileTransactionJournalStore.open)
        .toHaveBeenCalledTimes(stage === 'before-open' ? 0 : 1);

      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('detects a change confined to retained repair history', async () => {
    const t = setup(true);

    const changed = validateJournalSnapshotStructure({
      ...t.snapshot,
      repairs: t.snapshot.repairs.map((repair) => ({
        ...repair,
        at: '2026-10-11T13:00:00.000Z',
      })),
    }, IDENTITY);

    t.load.mockResolvedValueOnce(present(changed));

    expect(await syncNonce(t.options)).toEqual({
      status: 'refused',
      reason: 'journal-changed',
    });

    expect(t.save).not.toHaveBeenCalled();
  });

  it('saves the planned repair after revalidating the snapshot', async () => {
    const t = setup(true);

    const plan = planNonceSync({
      snapshot: t.snapshot,
      identity: IDENTITY,
      observation: OBSERVATION,
      latestNonce: 8n,
      pendingNonce: 8n,
      at: AT,
    });

    if (plan.status !== 'repair-available') {
      throw new Error('Expected a repair plan.');
    }

    const events: string[] = [];

    vi.mocked(FileTransactionJournalStore.read)
      .mockImplementation(async () => {
        events.push('read');
        return present(t.snapshot);
      });

    vi.mocked(FileTransactionJournalStore.open)
      .mockImplementationOnce(async () => {
        events.push('open');

        return {
          load: t.load,
          save: t.save,
        } as unknown as FileTransactionJournalStore;
      });

    t.load.mockImplementationOnce(async () => {
      events.push('load');
      return present(t.snapshot);
    });

    t.save.mockImplementationOnce(async () => {
      events.push('save');
    });

    expect(await syncNonce(t.options)).toEqual({
      status: 'applied',
      repair: plan.repair,
    });

    expect(events).toEqual([
      'read',
      'read',
      'open',
      'load',
      'save',
    ]);

    expect(t.save).toHaveBeenCalledExactlyOnceWith(plan.snapshot);

    expect(plan.snapshot.baseline).toEqual(t.snapshot.baseline);
    expect(plan.snapshot.nextNonce).toBe(8n);
    expect(plan.snapshot.durableNextNonce).toBe(8n);
    expect(plan.snapshot.repairs).toHaveLength(2);
  });

  it('refuses changed ownership immediately before saving', async () => {
    const t = setup(true);

    t.load.mockImplementationOnce(async () => {
      vi.mocked(assertServiceLockHeld).mockReturnValue({
        ...OWNERSHIP,
        ino: OWNERSHIP.ino + 1n,
      });

      return present(t.snapshot);
    });

    await expect(syncNonce(t.options))
      .rejects.toBeInstanceOf(ServiceLockNotHeldError);

    expect(t.save).not.toHaveBeenCalled();
  });

  it('honors cancellation before starting work', async () => {
    const t = setup(true);
    const controller = new AbortController();
    const reason = new Error('Stop');

    controller.abort(reason);

    await expect(syncNonce({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(inspectNonceSync).not.toHaveBeenCalled();
  });

  it('does not save when cancellation arrives during final revalidation', async () => {
    const t = setup(true);
    const controller = new AbortController();
    const reason = new Error('Stop');

    t.load.mockImplementationOnce(async () => {
      controller.abort(reason);
      return present(t.snapshot);
    });

    await expect(syncNonce({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(inspectNonceSync).toHaveBeenCalledWith({
      publicClient: t.options.publicClient,
      identity: IDENTITY,
      finality: { type: 'safe' },
      signal: controller.signal,
    });

    expect(t.save).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'preserves save %s when cancellation arrives during persistence',
    async (outcome) => {
      const t = setup(true);
      const controller = new AbortController();
      const reason = new Error('Stop');
      const failure = new Error('Journal persistence failed');
      const entered = deferred();
      const finish = deferred();

      t.save.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;

        if (outcome === 'failure') {
          throw failure;
        }
      });

      let settled = false;

      // Attach both handlers immediately so a rejected operation is
      // always observed, including if setup unexpectedly fails.
      const pending = syncNonce({
        ...t.options,
        signal: controller.signal,
      }).then(
        (value) => {
          settled = true;
          return { kind: 'returned' as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { kind: 'threw' as const, error };
        },
      );

      try {
        await Promise.race([entered.promise, pending]);

        expect(t.save).toHaveBeenCalledOnce();
        expect(settled).toBe(false);

        controller.abort(reason);

        expect(settled).toBe(false);
      } finally {
        finish.resolve();
        await pending;
      }

      const result = await pending;

      if (outcome === 'success') {
        expect(result).toMatchObject({
          kind: 'returned',
          value: {
            status: 'applied',
            repair: {
              kind: 'sync-nonce',
              previousNextNonce: 4n,
              nextNonce: 8n,
              observation: OBSERVATION,
            },
          },
        });
      } else {
        expect(result.kind).toBe('threw');

        if (result.kind !== 'threw') {
          throw new Error('Expected persistence failure.');
        }

        expect(result.error).toBe(failure);
      }
    },
  );
});