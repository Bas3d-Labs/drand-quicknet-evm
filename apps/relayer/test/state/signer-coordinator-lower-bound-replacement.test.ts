import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import * as inclusionInspection from '../../src/chain/inspect-signer-inclusions.js';
import { createRelayerLog } from '../../src/diagnostics/relayer-log.js';
import { createScrubber } from '../../src/diagnostics/text-scrubber.js';
import { BroadcastRetrySchedule } from '../../src/state/broadcast-retry-schedule.js';
import { DurableRecoverySchedule } from '../../src/state/durable-recovery-schedule.js';
import { FileTransactionJournalStore } from '../../src/state/file-transaction-journal-store.js';
import { isDurableRecoveryComplete } from '../../src/state/is-durable-recovery-complete.js';
import { SignerCoordinator } from '../../src/state/signer-coordinator.js';
import { SignerRecoveryCycle } from '../../src/state/signer-recovery-cycle.js';
import type {
  JournalAttempt,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);
const IDENTITY = { chainId: 4663, signer: ACCOUNT.address };
const HASH = `0x${'aa'.repeat(32)}` as const;
const FORK = `0x${'bb'.repeat(32)}` as const;
const LOWER = { anchor: { blockNumber: 100n, blockHash: HASH }, nonce: 4n };
const FACT = { anchor: { blockNumber: 120n, blockHash: HASH }, nonce: 6n };
const DURABLE = { blockNumber: 125n, blockHash: HASH };
const HEAD = { blockNumber: 130n, blockHash: HASH };
const REPLACEMENT = { anchor: { blockNumber: 100n, blockHash: FORK }, nonce: 4n };

afterEach(() => vi.restoreAllMocks());

async function snapshot(survivorFact = false, preserve = false): Promise<TransactionJournalSnapshot> {
  const attempts: JournalAttempt[] = [];
  for (const nonce of [4, 5]) {
    const signedTransaction = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: IDENTITY.chainId,
      nonce,
      gas: 21_000n,
      to: ACCOUNT.address,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    let replacementSearch = null;
    if (nonce === 4 || survivorFact) {
      replacementSearch = {
        lowerBound: LOWER,
        searchedThrough: FACT.anchor,
        exhausted: FACT,
      };
    }
    attempts.push({
      attemptId: `11111111-1111-4111-8111-11111111111${nonce}`,
      workId: `lower-bound:${nonce}`,
      nonce: BigInt(nonce),
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      createdAt: '2026-10-04T00:00:00.000Z',
      signedTransactions: [{ transactionHash: keccak256(signedTransaction), signedTransaction }],
      replacementSearch,
    });
  }
  let lastNonce = 6n;
  if (preserve) {
    lastNonce = 9n;
  }
  return {
    version: 1,
    identity: IDENTITY,
    baseline: LOWER,
    lastObservation: { anchor: HEAD, nonce: lastNonce },
    nextNonce: 6n,
    durableNextNonce: 4n,
    repairs: [],
    attempts,
  };
}

function summaries(attempts: readonly JournalAttempt[]) {
  return attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    workId: attempt.workId,
    nonce: attempt.nonce,
    phase: attempt.phase,
    transactionHashes: attempt.signedTransactions.map((signed) => signed.transactionHash),
  }));
}

function client() {
  const getBlock = vi.fn<PublicClient['getBlock']>().mockImplementation(async (request) => {
    const height = request?.blockNumber;
    let hash = HASH as `0x${string}`;
    if (height === 100n || height === 120n) {
      hash = FORK;
    }
    let parentHash = HASH as `0x${string}`;
    if (height === 101n) {
      parentHash = FORK;
    }
    return { number: height, hash, parentHash, transactions: [] } as never;
  });
  const getTransactionCount = vi.fn<PublicClient['getTransactionCount']>()
    .mockImplementation(async (request) => {
      if (request.blockNumber === 100n) {
        return 4;
      }
      return 6;
    });
  const getTransactionReceipt = vi.fn<PublicClient['getTransactionReceipt']>()
    .mockImplementation(async (request) => {
      throw new TransactionReceiptNotFoundError(request);
    });
  const sendRawTransaction = vi.fn();
  const publicClient = {
    getBlock,
    getTransactionCount,
    getTransactionReceipt,
    sendRawTransaction,
  } as unknown as PublicClient;
  return { publicClient, getBlock, getTransactionCount, getTransactionReceipt, sendRawTransaction };
}

function context(eventName = 'signer_search_lower_bound_replaced') {
  const lines: string[] = [];
  const createErrorSummary = (secrets: readonly string[] = []) => ({
    scrubText: createScrubber({ privateKey: KEY, rpcUrls: [], secrets }),
  });
  const log = createRelayerLog({
    chainId: IDENTITY.chainId,
    errorSummary: createErrorSummary(),
    destination: { write: (line) => { lines.push(line); } },
  });
  return {
    events: () => lines.map((line) => JSON.parse(line))
      .filter((record) => record.event === eventName),
    create: (store: TransactionJournalStore) => SignerCoordinator.create({
      identity: IDENTITY,
      store,
      maxRetainedAttempts: 3,
      log,
      createErrorSummary,
    }),
  };
}

function cycleFor(coordinator: SignerCoordinator) {
  const durableSchedule = new DurableRecoverySchedule({ refreshIntervalMs: 60_000, now: () => 0 });
  const completed = vi.spyOn(durableSchedule, 'recordCompleted');
  const cycle = new SignerRecoveryCycle({
    coordinator,
    schedule: new BroadcastRetrySchedule({ initialDelayMs: 100, maxDelayMs: 1000 }),
    durableSchedule,
  });
  return { cycle, durableSchedule, completed };
}

function options(publicClient: PublicClient) {
  return { publicClient, anchor: DURABLE, head: HEAD, maxBlockRange: 2n };
}

describe('acknowledged lower-bound replacement', () => {
  it.each([
    { failFirst: false, survivor: false, preserve: false },
    { failFirst: true, survivor: false, preserve: false },
    { failFirst: false, survivor: true, preserve: true },
    { failFirst: true, survivor: true, preserve: true },
  ])('publishes only on ack and keeps recovery incomplete: %j', async ({ failFirst, survivor, preserve }) => {
    const directory = await mkdtemp(join(tmpdir(), 'lower-bound-write-'));
    try {
      const input = await snapshot(survivor, preserve);
      const filePath = join(directory, 'journal.json');
      const store = await FileTransactionJournalStore.open({ filePath, identity: IDENTITY });
      await store.save(input);
      const initialBytes = await readFile(filePath, 'utf8');
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      const save = vi.fn(async (next: TransactionJournalSnapshot) => {
        writes += 1;
        if (writes === 1) {
          entered();
          await held;
          if (failFirst) {
            throw new Error('Injected replacement save failure');
          }
        }
        await store.save(next);
      });
      const t = context();
      const coordinator = await t.create({ load: () => store.load(), save });
      const revision = coordinator.durableRecoveryRevision;
      const rpc = client();
      const { cycle, durableSchedule, completed } = cycleFor(coordinator);
      const latest = vi.spyOn(inclusionInspection, 'inspectSignerInclusions');
      const pending = cycle.run(options(rpc.publicClient), 17).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      await started;
      const expected = {
        ...input,
        lastObservation: { anchor: DURABLE, nonce: 6n },
        attempts: [{
          ...input.attempts[0]!,
          replacementSearch: { lowerBound: REPLACEMENT, searchedThrough: null, exhausted: null },
        }, input.attempts[1]!],
      };
      if (preserve) {
        expected.lastObservation = input.lastObservation;
      }
      try {
        expect(save.mock.calls[0]![0]).toEqual(expected);
        expect(coordinator.attempts).toEqual(summaries(input.attempts));
        expect(coordinator.durableRecoveryRevision).toBe(revision);
        expect(coordinator.status.blockers).toContain('conflict-search-exhausted');
        expect(coordinator.status.open).toBe(false);
        expect(coordinator.canBroadcast).toBe(false);
        expect(t.events()).toEqual([]);
        expect(() => coordinator.beginInspection()).toThrow('already in progress');
        expect(await readFile(filePath, 'utf8')).toBe(initialBytes);
        const before = await t.create(await FileTransactionJournalStore.open({ filePath, identity: IDENTITY }));
        expect(before.status.blockers).toContain('conflict-search-exhausted');
        expect(before.attempts).toEqual(summaries(input.attempts));
      } finally {
        release();
      }
      const outcome = await pending;
      let eventCycle = 17;
      if (failFirst) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(t.events()).toEqual([]);
        expect(coordinator.status.persistenceState).toBe('failed');
        expect(coordinator.attempts).toEqual(summaries(input.attempts));
        expect(coordinator.durableRecoveryRevision).toBe(revision);
        expect(await readFile(filePath, 'utf8')).toBe(initialBytes);
        await coordinator.retryPersistence(18);
        eventCycle = 18;
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1]![0]).toBe(save.mock.calls[0]![0]);
      } else {
        expect(outcome.error).toBeNull();
        expect(outcome.result).toMatchObject({
          inspection: { status: 'search-lower-bound-replacement-required' },
          inclusions: null,
          broadcast: null,
        });
        expect(save).toHaveBeenCalledTimes(1);
      }
      expect(await store.load()).toEqual({ kind: 'present', snapshot: expected });
      expect(coordinator.attempts).toEqual(summaries(expected.attempts));
      expect(coordinator.status.blockers.includes('conflict-search-exhausted')).toBe(survivor);
      expect(coordinator.status.blockers.includes('unattributed-signer-activity')).toBe(preserve);
      expect(coordinator.durableRecoveryRevision).not.toBe(revision);
      expect(coordinator.status.recoveryComplete).toBe(false);
      expect(coordinator.status.inclusionChecksComplete).toBe(false);
      expect(coordinator.status.open).toBe(false);
      expect(coordinator.canBroadcast).toBe(false);
      expect(latest).not.toHaveBeenCalled();
      expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
      expect(rpc.getBlock.mock.calls.every(([request]) => !request?.includeTransactions)).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      expect(durableSchedule.isDue(DURABLE)).toBe(true);
      expect(t.events()).toEqual([expect.objectContaining({
        level: 40,
        cycle: eventCycle,
        signer: ACCOUNT.address,
        attemptId: input.attempts[0]!.attemptId,
        nonce: '4',
        oldLowerBlock: '100',
        oldLowerBlockHash: HASH,
        oldLowerNonce: '4',
        observedLowerBlock: '100',
        observedLowerBlockHash: FORK,
        replacementBlock: '100',
        replacementBlockHash: FORK,
        replacementNonce: '4',
        durableBlock: '125',
        durableBlockHash: HASH,
        durableNonce: '6',
        probeCount: '1',
        invalidatedFact: {
          expectedBlock: '120',
          expectedBlockHash: HASH,
          observedBlock: '120',
          observedBlockHash: FORK,
        },
      })]);
      await expect(coordinator.retryPersistence(19)).rejects.toThrow('No failed journal write');
      expect(t.events()).toHaveLength(1);
      const finalBytes = await readFile(filePath, 'utf8');
      const restarted = await t.create(await FileTransactionJournalStore.open({ filePath, identity: IDENTITY }));
      expect(restarted.attempts).toEqual(summaries(expected.attempts));
      expect(restarted.status.blockers.includes('conflict-search-exhausted')).toBe(survivor);
      expect(restarted.status.recoveryComplete).toBe(false);
      expect(restarted.status.open).toBe(false);
      expect(restarted.canBroadcast).toBe(false);
      expect(await readFile(filePath, 'utf8')).toBe(finalBytes);

      // The next invocation must inspect again and start after the new bound.
      if (!survivor && !preserve) {
        rpc.getBlock.mockClear();
        const next = await cycle.run(options(rpc.publicClient), 20);
        expect(next.inspection.status).toBe('unresolved');
        const fullReads = rpc.getBlock.mock.calls
          .filter(([request]) => request?.includeTransactions)
          .map(([request]) => request?.blockNumber);
        expect(fullReads).toEqual([101n, 102n, 103n, 104n]);
        expect(t.events()).toHaveLength(1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps standalone recovery incomplete and releases ownership after the correction', async () => {
    const input = await snapshot();
    const save = vi.fn();
    const t = context();
    const coordinator = await t.create({ load: async () => ({ kind: 'present', snapshot: input }), save });
    const rpc = client();
    const result = await coordinator.recover(options(rpc.publicClient));
    expect(result.status).toBe('search-lower-bound-replacement-required');
    expect(save).toHaveBeenCalledOnce();
    expect(coordinator.status.recoveryComplete).toBe(false);
    expect(coordinator.canBroadcast).toBe(false);
    expect(isDurableRecoveryComplete(result, {
      recoveryComplete: true,
      persistenceState: 'idle',
      attempts: [],
    })).toBe(false);
    coordinator.beginInspection().abandon();
  });

  it('refuses repair headers that conflict with an earlier acknowledged segment', async () => {
    const base = await snapshot(true);
    const input = {
      ...base,
      attempts: [{ ...base.attempts[0]!, replacementSearch: null }, base.attempts[1]!],
    };
    const save = vi.fn();
    const t = context();
    const coordinator = await t.create({ load: async () => ({ kind: 'present', snapshot: input }), save });
    const rpc = client();
    const originalRead = rpc.getBlock.getMockImplementation()!;
    let lowerReads = 0;
    rpc.getBlock.mockImplementation(async (request) => {
      const block = await originalRead(request);
      if (request?.blockNumber === 100n) {
        lowerReads += 1;
        if (lowerReads === 1) {
          return { ...block, hash: HASH };
        }
      }
      return block;
    });
    const hash = input.attempts[0]!.signedTransactions[0].transactionHash;
    rpc.getTransactionReceipt.mockImplementation(async (request) => {
      if (request.hash === hash) {
        return { transactionHash: hash, blockNumber: 100n, blockHash: HASH, status: 'success' } as never;
      }
      throw new TransactionReceiptNotFoundError(request);
    });
    const { cycle } = cycleFor(coordinator);
    const latest = vi.spyOn(inclusionInspection, 'inspectSignerInclusions');
    const result = await cycle.run(options(rpc.publicClient));
    expect(result.inspection.status).toBe('inconsistent-observations');
    expect(result.inclusions).toBeNull();
    expect(save).toHaveBeenCalledOnce();
    expect(coordinator.attempts).toEqual(summaries([input.attempts[1]!]));
    expect(save.mock.calls[0]![0].attempts).toEqual([input.attempts[1]]);
    expect(coordinator.status.blockers).toContain('conflict-search-exhausted');
    expect(coordinator.status.recoveryComplete).toBe(false);
    expect(coordinator.canBroadcast).toBe(false);
    expect(latest).not.toHaveBeenCalled();
    expect(t.events()).toEqual([]);
  });

  it.each([false, true])(
    'prevents continuation on a corrected inspection; unconsumed: %s',
    async (unconsumed) => {
      const input = await snapshot();
      const save = vi.fn();
      const t = context();
      const coordinator = await t.create({
        load: async () => ({ kind: 'present', snapshot: input }),
        save,
      });
      const rpc = client();

      if (unconsumed) {
        rpc.getTransactionCount.mockResolvedValue(4);
      }

      const owner = coordinator.beginInspection({
        publicClient: rpc.publicClient,
        head: HEAD,
        durableAnchor: DURABLE,
      });
      try {
        const result = await owner.recover(options(rpc.publicClient));
        let status = 'search-lower-bound-replacement-required';
        if (unconsumed) {
          status = 'search-unconsumed-bound-rebase-required';
        }
        expect(result.status).toBe(status);
        rpc.getBlock.mockClear();
        rpc.getTransactionCount.mockClear();
        rpc.getTransactionReceipt.mockClear();
        await expect(owner.recover(options(rpc.publicClient))).rejects.toThrow();
        await expect(owner.checkInclusions({ publicClient: rpc.publicClient, head: HEAD }))
          .rejects.toThrow();
        expect(() => owner.finish()).toThrow('has not completed successfully');
        expect(rpc.getBlock).not.toHaveBeenCalled();
        expect(rpc.getTransactionCount).not.toHaveBeenCalled();
        expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledOnce();
        expect(coordinator.status.recoveryComplete).toBe(false);
        expect(coordinator.canBroadcast).toBe(false);
      } finally {
        await owner.abandon();
      }
      coordinator.beginInspection().abandon();
    },
  );

  it.each(['matching-fact', 'budget-exhausted'] as const)(
    'keeps the old bound and authorization closed after %s refusal',
    async (fault) => {
      const input = await snapshot();
      const save = vi.fn();
      const t = context();
      const coordinator = await t.create({ load: async () => ({ kind: 'present', snapshot: input }), save });
      const revision = coordinator.durableRecoveryRevision;
      const rpc = client();
      if (fault === 'matching-fact') {
        const originalRead = rpc.getBlock.getMockImplementation()!;
        rpc.getBlock.mockImplementation(async (request) => {
          const block = await originalRead(request);
          if (request?.blockNumber === 120n) {
            return { ...block, hash: HASH };
          }
          return block;
        });
      } else {
        rpc.getTransactionCount.mockResolvedValue(6);
      }
      const { cycle, completed } = cycleFor(coordinator);
      const result = await cycle.run(options(rpc.publicClient));
      if (fault === 'budget-exhausted') {
        expect(result.inspection.status).toBe('search-lower-bound-replacement-unavailable');
      } else {
        expect(result.inspection.status).toBe('inconsistent-observations');
      }
      expect(result.inclusions).toBeNull();
      expect(result.broadcast).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect(coordinator.attempts).toEqual(summaries(input.attempts));
      expect(coordinator.durableRecoveryRevision).toBe(revision);
      expect(coordinator.status.blockers).toContain('conflict-search-exhausted');
      expect(coordinator.status.open).toBe(false);
      expect(coordinator.canBroadcast).toBe(false);
      expect(t.events()).toEqual([]);
    },
  );

  it('returns a changed candidate-height anchor without treating it as the selected anchor', async () => {
    const input = await snapshot();
    const save = vi.fn();
    const t = context();
    const coordinator = await t.create({ load: async () => ({ kind: 'present', snapshot: input }), save });
    const revision = coordinator.durableRecoveryRevision;
    const rpc = client();
    const originalRead = rpc.getBlock.getMockImplementation()!;
    let lowerReads = 0;
    rpc.getBlock.mockImplementation(async (request) => {
      const block = await originalRead(request);
      if (request?.blockNumber === 100n) {
        lowerReads += 1;
        if (lowerReads === 3) {
          return { ...block, hash: HASH };
        }
      }
      return block;
    });
    const { cycle, completed } = cycleFor(coordinator);
    const result = await cycle.run(options(rpc.publicClient));
    expect(result.inspection).toEqual({
      status: 'anchor-changed',
      observedAnchor: LOWER.anchor,
    });
    expect(result.inclusions).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(coordinator.attempts).toEqual(summaries(input.attempts));
    expect(coordinator.durableRecoveryRevision).toBe(revision);
    expect(coordinator.status.recoveryComplete).toBe(false);
    expect(coordinator.canBroadcast).toBe(false);
    expect(t.events()).toEqual([]);
  });
});

describe('acknowledged unconsumed bound rebase', () => {
  it.each([
    {
      preserve: false,
      failFirst: false,
      survivor: false,
    },
    {
      preserve: true,
      failFirst: false,
      survivor: false,
    },
    {
      preserve: false,
      failFirst: true,
      survivor: false,
    },
    {
      preserve: true,
      failFirst: true,
      survivor: false,
    },
    {
      preserve: false,
      failFirst: false,
      survivor: true,
    },
  ])(
    'ends closed and survives reload: %j',
    async ({ preserve, failFirst, survivor }) => {
      const directory = await mkdtemp(join(tmpdir(), 'unconsumed-rebase-'));

      try {
        const input = await snapshot(survivor, preserve);
        const filePath = join(directory, 'journal.json');
        const store = await FileTransactionJournalStore.open({
          filePath,
          identity: IDENTITY,
        });

        await store.save(input);

        const initialBytes = await readFile(filePath, 'utf8');
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const save = vi.fn(async (next: TransactionJournalSnapshot) => {
          if (save.mock.calls.length === 1) {
            entered();

            await held;

            if (failFirst) {
              throw new Error('B write failed');
            }
          }

          await store.save(next);
        });
        const t = context('signer_search_unconsumed_bound_rebased');
        const coordinator = await t.create({
          load: () => store.load(),
          save,
        });
        const rpc = client();

        rpc.getTransactionCount.mockResolvedValue(4);

        const latest = vi.spyOn(inclusionInspection, 'inspectSignerInclusions');
        const { cycle, completed } = cycleFor(coordinator);
        const running = cycle.run(options(rpc.publicClient), 21).then(
          (result) => ({
            result,
            error: null,
          }),
          (error: unknown) => ({
            result: null,
            error,
          }),
        );

        await started;

        expect(t.events()).toEqual([]);
        expect(coordinator.status.recoveryComplete).toBe(false);
        expect(coordinator.canBroadcast).toBe(false);
        expect(await readFile(filePath, 'utf8')).toBe(initialBytes);

        release();

        const outcome = await running;

        if (failFirst) {
          expect(outcome.error).toBeInstanceOf(Error);
          expect(t.events()).toEqual([]);
          expect(await readFile(filePath, 'utf8')).toBe(initialBytes);

          await coordinator.retryPersistence(22);
        } else {
          expect(outcome.error).toBeNull();
          expect(outcome.result).toMatchObject({
            inspection: { status: 'search-unconsumed-bound-rebase-required' },
            inclusions: null,
            broadcast: null,
          });
        }

        let lastObservation = {
          anchor: DURABLE,
          nonce: 4n,
        };

        if (preserve) {
          lastObservation = input.lastObservation;
        }

        const expected = {
          ...input,
          lastObservation,
          attempts: [
            {
              ...input.attempts[0]!,
              replacementSearch: {
                lowerBound: {
                  anchor: DURABLE,
                  nonce: 4n,
                },
                searchedThrough: null,
                exhausted: null,
              },
            },
            input.attempts[1]!,
          ],
        };

        expect(await store.load()).toEqual({
          kind: 'present',
          snapshot: expected,
        });
        expect(coordinator.status.recoveryComplete).toBe(false);
        expect(coordinator.status.inclusionChecksComplete).toBe(false);
        expect(coordinator.status.open).toBe(false);
        expect(coordinator.canBroadcast).toBe(false);
        expect(coordinator.status.blockers.includes('conflict-search-exhausted')).toBe(survivor);
        expect(coordinator.status.blockers.includes('unattributed-signer-activity')).toBe(preserve);
        expect(latest).not.toHaveBeenCalled();
        expect(completed).not.toHaveBeenCalled();
        expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
        let eventCycle = 21;

        if (failFirst) {
          eventCycle = 22;
        }

        expect(t.events()).toEqual([expect.objectContaining({
          level: 40,
          cycle: eventCycle,
          event: 'signer_search_unconsumed_bound_rebased',
          signer: ACCOUNT.address,
          attemptId: input.attempts[0]!.attemptId,
          nonce: '4',
          oldLowerBlock: '100',
          oldLowerBlockHash: HASH,
          oldLowerNonce: '4',
          observedLowerBlockHash: FORK,
          durableBlock: '125',
          durableBlockHash: HASH,
          durableNonce: '4',
          invalidatedFact: {
            expectedBlock: '120',
            expectedBlockHash: HASH,
            observedBlock: '120',
            observedBlockHash: FORK,
          },
        })]);

        const loaded = await t.create(await FileTransactionJournalStore.open({
          filePath,
          identity: IDENTITY,
        }));

        expect(loaded.status.blockers.includes('unattributed-signer-activity')).toBe(preserve);
        expect(loaded.status.blockers.includes('conflict-search-exhausted')).toBe(survivor);
        expect(loaded.status.recoveryComplete).toBe(false);
        expect(loaded.canBroadcast).toBe(false);

        if (!preserve) {
          // Exercise a fresh durable pass without entering latest/broadcast work.
          const writesBefore = save.mock.calls.length;

          rpc.getBlock.mockClear();

          const next = await coordinator.recover(options(rpc.publicClient));

          expect(next).toMatchObject({ status: 'unresolved', search: null });
          expect(save).toHaveBeenCalledTimes(writesBefore + 1);
          expect(save.mock.calls.at(-1)![0].attempts).toEqual(expected.attempts);
          expect(rpc.getBlock.mock.calls.some(
            ([request]) => request?.blockNumber === 100n,
          )).toBe(false);
          expect(t.events()).toHaveLength(1);
          expect(coordinator.status.blockers.includes('conflict-search-exhausted'))
            .toBe(survivor);
        }
      } finally {
        await rm(directory, {
          recursive: true,
          force: true,
        });
      }
    },
  );
});
