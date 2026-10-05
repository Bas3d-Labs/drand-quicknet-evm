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

async function setup(empty = false) {
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
    nextNonce: 4n,
    attempt: empty ? null : {
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      transactionHash: hash,
      signedTransaction: bytes,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      replacementSearch: null,
    },
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
  it('saves the nonce and resolution together before releasing the signer', async () => {
    const t = await setup();

    expect(
      await t.coordinator.recover(t.options, 7),
    ).toMatchObject({
      status: 'resolution-available',
    });

    expect(t.save).toHaveBeenCalledTimes(1);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempt: null,
      nextNonce: 5n,
      lastObservation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
    });

    expect(t.events()).toEqual([
      'attempt_resolved',
      'signer_gate_released',
    ]);

    expect(
      t.lines.map((line) => JSON.parse(line).cycle),
    ).toEqual([7, 7]);
  });

  it('excludes other coordinator operations during RPC inspection', async () => {
    const t = await setup(true);

    t.coordinator.completeRecovery();

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

      expect(() => t.coordinator.completeRecovery())
        .toThrow('already in progress');

      expect(() =>
        t.coordinator.block('unattributed-signer-activity'),
      ).toThrow('already in progress');

      await expect(
        t.coordinator.recover(t.options),
      ).rejects.toThrow('already in progress');

      await expect(
        t.coordinator.retryPersistence(),
      ).rejects.toThrow('already in progress');

      await expect(
        t.coordinator.recordObservation(t.snapshot.lastObservation),
      ).rejects.toThrow('already in progress');
    } finally {
      finish.resolve();
      await pending;
    }

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
      'signer_gate_released',
    ]);
  });

  it('persists excess activity with a receipt clear and retains it across restart', async () => {
    const t = await setup();

    t.getTransactionCount.mockResolvedValue(8);

    await t.coordinator.recover(t.options);

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempt: null,
      nextNonce: 5n,
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
      nextNonce: 4n,
      lastObservation: {
        anchor: anchorAt(105n),
        nonce: 5n,
      },
      attempt: {
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: anchorAt(102n),
        },
      },
    });

    const restarted = await t.create();

    await restarted.recover(t.options);

    expect(
      t.save.mock.calls[1]![0]
        .attempt?.replacementSearch?.searchedThrough,
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
        .attempt?.replacementSearch?.searchedThrough,
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
      attempt: null,
      nextNonce: 5n,
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

      t.coordinator.completeRecovery();

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

  it('opens a clean existing journal only after saving its observation', async () => {
    const t = await setup(true);

    t.getTransactionCount.mockResolvedValue(4);

    expect(
      await t.coordinator.recover(t.options),
    ).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.events()).toEqual([]);
    expect(t.save).toHaveBeenCalledTimes(1);
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
      attempt: null,
      nextNonce: 5n,
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
      nextNonce: 4n,
      attempt: {
        transactionHash: t.hash,
      },
    });

    expect(t.coordinator.status.open).toBe(false);
    expect(t.events()).not.toContain('attempt_resolved');
  });

  it('keeps a previously open signer closed after an RPC failure', async () => {
    const t = await setup(true);

    t.coordinator.completeRecovery();

    t.getTransactionCount.mockRejectedValueOnce(
      new Error('Unavailable'),
    );

    await expect(
      t.coordinator.recover(t.options),
    ).rejects.toThrow('Unavailable');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    expect(t.save).not.toHaveBeenCalled();

    t.getTransactionCount.mockResolvedValue(4);

    await t.coordinator.recover(t.options);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('refuses to initialize a missing journal', async () => {
    const t = await setup();

    t.setVisible({
      kind: 'missing',
    });

    const coordinator = await t.create();

    await expect(
      coordinator.recover(t.options),
    ).rejects.toThrow('initialized journal');

    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });
});