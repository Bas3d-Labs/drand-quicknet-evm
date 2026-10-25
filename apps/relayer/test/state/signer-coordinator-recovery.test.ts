import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const OTHER = `0x${'bb'.repeat(32)}` as const;

const hashAt = (number: bigint) =>
  `0x${number.toString(16).padStart(64, '0')}` as Hash;

const anchorAt = (number: bigint) => ({
  blockNumber: number,
  blockHash: hashAt(number),
});

async function setup(
  empty = false,
  maxRetainedAttempts = 3,
) {
  const bytes = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: 4663,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const hash = keccak256(bytes);

  const observation = {
    anchor: anchorAt(100n),
    nonce: 4n,
  };

  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: IDENTITY,
    baseline: observation,
    lastObservation: observation,
    nextNonce: empty ? 4n : 5n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: empty ? [] : [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      workId: 'test-work:4',
      nonce: 4n,
      signedTransactions: [{
        transactionHash: hash,
        signedTransaction: bytes,
      }],
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: null,
    }],
  };

  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot,
  };

  const save = vi.fn<TransactionJournalStore['save']>(
    async (next) => {
      visible = {
        kind: 'present',
        snapshot: next,
      };
    },
  );

  const load = vi.fn(async () => visible);
  const lines: string[] = [];

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    maxRetainedAttempts,
    store: {
      load,
      save,
    },
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    }),
    createErrorSummary: () => ({
      scrubText: () => ({
        text: 'redacted',
        removed: true,
      }),
    }),
  });

  const coordinator = await create();

  lines.length = 0;

  const transactions = new Map<bigint, unknown[]>();

  const getBlock = vi.fn(async (request: {
    blockNumber: bigint;
    includeTransactions?: boolean;
  }) => ({
    number: request.blockNumber,
    hash: hashAt(request.blockNumber),
    parentHash: hashAt(request.blockNumber - 1n),
    transactions: transactions.get(request.blockNumber) ?? [],
  }));

  const getTransactionCount = vi.fn(async () => 5);

  const getTransactionReceipt = vi.fn(async () => ({
    transactionHash: hash,
    blockNumber: 102n,
    blockHash: hashAt(102n),
    status: 'success' as const,
  }));

  const options = {
    publicClient: {
      getBlock,
      getTransactionCount,
      getTransactionReceipt,
    } as unknown as PublicClient,
    anchor: anchorAt(105n),
    maxBlockRange: 2n,
  };

  const missing = () => getTransactionReceipt.mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash }),
  );

  return {
    coordinator,
    options,
    create,
    save,
    load,
    lines,
    snapshot,
    hash,
    transactions,
    getBlock,
    getTransactionCount,
    getTransactionReceipt,
    missing,
    setVisible: (next: TransactionJournalRead) => {
      visible = next;
    },
    events: () => lines.map((line) => JSON.parse(line).event),
    checkInclusions: (cycle?: number) => coordinator.checkInclusions({
      publicClient: options.publicClient,
      head: options.anchor,
    }, cycle),
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

describe('coordinator recovery', () => {
  it('saves resolution before a fresh inclusion pass releases the signer', async () => {
    const t = await setup();

    expect(
      await t.coordinator.recover(t.options, 7),
    ).toMatchObject({
      status: 'resolution-available',
    });

    expect(t.save).toHaveBeenCalledTimes(1);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(JSON.parse(t.lines[1]!)).toMatchObject({
      reason: 'recovery-incomplete',
      cycle: 7,
    });

    await t.checkInclusions(8);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(
      t.lines.map((line) => JSON.parse(line).cycle),
    ).toEqual([7, 7, 8]);
  });

  it('excludes other coordinator operations during RPC inspection', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await expect(t.coordinator.recover(t.options))
      .resolves.toEqual({
        status: 'no-attempt',
        observation: {
          anchor: t.options.anchor,
          nonce: 4n,
        },
      });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    const entered = deferred();
    const finish = deferred();

    t.getTransactionCount.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return 4;
    });

    const pending = t.coordinator.recover(t.options);

    try {
      await Promise.race([entered.promise, pending]);

      expect(t.coordinator.status.open).toBe(false);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('already in progress');

      await expect(
        t.coordinator.retryPersistence(),
      ).rejects.toThrow('already in progress');

      await expect(
        t.checkInclusions(),
      ).rejects.toThrow('already in progress');

      expect(t.save).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await pending;
    }

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);
  });

  it('holds the gate and resolution event until persistence finishes', async () => {
    const t = await setup();
    const entered = deferred();
    const finish = deferred();

    t.save.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
    });

    const pending = t.coordinator.recover(t.options);

    try {
      await Promise.race([entered.promise, pending]);

      expect(t.coordinator.status.open).toBe(false);
      expect(t.events()).toEqual([]);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('already in progress');
    } finally {
      finish.resolve();
      await pending;
    }

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await t.checkInclusions();

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('persists excess activity with a receipt clear and retains it across restart', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(8);

    await t.coordinator.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: {
        nonce: 8n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.events()).not.toContain('signer_gate_released');

    const restarted = await t.create();

    expect(restarted.status.primaryReason)
      .toBe('unattributed-signer-activity');

    t.getTransactionCount.mockResolvedValue(5);

    await restarted.recover(t.options);

    expect(t.save).toHaveBeenCalledTimes(1);
    expect(restarted.status.open).toBe(false);
  });

  it('retains the exact failed clear and requires fresh inspection after retry', async () => {
    const t = await setup();

    t.save.mockImplementationOnce(async (snapshot) => {
      t.setVisible({
        kind: 'present',
        snapshot,
      });

      throw new Error('Durability uncertain');
    });

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('Journal persistence');

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('must be retried');

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);

    t.save.mockRejectedValueOnce(new Error('Retry failed'));

    await expect(
      t.coordinator.retryPersistence(),
    ).rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[2]![0])
      .toBe(t.save.mock.calls[0]![0]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    expect(
      t.events().filter((event) => event === 'attempt_resolved'),
    ).toHaveLength(1);

    expect(t.events()).not.toContain('signer_gate_released');

    await t.coordinator.recover(t.options);

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(t.getTransactionCount).toHaveBeenCalledTimes(2);
    expect(t.coordinator.status.open).toBe(false);

    await t.checkInclusions();

    expect(t.getTransactionCount).toHaveBeenCalledTimes(3);
    expect(t.coordinator.status.open).toBe(true);

    expect(
      t.events().filter((event) => event === 'signer_gate_released'),
    ).toHaveLength(1);

    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it('saves the observation, lower bound, and search cursor in one write', async () => {
    const t = await setup();

    t.missing();

    await t.coordinator.recover(t.options);

    expect(t.save).toHaveBeenCalledTimes(1);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
      attempts: [{
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: anchorAt(102n),
        },
      }],
    });

    const restarted = await t.create();

    await restarted.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
      attempts: [{
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: anchorAt(102n),
        },
      }],
    });

    expect(t.save).toHaveBeenCalledTimes(2);

    expect(
      t.save.mock.calls[1]![0]
        .attempts[0]?.replacementSearch?.searchedThrough,
    ).toEqual(anchorAt(104n));

    expect(restarted.status.open).toBe(false);
  });

  it('retries failed search progress without resolving the attempt', async () => {
    const t = await setup();

    t.missing();
    t.save.mockRejectedValueOnce(new Error('Failed'));

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0])
      .toBe(t.save.mock.calls[0]![0]);

    expect(t.events()).not.toContain('attempt_resolved');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    await t.coordinator.recover(t.options);

    expect(
      t.save.mock.calls[2]![0]
        .attempts[0]?.replacementSearch?.searchedThrough,
    ).toEqual(anchorAt(104n));
  });

  it('retains exhausted search blocking across restart', async () => {
    const t = await setup();

    t.missing();

    await t.coordinator.recover({
      ...t.options,
      maxBlockRange: 10n,
    });

    expect(t.coordinator.status.primaryReason)
      .toBe('conflict-search-exhausted');

    const restarted = await t.create();

    await restarted.recover(t.options);

    expect(restarted.status.primaryReason)
      .toBe('conflict-search-exhausted');

    expect(t.events()).not.toContain('signer_gate_released');
  });

  it('resolves a replacement without treating it as application completion', async () => {
    const t = await setup();

    t.missing();

    t.transactions.set(101n, [{
      hash: OTHER,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    expect(
      await t.coordinator.recover(t.options),
    ).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: 'replaced',
      },
    });

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
    });
  });

  it.each([
    'anchor',
    'regression',
    'inconsistent',
    'rpc',
  ] as const)(
    'keeps recovery incomplete and avoids writes on %s failure',
    async (kind) => {
      const t = await setup();

      // Establish completed recovery without resolving the retained attempt.
      // These overrides apply only to this setup pass.
      t.getTransactionReceipt.mockRejectedValueOnce(
        new TransactionReceiptNotFoundError({ hash: t.hash }),
      );
      t.getTransactionCount.mockResolvedValueOnce(4);

      await expect(t.coordinator.recover({
        ...t.options,
        anchor: t.snapshot.lastObservation.anchor,
      })).resolves.toMatchObject({
        status: 'unresolved',
        observation: t.snapshot.lastObservation,
        receipt: {
          status: 'receipt-not-found',
        },
        search: null,
      });

      expect(t.coordinator.status).toMatchObject({
        recoveryComplete: true,
        inclusionChecksComplete: false,
      });
      expect(t.coordinator.canBroadcast).toBe(true);

      expect(t.coordinator.attempts).toHaveLength(1);
      expect(t.coordinator.attempts[0]).toMatchObject({
        nonce: 4n,
        phase: 'broadcast-may-have-occurred',
      });

      expect(t.save).toHaveBeenCalledOnce();

      // Measure only the failing recovery below.
      t.save.mockClear();
      t.getBlock.mockClear();
      t.getTransactionReceipt.mockClear();
      t.getTransactionCount.mockClear();
      t.lines.length = 0;

      const error = new Error('RPC failed');

      if (kind === 'anchor') {
        t.getBlock.mockResolvedValueOnce({
          number: 105n,
          hash: OTHER,
          parentHash: hashAt(104n),
          transactions: [],
        });
      }

      if (kind === 'regression') {
        t.getTransactionCount.mockResolvedValue(3);
      }

      if (kind === 'inconsistent') {
        t.getTransactionCount.mockResolvedValue(4);
      }

      if (kind === 'rpc') {
        t.getTransactionCount.mockRejectedValue(error);

        await expect(
          t.coordinator.recover(t.options),
        ).rejects.toBe(error);
      } else {
        await t.coordinator.recover(t.options);
      }

      expect(t.save).not.toHaveBeenCalled();

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
      });

      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.attempts).toHaveLength(1);

      expect(t.events()).not.toContain('attempt_resolved');
    },
  );

  it('does not persist a changed search boundary or reopen recovery', async () => {
    const t = await setup();

    t.missing();

    await t.coordinator.recover(t.options);

    t.save.mockClear();

    const read = t.getBlock.getMockImplementation()!;

    t.getBlock.mockImplementation(async (request) => {
      const block = await read(request);

      if (request.blockNumber === 102n) {
        return {
          ...block,
          hash: OTHER,
        };
      }

      return block;
    });

    expect(
      await t.coordinator.recover(t.options),
    ).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'boundary-changed',
      },
    });

    expect(t.save).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });
  });

  it('opens a clean existing journal only after recovery and inclusion checking', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    expect(
      await t.coordinator.recover(t.options),
    ).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.events()).toEqual([]);
    expect(t.save).toHaveBeenCalledTimes(1);

    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);
    expect(t.events()).toEqual(['signer_gate_released']);
    expect(t.save).toHaveBeenCalledTimes(2);
  });

  it('persists unexpected activity on a journal without an attempt', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(8);

    await t.coordinator.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 4n,
      lastObservation: {
        nonce: 8n,
      },
    });

    expect(t.coordinator.status.primaryReason)
      .toBe('unattributed-signer-activity');

    expect((await t.create()).status.primaryReason)
      .toBe('unattributed-signer-activity');
  });

  it('preserves higher recorded activity when resolving with a lower observation', async () => {
    const t = await setup();

    t.setVisible({
      kind: 'present',
      snapshot: {
        ...t.snapshot,
        lastObservation: {
          anchor: anchorAt(104n),
          nonce: 8n,
        },
      },
    });

    const coordinator = await t.create();

    await coordinator.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: {
        anchor: anchorAt(104n),
        nonce: 8n,
      },
    });

    expect(coordinator.status.open).toBe(false);
    expect(t.events()).not.toContain('signer_gate_released');
  });

  it('retains an attempt found in a block without a receipt', async () => {
    const t = await setup();

    t.missing();

    t.transactions.set(101n, [{
      hash: t.hash,
      from: ACCOUNT.address,
      nonce: 4,
    }]);

    await t.coordinator.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        signedTransactions: [{
          transactionHash: t.hash,
        }],
      }],
    });

    expect(t.coordinator.status.open).toBe(false);
    expect(t.events()).not.toContain('attempt_resolved');
  });

  it('keeps a previously open signer closed after an RPC failure', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await expect(t.coordinator.recover(t.options))
      .resolves.toEqual({
        status: 'no-attempt',
        observation: {
          anchor: t.options.anchor,
          nonce: 4n,
        },
      });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    t.getTransactionCount.mockRejectedValueOnce(
      new Error('Unavailable'),
    );

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('Unavailable');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.save).not.toHaveBeenCalled();

    await t.coordinator.recover(t.options);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);
  });

  it('initializes a missing journal without inspecting an attempt', async () => {
    const t = await setup();

    t.setVisible({
      kind: 'missing',
    });

    const coordinator = await t.create();

    expect(await coordinator.recover(t.options)).toEqual({
      status: 'no-attempt',
      observation: {
        anchor: t.options.anchor,
        nonce: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      identity: IDENTITY,
      baseline: {
        anchor: t.options.anchor,
        nonce: 5n,
      },
      lastObservation: {
        anchor: t.options.anchor,
        nonce: 5n,
      },
      nextNonce: 5n,
      durableNextNonce: 5n,
      repairs: [],
      attempts: [],
    });

    expect(t.getTransactionReceipt).not.toHaveBeenCalled();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(coordinator.canBroadcast).toBe(false);
  });

  it('suppresses transient gate notifications across complete reconciliation', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await t.coordinator.recover(t.options);
    await t.checkInclusions();

    expect(t.coordinator.status.open).toBe(true);

    t.lines.length = 0;

    for (const cycle of [10, 11]) {
      await t.coordinator.observeReconciliation(async () => {
        await t.coordinator.recover(t.options, cycle);

        expect(t.coordinator.status).toMatchObject({
          open: false,
          recoveryComplete: true,
          inclusionChecksComplete: false,
        });

        expect(t.events()).toEqual([]);

        await t.checkInclusions(cycle);
      }, cycle);

      expect(t.coordinator.status.open).toBe(true);
      expect(t.events()).toEqual([]);
    }
  });

  it('publishes a failed reconciliation once and permits a later reconciliation', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await t.coordinator.recover(t.options);
    await t.checkInclusions();

    t.lines.length = 0;

    const failure = new Error('Nonce lookup failed');

    t.getTransactionCount.mockRejectedValueOnce(failure);

    await expect(
      t.coordinator.observeReconciliation(async () => {
        await t.coordinator.recover(t.options, 12);
        await t.checkInclusions(12);
      }, 12),
    ).rejects.toBe(failure);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.events()).toEqual(['signer_blocked']);

    const blocked = JSON.parse(t.lines[0]!);

    expect(blocked).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      cycle: 12,
      reason: 'recovery-incomplete',
      blockers: ['recovery-incomplete'],
      blockedSince: expect.any(String),
    });

    await t.coordinator.observeReconciliation(async () => {
      await t.coordinator.recover(t.options, 13);
      await t.checkInclusions(13);
    }, 13);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.events()).toEqual([
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(JSON.parse(t.lines[1]!)).toMatchObject({
      event: 'signer_gate_released',
      operation: { name: 'reconcile-attempt' },
      cycle: 13,
      blockedSince: blocked.blockedSince,
      cleared: ['recovery-incomplete'],
    });
  });

  it('publishes persistence failure at reconciliation completion without reporting resolution', async () => {
    const t = await setup();

    t.save.mockRejectedValueOnce(new Error('Disk unavailable'));

    await expect(
      t.coordinator.observeReconciliation(async () => {
        await t.coordinator.recover(t.options, 14);
        await t.checkInclusions(14);
      }, 14),
    ).rejects.toThrow('Journal persistence');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      persistenceState: 'failed',
    });

    expect(t.coordinator.attempts).toHaveLength(1);
    expect(t.events()).toEqual(['signer_blocked']);

    expect(JSON.parse(t.lines[0]!)).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      cycle: 14,
      reason: 'persistence-failure',
      blockers: t.coordinator.status.blockers,
    });
  });

  it('emits committed resolution inside the scope and releases the gate only at its end', async () => {
    const t = await setup();

    await t.coordinator.observeReconciliation(async () => {
      await t.coordinator.recover(t.options, 15);

      expect(t.save).toHaveBeenCalledOnce();
      expect(t.coordinator.attempts).toEqual([]);
      expect(t.coordinator.status.open).toBe(false);

      expect(t.events()).toEqual(['attempt_resolved']);

      expect(JSON.parse(t.lines[0]!)).toMatchObject({
        event: 'attempt_resolved',
        operation: { name: 'reconcile-attempt' },
        cycle: 15,
      });

      await t.checkInclusions(15);

      expect(t.coordinator.status.open).toBe(true);
      expect(t.events()).toEqual(['attempt_resolved']);
    }, 15);

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_gate_released',
    ]);

    expect(JSON.parse(t.lines[1]!)).toMatchObject({
      event: 'signer_gate_released',
      operation: { name: 'reconcile-attempt' },
      cycle: 15,
      blockedSince: t.snapshot.attempts[0]!.createdAt,
    });
  });

  it('keeps live status closed and rejects overlapping work during scoped RPC inspection', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await t.coordinator.recover(t.options);
    await t.checkInclusions();

    t.lines.length = 0;

    const entered = deferred();
    const finish = deferred();

    t.getTransactionCount.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return 4;
    });

    const pending = t.coordinator.recover(t.options, 16);
    const action = vi.fn(async () => {});

    try {
      await Promise.race([entered.promise, pending]);

      expect(t.coordinator.status.open).toBe(false);

      await expect(
        t.coordinator.observeReconciliation(action, 16),
      ).rejects.toThrow('already in progress');

      expect(action).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await pending;
    }

    await t.checkInclusions();

    t.lines.length = 0;

    const enteredScoped = deferred();
    const finishScoped = deferred();

    t.getTransactionCount.mockImplementationOnce(async () => {
      enteredScoped.resolve();
      await finishScoped.promise;
      return 4;
    });

    const scoped = t.coordinator.observeReconciliation(async () => {
      await t.coordinator.recover(t.options, 17);
      await t.checkInclusions(17);
    }, 17);

    try {
      await Promise.race([enteredScoped.promise, scoped]);

      expect(t.coordinator.status.open).toBe(false);
      expect(t.events()).toEqual([]);

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('already in progress');

      await expect(
        t.checkInclusions(),
      ).rejects.toThrow('already in progress');
    } finally {
      finishScoped.resolve();
      await scoped;
    }

    expect(t.coordinator.status.open).toBe(true);
    expect(t.events()).toEqual([]);
  });

  it('rejects nested observation without ending the outer scope', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    await t.coordinator.recover(t.options);
    await t.checkInclusions();

    t.lines.length = 0;

    const nestedAction = vi.fn(async () => {});

    await t.coordinator.observeReconciliation(async () => {
      await expect(
        t.coordinator.observeReconciliation(nestedAction),
      ).rejects.toThrow(
        'Signer reconciliation observation is already active.',
      );

      expect(nestedAction).not.toHaveBeenCalled();

      await t.coordinator.recover(t.options);

      expect(t.coordinator.status.open).toBe(false);
      expect(t.events()).toEqual([]);

      await t.checkInclusions();
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.events()).toEqual([]);

    await expect(
      t.coordinator.observeReconciliation(async () => 'completed'),
    ).resolves.toBe('completed');
  });

  it('reports blocker-set expansion and contraction while preserving the blocked episode', async () => {
    const t = await setup(false, 1);
    const blockedSince = t.snapshot.attempts[0]!.createdAt;

    expect(t.coordinator.status.blockers).toEqual([
      'unresolved-attempt',
      'retention-capacity-reached',
      'recovery-incomplete',
    ]);

    // The receipt is above the durable anchor, so recovery retains it.
    t.getTransactionCount.mockResolvedValueOnce(4);

    await t.coordinator.observeReconciliation(async () => {
      await t.coordinator.recover({
        ...t.options,
        anchor: anchorAt(100n),
      }, 20);

      await t.checkInclusions(20);
    }, 20);

    expect(t.coordinator.status.blockers).toEqual([
      'retention-capacity-reached',
    ]);

    expect(t.events()).toEqual(['signer_blocked']);

    expect(JSON.parse(t.lines[0]!)).toMatchObject({
      cycle: 20,
      reason: 'retention-capacity-reached',
      blockers: ['retention-capacity-reached'],
      blockedSince,
    });

    t.lines.length = 0;

    const failure = new Error('Receipt lookup failed');

    t.getTransactionReceipt.mockRejectedValueOnce(failure);

    await expect(
      t.coordinator.observeReconciliation(
        () => t.checkInclusions(21),
        21,
      ),
    ).rejects.toBe(failure);

    expect(t.coordinator.status.primaryReason)
      .toBe('retention-capacity-reached');

    expect(t.coordinator.status.blockers).toEqual([
      'retention-capacity-reached',
      'recovery-incomplete',
    ]);

    expect(t.events()).toEqual(['signer_blocked']);

    // An identical failed pass must not repeat the notification.
    t.getTransactionReceipt.mockRejectedValueOnce(failure);

    await expect(
      t.coordinator.observeReconciliation(
        () => t.checkInclusions(22),
        22,
      ),
    ).rejects.toBe(failure);

    expect(t.events()).toEqual(['signer_blocked']);

    await t.coordinator.observeReconciliation(
      () => t.checkInclusions(23),
      23,
    );

    expect(t.coordinator.status.blockers).toEqual([
      'retention-capacity-reached',
    ]);

    // An identical successful pass must also stay silent.
    await t.coordinator.observeReconciliation(
      () => t.checkInclusions(24),
      24,
    );

    const records = t.lines.map((line) => JSON.parse(line));

    expect(records.map((record) => record.event)).toEqual([
      'signer_blocked',
      'signer_blocked',
    ]);

    expect(records.map((record) => record.reason)).toEqual([
      'retention-capacity-reached',
      'retention-capacity-reached',
    ]);

    expect(records.map((record) => record.blockers)).toEqual([
      ['retention-capacity-reached', 'recovery-incomplete'],
      ['retention-capacity-reached'],
    ]);

    expect(records.map((record) => record.cycle)).toEqual([21, 23]);

    expect(
      records.every((record) => record.blockedSince === blockedSince),
    ).toBe(true);

    expect(t.coordinator.status.open).toBe(false);
    expect(t.events()).not.toContain('signer_gate_released');
  });
});