import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  parseTransaction,
  type LocalAccount,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

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
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const CREATED = '2026-10-05T12:00:00.000Z';

const OBSERVATION = {
  anchor: {
    blockNumber: 100n,
    blockHash: HASH,
  },
  nonce: 4n,
};

function transaction() {
  return {
    type: 'eip1559' as const,
    to: ACCOUNT.address,
    data: '0x1234' as const,
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
}

async function setup(options: {
  missing?: boolean;
  unrecovered?: boolean;
  brokenLog?: boolean;
} = {}) {
  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: IDENTITY,
    baseline: OBSERVATION,
    lastObservation: OBSERVATION,
    nextNonce: 4n,
    durableNextNonce: 4n,
    attempts: [],
  };

  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot,
  };

  if (options.missing) {
    visible = { kind: 'missing' };
  }

  const load = vi.fn(async () => visible);

  const save = vi.fn<TransactionJournalStore['save']>(
    async (next) => {
      visible = {
        kind: 'present',
        snapshot: next,
      };
    },
  );

  const lines: string[] = [];

  const factory = vi.fn((secrets: readonly string[] = []) => ({
    scrubText: createScrubber({
      privateKey: KEY,
      rpcUrls: [],
      secrets,
    }),
  }));

  let log = createRelayerLog({
    chainId: 4663,
    errorSummary: factory(),
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  if (options.brokenLog) {
    const wrap = (
      current: ScopedRelayerLog,
    ): ScopedRelayerLog => ({
      ...current,
      withContext: (context) =>
        wrap(current.withContext(context)),
      withErrorSummary: (policy) =>
        wrap(current.withErrorSummary(policy)),
      signerBlocked() {
        let bytes = '';

        if (visible.kind === 'present') {
          bytes = visible.snapshot.attempts.flatMap((attempt) =>
            attempt.signedTransactions.map(
              (transaction) => transaction.signedTransaction,
            ),
          ).join(' ');
        }

        throw new Error(`failed ${bytes} ${KEY}`);
      },
    });

    log = wrap(log);
  }

  factory.mockClear();

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    maxRetainedAttempts: 3,
    log,
    createErrorSummary: factory,
    now: () => Date.parse(CREATED),
  });

  const coordinator = await create();

  if (!options.missing && !options.unrecovered) {
    coordinator.completeRecovery();

    await coordinator.checkInclusions({
      publicClient: {
        getBlock: async () => ({
          number: OBSERVATION.anchor.blockNumber,
          hash: OBSERVATION.anchor.blockHash,
        }),
        getTransactionCount: async () => Number(OBSERVATION.nonce),
      } as unknown as PublicClient,
      head: OBSERVATION.anchor,
    });
  }

  // Assertions below measure preparation, excluding fixture initialization.
  save.mockClear();
  factory.mockClear();
  lines.length = 0;

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const account: LocalAccount = {
    ...ACCOUNT,
    signTransaction,
  };

  const prepare = () => coordinator.prepareAttempt({
    account,
    transaction: transaction(),
  }, 7);

  return {
    coordinator,
    create,
    prepare,
    account,
    signTransaction,
    save,
    load,
    factory,
    lines,
    records: () => lines.map((line) => JSON.parse(line)),
    setVisible: (next: TransactionJournalRead) => {
      visible = next;
    },
  };
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('durable attempt preparation', () => {
  it('records signed bytes and advances allocation without advancing durable progress', async () => {
    const t = await setup();
    const result = await t.prepare();
    const saved = t.save.mock.calls[0]![0];
    const attempt = saved.attempts[0]!;
    const signed = attempt.signedTransactions[0];

    expect(saved).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: OBSERVATION,
      attempts: [{
        attemptId: result.attemptId,
        nonce: result.nonce,
        phase: 'signed',
        inclusion: null,
        createdAt: CREATED,
        signedTransactions: [{
          transactionHash: result.transactionHash,
        }],
        replacementSearch: {
          lowerBound: OBSERVATION,
          searchedThrough: null,
        },
      }],
    });

    expect(saved.attempts).toHaveLength(1);
    expect(attempt.signedTransactions).toHaveLength(1);

    expect(
      parseTransaction(signed.signedTransaction),
    ).toMatchObject({
      chainId: 4663,
      nonce: 4,
      to: ACCOUNT.address.toLowerCase(),
      data: '0x1234',
    });

    expect(Object.keys(result).sort()).toEqual([
      'attemptId',
      'nonce',
      'transactionHash',
    ]);

    expect(Object.isFrozen(result)).toBe(true);

    expect(t.factory).toHaveBeenCalledExactlyOnceWith([
      signed.signedTransaction,
    ]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      inclusionChecksComplete: false,
      primaryReason: 'unresolved-attempt',
      blockedSince: CREATED,
    });

    expect(t.records()).toHaveLength(1);

    expect(t.records()[0]).toMatchObject({
      event: 'signer_blocked',
      cycle: 7,
      operation: { name: 'prepare-attempt' },
    });

    // Signer gate events describe the queue, not an individual attempt.
    expect(t.records()[0]).not.toHaveProperty('attemptId');

    expect(t.lines.join(''))
      .not.toContain(signed.signedTransaction);

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { missing: true },
    { unrecovered: true },
  ])(
    'rejects preparation before recovery: %#',
    async (options) => {
      const t = await setup(options);

      await expect(t.prepare()).rejects.toThrow('signer gate');

      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    'unattributed-signer-activity',
    'conflict-search-exhausted',
  ] as const)(
    'rejects preparation while blocked by %s',
    async (reason) => {
      const t = await setup();

      t.coordinator.block(reason);

      await expect(t.prepare()).rejects.toThrow('signer gate');

      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('rejects another attempt while the recorded attempt is unresolved', async () => {
    const t = await setup();

    await t.prepare();

    await expect(t.prepare()).rejects.toThrow('signer gate');

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    'signing',
    'saving',
  ] as const)(
    'holds exclusive ownership while %s',
    async (stage) => {
      const t = await setup();
      const entered = deferred();
      const finish = deferred();

      if (stage === 'signing') {
        t.signTransaction.mockImplementationOnce(async (input) => {
          entered.resolve();
          await finish.promise;

          return ACCOUNT.signTransaction(input);
        });
      } else {
        t.save.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
        });
      }

      const pending = t.prepare();

      try {
        await Promise.race([entered.promise, pending]);

        expect(t.coordinator.status.open).toBe(false);
        expect(t.records()).toEqual([]);

        await expect(t.prepare())
          .rejects.toThrow('already in progress');

        await expect(t.coordinator.retryPersistence())
          .rejects.toThrow('already in progress');

        expect(() => t.coordinator.completeRecovery())
          .toThrow('already in progress');
      } finally {
        finish.resolve();
        await pending;
      }

      expect(t.coordinator.status.primaryReason)
        .toBe('unresolved-attempt');
    },
  );

  it('leaves no pending write when signing fails and allows a new attempt', async () => {
    const t = await setup();

    t.signTransaction.mockRejectedValueOnce(new Error(KEY));

    await expect(t.prepare()).rejects.toThrow('Could not sign');

    expect(t.save).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: true,
      persistenceState: 'idle',
    });

    expect(t.records()).toEqual([]);

    await t.prepare();

    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it('retains exact bytes through ambiguous writes and retries without signing again', async () => {
    const t = await setup();

    t.save.mockImplementationOnce(async (snapshot) => {
      t.setVisible({
        kind: 'present',
        snapshot,
      });

      throw new Error('uncertain');
    });

    await expect(t.prepare())
      .rejects.toThrow('Journal persistence');

    const first = t.save.mock.calls[0]![0];

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'persistence-failure',
      blockedSince: CREATED,
    });

    await expect(t.prepare())
      .rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('again'));

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence(8);

    expect(t.save.mock.calls[1]![0]).toBe(first);
    expect(t.save.mock.calls[2]![0]).toBe(first);

    expect(t.signTransaction).toHaveBeenCalledTimes(1);
    expect(t.load).toHaveBeenCalledTimes(1);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    expect(t.lines.join(''))
      .not.toContain(
        first.attempts[0]!.signedTransactions[0].signedTransaction,
      );
  });

  it('restores an unresolved signed attempt after restart', async () => {
    const t = await setup();
    const prepared = await t.prepare();
    const restarted = await t.create();

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unresolved-attempt',
      blockedSince: CREATED,
    });

    await expect(restarted.prepareAttempt({
      account: t.account,
      transaction: transaction(),
    })).rejects.toThrow('signer gate');

    expect(t.signTransaction).toHaveBeenCalledTimes(1);

    expect(t.save.mock.calls[0]![0].attempts[0]!.attemptId)
      .toBe(prepared.attemptId);
  });

  it('contains logger failures with signed-byte redaction installed', async () => {
    const t = await setup({ brokenLog: true });

    await t.prepare();

    expect(t.coordinator.status.primaryReason)
      .toBe('unresolved-attempt');

    expect(t.records().map((record) => record.event)).toEqual([
      'logging_failed',
    ]);

    expect(t.lines.join('')).not.toContain(KEY);

    expect(t.lines.join('')).not.toContain(
      t.save.mock.calls[0]![0]
        .attempts[0]!.signedTransactions[0].signedTransaction,
    );
  });

  it('does not persist or expose raw errors when diagnostic policy creation fails', async () => {
    const t = await setup();

    t.factory.mockImplementationOnce((secrets) => {
      throw new Error(`failed ${secrets?.[0]} ${KEY}`);
    });

    const failure = await t.prepare()
      .catch((error: unknown) => error);

    expect(failure).toHaveProperty(
      'message',
      'Could not configure signed attempt diagnostics.',
    );

    expect(failure).not.toHaveProperty('cause');
    expect(t.save).not.toHaveBeenCalled();
    expect(t.coordinator.status.open).toBe(true);
    expect(t.records()).toEqual([]);
  });
});