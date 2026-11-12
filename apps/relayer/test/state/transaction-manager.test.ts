import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  isOperationCancelled,
} from '../../src/execution/is-operation-cancelled.js';

import type {
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import {
  TransactionManager,
  submissionRecording,
  type TransactionManagerOptions,
} from '../../src/state/transaction-manager.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

const DURABLE = {
  blockNumber: 100n,
  blockHash: HASH,
};

const HEAD = {
  blockNumber: 110n,
  blockHash: HASH,
};

function submissionOptions() {
  return {
    work: {
      workId: 'test-work:manager',
      call: {
        to: ACCOUNT.address,
        data: '0x1234' as const,
        value: 0n,
        gas: 100_000n,
      },
    },
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

async function rejectedValue(
  operation: Promise<unknown>,
): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to reject.');
}

async function managerFixture(options: {
  maxRetainedAttempts?: number;
  durableRecovery?: TransactionManagerOptions['durableRecovery'];
  onRecoveryCompleted?: TransactionManagerOptions['onRecoveryCompleted'];
} = {}) {
  const observation = {
    anchor: DURABLE,
    nonce: 4n,
  };

  let visibleSnapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: IDENTITY,
    baseline: observation,
    lastObservation: observation,
    nextNonce: 4n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [],
  };

  const load = vi.fn<TransactionJournalStore['load']>()
    .mockImplementation(async () => ({
      kind: 'present',
      snapshot: visibleSnapshot,
    }));

  const save = vi.fn<TransactionJournalStore['save']>()
    .mockImplementation(async (snapshot) => {
      visibleSnapshot = snapshot;
    });

  const getBlock = vi.fn(async (
    { blockNumber }: { blockNumber: bigint },
  ) => ({
    number: blockNumber,
    hash: HASH,
  }));

  const getTransactionCount =
    vi.fn<PublicClient['getTransactionCount']>()
      .mockResolvedValue(4);

  const getTransactionReceipt =
    vi.fn<PublicClient['getTransactionReceipt']>();

  const request = vi.fn(async (
    args: { method: string; params: readonly Hex[] },
  ) => {
    expect(args.method).toBe('eth_sendRawTransaction');

    return keccak256(args.params[0]!);
  });

  const prepareTransactionRequest = vi.fn(async () => ({
    type: 'eip1559' as const,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }));

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const readChainHeads = vi.fn(async () => ({
    durableBlock: DURABLE.blockNumber,
    latestBlock: HEAD.blockNumber,
  }));

  const manager = await TransactionManager.create({
    identity: IDENTITY,
    store: { load, save },
    maxRetainedAttempts: options.maxRetainedAttempts ?? 3,
    ...(options.durableRecovery === undefined
      ? {}
      : { durableRecovery: options.durableRecovery }),
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      destination: {
        write() {},
      },
    }),
    createErrorSummary: () => ({
      scrubText: () => ({
        text: '[redacted]',
        removed: true,
      }),
    }),
    publicClient: {
      getBlock,
      getTransactionCount,
      getTransactionReceipt,
      request,
    } as unknown as PublicClient,
    walletClient: {
      prepareTransactionRequest,
    } as unknown as WalletClient,
    account: {
      ...ACCOUNT,
      signTransaction,
    },
    readChainHeads,
    maxBlockRange: 2n,
    ...(options.onRecoveryCompleted === undefined
      ? {}
      : { onRecoveryCompleted: options.onRecoveryCompleted }),
    retry: {
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      now: () => 0,
    },
  });

  return {
    manager,
    load,
    save,
    getBlock,
    getTransactionCount,
    getTransactionReceipt,
    request,
    prepareTransactionRequest,
    signTransaction,
    readChainHeads,
    visible: () => visibleSnapshot,
  };
}

describe('transaction manager submission', () => {
  it('rejects reconciliation while signing holds submission ownership', async () => {
    const t = await managerFixture();
    const entered = deferred();
    const release = deferred();

    t.signTransaction.mockImplementationOnce((transaction) => {
      entered.resolve();

      return release.promise.then(
        () => ACCOUNT.signTransaction(transaction),
      );
    });

    const pending = t.manager.submit(submissionOptions());

    try {
      await entered.promise;

      expect(t.manager.status).toMatchObject({
        busy: true,
        open: false,
        attempts: [],
      });

      const before = {
        blocks: t.getBlock.mock.calls.length,
        nonces: t.getTransactionCount.mock.calls.length,
        writes: t.save.mock.calls.length,
        heads: t.readChainHeads.mock.calls.length,
      };

      const error = await rejectedValue(t.manager.reconcile({
        head: HEAD,
        durable: DURABLE,
      }));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message)
        .toBe('Transaction manager operation is already in progress.');

      expect(submissionRecording(error)).toBeUndefined();

      expect(t.getBlock).toHaveBeenCalledTimes(before.blocks);
      expect(t.getTransactionCount).toHaveBeenCalledTimes(before.nonces);
      expect(t.save).toHaveBeenCalledTimes(before.writes);
      expect(t.readChainHeads).toHaveBeenCalledTimes(before.heads);

      expect(t.request).not.toHaveBeenCalled();
      expect(t.visible().attempts).toEqual([]);
    } finally {
      release.resolve();
      await pending;
    }

    expect(await pending).toMatchObject({
      status: 'submitted',
      broadcast: {
        status: 'acknowledged',
        workId: submissionOptions().work.workId,
        nonce: 4n,
      },
    });

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledTimes(1);

    expect(t.visible().attempts[0]).toMatchObject({
      phase: 'broadcast-may-have-occurred',
      nonce: 4n,
    });

    expect(t.manager.status.busy).toBe(false);
  });

  it('records none and preserves the cause when fee preparation fails', async () => {
    const t = await managerFixture();
    const failure = new Error('Fee preparation failed.');

    t.prepareTransactionRequest.mockRejectedValueOnce(failure);

    const error = await rejectedValue(
      t.manager.submit(submissionOptions()),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(failure);

    const recording = submissionRecording(error);

    expect(recording).toEqual({ status: 'none' });
    expect(Object.isFrozen(recording)).toBe(true);

    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.manager.status.attempts).toEqual([]);
    expect(t.visible().attempts).toEqual([]);
    expect(t.manager.status.busy).toBe(false);
  });

  it('captures uncertain preparation when the snapshot becomes visible then saving fails', async () => {
    const t = await managerFixture();
    const persist = t.save.getMockImplementation()!;

    t.save.mockImplementation(async (snapshot) => {
      await persist(snapshot);

      if (snapshot.attempts.some(
        (attempt) => attempt.phase === 'signed',
      )) {
        throw new Error('Preparation durability uncertain.');
      }
    });

    const error = await rejectedValue(
      t.manager.submit(submissionOptions()),
    );

    const visibleAttempt = t.visible().attempts[0]!;
    const recording = submissionRecording(error);

    expect(recording).toEqual({
      status: 'uncertain',
      attempt: {
        workId: visibleAttempt.workId,
        attemptId: visibleAttempt.attemptId,
      },
    });

    if (recording?.status !== 'uncertain') {
      throw new Error('Expected uncertain submission recording.');
    }

    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.attempt)).toBe(true);

    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message)
      .toContain('Journal persistence did not complete.');

    expect(t.manager.status).toMatchObject({
      busy: false,
      open: false,
      persistenceState: 'failed',
      attempts: [],
    });

    expect(visibleAttempt.phase).toBe('signed');
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();

    // A lookalike wrapper cannot inherit the original error's registration.
    expect(submissionRecording(Object.assign(
      new Error('Transaction submission did not complete.'),
      {
        name: 'TransactionSubmissionError',
        cause: error,
        recording,
      },
    ))).toBeUndefined();
  });

  it('captures retained preparation when the broadcast-marker write fails', async () => {
    const t = await managerFixture();
    const persist = t.save.getMockImplementation()!;

    t.save.mockImplementation(async (snapshot) => {
      await persist(snapshot);

      if (snapshot.attempts.some(
        (attempt) => attempt.phase === 'broadcast-may-have-occurred',
      )) {
        throw new Error('Marker durability uncertain.');
      }
    });

    const error = await rejectedValue(
      t.manager.submit(submissionOptions()),
    );

    const acknowledgedAttempt = t.manager.status.attempts[0]!;
    const visibleAttempt = t.visible().attempts[0]!;
    const recording = submissionRecording(error);

    expect(recording).toEqual({
      status: 'retained',
      attempt: {
        workId: acknowledgedAttempt.workId,
        attemptId: acknowledgedAttempt.attemptId,
      },
    });

    if (recording?.status !== 'retained') {
      throw new Error('Expected retained submission recording.');
    }

    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.attempt)).toBe(true);

    expect(acknowledgedAttempt.phase).toBe('signed');
    expect(visibleAttempt).toMatchObject({
      attemptId: acknowledgedAttempt.attemptId,
      phase: 'broadcast-may-have-occurred',
    });

    expect(t.manager.status).toMatchObject({
      busy: false,
      open: false,
      persistenceState: 'failed',
    });

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('reports retained when cancellation follows acknowledged preparation', async () => {
    const t = await managerFixture();
    const controller = new AbortController();
    const reason = new Error('Submission cancelled.');
    const persist = t.save.getMockImplementation()!;

    t.save.mockImplementation(async (snapshot) => {
      await persist(snapshot);

      if (snapshot.attempts.some(
        (attempt) => attempt.phase === 'signed',
      )) {
        controller.abort(reason);
      }
    });

    const error = await rejectedValue(t.manager.submit({
      ...submissionOptions(),
      signal: controller.signal,
    }));

    const attempt = t.manager.status.attempts[0]!;

    expect((error as Error).cause).toBe(reason);

    expect(submissionRecording(error)).toEqual({
      status: 'retained',
      attempt: {
        workId: attempt.workId,
        attemptId: attempt.attemptId,
      },
    });

    expect(attempt.phase).toBe('signed');
    expect(t.visible().attempts[0]).toMatchObject({
      attemptId: attempt.attemptId,
      phase: 'signed',
    });

    expect(t.manager.status).toMatchObject({
      busy: false,
      open: false,
      persistenceState: 'idle',
    });

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('holds submission ownership until the broadcast request settles', async () => {
    const t = await managerFixture();
    const entered = deferred();
    const release = deferred();
    const send = t.request.getMockImplementation()!;

    t.request.mockImplementationOnce(async (args) => {
      entered.resolve();
      await release.promise;
      return send(args);
    });

    const pending = t.manager.submit(submissionOptions());

    try {
      await entered.promise;

      expect(t.manager.status).toMatchObject({
        busy: true,
        open: false,
        persistenceState: 'idle',
      });

      expect(t.visible().attempts[0]).toMatchObject({
        phase: 'broadcast-may-have-occurred',
      });

      const before = {
        blocks: t.getBlock.mock.calls.length,
        nonces: t.getTransactionCount.mock.calls.length,
        writes: t.save.mock.calls.length,
        heads: t.readChainHeads.mock.calls.length,
        preparations: t.prepareTransactionRequest.mock.calls.length,
      };

      await expect(t.manager.reconcile({
        head: HEAD,
        durable: DURABLE,
      })).rejects.toThrow(
        'Transaction manager operation is already in progress.',
      );

      const overlapping = await rejectedValue(
        t.manager.submit(submissionOptions()),
      );

      expect((overlapping as Error).message).toBe(
        'Transaction manager operation is already in progress.',
      );
      expect(submissionRecording(overlapping)).toBeUndefined();

      expect(t.getBlock).toHaveBeenCalledTimes(before.blocks);
      expect(t.getTransactionCount).toHaveBeenCalledTimes(before.nonces);
      expect(t.save).toHaveBeenCalledTimes(before.writes);
      expect(t.readChainHeads).toHaveBeenCalledTimes(before.heads);
      expect(t.prepareTransactionRequest)
        .toHaveBeenCalledTimes(before.preparations);

      expect(t.signTransaction).toHaveBeenCalledTimes(1);
      expect(t.request).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
    }

    expect(await pending).toMatchObject({
      status: 'submitted',
      broadcast: {
        status: 'acknowledged',
      },
    });

    expect(t.manager.status.busy).toBe(false);
  });

  it('returns already-retained without preparing fees or signing again', async () => {
    const t = await managerFixture();
    const options = submissionOptions();

    const submitted = await t.manager.submit(options);

    if (submitted.status !== 'submitted') {
      throw new Error('Expected a submitted transaction.');
    }

    const { broadcast } = submitted;

    // Included at the latest head, but not yet at the durable boundary.
    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: broadcast.transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === DURABLE.blockNumber) {
        return 4;
      }

      return 5;
    });

    t.prepareTransactionRequest.mockClear();
    t.signTransaction.mockClear();
    t.request.mockClear();

    expect(await t.manager.submit(options)).toEqual({
      status: 'already-retained',
      retained: {
        workId: options.work.workId,
        attemptId: broadcast.attemptId,
      },
    });

    expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();

    expect(t.manager.status.attempts).toHaveLength(1);
    expect(t.manager.status.attempts[0]).toMatchObject({
      attemptId: broadcast.attemptId,
      phase: 'included',
    });
  });

  it.each(['preparation', 'marker'] as const)(
    'preserves failure-time recording after retry and resolution: %s',
    async (failureAt) => {
      const t = await managerFixture();
      const persist = t.save.getMockImplementation()!;

      t.save.mockImplementation(async (snapshot) => {
        await persist(snapshot);

        const attempt = snapshot.attempts[0];

        if (attempt === undefined) {
          return;
        }

        if (
          failureAt === 'preparation' &&
          attempt.phase === 'signed'
        ) {
          throw new Error('Preparation durability uncertain.');
        }

        if (
          failureAt === 'marker' &&
          attempt.phase === 'broadcast-may-have-occurred'
        ) {
          throw new Error('Marker durability uncertain.');
        }
      });

      const error = await rejectedValue(
        t.manager.submit(submissionOptions()),
      );

      const recording = submissionRecording(error);
      const failedSnapshot = t.save.mock.calls.at(-1)![0];
      const attempt = failedSnapshot.attempts[0]!;

      let expectedStatus: 'uncertain' | 'retained' = 'uncertain';

      if (failureAt === 'marker') {
        expectedStatus = 'retained';
      }

      expect(recording).toEqual({
        status: expectedStatus,
        attempt: {
          workId: attempt.workId,
          attemptId: attempt.attemptId,
        },
      });

      expect(t.request).not.toHaveBeenCalled();

      t.save.mockImplementation(persist);
      t.save.mockClear();

      // Synthetic chain evidence lets this test exercise resolution after
      // retry. In the preparation-failure case, this fixture never sent
      // the transaction; the receipt does not imply that submission did.
      t.getTransactionReceipt.mockResolvedValue({
        transactionHash: attempt.signedTransactions[0].transactionHash,
        blockNumber: 105n,
        blockHash: HASH,
        status: 'success',
      } as never);

      t.getTransactionCount.mockResolvedValue(5);

      // The advanced durable boundary can resolve the recorded attempt.
      const report = await t.manager.reconcile({
        head: HEAD,
        durable: HEAD,
      });

      expect(t.save.mock.calls[0]![0]).toBe(failedSnapshot);

      expect(report.state).toMatchObject({
        busy: false,
        open: true,
        persistenceState: 'idle',
        attempts: [],
      });

      expect(t.manager.status).toMatchObject({
        busy: false,
        open: true,
        persistenceState: 'idle',
        attempts: [],
      });

      expect(t.visible().attempts).toEqual([]);

      expect(submissionRecording(error)).toBe(recording);
      expect(recording).toEqual({
        status: expectedStatus,
        attempt: {
          workId: attempt.workId,
          attemptId: attempt.attemptId,
        },
      });

      expect(t.signTransaction).toHaveBeenCalledTimes(1);
      expect(t.request).not.toHaveBeenCalled();
    },
  );

  it('defers new work at retained capacity without preparing or signing', async () => {
    const t = await managerFixture({
      maxRetainedAttempts: 1,
    });

    const submitted = await t.manager.submit(submissionOptions());

    if (submitted.status !== 'submitted') {
      throw new Error('Expected a submitted transaction.');
    }

    t.getTransactionReceipt.mockResolvedValue({
      transactionHash: submitted.broadcast.transactionHash,
      blockNumber: 105n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockImplementation(async ({ blockNumber }) => {
      if (blockNumber === DURABLE.blockNumber) {
        return 4;
      }

      return 5;
    });

    // Establish inclusion so the next submission changes no attempt state.
    await t.manager.reconcile({
      head: HEAD,
      durable: DURABLE,
    });

    const attempts = t.manager.status.attempts;

    t.prepareTransactionRequest.mockClear();
    t.signTransaction.mockClear();
    t.request.mockClear();

    const options = submissionOptions();

    const result = await t.manager.submit({
      work: {
        ...options.work,
        workId: 'test-work:second',
      },
    });

    expect(result).toMatchObject({
      status: 'deferred',
      primaryReason: 'retention-capacity-reached',
    });

    if (result.status !== 'deferred') {
      throw new Error('Expected capacity deferral.');
    }

    expect(result.reasons).toEqual(['retention-capacity-reached']);
    expect(result.reasons[0]).toBe(result.primaryReason);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);

    expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.manager.status.attempts).toEqual(attempts);
    expect(t.manager.status.busy).toBe(false);
  });

  it('reports completed reconciliation for an empty journal', async () => {
    const t = await managerFixture();

    const report = await t.manager.reconcile({
      head: HEAD,
      durable: DURABLE,
    });

    expect(report).toMatchObject({
      recoveryStatus: 'no-attempt',
      inclusionStatus: 'inspected',
      broadcast: null,
      retryDelayMs: null,
      state: {
        open: true,
        busy: false,
        journalInitialized: true,
        primaryReason: null,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
        attempts: [],
      },
    });

    expect(report.state).toEqual(t.manager.status);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.state)).toBe(true);
    expect(Object.isFrozen(report.state.blockers)).toBe(true);
    expect(Object.isFrozen(report.state.attempts)).toBe(true);

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
  });

  it('reports reuse of a completed durable pass at unchanged anchors', async () => {
    const t = await managerFixture({
      durableRecovery: {
        refreshIntervalMs: 60_000,
        now: () => 0,
      },
    });

    const options = {
      head: HEAD,
      durable: DURABLE,
    };

    const first = await t.manager.reconcile(options);

    expect(first.recoveryStatus).toBe('no-attempt');

    const second = await t.manager.reconcile(options);

    expect(second).toMatchObject({
      recoveryStatus: 'skipped',
      inclusionStatus: 'inspected',
      broadcast: null,
      retryDelayMs: null,
      state: {
        open: true,
        busy: false,
        attempts: [],
      },
    });

    expect(second.state).toEqual(t.manager.status);
    expect(t.request).not.toHaveBeenCalled();
  });

  it('reports the work identity of an eligible rebroadcast', async () => {
    const onRecoveryCompleted = vi.fn<
      NonNullable<TransactionManagerOptions['onRecoveryCompleted']>
    >();

    const t = await managerFixture({ onRecoveryCompleted });
    const controller = new AbortController();
    const persist = t.save.getMockImplementation()!;

    t.save.mockImplementation(async (snapshot) => {
      await persist(snapshot);

      if (snapshot.attempts.some(
        (attempt) => attempt.phase === 'signed',
      )) {
        controller.abort(new Error('Stopped before broadcast.'));
      }
    });

    await rejectedValue(t.manager.submit({
      ...submissionOptions(),
      signal: controller.signal,
    }));

    const attempt = t.manager.status.attempts[0]!;

    expect(attempt.phase).toBe('signed');
    expect(t.request).not.toHaveBeenCalled();

    t.save.mockImplementation(persist);

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

    onRecoveryCompleted.mockClear();

    const report = await t.manager.reconcile({
      head: HEAD,
      durable: DURABLE,
    });

    expect(report).toMatchObject({
      recoveryStatus: 'unresolved',
      inclusionStatus: 'inspected',
      broadcast: {
        status: 'acknowledged',
        workId: attempt.workId,
        attemptId: attempt.attemptId,
        nonce: attempt.nonce,
        transactionHash: attempt.transactionHashes[0],
      },
      retryDelayMs: 1_000,
      state: {
        busy: false,
        open: false,
      },
    });

    expect(Object.isFrozen(report.broadcast)).toBe(true);
    expect(report.state).toEqual(t.manager.status);

    expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
      retryDelayMs: 1_000,
    });

    expect(Object.isFrozen(
      onRecoveryCompleted.mock.calls[0]![0],
    )).toBe(true);

    expect(t.request.mock.invocationCallOrder[0]!)
      .toBeLessThan(
        onRecoveryCompleted.mock.invocationCallOrder[0]!,
      );

    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.signTransaction).toHaveBeenCalledTimes(1);

    expect(t.manager.status.attempts[0]).toMatchObject({
      attemptId: attempt.attemptId,
      phase: 'broadcast-may-have-occurred',
    });
  });

  it('releases ownership without work when submission is already aborted', async () => {
    const t = await managerFixture();
    const controller = new AbortController();
    const reason = new Error('Already cancelled.');

    controller.abort(reason);

    const error = await rejectedValue(t.manager.submit({
      ...submissionOptions(),
      signal: controller.signal,
    }));

    expect((error as Error).cause).toBe(reason);
    expect(submissionRecording(error)).toEqual({ status: 'none' });

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(t.getBlock).not.toHaveBeenCalled();
    expect(t.getTransactionCount).not.toHaveBeenCalled();
    expect(t.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();

    expect(t.manager.status.busy).toBe(false);

    // A fresh operation must be able to acquire ownership.
    const report = await t.manager.reconcile({
      head: HEAD,
      durable: DURABLE,
    });

    expect(report.state.open).toBe(true);
  });
});

describe('transaction manager recovery notifications', () => {
  type RecoveryObserver =
    NonNullable<TransactionManagerOptions['onRecoveryCompleted']>;

  it.each(['reconcile', 'submit'] as const)(
    'notifies through %s while ownership is held',
    async (operation) => {
      let manager!: TransactionManager;
      let busyDuringNotification: boolean | undefined;
      let overlap: Promise<unknown> | undefined;

      const onRecoveryCompleted = vi.fn<RecoveryObserver>(() => {
        busyDuringNotification = manager.status.busy;

        // Attach rejection handling immediately. The observer itself is
        // synchronous and does not wait for the rejected operation.
        overlap = rejectedValue(manager.reconcile({
          head: HEAD,
          durable: DURABLE,
        }));
      });

      const t = await managerFixture({ onRecoveryCompleted });
      manager = t.manager;

      if (operation === 'reconcile') {
        await manager.reconcile({
          head: HEAD,
          durable: DURABLE,
        });
      } else {
        await manager.submit(submissionOptions());
      }

      expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
        retryDelayMs: null,
      });

      const observation = onRecoveryCompleted.mock.calls[0]![0];

      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.keys(observation)).toEqual(['retryDelayMs']);
      expect(busyDuringNotification).toBe(true);

      if (overlap === undefined) {
        throw new Error('Expected an overlapping reconciliation attempt.');
      }

      const error = await overlap;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Transaction manager operation is already in progress.',
      );
      expect(submissionRecording(error)).toBeUndefined();

      if (operation === 'submit') {
        expect(onRecoveryCompleted.mock.invocationCallOrder[0]!)
          .toBeLessThan(
            t.prepareTransactionRequest.mock.invocationCallOrder[0]!,
          );
      } else {
        expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
      }

      expect(manager.status.busy).toBe(false);
    },
  );

  it('waits for the inclusion write before notifying or preparing', async () => {
    const onRecoveryCompleted = vi.fn<RecoveryObserver>();
    const t = await managerFixture({ onRecoveryCompleted });
    const entered = deferred();
    const release = deferred();
    const persist = t.save.getMockImplementation()!;

    t.save.mockImplementation(async (snapshot) => {
      // Durable recovery uses block 100; inclusion inspection uses 110.
      if (
        snapshot.lastObservation.anchor.blockNumber === HEAD.blockNumber &&
        snapshot.attempts.length === 0
      ) {
        entered.resolve();
        await release.promise;
      }

      await persist(snapshot);
    });

    const pending = t.manager.submit(submissionOptions());

    try {
      await Promise.race([entered.promise, pending]);

      expect(t.manager.status).toMatchObject({
        busy: true,
        open: false,
        persistenceState: 'writing',
      });

      expect(onRecoveryCompleted).not.toHaveBeenCalled();
      expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }

    expect(await pending).toMatchObject({
      status: 'submitted',
      broadcast: {
        status: 'acknowledged',
      },
    });

    expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
      retryDelayMs: null,
    });

    expect(onRecoveryCompleted.mock.invocationCallOrder[0]!)
      .toBeLessThan(
        t.prepareTransactionRequest.mock.invocationCallOrder[0]!,
      );
  });

  it.each(['reconcile', 'submit'] as const)(
    'does not notify when recovery fails through %s',
    async (operation) => {
      const onRecoveryCompleted = vi.fn<RecoveryObserver>();
      const t = await managerFixture({ onRecoveryCompleted });
      const failure = new Error('Recovery RPC failed.');

      t.getTransactionCount.mockRejectedValueOnce(failure);

      let error: unknown;

      if (operation === 'reconcile') {
        error = await rejectedValue(t.manager.reconcile({
          head: HEAD,
          durable: DURABLE,
        }));

        expect(error).toBe(failure);
      } else {
        error = await rejectedValue(
          t.manager.submit(submissionOptions()),
        );

        expect((error as Error).cause).toBe(failure);
        expect(submissionRecording(error)).toEqual({
          status: 'none',
        });
      }

      expect(onRecoveryCompleted).not.toHaveBeenCalled();
      expect(t.prepareTransactionRequest).not.toHaveBeenCalled();
      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();
      expect(t.manager.status.busy).toBe(false);
    },
  );

  it.each(['reconcile', 'submit'] as const)(
    'preserves %s when the recovery observer throws',
    async (operation) => {
      const onRecoveryCompleted = vi.fn<RecoveryObserver>(() => {
        throw new Error('Diagnostic observer failed.');
      });

      const t = await managerFixture({ onRecoveryCompleted });

      if (operation === 'reconcile') {
        await expect(t.manager.reconcile({
          head: HEAD,
          durable: DURABLE,
        })).resolves.toMatchObject({
          recoveryStatus: 'no-attempt',
          inclusionStatus: 'inspected',
          state: {
            busy: false,
            open: true,
          },
        });
      } else {
        await expect(t.manager.submit(submissionOptions()))
          .resolves.toMatchObject({
            status: 'submitted',
            broadcast: {
              status: 'acknowledged',
            },
          });

        expect(t.signTransaction).toHaveBeenCalledOnce();
        expect(t.request).toHaveBeenCalledOnce();
      }

      expect(onRecoveryCompleted).toHaveBeenCalledOnce();
      expect(t.manager.status.busy).toBe(false);
    },
  );

  it('delivers recovery notification before a later preparation failure', async () => {
    const onRecoveryCompleted = vi.fn<RecoveryObserver>();
    const t = await managerFixture({ onRecoveryCompleted });
    const failure = new Error('Fee preparation failed.');

    t.prepareTransactionRequest.mockRejectedValueOnce(failure);

    const error = await rejectedValue(
      t.manager.submit(submissionOptions()),
    );

    expect(onRecoveryCompleted).toHaveBeenCalledExactlyOnceWith({
      retryDelayMs: null,
    });

    expect(onRecoveryCompleted.mock.invocationCallOrder[0]!)
      .toBeLessThan(
        t.prepareTransactionRequest.mock.invocationCallOrder[0]!,
      );

    expect((error as Error).cause).toBe(failure);
    expect(submissionRecording(error)).toEqual({ status: 'none' });
    expect(t.signTransaction).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.manager.status.busy).toBe(false);
  });
});

describe('submissionRecording', () => {
  it('returns undefined for values without a registered recording', () => {
    const values: unknown[] = [
      undefined,
      null,
      false,
      0,
      '',
      Symbol('submission'),
      () => undefined,
      {},
      new Error('Unregistered failure.'),
    ];

    for (const value of values) {
      expect(submissionRecording(value)).toBeUndefined();
    }
  });

  it('rejects an error with a forged name and recording', () => {
    const error = Object.assign(
      new Error('Transaction submission did not complete.'),
      {
        name: 'TransactionSubmissionError',
        recording: {
          status: 'retained',
          attempt: {
            workId: 'test-work:4',
            attemptId: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
    );

    expect(submissionRecording(error)).toBeUndefined();
  });

  it('does not inspect getters on an unregistered object', () => {
    const getter = vi.fn(() => {
      throw new Error('Unexpected property access.');
    });

    const error = Object.create(null);

    for (const property of ['name', 'recording', 'cause']) {
      Object.defineProperty(error, property, {
        get: getter,
      });
    }

    expect(submissionRecording(error)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not inspect proxy properties', () => {
    const get = vi.fn(() => {
      throw new Error('Unexpected property access.');
    });

    const error = new Proxy({}, { get });

    expect(submissionRecording(error)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('isOperationCancelled', () => {
  it('returns false before the signal is aborted even when the reason matches', () => {
    const controller = new AbortController();

    expect(isOperationCancelled(
      controller.signal.reason,
      controller.signal,
    )).toBe(false);

    expect(isOperationCancelled(undefined, undefined)).toBe(false);
  });

  it('recognizes the direct abort reason', () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled.');

    controller.abort(reason);

    expect(isOperationCancelled(reason, controller.signal)).toBe(true);
  });

  it('recognizes a registered submission error with the matching cause', async () => {
    const t = await managerFixture();
    const controller = new AbortController();
    const reason = new Error('Cancelled before submission.');

    controller.abort(reason);

    const error = await rejectedValue(t.manager.submit({
      ...submissionOptions(),
      signal: controller.signal,
    }));

    expect(submissionRecording(error)).toEqual({ status: 'none' });
    expect(isOperationCancelled(error, controller.signal)).toBe(true);
  });

  it('rejects a registered submission error with a different cause', async () => {
    const t = await managerFixture();
    const failure = new Error('Fee preparation failed.');

    t.prepareTransactionRequest.mockRejectedValueOnce(failure);

    const error = await rejectedValue(
      t.manager.submit(submissionOptions()),
    );

    const controller = new AbortController();
    controller.abort(new Error('Cancelled after the failure.'));

    expect(submissionRecording(error)).toEqual({ status: 'none' });
    expect((error as Error).cause).toBe(failure);
    expect(isOperationCancelled(error, controller.signal)).toBe(false);
  });

  it('rejects an unregistered error with a matching cause', () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled.');

    controller.abort(reason);

    const error = new Error('Unregistered wrapper.', {
      cause: reason,
    });

    expect(isOperationCancelled(error, controller.signal)).toBe(false);
  });

  it('does not invoke a cause getter on an unregistered object', () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled.');
    const getter = vi.fn(() => reason);

    controller.abort(reason);

    const error = Object.create(null);

    Object.defineProperty(error, 'cause', {
      get: getter,
    });

    expect(isOperationCancelled(error, controller.signal)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});