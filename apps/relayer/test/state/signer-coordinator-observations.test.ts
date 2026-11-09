import {
  afterEach,
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
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';
import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';
import {
  DurableRecoverySchedule,
} from '../../src/state/durable-recovery-schedule.js';
import * as inclusionPlanner from '../../src/state/plan-signer-inclusions.js';
import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';
import {
  SignerRecoveryCycle,
} from '../../src/state/signer-recovery-cycle.js';
import type {
  JournalAttempt,
  TransactionJournalRead,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);
const IDENTITY = { chainId: 4663, signer: ACCOUNT.address };
const OTHER = `0x${'bb'.repeat(32)}` as const;
const CLAIM = `0x${'cc'.repeat(32)}` as const;

function hashAt(height: bigint): Hash {
  return `0x${height.toString(16).padStart(64, '0')}`;
}

function anchorAt(height: bigint) {
  return { blockNumber: height, blockHash: hashAt(height) };
}

const DURABLE = anchorAt(100n);
const HEAD = anchorAt(130n);

function receipt(hash: Hash, height = 90n, blockHash = hashAt(height)) {
  return {
    transactionHash: hash,
    blockNumber: height,
    blockHash,
    status: 'success' as const,
  };
}

async function setup(options: {
  count?: number;
  variants?: number;
  higherObservation?: boolean;
  invalidSearchBoundary?: boolean;
} = {}) {
  const attempts: JournalAttempt[] = [];
  const count = options.count ?? 1;

  for (let index = 0; index < count; index += 1) {
    const nonce = 4 + index;
    const signed = [];

    for (let variant = 0; variant < (options.variants ?? 1); variant += 1) {
      const signedTransaction = await ACCOUNT.signTransaction({
        type: 'eip1559',
        chainId: IDENTITY.chainId,
        nonce,
        to: ACCOUNT.address,
        gas: 21_000n,
        maxFeePerGas: BigInt(2 + variant),
        maxPriorityFeePerGas: 1n,
      });

      signed.push({
        signedTransaction,
        transactionHash: keccak256(signedTransaction),
      });
    }

    const [first, ...rest] = signed;
    if (first === undefined) {
      throw new Error('Expected a signed fixture transaction.');
    }

    let replacementSearch = null;
    if (index === 1 && options.invalidSearchBoundary) {
      replacementSearch = {
        exhausted: null,
        lowerBound: { anchor: DURABLE, nonce: 4n },
        searchedThrough: null,
      };
    }

    attempts.push({
      attemptId: `11111111-1111-4111-8111-${String(nonce).padStart(12, '0')}`,
      workId: `test-work:${nonce}`,
      nonce: BigInt(nonce),
      createdAt: '2026-11-08T00:00:00.000Z',
      signedTransactions: [first, ...rest],
      phase: 'signed',
      inclusion: null,
      replacementSearch,
    });
  }

  let visible: TransactionJournalRead = {
    kind: 'present',
    snapshot: {
      version: 1,
      identity: IDENTITY,
      baseline: { anchor: DURABLE, nonce: 4n },
      lastObservation: {
        anchor: options.higherObservation ? HEAD : DURABLE,
        nonce: options.higherObservation ? 9n : 4n,
      },
      nextNonce: 4n + BigInt(count),
      durableNextNonce: 4n,
      repairs: [],
      attempts,
    },
  };

  const save = vi.fn<TransactionJournalStore['save']>(async (snapshot) => {
    visible = { kind: 'present', snapshot };
  });
  const coordinator = await SignerCoordinator.create({
    identity: IDENTITY,
    maxRetainedAttempts: 16,
    store: { load: async () => visible, save },
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      destination: { write() {} },
    }),
    createErrorSummary: (secrets = []) => ({
      scrubText: createScrubber({ privateKey: KEY, rpcUrls: [], secrets }),
    }),
  });

  const getBlock = vi.fn(async ({ blockNumber }: {
    blockNumber: bigint;
    includeTransactions?: boolean;
  }) => ({
    number: blockNumber,
    hash: hashAt(blockNumber),
    parentHash: hashAt(blockNumber - 1n),
    transactions: [],
  }));
  const getTransactionReceipt = vi.fn(async ({ hash }: {
    hash: Hash;
  }): Promise<ReturnType<typeof receipt>> => {
    throw new TransactionReceiptNotFoundError({ hash });
  });
  const getTransactionCount = vi.fn(async () => 4);
  const request = vi.fn(async () =>
    attempts[0]!.signedTransactions[0].transactionHash,
  );
  const publicClient = {
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    request,
  } as unknown as PublicClient;
  const recovery = { publicClient, anchor: DURABLE, maxBlockRange: 2n };
  const latest = { publicClient, head: HEAD };
  const begin = () => coordinator.beginInspection({
    publicClient,
    head: HEAD,
    durableAnchor: DURABLE,
  });

  return {
    coordinator,
    save,
    attempts,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    request,
    recovery,
    latest,
    begin,
    visible: () => visible,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('inspection block-hash consistency', () => {
  it.each([false, true])(
    'compares latest headers with durable fork-served observations; changed: %s',
    async (changed) => {
      const t = await setup();
      const planner = vi.spyOn(inclusionPlanner, 'planSignerInclusions');
      const owner = t.begin();

      t.getTransactionReceipt.mockImplementation(async ({ hash }) =>
        receipt(hash, 90n, CLAIM),
      );
      await owner.recover(t.recovery);
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.save).toHaveBeenCalledOnce();
      const durableCommit = t.visible();

      const read = t.getBlock.getMockImplementation()!;
      t.getBlock.mockImplementation(async (input) => {
        const block = await read(input);
        if (changed && input.blockNumber === 90n) {
          return { ...block, hash: OTHER };
        }
        return block;
      });

      const result = await owner.checkInclusions(t.latest);

      if (changed) {
        expect(result.status).toBe('inconsistent-observations');
        expect(planner).not.toHaveBeenCalled();
        expect(t.save).toHaveBeenCalledOnce();
        expect(t.visible()).toBe(durableCommit);
        expect(() => owner.finish()).toThrow('bracket has not completed');
        await owner.abandon();
        expect(t.coordinator.canBroadcast).toBe(false);
      } else {
        expect(result.status).toBe('inspected');
        expect(planner).toHaveBeenCalledOnce();
        expect(t.coordinator.canBroadcast).toBe(false);
        owner.finish();
        expect(t.coordinator.canBroadcast).toBe(true);
        expect(t.save).toHaveBeenCalledTimes(2);
      }
    },
  );

  it('compares latest receipt headers against admitted replacement-search progress', async () => {
    const t = await setup();
    const recovery = { ...t.recovery, anchor: anchorAt(105n) };
    const owner = t.coordinator.beginInspection({
      publicClient: recovery.publicClient,
      head: HEAD,
      durableAnchor: recovery.anchor,
    });
    const read = t.getBlock.getMockImplementation()!;
    let receiptReads = 0;
    let blockReads = 0;

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      receiptReads += 1;
      if (receiptReads === 1) {
        throw new TransactionReceiptNotFoundError({ hash });
      }
      return receipt(hash, 101n, CLAIM);
    });
    t.getBlock.mockImplementation(async (input) => {
      const block = await read(input);
      if (input.blockNumber === 101n && ++blockReads === 2) {
        return { ...block, hash: OTHER };
      }
      return block;
    });
    t.getTransactionCount.mockResolvedValue(5);

    expect(await owner.recover(recovery)).toMatchObject({
      status: 'unresolved',
      search: { status: 'not-found', scannedBlocks: 2n, remainingBlocks: 3n },
    });
    const committed = t.visible();
    expect(committed).toMatchObject({
      kind: 'present',
      snapshot: {
        attempts: [{
          replacementSearch: { searchedThrough: anchorAt(102n) },
        }],
      },
    });

    expect((await owner.checkInclusions(t.latest)).status).toBe('inconsistent-observations');
    expect(blockReads).toBe(2);
    expect(t.save).toHaveBeenCalledOnce();
    expect(t.visible()).toBe(committed);
    await owner.abandon();
    expect(t.coordinator.canBroadcast).toBe(false);
  });

  it('preserves the first acknowledged resolution when a later durable segment contradicts it', async () => {
    const t = await setup({ count: 2 });
    const firstHash = t.attempts[0]!.signedTransactions[0].transactionHash;
    let first = true;
    const read = t.getBlock.getMockImplementation()!;

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      first = hash === firstHash;
      return receipt(hash, 90n, first ? hashAt(90n) : OTHER);
    });
    t.getBlock.mockImplementation(async (input) => {
      const block = await read(input);
      if (input.blockNumber === 90n && !first) {
        return { ...block, hash: OTHER };
      }
      return block;
    });
    t.getTransactionCount.mockResolvedValue(6);
    const owner = t.begin();

    expect((await owner.recover(t.recovery)).status).toBe('resolution-available');
    const committed = t.visible();
    expect((await owner.recover(t.recovery)).status).toBe('inconsistent-observations');

    expect(t.visible()).toBe(committed);
    expect(t.save).toHaveBeenCalledOnce();
    expect(t.coordinator.attempts.map((attempt) => attempt.nonce)).toEqual([5n]);
    expect(t.coordinator.status.recoveryComplete).toBe(false);
    await owner.abandon();
    expect(t.coordinator.canBroadcast).toBe(false);
  });

  it.each(['same', 'different', 'different-case'] as const)(
    'checks repeated heights within one durable receipt bracket: %s hashes',
    async (kind) => {
      const t = await setup({ variants: 2 });
      const read = t.getBlock.getMockImplementation()!;
      let reads = 0;
      let secondHash: Hash = hashAt(90n);

      if (kind === 'different') {
        secondHash = OTHER;
      } else if (kind === 'different-case') {
        secondHash = `0x${hashAt(90n).slice(2).toUpperCase()}`;
      }

      t.getBlock.mockImplementation(async (input) => {
        const block = await read(input);
        if (input.blockNumber === 90n && ++reads === 2) {
          return { ...block, hash: secondHash };
        }
        return block;
      });
      const [original, replacement] = t.attempts[0]!.signedTransactions;
      t.getTransactionReceipt
        .mockResolvedValueOnce(receipt(original!.transactionHash, 90n, CLAIM))
        .mockResolvedValueOnce(receipt(replacement!.transactionHash, 90n, secondHash));
      t.getTransactionCount.mockResolvedValue(5);
      const owner = t.begin();
      const result = await owner.recover(t.recovery);

      if (kind === 'different') {
        expect(result.status).toBe('inconsistent-observations');
        expect(t.save).not.toHaveBeenCalled();
        expect(t.coordinator.attempts).toHaveLength(1);
      } else {
        expect(result.status).toBe('resolution-available');
        expect(t.save).toHaveBeenCalledOnce();
        expect(t.coordinator.attempts).toHaveLength(0);
      }

      expect(reads).toBe(2);
      await owner.abandon();
      expect(t.coordinator.canBroadcast).toBe(false);
    },
  );

  it.each(['owned', 'standalone'] as const)(
    'rejects differing latest-only headers at the same height through the %s entry',
    async (entry) => {
      const t = await setup({ count: 2 });
      const owner = entry === 'owned' ? t.begin() : null;

      if (owner === null) {
        await t.coordinator.recover(t.recovery);
      } else {
        await owner.recover(t.recovery);
      }

      const committed = t.visible();
      const read = t.getBlock.getMockImplementation()!;
      let reads = 0;
      t.getTransactionReceipt.mockImplementation(async ({ hash }) =>
        receipt(hash, 110n, CLAIM),
      );
      t.getBlock.mockImplementation(async (input) => {
        const block = await read(input);
        if (input.blockNumber === 110n && ++reads === 2) {
          return { ...block, hash: OTHER };
        }
        return block;
      });

      const result = owner === null
        ? await t.coordinator.checkInclusions(t.latest)
        : await owner.checkInclusions(t.latest);

      expect(result.status).toBe('inconsistent-observations');
      expect(t.visible()).toBe(committed);
      expect(t.save).toHaveBeenCalledOnce();
      expect(reads).toBe(2);

      if (owner !== null) {
        await owner.abandon();
      }
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.coordinator.status.open).toBe(false);
    },
  );

  it('does not promote an above-durable receipt read into the consistency set', async () => {
    const t = await setup();
    const owner = t.begin();
    const read = t.getBlock.getMockImplementation()!;
    let reads = 0;

    t.getTransactionReceipt.mockImplementation(async ({ hash }) =>
      receipt(hash, 110n, CLAIM),
    );
    t.getBlock.mockImplementation(async (input) => {
      const block = await read(input);
      if (input.blockNumber === 110n && ++reads === 2) {
        return { ...block, hash: OTHER };
      }
      return block;
    });

    expect((await owner.recover(t.recovery)).status).toBe('unresolved');
    expect((await owner.checkInclusions(t.latest)).status).toBe('inspected');
    owner.finish();

    expect(reads).toBe(2);
    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.coordinator.canBroadcast).toBe(true);
  });
});

describe('durable evidence admission and lifetime', () => {
  it.each([false, true])(
    'uses the planner disposition before admitting a skipped segment; invalid search: %s',
    async (invalidSearchBoundary) => {
      const t = await setup({
        count: 2,
        higherObservation: true,
        invalidSearchBoundary,
      });
      const owner = t.begin();
      const firstHash = t.attempts[0]!.signedTransactions[0].transactionHash;
      const read = t.getBlock.getMockImplementation()!;
      let first = true;

      t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
        first = hash === firstHash;
        return receipt(hash, 90n, first ? hashAt(90n) : CLAIM);
      });
      t.getBlock.mockImplementation(async (input) => {
        const block = await read(input);
        if (input.blockNumber === 90n && !first) {
          return { ...block, hash: OTHER };
        }
        return block;
      });
      t.getTransactionCount.mockResolvedValue(6);

      expect((await owner.recover(t.recovery)).status).toBe('resolution-available');
      expect(t.save.mock.calls[0]![0].lastObservation.nonce).toBe(9n);
      const committed = t.visible();
      const result = await owner.recover(t.recovery);

      // A valid preservation-only skip admits its observations and detects the
      // contradictory hash. An invalid search never reaches evidence admission.
      if (invalidSearchBoundary) {
        expect(result).toMatchObject({
          status: 'unresolved',
          search: { status: 'anchor-behind-search' },
        });
      } else {
        expect(result.status).toBe('inconsistent-observations');
      }

      expect(t.save).toHaveBeenCalledOnce();
      expect(t.visible()).toBe(committed);
      expect(t.coordinator.status.recoveryComplete).toBe(false);
      await owner.abandon();
      expect(t.coordinator.canBroadcast).toBe(false);
    },
  );

  it.each(['finished', 'abandoned', 'persistence-failed'] as const)(
    'starts with fresh evidence after the previous inspection %s',
    async (ending) => {
      const t = await setup();
      const first = t.begin();
      const read = t.getBlock.getMockImplementation()!;
      t.getTransactionReceipt.mockImplementation(async ({ hash }) =>
        receipt(hash, 90n, CLAIM),
      );

      if (ending === 'persistence-failed') {
        t.save.mockRejectedValueOnce(new Error('Injected storage failure.'));
        await expect(first.recover(t.recovery)).rejects.toThrow();
        await expect(first.checkInclusions(t.latest)).rejects.toThrow();
      } else {
        await first.recover(t.recovery);
      }

      if (ending === 'finished') {
        await first.checkInclusions(t.latest);
        first.finish();
      } else {
        await first.abandon();
      }

      if (ending === 'persistence-failed') {
        await t.coordinator.retryPersistence();
      }

      t.getBlock.mockImplementation(async (input) => {
        const block = await read(input);
        if (input.blockNumber === 90n) {
          return { ...block, hash: OTHER };
        }
        return block;
      });

      const second = t.begin();
      expect((await second.recover(t.recovery)).status).toBe('unresolved');
      expect((await second.checkInclusions(t.latest)).status).toBe('inspected');
      second.finish();
      expect(t.coordinator.canBroadcast).toBe(true);
    },
  );

  it('invalidates the cycle reuse conclusion after a latest hash contradiction', async () => {
    const t = await setup({ count: 2 });
    const durableSchedule = new DurableRecoverySchedule({
      refreshIntervalMs: 10_000,
      now: () => 0,
    });
    const recorded = vi.spyOn(durableSchedule, 'recordCompleted');
    const cycle = new SignerRecoveryCycle({
      coordinator: t.coordinator,
      schedule: new BroadcastRetrySchedule({
        initialDelayMs: 100,
        maxDelayMs: 400,
        now: () => 0,
      }),
      durableSchedule,
    });
    const firstHash = t.attempts[0]!.signedTransactions[0].transactionHash;
    const read = t.getBlock.getMockImplementation()!;
    let secondAttemptReads = 0;
    let blockReads = 0;

    t.getTransactionReceipt.mockImplementation(async ({ hash }) => {
      if (hash === firstHash) {
        return receipt(hash);
      }

      secondAttemptReads += 1;
      if (secondAttemptReads === 1) {
        // The second durable segment completes with an absent receipt.
        throw new TransactionReceiptNotFoundError({ hash });
      }

      return receipt(hash, 90n, CLAIM);
    });
    t.getTransactionCount.mockResolvedValue(5);
    t.getBlock.mockImplementation(async (input) => {
      const block = await read(input);
      if (input.blockNumber === 90n && ++blockReads === 2) {
        // Completion was recorded after the durable loop. The latest pass
        // now contradicts a header from the acknowledged first resolution.
        expect(durableSchedule.isDue(DURABLE)).toBe(false);
        return { ...block, hash: OTHER };
      }
      return block;
    });

    const result = await cycle.run({ ...t.recovery, head: HEAD });

    expect(recorded).toHaveBeenCalledOnce();
    expect(result.inclusions?.status).toBe('inconsistent-observations');
    expect(durableSchedule.isDue(DURABLE)).toBe(true);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.coordinator.attempts.map((attempt) => attempt.nonce)).toEqual([5n]);
    expect(t.coordinator.canBroadcast).toBe(false);
  });
});
