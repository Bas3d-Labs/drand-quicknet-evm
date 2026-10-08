import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import * as inclusionInspection from
  '../../src/chain/inspect-signer-inclusions.js';

import * as recoveryInspection from
  '../../src/chain/inspect-signer-recovery.js'

import * as transactionSigning from
  '../../src/chain/sign-prepared-transaction.js';

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
  JournalAttempt,
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

// Public test fixture only.
const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const CREATED = '2026-10-04T00:00:00.000Z';

const BASELINE = {
  anchor: {
    blockNumber: 100n,
    blockHash: HASH,
  },
  nonce: 4n,
};

const OBSERVED_AT = {
  blockNumber: 120n,
  blockHash: HASH,
};

function emptySnapshot(): TransactionJournalSnapshot {
  return {
    version: 1,
    identity: { ...IDENTITY },
    baseline: BASELINE,
    lastObservation: BASELINE,
    nextNonce: 4n,
    durableNextNonce: 4n,
    attempts: [],
  };
}

async function sign(nonce: number, maxFeePerGas = 2n) {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas: 1n,
  });

  return {
    transactionHash: keccak256(signedTransaction),
    signedTransaction,
  };
}

async function queueSnapshot(): Promise<TransactionJournalSnapshot> {
  const original = await sign(4);
  const replacement = await sign(4, 4n);
  const second = await sign(5);

  return {
    ...emptySnapshot(),
    nextNonce: 6n,
    lastObservation: {
      anchor: OBSERVED_AT,
      nonce: 6n,
    },
    attempts: [
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        nonce: 4n,
        createdAt: CREATED,
        signedTransactions: [original, replacement],
        replacementSearch: null,
        phase: 'included',
        inclusion: {
          outcome: 'success',
          transactionHash: replacement.transactionHash,
          inclusion: {
            blockNumber: 110n,
            blockHash: HASH,
          },
          observedAt: OBSERVED_AT,
        },
      },
      {
        attemptId: '22222222-2222-4222-8222-222222222222',
        nonce: 5n,
        createdAt: '2026-10-04T00:01:00.000Z',
        signedTransactions: [second],
        replacementSearch: null,
        phase: 'included',
        inclusion: {
          outcome: 'success',
          transactionHash: second.transactionHash,
          inclusion: {
            blockNumber: 111n,
            blockHash: HASH,
          },
          observedAt: OBSERVED_AT,
        },
      },
    ],
  };
}

async function searchSetup(firstIncluded = false) {
  const snapshot = await queueSnapshot();

  const attempts = snapshot.attempts.map(
    (attempt, index): JournalAttempt => {
      if (firstIncluded && index === 0) {
        return attempt;
      }

      return {
        ...attempt,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
        replacementSearch: {
          lowerBound: BASELINE,
          searchedThrough: null,
        },
      };
    },
  );

  const input: TransactionJournalSnapshot = {
    ...snapshot,
    attempts,
  };

  const t = setup({ kind: 'present', snapshot: input });
  const coordinator = await t.create();
  const targetIndex = firstIncluded ? 1 : 0;

  const progress = {
    attemptId: input.attempts[targetIndex]!.attemptId,
    observation: input.lastObservation,
    result: {
      status: 'not-found' as const,
      searchedThrough: {
        blockNumber: 105n,
        blockHash: HASH,
      },
      scannedBlocks: 5n,
      remainingBlocks: 15n,
    },
  };

  return {
    ...t,
    coordinator,
    snapshot: input,
    targetIndex,
    progress,
  };
}

async function preparationSetup(maxRetainedAttempts = 3) {
  const snapshot = await queueSnapshot();
  const t = setup({ kind: 'present', snapshot }, maxRetainedAttempts);
  const coordinator = await t.create();

  coordinator.completeRecovery();

  const inspect = vi.spyOn(
    inclusionInspection,
    'inspectSignerInclusions',
  ).mockResolvedValueOnce({
    status: 'inspected',
    broadcastAttemptId: null,
    observation: snapshot.lastObservation,
    attempts: snapshot.attempts,
    inclusionChecksComplete: true,
  });

  try {
    await coordinator.checkInclusions({
      publicClient: {} as PublicClient,
      head: OBSERVED_AT,
    });
  } finally {
    inspect.mockRestore();
  }

  t.save.mockClear();
  t.factory.mockClear();
  t.lines.length = 0;

  const signed = {
    ...await sign(6),
    nonce: 6n,
  };

  const signing = vi.spyOn(
    transactionSigning,
    'signPreparedTransaction',
  ).mockResolvedValue(signed);

  // The coordinator forwards this value; signing validation is tested
  // in the signPreparedTransaction suite.
  const transaction = {} as Parameters<
    typeof transactionSigning.signPreparedTransaction
  >[0]['transaction'];

  return {
    ...t,
    snapshot,
    coordinator,
    signed,
    signing,
    options: {
      account: ACCOUNT,
      transaction,
    },
  };
}

function setup(
  initial: TransactionJournalRead,
  maxRetainedAttempts = 3,
) {
  const load = vi.fn<TransactionJournalStore['load']>()
    .mockResolvedValue(initial);

  const save = vi.fn<TransactionJournalStore['save']>()
    .mockResolvedValue(undefined);

  const lines: string[] = [];

  const factory = vi.fn((signedTransactions: readonly string[] = []) => ({
    scrubText: createScrubber({
      privateKey: KEY,
      rpcUrls: [],
      secrets: signedTransactions,
    }),
  }));

  const log = createRelayerLog({
    chainId: IDENTITY.chainId,
    errorSummary: factory(),
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  factory.mockClear();

  return {
    load,
    save,
    lines,
    factory,
    create: () => SignerCoordinator.create({
      identity: IDENTITY,
      store: { load, save },
      maxRetainedAttempts,
      log,
      createErrorSummary: factory,
      now: () => Date.parse('2026-10-04T01:00:00.000Z'),
    }),
  };
}

describe('signer coordinator startup', () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid capacity before loading storage: %s',
    async (capacity) => {
      const t = setup({ kind: 'missing' }, capacity);

      await expect(t.create())
        .rejects.toThrow('Invalid retained attempt capacity.');

      expect(t.load).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
      expect(t.factory).not.toHaveBeenCalled();
      expect(t.lines).toEqual([]);
    },
  );

  it('preserves a missing journal without authorizing preparation', async () => {
    const t = setup({ kind: 'missing' });
    const coordinator = await t.create();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.load).toHaveBeenCalledTimes(1);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('does not authorize an empty journal merely because it loaded', async () => {
    const t = setup({
      kind: 'present',
      snapshot: emptySnapshot(),
    });

    const coordinator = await t.create();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.factory).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('registers every retained signed transaction before startup logging', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });

    const bytes = snapshot.attempts.flatMap((attempt) =>
      attempt.signedTransactions.map(
        (transaction) => transaction.signedTransaction,
      ),
    );

    const coordinator = await t.create();

    expect(t.factory).toHaveBeenCalledExactlyOnceWith(bytes);

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
      primaryReason: 'recovery-incomplete',
    });

    const records = t.lines.map((line) => JSON.parse(line));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'signer_blocked',
      signer: ACCOUNT.address,
      reason: 'recovery-incomplete',
    });

    // A queue-wide event must not claim one attempt's correlation.
    expect(records[0]).not.toHaveProperty('attemptId');

    for (const value of [...bytes, KEY]) {
      expect(t.lines.join('')).not.toContain(value);
    }

    expect(t.save).not.toHaveBeenCalled();
  });

  it('does not let completeRecovery bypass inclusion checks', async () => {
    const t = setup({
      kind: 'present',
      snapshot: await queueSnapshot(),
    });

    const coordinator = await t.create();
    coordinator.completeRecovery();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });
  });

  it.each([4n, 5n, 6n, 7n])(
    'accounts for allocated nonces when the observation is %s',
    async (nonce) => {
      const snapshot = await queueSnapshot();

      const t = setup({
        kind: 'present',
        snapshot: {
          ...snapshot,
          lastObservation: {
            anchor: OBSERVED_AT,
            nonce,
          },
        },
      });

      const coordinator = await t.create();

      expect(
        coordinator.status.blockers.includes(
          'unattributed-signer-activity',
        ),
      ).toBe(nonce > snapshot.nextNonce);

      expect(coordinator.status.open).toBe(false);
      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('reports capacity without discarding retained attempts', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot }, 2);

    const coordinator = await t.create();

    expect(coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'journal-capacity-reached',
      blockers: [
        'journal-capacity-reached',
        'recovery-incomplete',
      ],
    });

    expect(t.save).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'reconstructs search exhaustion only for an unresolved record: %s',
    async (unresolved) => {
      const snapshot = await queueSnapshot();
      const first = snapshot.attempts[0]!;

      const searched = {
        ...first,
        replacementSearch: {
          lowerBound: BASELINE,
          searchedThrough: OBSERVED_AT,
        },
      };

      const attempt: JournalAttempt = unresolved
        ? {
            ...searched,
            phase: 'broadcast-may-have-occurred',
            inclusion: null,
          }
        : searched;

      const t = setup({
        kind: 'present',
        snapshot: {
          ...snapshot,
          attempts: [attempt, snapshot.attempts[1]!],
        },
      });

      const coordinator = await t.create();

      expect(
        coordinator.status.blockers.includes(
          'conflict-search-exhausted',
        ),
      ).toBe(unresolved);

      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('contains diagnostic factory failures without retaining signed bytes', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const bytes = snapshot.attempts[0]!.signedTransactions[0].signedTransaction;

    t.factory.mockImplementationOnce(() => {
      throw new Error(`Injected failure ${bytes} ${KEY}`);
    });

    const failure = await t.create().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty(
      'message',
      'Could not configure signed attempt diagnostics.',
    );
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(bytes);
    expect(String(failure)).not.toContain(KEY);
    expect(t.lines).toEqual([]);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('returns an empty frozen queue when the journal is missing', async () => {
    const t = setup({ kind: 'missing' });
    const coordinator = await t.create();

    expect(coordinator.attempts).toEqual([]);
    expect(Object.isFrozen(coordinator.attempts)).toBe(true);
  });

  it('returns an empty frozen queue for an initialized empty journal', async () => {
    const t = setup({
      kind: 'present',
      snapshot: emptySnapshot(),
    });

    const coordinator = await t.create();

    expect(coordinator.attempts).toEqual([]);
    expect(Object.isFrozen(coordinator.attempts)).toBe(true);
  });

  it('exposes ordered attempt summaries with every recorded hash', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const summaries = coordinator.attempts;

    expect(summaries).toEqual(snapshot.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      nonce: attempt.nonce,
      phase: attempt.phase,
      transactionHashes: attempt.signedTransactions.map(
        (transaction) => transaction.transactionHash,
      ),
    })));

    expect(summaries.map((attempt) => attempt.nonce)).toEqual([4n, 5n]);
    expect(summaries[0]!.transactionHashes).toHaveLength(2);

    expect(Object.isFrozen(summaries)).toBe(true);

    for (const summary of summaries) {
      expect(Object.isFrozen(summary)).toBe(true);
      expect(Object.isFrozen(summary.transactionHashes)).toBe(true);

      expect(Object.keys(summary).sort()).toEqual([
        'attemptId',
        'nonce',
        'phase',
        'transactionHashes',
      ]);
    }

    expect(t.save).not.toHaveBeenCalled();
  });

  it('returns detached summaries without exposing signed bytes', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const firstView = coordinator.attempts;
    const secondView = coordinator.attempts;

    expect(secondView).toEqual(firstView);
    expect(secondView).not.toBe(firstView);
    expect(secondView[0]).not.toBe(firstView[0]);
    expect(secondView[0]!.transactionHashes)
      .not.toBe(firstView[0]!.transactionHashes);

    const serialized = JSON.stringify(
      firstView,
      (_key, value) => typeof value === 'bigint'
        ? value.toString()
        : value,
    );

    for (const attempt of snapshot.attempts) {
      for (const transaction of attempt.signedTransactions) {
        expect(serialized).not.toContain(transaction.signedTransaction);
      }
    }

    expect(serialized).not.toContain(KEY);
  });

  it('records an observation below allocation without advancing either counter', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const observation = {
      anchor: {
        blockNumber: 130n,
        blockHash: HASH,
      },
      nonce: 5n,
    };

    await coordinator.recordObservation(observation);

    const saved = t.save.mock.calls[0]![0];

    expect(saved.nextNonce).toBe(6n);
    expect(saved.durableNextNonce).toBe(4n);
    expect(saved.lastObservation).toEqual(observation);
    expect(saved.attempts).toHaveLength(2);

    // Neither observation proves nonce 4 was unconsumed.
    expect(saved.attempts[0]!.replacementSearch).toBeNull();

    // Nonce 5 remains unconsumed at the new observation.
    expect(saved.attempts[1]!.replacementSearch).toEqual({
      lowerBound: observation,
      searchedThrough: null,
    });

    expect(saved.attempts.map((attempt) => attempt.inclusion))
      .toEqual(snapshot.attempts.map((attempt) => attempt.inclusion));

    expect(coordinator.status.inclusionChecksComplete).toBe(false);
    expect(coordinator.status.open).toBe(false);
  });

  it('uses the earlier observation when the new nonce has consumed both attempts', async () => {
    const snapshot = {
      ...await queueSnapshot(),
      lastObservation: BASELINE,
    };

    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    await coordinator.recordObservation({
      anchor: OBSERVED_AT,
      nonce: 6n,
    });

    const saved = t.save.mock.calls[0]![0];

    for (const attempt of saved.attempts) {
      expect(attempt.replacementSearch).toEqual({
        lowerBound: BASELINE,
        searchedThrough: null,
      });
    }

    expect(saved.nextNonce).toBe(6n);
    expect(saved.durableNextNonce).toBe(4n);
  });

  it('preserves established lower bounds and search progress', async () => {
    const snapshot = await queueSnapshot();

    const search = {
      lowerBound: BASELINE,
      searchedThrough: {
        blockNumber: 105n,
        blockHash: HASH,
      },
    };

    const t = setup({
      kind: 'present',
      snapshot: {
        ...snapshot,
        attempts: snapshot.attempts.map((attempt) => ({
          ...attempt,
          replacementSearch: search,
        })),
      },
    });

    const coordinator = await t.create();

    await coordinator.recordObservation({
      anchor: {
        blockNumber: 130n,
        blockHash: HASH,
      },
      nonce: 6n,
    });

    const saved = t.save.mock.calls[0]![0];

    for (const attempt of saved.attempts) {
      expect(attempt.replacementSearch).toEqual(search);
    }
  });

  it('requires recovery when an observation falls behind durable progress', async () => {
    const snapshot = await queueSnapshot();

    const t = setup({
      kind: 'present',
      snapshot: {
        ...snapshot,
        durableNextNonce: 5n,
        attempts: [snapshot.attempts[1]!],
      },
    });

    const coordinator = await t.create();
    coordinator.completeRecovery();

    await expect(coordinator.recordObservation({
      anchor: OBSERVED_AT,
      nonce: 4n,
    })).rejects.toThrow('Observed nonce is behind the journal');

    expect(t.save).not.toHaveBeenCalled();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });
  });

  it('retains the exact failed observation snapshot through retry', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();
    const before = coordinator.attempts;

    t.save.mockRejectedValueOnce(new Error('Injected write failure'));

    const observation = {
      anchor: {
        blockNumber: 130n,
        blockHash: HASH,
      },
      nonce: 7n,
    };

    await expect(coordinator.recordObservation(observation))
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    expect(coordinator.attempts).toEqual(before);
    expect(coordinator.status.primaryReason).toBe('persistence-failure');

    observation.nonce = 4n;
    observation.anchor.blockNumber = 999n;

    await coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(pending.lastObservation).toEqual({
      anchor: {
        blockNumber: 130n,
        blockHash: HASH,
      },
      nonce: 7n,
    });

    expect(pending.nextNonce).toBe(6n);
    expect(pending.durableNextNonce).toBe(4n);
    expect(pending.attempts).toHaveLength(2);

    expect(coordinator.status).toMatchObject({
      open: false,
      inclusionChecksComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    await expect(coordinator.recordObservation(observation))
      .rejects.toThrow('Cannot overwrite');

    expect(t.load).toHaveBeenCalledTimes(1);
    expect(t.save).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'saves progress only for the oldest unresolved attempt; first included: %s',
    async (firstIncluded) => {
      const t = await searchSetup(firstIncluded);

      await t.coordinator.recordSearchProgress(t.progress);

      const saved = t.save.mock.calls[0]![0];

      expect(saved.nextNonce).toBe(t.snapshot.nextNonce);
      expect(saved.durableNextNonce).toBe(t.snapshot.durableNextNonce);
      expect(saved.lastObservation).toEqual(t.snapshot.lastObservation);

      expect(saved.attempts).toEqual(
        t.snapshot.attempts.map((attempt, index) =>
          index === t.targetIndex
            ? {
                ...attempt,
                replacementSearch: {
                  lowerBound: BASELINE,
                  searchedThrough: t.progress.result.searchedThrough,
                },
              }
            : attempt,
        ),
      );

      expect(t.coordinator.status.open).toBe(false);
    },
  );

  it('rejects progress for a later unresolved attempt', async () => {
    const t = await searchSetup();

    await expect(t.coordinator.recordSearchProgress({
      ...t.progress,
      attemptId: t.snapshot.attempts[1]!.attemptId,
    })).rejects.toThrow('Search progress does not match');

    expect(t.save).not.toHaveBeenCalled();
  });

  it('rejects progress for an included attempt before the unresolved target', async () => {
    const t = await searchSetup(true);

    await expect(t.coordinator.recordSearchProgress({
      ...t.progress,
      attemptId: t.snapshot.attempts[0]!.attemptId,
    })).rejects.toThrow('Search progress does not match');

    expect(t.save).not.toHaveBeenCalled();
  });

  it('rejects search progress when every retained attempt is included', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    await expect(coordinator.recordSearchProgress({
      attemptId: snapshot.attempts[0]!.attemptId,
      observation: snapshot.lastObservation,
      result: {
        status: 'not-found',
        searchedThrough: OBSERVED_AT,
        scannedBlocks: 20n,
        remainingBlocks: 0n,
      },
    })).rejects.toThrow('No unresolved attempt');

    expect(t.save).not.toHaveBeenCalled();
  });

  it('retains the exact progress snapshot and blocker through a failed write', async () => {
    const t = await searchSetup();

    t.coordinator.block('conflict-search-exhausted');
    t.save.mockRejectedValueOnce(new Error('Injected write failure'));

    await expect(
      t.coordinator.recordSearchProgress(t.progress),
    ).rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    // Mutating the caller's input must not change the retained retry.
    t.progress.result.searchedThrough.blockNumber = 120n;
    t.progress.result.scannedBlocks = 20n;
    t.progress.result.remainingBlocks = 0n;

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(
      pending.attempts[0]!.replacementSearch!.searchedThrough!.blockNumber,
    ).toBe(105n);

    expect(pending.attempts[1]).toEqual(t.snapshot.attempts[1]);
    expect(pending.nextNonce).toBe(6n);
    expect(pending.durableNextNonce).toBe(4n);

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');
    expect(t.coordinator.status.blockers)
      .toContain('unresolved-attempt');

    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it('keeps repeated zero progress inert and rejects a changed boundary hash', async () => {
    const t = await searchSetup();

    await t.coordinator.recordSearchProgress(t.progress);

    const repeated = {
      ...t.progress,
      result: {
        ...t.progress.result,
        scannedBlocks: 0n,
      },
    };

    await t.coordinator.recordSearchProgress(repeated);

    expect(t.save).toHaveBeenCalledTimes(1);

    await expect(t.coordinator.recordSearchProgress({
      ...repeated,
      result: {
        ...repeated.result,
        searchedThrough: {
          ...repeated.result.searchedThrough,
          blockHash: `0x${'bb'.repeat(32)}`,
        },
      },
    })).rejects.toThrow('Invalid replacement search progress');

    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it('reconstructs an exhausted search after restarting with the saved queue', async () => {
    const t = await searchSetup();

    await t.coordinator.recordSearchProgress({
      ...t.progress,
      result: {
        status: 'not-found',
        searchedThrough: OBSERVED_AT,
        scannedBlocks: 20n,
        remainingBlocks: 0n,
      },
    });

    const saved = t.save.mock.calls[0]![0];
    const restarted = await setup({
      kind: 'present',
      snapshot: saved,
    }).create();

    expect(restarted.status.primaryReason)
      .toBe('conflict-search-exhausted');

    expect(saved.attempts[1]).toEqual(t.snapshot.attempts[1]);
    expect(saved.nextNonce).toBe(6n);
    expect(saved.durableNextNonce).toBe(4n);
  });

  it.each([
    { outcome: 'success', transactionIndex: 0 },
    { outcome: 'success', transactionIndex: 1 },
    { outcome: 'reverted', transactionIndex: 0 },
    { outcome: 'reverted', transactionIndex: 1 },
  ] as const)(
    'resolves the oldest attempt as $outcome using signed transaction $transactionIndex',
    async ({ outcome, transactionIndex }) => {
      const snapshot = await queueSnapshot();
      const first = snapshot.attempts[0]!;
      const t = setup({ kind: 'present', snapshot });
      const coordinator = await t.create();

      t.lines.length = 0;

      const evidence = {
        outcome,
        transactionHash:
          first.signedTransactions[transactionIndex]!.transactionHash,
        inclusion: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        anchor: OBSERVED_AT,
      };

      await coordinator.resolveAttempt(evidence, 7);

      const saved = t.save.mock.calls[0]![0];

      expect(saved).toEqual({
        ...snapshot,
        durableNextNonce: 5n,
        attempts: [snapshot.attempts[1]!],
      });

      expect(coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([5n]);

      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });

      const records = t.lines.map((line) => JSON.parse(line));
      const resolved = records.filter(
        (record) => record.event === 'attempt_resolved',
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        cycle: 7,
        attemptId: first.attemptId,
        transactionHash: evidence.transactionHash,
        nonce: '4',
        resolution: {
          outcome,
          transactionHash: evidence.transactionHash,
          anchor: {
            blockNumber: '120',
          },
        },
      });

      expect(records.some(
        (record) => record.event === 'signer_gate_released',
      )).toBe(false);
    },
  );

  it('rejects resolution for a later attempt before removing the oldest', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    await expect(coordinator.resolveAttempt({
      outcome: 'success',
      transactionHash:
        snapshot.attempts[1]!.signedTransactions[0].transactionHash,
      inclusion: {
        blockNumber: 111n,
        blockHash: HASH,
      },
      anchor: OBSERVED_AT,
    })).rejects.toThrow('Invalid attempt resolution evidence');

    expect(t.save).not.toHaveBeenCalled();
    expect(coordinator.attempts.map((attempt) => attempt.nonce))
      .toEqual([4n, 5n]);
  });

  it.each([6n, 7n])(
    'compares replacement nonce %s with allocation progress',
    async (nonceAtAnchor) => {
      const snapshot = await queueSnapshot();
      const t = setup({ kind: 'present', snapshot });
      const coordinator = await t.create();

      await coordinator.resolveAttempt({
        outcome: 'replaced',
        replacementTransactionHash: `0x${'ef'.repeat(32)}`,
        inclusion: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        anchor: OBSERVED_AT,
        nonceAtAnchor,
      });

      const saved = t.save.mock.calls[0]![0];

      expect(saved.nextNonce).toBe(6n);
      expect(saved.durableNextNonce).toBe(5n);
      expect(saved.attempts).toEqual([snapshot.attempts[1]!]);
      expect(saved.lastObservation.nonce).toBe(nonceAtAnchor);

      expect(
        coordinator.status.blockers.includes(
          'unattributed-signer-activity',
        ),
      ).toBe(nonceAtAnchor > snapshot.nextNonce);
    },
  );

  it('retains the full queue and resolution evidence until a failed removal is retried', async () => {
    const snapshot = await queueSnapshot();
    const first = snapshot.attempts[0]!;
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    let visible = snapshot;

    t.save.mockImplementationOnce(async (candidate) => {
      visible = candidate;
      throw new Error('Injected failure after replacement');
    });

    t.lines.length = 0;

    const evidence = {
      outcome: 'success' as const,
      transactionHash: first.signedTransactions[1]!.transactionHash,
      inclusion: {
        blockNumber: 110n,
        blockHash: HASH,
      },
      anchor: { ...OBSERVED_AT },
    };

    await expect(coordinator.resolveAttempt(evidence))
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    // Storage visibility alone must not publish the prefix removal.
    expect(visible.attempts).toHaveLength(1);
    expect(coordinator.attempts.map((attempt) => attempt.nonce))
      .toEqual([4n, 5n]);

    expect(coordinator.status.primaryReason)
      .toBe('persistence-failure');

    expect(t.lines.map((line) => JSON.parse(line)).some(
      (record) => record.event === 'attempt_resolved',
    )).toBe(false);

    evidence.anchor.blockNumber = 999n;

    t.save.mockRejectedValueOnce(new Error('Injected retry failure'));

    await expect(coordinator.retryPersistence())
      .rejects.toThrow('Journal persistence');

    expect(coordinator.attempts.map((attempt) => attempt.nonce))
      .toEqual([4n, 5n]);

    await coordinator.retryPersistence(9);

    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(t.save.mock.calls[2]![0]).toBe(pending);

    expect(coordinator.attempts.map((attempt) => attempt.nonce))
      .toEqual([5n]);

    expect(pending.nextNonce).toBe(6n);
    expect(pending.durableNextNonce).toBe(5n);

    const resolved = t.lines.map((line) => JSON.parse(line)).filter(
      (record) => record.event === 'attempt_resolved',
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      cycle: 9,
      attemptId: first.attemptId,
      resolution: {
        transactionHash: first.signedTransactions[1]!.transactionHash,
        anchor: {
          blockNumber: '120',
        },
      },
    });

    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it('removes the durable prefix in nonce order without rolling back allocation', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    for (const attempt of snapshot.attempts) {
      await coordinator.resolveAttempt({
        outcome: 'success',
        transactionHash: attempt.signedTransactions[0].transactionHash,
        inclusion: {
          blockNumber: 110n + (attempt.nonce - 4n),
          blockHash: HASH,
        },
        anchor: OBSERVED_AT,
      });
    }

    const saved = t.save.mock.calls[1]![0];

    expect(saved.nextNonce).toBe(6n);
    expect(saved.durableNextNonce).toBe(6n);
    expect(saved.attempts).toEqual([]);
    expect(coordinator.attempts).toEqual([]);

    // Removing records does not perform fresh inclusion/recovery checks.
    expect(coordinator.status.open).toBe(false);
    expect(coordinator.status.inclusionChecksComplete).toBe(false);
  });

  it('applies durable recovery to the oldest record without advancing allocation', async () => {
    const snapshot = await queueSnapshot();
    const first = snapshot.attempts[0]!;
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const inspection = {
      status: 'resolution-available' as const,
      observation: {
        anchor: OBSERVED_AT,
        nonce: 5n,
      },
      evidence: {
        outcome: 'success' as const,
        transactionHash: first.signedTransactions[1]!.transactionHash,
        inclusion: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        anchor: OBSERVED_AT,
      },
    };

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce(inspection);

    try {
      t.lines.length = 0;

      expect(await coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 2n,
      }, 7)).toEqual(inspection);

      const saved = t.save.mock.calls[0]![0];

      expect(saved).toEqual({
        ...snapshot,
        lastObservation: inspection.observation,
        durableNextNonce: 5n,
        attempts: [snapshot.attempts[1]!],
      });

      expect(inspect).toHaveBeenCalledTimes(1);

      expect(coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: true,
        inclusionChecksComplete: false,
      });

      const resolved = t.lines.map((line) => JSON.parse(line)).filter(
        (record) => record.event === 'attempt_resolved',
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        cycle: 7,
        attemptId: first.attemptId,
        transactionHash: inspection.evidence.transactionHash,
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('saves recovery search progress without changing later records', async () => {
    const t = await searchSetup();

    const inspection = {
      status: 'unresolved' as const,
      observation: t.snapshot.lastObservation,
      receipt: {
        status: 'receipt-not-found' as const,
      },
      search: t.progress.result,
    };

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce(inspection);

    try {
      await t.coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 5n,
      });

      const saved = t.save.mock.calls[0]![0];

      expect(saved.nextNonce).toBe(6n);
      expect(saved.durableNextNonce).toBe(4n);
      expect(saved.attempts[1]).toEqual(t.snapshot.attempts[1]);

      expect(saved.attempts[0]!.replacementSearch).toEqual({
        lowerBound: BASELINE,
        searchedThrough: t.progress.result.searchedThrough,
      });

      expect(t.coordinator.status.open).toBe(false);
      expect(t.coordinator.status.inclusionChecksComplete).toBe(false);
    } finally {
      inspect.mockRestore();
    }
  });

  it('retries a failed recovery removal without inspecting the chain again', async () => {
    const snapshot = await queueSnapshot();
    const first = snapshot.attempts[0]!;
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce({
      status: 'resolution-available',
      observation: snapshot.lastObservation,
      evidence: {
        outcome: 'success',
        transactionHash: first.signedTransactions[1]!.transactionHash,
        inclusion: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        anchor: OBSERVED_AT,
      },
    });

    try {
      t.lines.length = 0;
      t.save.mockRejectedValueOnce(new Error('Injected write failure'));

      await expect(coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 2n,
      })).rejects.toThrow('Journal persistence');

      const pending = t.save.mock.calls[0]![0];

      expect(coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([4n, 5n]);

      expect(t.lines.map((line) => JSON.parse(line)).some(
        (record) => record.event === 'attempt_resolved',
      )).toBe(false);

      await coordinator.retryPersistence(9);

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([5n]);

      expect(coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
      });

      const resolved = t.lines.map((line) => JSON.parse(line)).filter(
        (record) => record.event === 'attempt_resolved',
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        cycle: 9,
        attemptId: first.attemptId,
        transactionHash: first.signedTransactions[1]!.transactionHash,
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('opens preparation only after the inclusion snapshot is saved', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    coordinator.completeRecovery();

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: snapshot.attempts,
      inclusionChecksComplete: true,
    });

    let releaseSave!: () => void;

    t.save.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseSave = resolve;
    }));

    try {
      const checking = coordinator.checkInclusions({
        publicClient: {} as PublicClient,
        head: OBSERVED_AT,
      });

      await vi.waitFor(() => {
        expect(t.save).toHaveBeenCalledTimes(1);
      });

      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });

      releaseSave();
      await checking;

      expect(t.save.mock.calls[0]![0]).toEqual(snapshot);

      expect(coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
        inclusionChecksComplete: true,
      });

      // Included records remain retained until durable resolution.
      expect(coordinator.attempts).toHaveLength(2);
    } finally {
      releaseSave?.();
      inspect.mockRestore();
    }
  });

  it('does not let inclusion checking replace durable recovery', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: snapshot.attempts,
      inclusionChecksComplete: true,
    });

    try {
      await coordinator.checkInclusions({
        publicClient: {} as PublicClient,
        head: OBSERVED_AT,
      });

      expect(coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: true,
        primaryReason: 'recovery-incomplete',
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('persists uncertain inclusion observations without opening preparation', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    coordinator.completeRecovery();

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: snapshot.attempts,
      inclusionChecksComplete: false,
    });

    try {
      await coordinator.checkInclusions({
        publicClient: {} as PublicClient,
        head: OBSERVED_AT,
      });

      expect(t.save.mock.calls[0]![0].attempts)
        .toEqual(snapshot.attempts);

      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('persists only the contradicted attempt invalidation', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    const invalidated: JournalAttempt = {
      ...snapshot.attempts[0]!,
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
    };

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: [invalidated, snapshot.attempts[1]!],
      inclusionChecksComplete: false,
    });

    try {
      await coordinator.checkInclusions({
        publicClient: {} as PublicClient,
        head: OBSERVED_AT,
      });

      const saved = t.save.mock.calls[0]![0];

      expect(saved.nextNonce).toBe(6n);
      expect(saved.durableNextNonce).toBe(4n);
      expect(saved.attempts).toEqual([
        invalidated,
        snapshot.attempts[1],
      ]);

      expect(coordinator.status.blockers)
        .toContain('unresolved-attempt');
      expect(coordinator.status.open).toBe(false);
    } finally {
      inspect.mockRestore();
    }
  });

  it('requires a fresh inclusion pass after retrying a failed write', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    coordinator.completeRecovery();

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValue({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: snapshot.attempts,
      inclusionChecksComplete: true,
    });

    t.save.mockRejectedValueOnce(new Error('Injected write failure'));

    const options = {
      publicClient: {} as PublicClient,
      head: OBSERVED_AT,
    };

    try {
      await expect(coordinator.checkInclusions(options))
        .rejects.toThrow('Journal persistence');

      const pending = t.save.mock.calls[0]![0];

      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
        primaryReason: 'persistence-failure',
      });

      await coordinator.retryPersistence();

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(inspect).toHaveBeenCalledTimes(1);

      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });

      await coordinator.checkInclusions(options);

      expect(inspect).toHaveBeenCalledTimes(2);
      expect(coordinator.status.open).toBe(true);
    } finally {
      inspect.mockRestore();
    }
  });

  it('preserves unattributed activity across a lower inclusion observation', async () => {
    const snapshot = {
      ...await queueSnapshot(),
      lastObservation: {
        anchor: OBSERVED_AT,
        nonce: 7n,
      },
    };

    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    coordinator.completeRecovery();

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      observation: {
        anchor: {
          blockNumber: 130n,
          blockHash: HASH,
        },
        nonce: 6n,
      },
      broadcastAttemptId: null,
      attempts: snapshot.attempts,
      inclusionChecksComplete: true,
    });

    try {
      await coordinator.checkInclusions({
        publicClient: {} as PublicClient,
        head: {
          blockNumber: 130n,
          blockHash: HASH,
        },
      });

      expect(t.save.mock.calls[0]![0].lastObservation)
        .toEqual(snapshot.lastObservation);

      expect(coordinator.status).toMatchObject({
        open: false,
        primaryReason: 'unattributed-signer-activity',
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('revokes inclusion authorization when a subsequent head check changes', async () => {
    const snapshot = await queueSnapshot();
    const t = setup({ kind: 'present', snapshot });
    const coordinator = await t.create();

    coordinator.completeRecovery();

    const changed = {
      status: 'anchor-changed' as const,
      observedAnchor: {
        blockNumber: 120n,
        blockHash: `0x${'bb'.repeat(32)}` as const,
      },
    };

    const inspect = vi.spyOn(
      inclusionInspection,
      'inspectSignerInclusions',
    ).mockResolvedValueOnce({
      status: 'inspected',
      broadcastAttemptId: null,
      observation: snapshot.lastObservation,
      attempts: snapshot.attempts,
      inclusionChecksComplete: true,
    }).mockResolvedValueOnce(changed);

    const options = {
      publicClient: {} as PublicClient,
      head: OBSERVED_AT,
    };

    try {
      await coordinator.checkInclusions(options);
      expect(coordinator.status.open).toBe(true);

      expect(await coordinator.checkInclusions(options))
        .toEqual(changed);

      expect(t.save).toHaveBeenCalledTimes(1);
      expect(coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });
    } finally {
      inspect.mockRestore();
    }
  });

  it('appends a signed allocation without removing retained inclusions', async () => {
    const t = await preparationSetup();

    try {
      const prepared = await t.coordinator.prepareAttempt(t.options, 10);
      const saved = t.save.mock.calls[0]![0];
      const appended = saved.attempts[2]!;

      expect(t.signing).toHaveBeenCalledExactlyOnceWith({
        identity: IDENTITY,
        nonce: 6n,
        account: ACCOUNT,
        transaction: t.options.transaction,
      });

      expect(saved.nextNonce).toBe(7n);
      expect(saved.durableNextNonce).toBe(4n);
      expect(saved.lastObservation).toEqual(t.snapshot.lastObservation);
      expect(saved.attempts.slice(0, 2)).toEqual(t.snapshot.attempts);

      expect(appended).toMatchObject({
        attemptId: prepared.attemptId,
        nonce: 6n,
        phase: 'signed',
        inclusion: null,
        signedTransactions: [{
          transactionHash: t.signed.transactionHash,
          signedTransaction: t.signed.signedTransaction,
        }],
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: null,
        },
      });

      expect(prepared).toEqual({
        attemptId: appended.attemptId,
        transactionHash: t.signed.transactionHash,
        nonce: 6n,
      });

      expect(Object.isFrozen(prepared)).toBe(true);

      expect(t.coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([4n, 5n, 6n]);

      expect(t.coordinator.status).toMatchObject({
        open: false,
        inclusionChecksComplete: false,
      });

      const bytes = [
        ...t.snapshot.attempts.flatMap((attempt) =>
          attempt.signedTransactions.map(
            (transaction) => transaction.signedTransaction,
          ),
        ),
        t.signed.signedTransaction,
      ];

      expect(t.factory).toHaveBeenCalledExactlyOnceWith(bytes);

      for (const value of [...bytes, KEY]) {
        expect(t.lines.join('')).not.toContain(value);
      }

      const records = t.lines.map((line) => JSON.parse(line));

      for (const record of records) {
        if (record.event === 'signer_blocked') {
          expect(record).not.toHaveProperty('attemptId');
        }
      }

      await expect(t.coordinator.prepareAttempt(t.options))
        .rejects.toThrow('The signer gate must be open');

      expect(t.signing).toHaveBeenCalledTimes(1);
    } finally {
      t.signing.mockRestore();
    }
  });

  it('rejects preparation at capacity before signing', async () => {
    const t = await preparationSetup(2);

    try {
      await expect(t.coordinator.prepareAttempt(t.options))
        .rejects.toThrow('The signer gate must be open');

      expect(t.signing).not.toHaveBeenCalled();
      expect(t.factory).not.toHaveBeenCalled();
      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.attempts).toHaveLength(2);
    } finally {
      t.signing.mockRestore();
    }
  });

  it('retains the exact failed allocation and retries without signing again', async () => {
    const t = await preparationSetup();

    t.save.mockRejectedValueOnce(new Error('Injected write failure'));

    try {
      await expect(t.coordinator.prepareAttempt(t.options))
        .rejects.toThrow('Journal persistence');

      const pending = t.save.mock.calls[0]![0];

      expect(pending.nextNonce).toBe(7n);
      expect(pending.durableNextNonce).toBe(4n);
      expect(pending.attempts).toHaveLength(3);

      // The new allocation is not published until persistence succeeds.
      expect(t.coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([4n, 5n]);

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
        primaryReason: 'persistence-failure',
      });

      await expect(t.coordinator.prepareAttempt(t.options))
        .rejects.toThrow('A pending journal write must be retried first');

      await t.coordinator.retryPersistence();

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(t.signing).toHaveBeenCalledTimes(1);
      expect(t.factory).toHaveBeenCalledTimes(1);
      expect(t.load).toHaveBeenCalledTimes(1);

      expect(t.coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([4n, 5n, 6n]);

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
      });
    } finally {
      t.signing.mockRestore();
    }
  });

  it('preserves the existing gate and queue when signing fails', async () => {
    const t = await preparationSetup();
    const error = new Error('Injected signing failure');

    t.signing.mockRejectedValueOnce(error);

    try {
      await expect(t.coordinator.prepareAttempt(t.options))
        .rejects.toBe(error);

      expect(t.save).not.toHaveBeenCalled();
      expect(t.factory).not.toHaveBeenCalled();
      expect(t.coordinator.attempts.map((attempt) => attempt.nonce))
        .toEqual([4n, 5n]);

      expect(t.coordinator.status).toMatchObject({
        open: true,
        recoveryComplete: true,
        inclusionChecksComplete: true,
      });
    } finally {
      t.signing.mockRestore();
    }
  });

  it('sanitizes diagnostic policy failure before saving an allocation', async () => {
    const t = await preparationSetup();

    t.factory.mockImplementationOnce(() => {
      throw new Error(
        `Injected failure ${t.signed.signedTransaction} ${KEY}`,
      );
    });

    try {
      const failure = await t.coordinator.prepareAttempt(t.options).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty(
        'message',
        'Could not configure signed attempt diagnostics.',
      );
      expect(failure).not.toHaveProperty('cause');
      expect(String(failure)).not.toContain(t.signed.signedTransaction);
      expect(String(failure)).not.toContain(KEY);

      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.attempts).toHaveLength(2);
      expect(t.coordinator.status.open).toBe(true);
    } finally {
      t.signing.mockRestore();
    }
  });

  it('persists the broadcast marker before sending recorded bytes', async () => {
    const t = await preparationSetup();

    let releaseSave: (() => void) | undefined;

    try {
      const prepared = await t.coordinator.prepareAttempt(t.options);
      const allocated = t.save.mock.calls[0]![0];

      t.save.mockClear();

      const request = vi.fn(async () => t.signed.transactionHash);
      const publicClient = { request } as unknown as PublicClient;

      t.save.mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseSave = resolve;
      }));

      // The allocation filled capacity, but its broadcast remains allowed.
      expect(t.coordinator.status.open).toBe(false);
      expect(t.coordinator.canBroadcast).toBe(true);

      const broadcasting = t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: prepared.attemptId,
      }, 11);

      await vi.waitFor(() => {
        expect(t.save).toHaveBeenCalledTimes(1);
      });

      expect(request).not.toHaveBeenCalled();
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.attempts[2]!.phase).toBe('signed');

      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: prepared.attemptId,
      })).rejects.toThrow('already in progress');

      releaseSave!();

      const result = await broadcasting;
      const saved = t.save.mock.calls[0]![0];

      expect(saved.nextNonce).toBe(7n);
      expect(saved.durableNextNonce).toBe(4n);
      expect(saved.attempts.slice(0, 2)).toEqual(allocated.attempts.slice(0, 2));

      expect(saved.attempts[2]).toEqual({
        ...allocated.attempts[2]!,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      });

      expect(request).toHaveBeenCalledExactlyOnceWith({
        method: 'eth_sendRawTransaction',
        params: [t.signed.signedTransaction],
      }, {
        retryCount: 0,
      });

      expect(result).toEqual({
        ...prepared,
        status: 'acknowledged',
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
      });

      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: prepared.attemptId,
      })).rejects.toThrow('Fresh reconciliation is required');

      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      releaseSave?.();
      t.signing.mockRestore();
    }
  });

  it('rejects broadcasting an included attempt without consuming the permit', async () => {
    const t = await preparationSetup();

    try {
      await t.coordinator.prepareAttempt(t.options);
      t.save.mockClear();

      const request = vi.fn(async () => t.signed.transactionHash);

      await expect(t.coordinator.broadcastAttempt({
        publicClient: { request } as unknown as PublicClient,
        attemptId: t.snapshot.attempts[0]!.attemptId,
      })).rejects.toThrow('Broadcast does not match a recorded attempt');

      expect(t.save).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(t.coordinator.canBroadcast).toBe(true);
    } finally {
      t.signing.mockRestore();
    }
  });

  it('retries a failed broadcast marker without sending or restoring its permit', async () => {
    const t = await preparationSetup();

    try {
      const prepared = await t.coordinator.prepareAttempt(t.options);
      t.save.mockClear();

      const request = vi.fn(async () => t.signed.transactionHash);
      const publicClient = { request } as unknown as PublicClient;

      t.save.mockRejectedValueOnce(new Error('Injected marker failure'));

      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: prepared.attemptId,
      })).rejects.toThrow('Journal persistence');

      const pending = t.save.mock.calls[0]![0];

      expect(request).not.toHaveBeenCalled();
      expect(t.coordinator.attempts[2]!.phase).toBe('signed');
      expect(t.coordinator.status.primaryReason).toBe('persistence-failure');

      await t.coordinator.retryPersistence();

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(t.coordinator.attempts[2]!.phase)
        .toBe('broadcast-may-have-occurred');

      expect(request).not.toHaveBeenCalled();
      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: prepared.attemptId,
      })).rejects.toThrow('Fresh reconciliation is required');

      expect(request).not.toHaveBeenCalled();
      expect(t.signing).toHaveBeenCalledTimes(1);
    } finally {
      t.signing.mockRestore();
    }
  });

  it.each(['rpc-failure', 'unexpected-hash'] as const)(
    'requires reconciliation after broadcast %s',
    async (failureKind) => {
      const t = await preparationSetup();

      try {
        const prepared = await t.coordinator.prepareAttempt(t.options);
        t.save.mockClear();

        const request = vi.fn(async () => t.signed.transactionHash);

        if (failureKind === 'rpc-failure') {
          request.mockRejectedValueOnce(new Error(
            `Injected failure ${t.signed.signedTransaction} ${KEY}`,
          ));
        } else {
          request.mockResolvedValueOnce(`0x${'ee'.repeat(32)}`);
        }

        const publicClient = { request } as unknown as PublicClient;

        const failure = await t.coordinator.broadcastAttempt({
          publicClient,
          attemptId: prepared.attemptId,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('Reconciliation is required');
        expect(failure).not.toHaveProperty('cause');
        expect(String(failure)).not.toContain(t.signed.signedTransaction);
        expect(String(failure)).not.toContain(KEY);

        expect(t.coordinator.attempts[2]!.phase)
          .toBe('broadcast-may-have-occurred');

        expect(t.coordinator.canBroadcast).toBe(false);
        expect(t.coordinator.status).toMatchObject({
          open: false,
          recoveryComplete: false,
          inclusionChecksComplete: false,
        });

        await expect(t.coordinator.broadcastAttempt({
          publicClient,
          attemptId: prepared.attemptId,
        })).rejects.toThrow('Fresh reconciliation is required');

        expect(t.save).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        t.signing.mockRestore();
      }
    },
  );

  it('authorizes one rebroadcast of the oldest unresolved attempt after recovery', async () => {
    const t = await searchSetup();
    const first = t.snapshot.attempts[0]!;
    const transaction =
      first.signedTransactions[first.signedTransactions.length - 1]!;

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce({
      status: 'unresolved',
      observation: {
        anchor: OBSERVED_AT,
        nonce: first.nonce,
      },
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    });

    const request = vi.fn(async () => transaction.transactionHash);
    const publicClient = { request } as unknown as PublicClient;

    try {
      expect(t.coordinator.canBroadcast).toBe(false);

      await t.coordinator.recover({
        publicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 5n,
      });

      expect(t.coordinator.canBroadcast).toBe(true);
      expect(t.coordinator.status.open).toBe(false);

      // A later unresolved record cannot use the first record's permit.
      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: t.snapshot.attempts[1]!.attemptId,
      })).rejects.toThrow('Broadcast does not match a recorded attempt');

      expect(t.coordinator.canBroadcast).toBe(true);
      expect(request).not.toHaveBeenCalled();

      const recoveredSnapshot = t.save.mock.calls[0]![0];

      const result = await t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: first.attemptId,
      });

      expect(result).toEqual({
        status: 'acknowledged',
        attemptId: first.attemptId,
        transactionHash: transaction.transactionHash,
        nonce: first.nonce,
      });

      expect(request).toHaveBeenCalledExactlyOnceWith({
        method: 'eth_sendRawTransaction',
        params: [transaction.signedTransaction],
      }, {
        retryCount: 0,
      });

      // The record already had a durable broadcast marker.
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(recoveredSnapshot.nextNonce).toBe(6n);
      expect(recoveredSnapshot.durableNextNonce).toBe(4n);
      expect(recoveredSnapshot.attempts).toHaveLength(2);

      expect(t.coordinator.canBroadcast).toBe(false);

      await expect(t.coordinator.broadcastAttempt({
        publicClient,
        attemptId: first.attemptId,
      })).rejects.toThrow('Fresh reconciliation is required');

      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      inspect.mockRestore();
    }
  });

  it('does not authorize rebroadcast when recovery observes the nonce consumed', async () => {
    const t = await searchSetup();

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce({
      status: 'unresolved',
      observation: t.snapshot.lastObservation,
      receipt: {
        status: 'receipt-not-found',
      },
      search: t.progress.result,
    });

    try {
      await t.coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 5n,
      });

      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.status.open).toBe(false);
      expect(t.save).toHaveBeenCalledTimes(1);
    } finally {
      inspect.mockRestore();
    }
  });

  it('does not use an included oldest record to authorize a later unresolved record', async () => {
    const t = await searchSetup(true);

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce({
      status: 'unresolved',
      observation: {
        anchor: OBSERVED_AT,
        nonce: t.snapshot.attempts[0]!.nonce,
      },
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    });

    try {
      await t.coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 5n,
      });

      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.attempts.map((attempt) => attempt.phase))
        .toEqual([
          'included',
          'broadcast-may-have-occurred',
        ]);
    } finally {
      inspect.mockRestore();
    }
  });

  it('requires fresh recovery after retrying a failed rebroadcast observation', async () => {
    const t = await searchSetup();
    const first = t.snapshot.attempts[0]!;

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValue({
      status: 'unresolved',
      observation: {
        anchor: OBSERVED_AT,
        nonce: first.nonce,
      },
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    });

    const options = {
      publicClient: {} as PublicClient,
      anchor: OBSERVED_AT,
      maxBlockRange: 5n,
    };

    t.save.mockRejectedValueOnce(new Error('Injected recovery write failure'));

    try {
      await expect(t.coordinator.recover(options))
        .rejects.toThrow('Journal persistence');

      const pending = t.save.mock.calls[0]![0];

      expect(t.coordinator.canBroadcast).toBe(false);

      await t.coordinator.retryPersistence();

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.status.recoveryComplete).toBe(false);

      await t.coordinator.recover(options);

      expect(inspect).toHaveBeenCalledTimes(2);
      expect(t.coordinator.canBroadcast).toBe(true);
    } finally {
      inspect.mockRestore();
    }
  });

  it('does not authorize rebroadcast while a coordinator blocker remains', async () => {
    const t = await searchSetup();

    t.coordinator.block('conflict-search-exhausted');

    const inspect = vi.spyOn(
      recoveryInspection,
      'inspectSignerRecovery',
    ).mockResolvedValueOnce({
      status: 'unresolved',
      observation: {
        anchor: OBSERVED_AT,
        nonce: t.snapshot.attempts[0]!.nonce,
      },
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    });

    try {
      await t.coordinator.recover({
        publicClient: {} as PublicClient,
        anchor: OBSERVED_AT,
        maxBlockRange: 5n,
      });

      expect(t.coordinator.status.blockers)
        .toContain('conflict-search-exhausted');
      expect(t.coordinator.canBroadcast).toBe(false);
    } finally {
      inspect.mockRestore();
    }
  });
});