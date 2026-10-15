import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createPublicClient,
  http,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalRead,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

const OBSERVATION = {
  anchor: ANCHOR,
  nonce: 4n,
};

async function setup() {
  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot: {
      version: 1,
      identity: IDENTITY,
      baseline: OBSERVATION,
      lastObservation: OBSERVATION,
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    },
  };

  const load = vi.fn(async () => visible);

  const save = vi.fn<TransactionJournalStore['save']>(
    async (snapshot) => {
      visible = {
        kind: 'present',
        snapshot,
      };
    },
  );

  const lines: string[] = [];

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    maxRetainedAttempts: 3,
    log: createRelayerLog({
      chainId: 4663,
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    }),
    createErrorSummary: (secrets = []) => ({
      scrubText: createScrubber({
        privateKey: KEY,
        rpcUrls: [],
        secrets,
      }),
    }),
  });

  const coordinator = await create();

  const startupClient = {
    getBlock: async () => ({
      number: ANCHOR.blockNumber,
      hash: ANCHOR.blockHash,
    }),
    getTransactionCount: async () => Number(OBSERVATION.nonce),
  } as unknown as PublicClient;

  await expect(coordinator.recover({
    publicClient: startupClient,
    anchor: ANCHOR,
    maxBlockRange: 2n,
  })).resolves.toEqual({
    status: 'no-attempt',
    observation: OBSERVATION,
  });

  expect(coordinator.status).toMatchObject({
    open: false,
    recoveryComplete: true,
    inclusionChecksComplete: false,
  });

  await coordinator.checkInclusions({
    publicClient: startupClient,
    head: ANCHOR,
  });

  expect(coordinator.status).toMatchObject({
    open: true,
    recoveryComplete: true,
    inclusionChecksComplete: true,
  });

  // Keep saved-call indexing focused on preparation and broadcasting.
  save.mockClear();

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const prepared = await coordinator.prepareAttempt({
    workId: 'test-work:broadcast',
    account: {
      ...ACCOUNT,
      signTransaction,
    },
    transaction: {
      type: 'eip1559',
      to: ACCOUNT.address,
      data: '0x1234',
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    },
  });

  const signed = save.mock.calls[0]![0];

  if (prepared.status !== 'prepared') {
    throw new Error('Expected a newly prepared broadcast fixture.');
  }

  const signedTransaction =
    signed.attempts[0]!.signedTransactions[0].signedTransaction;

  save.mockClear();
  lines.length = 0;

  const request = vi.fn<PublicClient['request']>()
    .mockResolvedValue(prepared.transactionHash);

  const getBlock = vi.fn<PublicClient['getBlock']>()
    .mockImplementation(async ({ blockNumber } = {}) => ({
      number: blockNumber,
      hash: HASH,
    }) as never);

  const getTransactionReceipt =
    vi.fn<PublicClient['getTransactionReceipt']>()
      .mockRejectedValue(new TransactionReceiptNotFoundError({
        hash: prepared.transactionHash,
      }));

  const getTransactionCount =
    vi.fn<PublicClient['getTransactionCount']>()
      .mockResolvedValue(4);

  const publicClient = {
    request,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
  } as unknown as PublicClient;

  const options = {
    publicClient,
    attemptId: prepared.attemptId,
  };

  const recovery = {
    publicClient,
    anchor: ANCHOR,
    maxBlockRange: 2n,
  };

  const broadcast = () =>
    coordinator.broadcastAttempt(options, 7);

  return {
    coordinator,
    create,
    save,
    load,
    lines,
    prepared,
    signed,
    signedTransaction,
    signTransaction,
    request,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    publicClient,
    options,
    recovery,
    broadcast,
    visible: () => visible,
    records: () => lines.map((line) => JSON.parse(line)),
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('journaled transaction broadcast', () => {
  it('persists the broadcast phase before sending the exact stored bytes', async () => {
    const t = await setup();

    t.request.mockImplementationOnce(async () => {
      expect(t.visible()).toMatchObject({
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            phase: 'broadcast-may-have-occurred',
            inclusion: null,
          }],
        },
      });

      return t.prepared.transactionHash;
    });

    const result = await t.broadcast();

    expect(result).toEqual({
      ...t.prepared,
      status: 'acknowledged',
    });

    expect(Object.isFrozen(result)).toBe(true);

    expect(t.save.mock.calls[0]![0]).toEqual({
      ...t.signed,
      attempts: [{
        ...t.signed.attempts[0]!,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      }],
    });

    expect(t.request).toHaveBeenCalledExactlyOnceWith({
      method: 'eth_sendRawTransaction',
      params: [t.signedTransaction],
    }, {
      retryCount: 0,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.records()).toEqual([
      expect.objectContaining({
        event: 'attempt_broadcast_accepted',
        cycle: 7,
        signer: ACCOUNT.address,
        attemptId: t.prepared.attemptId,
        transactionHash: t.prepared.transactionHash,
        nonce: '4',
        operation: { name: 'broadcast-attempt' },
      }),
    ]);

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('requires fresh inspection after acknowledgement, even if recovery is manually completed', async () => {
    const t = await setup();

    await t.broadcast();

    t.coordinator.completeRecovery();

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale attempt identifier without spending the valid permit', async () => {
    const t = await setup();

    await expect(t.coordinator.broadcastAttempt({
      ...t.options,
      attemptId: 'other',
    })).rejects.toThrow('does not match');

    expect(t.save).not.toHaveBeenCalled();
    expect(t.request).not.toHaveBeenCalled();

    await t.broadcast();
  });

  it.each([
    'unattributed-signer-activity',
    'conflict-search-exhausted',
  ] as const)(
    'does not broadcast while blocked by %s',
    async (reason) => {
      const t = await setup();

      t.coordinator.block(reason);

      await expect(t.broadcast())
        .rejects.toThrow('Fresh reconciliation');

      expect(t.save).not.toHaveBeenCalled();
      expect(t.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    'saving',
    'sending',
  ] as const)(
    'retains exclusive ownership while %s',
    async (stage) => {
      const t = await setup();
      const entered = deferred();
      const finish = deferred();

      if (stage === 'saving') {
        t.save.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
        });
      } else {
        t.request.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;

          return t.prepared.transactionHash;
        });
      }

      const pending = t.broadcast();

      try {
        await Promise.race([entered.promise, pending]);

        expect(t.coordinator.status.open).toBe(false);

        if (stage === 'saving') {
          expect(t.request).not.toHaveBeenCalled();
        }

        await expect(t.broadcast())
          .rejects.toThrow('already in progress');

        await expect(t.coordinator.recover(t.recovery))
          .rejects.toThrow('already in progress');

        await expect(t.coordinator.retryPersistence())
          .rejects.toThrow('already in progress');
      } finally {
        finish.resolve();
        await pending;
      }
    },
  );

  it('retries a failed phase write without sending, then requires recovery', async () => {
    const t = await setup();
    const ordinarySave = t.save.getMockImplementation()!;

    t.save.mockImplementationOnce(async (snapshot) => {
      await ordinarySave(snapshot);
      throw new Error('durability uncertain');
    });

    await expect(t.broadcast())
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    expect(t.visible()).toMatchObject({
      snapshot: {
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{
          phase: 'broadcast-may-have-occurred',
          inclusion: null,
        }],
      },
    });

    // Storage visibility does not publish an unconfirmed durable write.
    expect(t.coordinator.attempts[0]!.phase).toBe('signed');

    expect(t.request).not.toHaveBeenCalled();

    await expect(t.broadcast())
      .rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('again'));

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(t.save.mock.calls[2]![0]).toBe(pending);
    expect(t.request).not.toHaveBeenCalled();

    expect(t.coordinator.attempts[0]!.phase)
      .toBe('broadcast-may-have-occurred');

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    await t.coordinator.recover(t.recovery);

    t.save.mockClear();

    await t.broadcast();

    expect(t.save).not.toHaveBeenCalled();
    expect(t.request).toHaveBeenCalledTimes(1);

    expect(t.records().some((record) =>
      record.event === 'signer_gate_released',
    )).toBe(false);
  });

  it.each([
    'timeout',
    'already known',
    'nonce too low',
  ])(
    'returns not-acknowledged and retains the attempt after RPC error: %s',
    async (message) => {
      const t = await setup();

      t.request.mockRejectedValueOnce(new Error(
        `${message} ${KEY} ${t.signedTransaction}`,
      ));

      const result = await t.broadcast();

      expect(result).toEqual({
        ...t.prepared,
        status: 'not-acknowledged',
      });
      expect(Object.isFrozen(result)).toBe(true);

      expect(t.visible()).toMatchObject({
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            phase: 'broadcast-may-have-occurred',
            inclusion: null,
          }],
        },
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
        persistenceState: 'idle',
      });
      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.broadcast())
        .rejects.toThrow('Fresh reconciliation');

      expect(t.request).toHaveBeenCalledTimes(1);

      expect(t.records()).toEqual([
        expect.objectContaining({
          event: 'attempt_broadcast_not_acknowledged',
          cycle: 7,
          signer: ACCOUNT.address,
          attemptId: t.prepared.attemptId,
          transactionHash: t.prepared.transactionHash,
          nonce: '4',
          operation: { name: 'broadcast-attempt' },
          observation: 'request-error',
          err: expect.any(Object),
        }),
      ]);

      expect(t.records()[0])
        .not.toHaveProperty('returnedTransactionHash');

      expect(t.lines.join('')).not.toContain(KEY);
      expect(t.lines.join('')).not.toContain(t.signedTransaction);
    },
  );

  it.each([
    {
      hash: OTHER,
      observation: 'hash-mismatch',
    },
    {
      hash: '0x1234',
      observation: 'invalid-response',
    },
    {
      hash: undefined,
      observation: 'invalid-response',
    },
  ] as const)(
    'returns not-acknowledged for $observation without clearing the attempt',
    async ({ hash, observation }) => {
      const t = await setup();

      t.request.mockResolvedValueOnce(hash as never);

      await expect(t.broadcast()).resolves.toEqual({
        ...t.prepared,
        status: 'not-acknowledged',
      });

      expect(t.visible()).toMatchObject({
        snapshot: {
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [{
            attemptId: t.prepared.attemptId,
            phase: 'broadcast-may-have-occurred',
            inclusion: null,
          }],
        },
      });

      expect(t.coordinator.status.open).toBe(false);
      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.broadcast())
        .rejects.toThrow('Fresh reconciliation');

      expect(t.request).toHaveBeenCalledTimes(1);

      expect(t.records()).toEqual([
        expect.objectContaining({
          event: 'attempt_broadcast_not_acknowledged',
          cycle: 7,
          signer: ACCOUNT.address,
          attemptId: t.prepared.attemptId,
          transactionHash: t.prepared.transactionHash,
          nonce: '4',
          operation: { name: 'broadcast-attempt' },
          observation,
        }),
      ]);

      const record = t.records()[0];

      expect(record).not.toHaveProperty('err');

      if (observation === 'hash-mismatch') {
        expect(record.returnedTransactionHash).toBe(OTHER);
      } else {
        expect(record).not.toHaveProperty('returnedTransactionHash');
      }
    },
  );

  it('accepts a matching hash with different hex casing', async () => {
    const t = await setup();

    const uppercase =
      `0x${t.prepared.transactionHash.slice(2).toUpperCase()}`;

    t.request.mockResolvedValueOnce(uppercase as never);

    expect(await t.broadcast()).toMatchObject({
      transactionHash: t.prepared.transactionHash,
    });
  });

  it('rebroadcasts identical bytes once after a fresh receipt and nonce inspection', async () => {
    const t = await setup();

    await t.broadcast();
    await t.coordinator.recover(t.recovery);

    t.save.mockClear();

    await t.broadcast();

    expect(t.request.mock.calls[1])
      .toEqual(t.request.mock.calls[0]);

    expect(t.save).not.toHaveBeenCalled();
    expect(t.signTransaction).toHaveBeenCalledTimes(1);

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(t.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it('does not retain a permit after recovery fails', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockRejectedValueOnce(
      new Error('RPC failed'),
    );

    await expect(t.coordinator.recover(t.recovery))
      .rejects.toThrow('RPC failed');

    t.coordinator.completeRecovery();

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.request).not.toHaveBeenCalled();
  });

  it('waits for durability when the receipt is already included above the anchor', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.prepared.transactionHash,
      blockNumber: 101n,
      blockHash: HASH,
      status: 'success',
    } as never);

    const result = await t.coordinator.recover(t.recovery);

    expect(result).toMatchObject({
      status: 'unresolved',
      receipt: {
        status: 'included-not-durable',
      },
    });

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.request).not.toHaveBeenCalled();
  });

  it('does not broadcast after head inspection observes a consumed nonce', async () => {
    const t = await setup();

    expect(t.coordinator.canBroadcast).toBe(true);

    const head = {
      blockNumber: 101n,
      blockHash: HASH,
    };

    t.getTransactionCount.mockResolvedValueOnce(5);

    const result = await t.coordinator.checkInclusions({
      publicClient: t.publicClient,
      head,
    });

    expect(result).toMatchObject({
      status: 'inspected',
      observation: {
        anchor: head,
        nonce: 5n,
      },
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
    });

    expect(t.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(t.getTransactionCount).toHaveBeenCalledTimes(1);

    expect(t.save).toHaveBeenCalledOnce();

    expect(t.visible()).toMatchObject({
      kind: 'present',
      snapshot: {
        lastObservation: {
          anchor: head,
          nonce: 5n,
        },
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{
          attemptId: t.prepared.attemptId,
          nonce: 4n,
          phase: 'signed',
          inclusion: null,
        }],
      },
    });

    expect(t.coordinator.canBroadcast).toBe(false);

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.request).not.toHaveBeenCalled();
    expect(t.save).toHaveBeenCalledOnce();
    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('requires inspection after restart before sending the recorded attempt', async () => {
    const t = await setup();

    await t.broadcast();

    const restarted = await t.create();

    restarted.completeRecovery();

    await expect(restarted.broadcastAttempt(t.options))
      .rejects.toThrow('Fresh reconciliation');

    await restarted.recover(t.recovery);
    await restarted.broadcastAttempt(t.options);

    expect(t.request.mock.calls[1])
      .toEqual(t.request.mock.calls[0]);

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not send an attempt cleared by durable receipt reconciliation', async () => {
    const t = await setup();

    t.getTransactionReceipt.mockResolvedValueOnce({
      transactionHash: t.prepared.transactionHash,
      blockNumber: 100n,
      blockHash: HASH,
      status: 'success',
    } as never);

    t.getTransactionCount.mockResolvedValueOnce(5);

    await t.coordinator.recover(t.recovery);

    await expect(t.broadcast()).rejects.toThrow('does not match');

    expect(t.request).not.toHaveBeenCalled();

    expect(t.visible()).toMatchObject({
      snapshot: {
        nextNonce: 5n,
        durableNextNonce: 5n,
        attempts: [],
      },
    });

    expect(t.coordinator.attempts).toEqual([]);
  });

  it('disables viem retries for the send request', async () => {
    const t = await setup();

    const fetchFn = vi.fn<typeof fetch>()
      .mockRejectedValue(new TypeError('network failure'));

    const publicClient = createPublicClient({
      transport: http('https://rpc.example', {
        fetchFn,
        retryCount: 3,
        retryDelay: 0,
      }),
    });

    await expect(t.coordinator.broadcastAttempt({
      ...t.options,
      publicClient,
    })).resolves.toEqual({
      ...t.prepared,
      status: 'not-acknowledged',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('authorizes broadcasting from a head inspection only after persistence finishes', async () => {
    const t = await setup();
    const entered = deferred();
    const finish = deferred();
    const save = t.save.getMockImplementation()!;

    t.save.mockImplementationOnce(async (snapshot) => {
      entered.resolve();
      await finish.promise;
      await save(snapshot);
    });

    const pending = t.coordinator.checkInclusions({
      publicClient: t.publicClient,
      head: ANCHOR,
    });

    try {
      await Promise.race([entered.promise, pending]);

      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.request).not.toHaveBeenCalled();

      await expect(t.broadcast())
        .rejects.toThrow('already in progress');
    } finally {
      finish.resolve();
      await pending;
    }

    expect(t.coordinator.canBroadcast).toBe(true);

    await t.broadcast();

    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.coordinator.canBroadcast).toBe(false);

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');
  });

  it('requires a fresh head inspection after retrying its failed persistence', async () => {
    const t = await setup();

    t.save.mockRejectedValueOnce(new Error('Inspection write failed'));

    await expect(t.coordinator.checkInclusions({
      publicClient: t.publicClient,
      head: ANCHOR,
    })).rejects.toThrow('Journal persistence');

    const failed = t.save.mock.calls[0]![0];

    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.request).not.toHaveBeenCalled();

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(failed);
    expect(t.coordinator.canBroadcast).toBe(false);

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    await t.coordinator.checkInclusions({
      publicClient: t.publicClient,
      head: ANCHOR,
    });

    expect(t.coordinator.canBroadcast).toBe(true);

    await t.broadcast();

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('does not let head inspection alone complete recovery after a broadcast', async () => {
    const t = await setup();

    await t.broadcast();

    const result = await t.coordinator.checkInclusions({
      publicClient: t.publicClient,
      head: ANCHOR,
    });

    expect(result).toMatchObject({
      status: 'inspected',
      broadcastAttemptId: t.prepared.attemptId,
    });

    expect(t.coordinator.status.recoveryComplete).toBe(false);
    expect(t.coordinator.canBroadcast).toBe(false);

    await expect(t.broadcast())
      .rejects.toThrow('Fresh reconciliation');

    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    'unattributed-signer-activity',
    'conflict-search-exhausted',
  ] as const)(
    'does not authorize broadcasting from head inspection while blocked by %s',
    async (reason) => {
      const t = await setup();

      t.coordinator.block(reason);

      await t.coordinator.checkInclusions({
        publicClient: t.publicClient,
        head: ANCHOR,
      });

      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.broadcast())
        .rejects.toThrow('Fresh reconciliation');

      expect(t.request).not.toHaveBeenCalled();
    },
  );
});