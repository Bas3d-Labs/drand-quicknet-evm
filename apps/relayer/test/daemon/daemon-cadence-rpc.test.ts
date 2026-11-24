import {
  performance,
} from 'node:perf_hooks';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  toHex,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  createChainHeadsReader,
} from '../../src/chain/chain-heads-reader.js';

import {
  runDaemon,
  type DaemonWorkContext,
} from '../../src/daemon/daemon.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createBeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  SchedulerInspectionCompletion,
} from '../../src/state/scheduler-recovery-observer.js';

import {
  TransactionManager,
} from '../../src/state/transaction-manager.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import * as completion from '../../src/state/write-completion.js';

import {
  SignerRestartRequiredError,
} from '../../src/state/signer-restart-required-error.js';

import {
  isSignerRestartFailure,
} from '../../src/execution/signer-restart-failure.js';

const beacon = vi.hoisted(() => vi.fn());

vi.mock('../../src/rounds/fetch-beacon-with-retry.js', () => ({
  fetchQuicknetBeaconWithRetry: beacon,
}));

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const VERIFIER = `0x${'33'.repeat(20)}` as const;

const CONSUMER = `0x${'44'.repeat(20)}` as const;

const RANDOMNESS = toHex(1n, { size: 32 });

const WALL = Number(roundScheduledTime(100n)) * 1000 + 1000;

function anchor(number: bigint) {
  return { blockNumber: number, blockHash: toHex(number, { size: 32 }) };
}

async function loadedFixture(
  unacknowledged: boolean,
  options: {
    secondRequest?: boolean;
    preparationFailure?: boolean;
    completionFault?: 'recovery' | 'consumer' | 'scheduled';
  } = {},
) {
  let time = 0;
  let pendingRound = 0n;
  let checkpoint = 101n;

  vi.spyOn(performance, 'now').mockImplementation(() => time);

  const calls: string[] = [];
  const inspections: SchedulerInspectionCompletion[] = [];
  const discoveries: { round: bigint; at: number }[] = [];
  const work: {
    context: DaemonWorkContext;
    at: number;
    calls: string[];
    retained: number;
  }[] = [];
  const errors: unknown[] = [];

  let faulted = false;
  let faultCallCount = 0;
  let savesAfterFault = 0;
  let checkpointsAfterFault = 0;
  let completedAfterFault = 0;
  let sleepsAfterFault = 0;
  let escaped: unknown;

  let preparationFailed = false;

  const sent: { hash: Hex; round: bigint; included: bigint; at: number }[] = [];

  let observe: ((fact: SchedulerInspectionCompletion) => void) | undefined;

  const observation = { anchor: anchor(100n), nonce: 0n };

  let snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: { chainId: 46630, signer: ACCOUNT.address },
    baseline: observation,
    lastObservation: observation,
    nextNonce: 0n,
    durableNextNonce: 0n,
    repairs: [],
    ledger: { outcomes: [], obligations: [] },
    attempts: [],
  };

  function latest() {
    return 200n + BigInt(Math.floor(time / 1000));
  }

  function receipt(hash: Hex) {
    const found = sent.find((item) => item.hash === hash)!;

    expect(found).toBeDefined();
    expect(latest()).toBeGreaterThanOrEqual(found.included);

    return {
      transactionHash: hash,
      blockNumber: found.included,
      blockHash: anchor(found.included).blockHash,
      status: 'success',
    };
  }

  beacon.mockReset().mockImplementation(async ({ round }: { round: bigint }) => {
    time += 1000;

    return { round, signature: `0x${'ff'.repeat(48)}` };
  });

  const client = {
    async getBlockNumber() {
      calls.push('eth_blockNumber');

      return latest();
    },
    async getBlock(args: { blockNumber?: bigint; blockTag?: string }) {
      calls.push(`eth_getBlockByNumber:${args.blockTag ?? args.blockNumber}`);

      let durable = 100n;

      if (time >= 90_000) {
        durable = 250n;
      } else if (options.completionFault === 'consumer') {
        durable = 150n;
      }

      const number = args.blockNumber ?? durable;

      return { number, hash: anchor(number).blockHash };
    },
    async getTransactionCount(args: { blockNumber: bigint }) {
      calls.push(`eth_getTransactionCount:${args.blockNumber}`);

      return sent.filter((item) => item.included <= args.blockNumber).length;
    },
    async getTransactionReceipt(args: { hash: Hex }) {
      calls.push('eth_getTransactionReceipt');

      return receipt(args.hash);
    },
    async waitForTransactionReceipt(args: { hash: Hex }) {
      // Deterministic receipt availability, not an injected recovery result.
      time += 1000;
      calls.push('eth_getTransactionReceipt');

      return receipt(args.hash);
    },
    async getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
      calls.push(`eth_getLogs:${args.fromBlock}-${args.toBlock}`);

      let height = 205n;

      if (options.completionFault === 'consumer') {
        height = 101n;
      }

      const requests = [{ round: 100n, height }];

      if (options.secondRequest !== false) {
        requests.push({ round: 108n, height: 210n });
      }

      return requests
        .filter((item) => args.fromBlock <= item.height && item.height <= args.toBlock)
        .map((item) => ({
          address: CONSUMER,
          args: { round: item.round },
          blockNumber: item.height,
          blockHash: anchor(item.height).blockHash,
          transactionHash: toHex(item.round, { size: 32 }),
          logIndex: 0,
        }));
    },
    async getChainId() {
      calls.push('eth_chainId');

      return 46630;
    },
    async getCode(args: { address: string }) {
      calls.push('eth_getCode');

      return args.address.toLowerCase() === REGISTRY ? '0x6000' : '0x6001';
    },
    async readContract(args: { functionName: string; args?: readonly bigint[] }) {
      calls.push(`eth_call:${args.functionName}`);

      if (args.functionName === 'verifier') {
        return VERIFIER;
      }

      if (args.functionName === 'verifierCodehash') {
        return keccak256('0x6001');
      }

      if (args.functionName === 'isStored') {
        return sent.some((item) => item.round === args.args![0] && item.included <= latest());
      }

      expect(args.functionName).toBe('getBeacon');

      return RANDOMNESS;
    },
    async simulateContract(args: { args: readonly bigint[] }) {
      calls.push('eth_call:simulate');
      pendingRound = args.args[0]!;

      return { request: args, result: RANDOMNESS };
    },
    async request(args: { method: string; params: readonly [Hex] }) {
      expect(args.method).toBe('eth_sendRawTransaction');

      calls.push('eth_sendRawTransaction');

      const hash = keccak256(args.params[0]);

      sent.push({ hash, round: pendingRound, included: latest() + 1n, at: time });

      if (unacknowledged && sent.length === 1) {
        throw new Error('Response lost after acceptance.');
      }

      return hash;
    },
  } as unknown as PublicClient;

  const readChainHeads = createChainHeadsReader({
    publicClient: client,
    finality: { type: 'safe' },
    durableHeadPollIntervalMs: 30_000,
  });

  const manager = await TransactionManager.create({
    identity: snapshot.identity,
    store: {
      load: async () => ({ kind: 'present', snapshot }),
      save: async (next) => {
        if (faulted) {
          savesAfterFault += 1;
        }

        snapshot = next;
      },
    },
    maxRetainedAttempts: 16,
    publicClient: client,
    walletClient: {
      async prepareTransactionRequest() {
        calls.push('wallet:prepareTransactionRequest');
        time += 100;

        if (options.preparationFailure && pendingRound === 108n && !preparationFailed) {
          preparationFailed = true;

          throw new Error('Preparation unavailable.');
        }

        return { type: 'eip1559', gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
      },
    } as unknown as WalletClient,
    account: ACCOUNT,
    readChainHeads,
    maxBlockRange: 2_000n,
    durableRecovery: { now: () => time, refreshIntervalMs: 60_000 },
    retry: { now: () => time, initialDelayMs: 5_000, maxDelayMs: 60_000 },
    log: createRelayerLog({ chainId: 46630, destination: { write() {} } }),
    createErrorSummary: () => ({ scrubText: (text: string) => ({ text, removed: false }) }),
    schedulerObserver: {
      now: () => time,
      onInspectionCompleted(fact) {
        inspections.push(fact);
        observe?.(fact);
      },
    },
  });

  const controller = new AbortController();

  if (options.completionFault !== undefined) {
    const describeWrite = completion.describeWriteCompletion;

    vi.spyOn(completion, 'describeWriteCompletion')
      .mockImplementation((pending, signer) => {
        if (
          !faulted &&
          (options.completionFault === 'recovery' ||
            pending.kind === 'prepared')
        ) {
          faulted = true;
          faultCallCount = calls.length;
          throw new Error('Injected acknowledged completion failure');
        }

        return describeWrite(pending, signer);
      });
  }

  await runDaemon({
    account: ACCOUNT,
    publicClient: client,
    submitter: createBeaconSubmitter({ publicClient: client, manager, readChainHeads }),
    deployment: {
      chainId: 46630,
      address: REGISTRY,
      runtimeCodehash: keccak256('0x6000'),
      verifierAddress: VERIFIER,
      verifierRuntimeCodehash: keccak256('0x6001'),
    },
    consumers: [{ address: CONSUMER, registry: REGISTRY }],
    checkpointStore: {
      load: async () => checkpoint,
      save: async (_consumer, next) => {
        if (faulted) {
          checkpointsAfterFault += 1;
        }

        checkpoint = next;
      },
    },
    readChainHeads,
    readSchedulingState: () => ({
      open: manager.status.open,
      blockers: manager.status.blockers,
      retainedCount: manager.status.attempts.length,
    }),
    installInspectionObserver(callback) {
      observe = callback;

      return () => {
        observe = undefined;
      };
    },
    startBlock: 101n,
    maxBlockRange: 2_000n,
    finality: { type: 'safe' },
    pollIntervalMs: 15_000,
    monotonicNow: () => time,
    now: () => WALL + time,
    sleep: async (delay) => {
      if (faulted) {
        sleepsAfterFault += 1;
        controller.abort();
      }

      time += delay;

      if (time >= 210_000) {
        controller.abort();
      }
    },
    signal: controller.signal,
    onRequestDiscovered(_scan, event) {
      discoveries.push({ round: event.round, at: time });
    },
    onWork(result, context) {
      if (faulted) {
        completedAfterFault += 1;
        controller.abort();
      }

      for (const outcome of result.cycle?.scheduled?.outcomes ?? []) {
        if (outcome.status === 'failed') {
          errors.push(outcome.error);
        }
      }
      work.push({
        context,
        at: time,
        calls: calls.splice(0),
        retained: manager.status.attempts.length,
      });
    },
  }).catch((error: unknown) => {
    if (options.completionFault === undefined) {
      throw error;
    }

    escaped = error;
  });

  return {
    inspections,
    sent,
    discoveries,
    work,
    snapshot,
    errors,
    fault: {
      faulted,
      escaped,
      savesAfterFault,
      checkpointsAfterFault,
      completedAfterFault,
      sleepsAfterFault,
      detached: observe === undefined,
      callsAfterFault: calls.slice(faultCallCount),
    },
  };
}

function header(height: number | 'safe') {
  return `eth_getBlockByNumber:${height}`;
}

function nonce(height: number) {
  return `eth_getTransactionCount:${height}`;
}

function selection(durable: number, latest: number, refresh = false) {
  return [
    ...(refresh ? [header('safe')] : []),
    'eth_blockNumber', header(durable), header(latest), header(latest),
  ];
}

function durableNonce(height: number) {
  return [header(height), nonce(height), header(height)];
}

function durableAttempt(durable: number, inclusion: number) {
  return [
    header(durable), 'eth_getTransactionReceipt', header(inclusion), header(durable),
    ...durableNonce(durable),
  ];
}

function firstInclusion(latest: number, inclusion: number) {
  return [header(latest), 'eth_getTransactionReceipt', header(inclusion), header(latest)];
}

function retained(inclusion: number) {
  return [header(inclusion), 'eth_getTransactionReceipt'];
}

function latestNonce(height: number) {
  return [header(height), nonce(height), header(height), header(height)];
}

function deploymentAndStored() {
  return [
    'eth_chainId', 'eth_getCode', 'eth_call:verifier',
    'eth_call:verifierCodehash', 'eth_getCode', 'eth_call:isStored',
  ];
}

function importChecks() {
  return [...deploymentAndStored(), ...deploymentAndStored(), 'eth_call:simulate'];
}

function send(acknowledged = true) {
  return [
    'wallet:prepareTransactionRequest', 'eth_sendRawTransaction',
    ...(acknowledged ? ['eth_getTransactionReceipt', 'eth_call:getBeacon'] : []),
  ];
}

describe('loaded cadence through the real daemon and transaction manager', () => {
  it('tightens an unacknowledged first send to 30 seconds without a release wake', async () => {
    const result = await loadedFixture(true, { secondRequest: false });

    expect(result.errors).toEqual([]);
    expect(result.sent).toHaveLength(1);

    const full = result.work.filter((item) => item.context.kind === 'full');

    expect(full.slice(0, 3).map((item) => item.at)).toEqual([0, 16_100, 46_100]);
    expect(result.inspections.slice(0, 4).map((fact) => fact.completedAt))
      .toEqual([0, 15_000, 16_000, 46_100]);
  });

  it('keeps pre-submit credit when preparation fails', async () => {
    const result = await loadedFixture(false, { preparationFailure: true });

    expect(result.errors).toHaveLength(1);
    expect(result.sent).toHaveLength(2);
    expect(result.inspections.find((fact) => fact.completedAt === 24_000))
      .toMatchObject({
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceIdle: true,
      });

    const full = result.work.filter((item) => item.context.kind === 'full');

    // The failed preparation finishes at 24.1 s. Its release retries at 39.1 s,
    // while its successful 24 s inspection retains credit independently.
    expect(full.slice(0, 4).map((item) => item.at)).toEqual([0, 17_100, 24_100, 41_200]);
    expect(result.inspections.map((fact) => fact.completedAt)).toEqual([
      0, 15_000, 16_000, 23_000, 24_000, 39_100, 40_100, 70_100, 100_100, 190_100,
    ]);

  });

  it.each([false, true])('runs two imports (first response lost: %s)', async (unacknowledged) => {
    const result = await loadedFixture(unacknowledged);

    expect(result.errors).toEqual([]);
    expect(result.sent.map((item) => [item.round, item.at])).toEqual([
      [100n, 16_100], [108n, 24_100],
    ]);
    expect(result.snapshot.attempts).toHaveLength(0);
    expect(result.discoveries.slice(0, 2)).toEqual([
      { round: 100n, at: 15_000 }, { round: 108n, at: 15_000 },
    ]);
    expect(Number(roundScheduledTime(100n)) * 1000).toBeLessThan(WALL + 15_000);
    expect(Number(roundScheduledTime(108n)) * 1000).toBe(WALL + 23_000);

    const full = result.work.filter((item) => item.context.kind === 'full');

    // Acknowledgement adds no work. A queued release precedes the 30-second
    // tightening; its pre-submit inspection moves periodic work to 54 seconds.
    expect(full.map((item) => item.at)).toEqual([
      0, unacknowledged ? 16_100 : 17_100, 25_100, 54_000, 84_000, 114_000, 204_000,
    ]);
    expect(full.map((item) => item.retained)).toEqual([0, 1, 2, 2, 2, 0, 0]);
    expect(result.inspections.map((fact) => [fact.completedAt, fact.retainedCount])).toEqual([
      [0, 0], [15_000, 0], [16_000, 0], [23_000, 1], [24_000, 1],
      [54_000, 2], [84_000, 2], [114_000, 0], [204_000, 0],
    ]);

    // Expected sequences are composed from the recovery/import contracts.
    // Provider timing determines inclusion and safe availability, never a fact.
    expect(full.map((item) => item.calls)).toEqual([
      [
        ...selection(100, 200, true), ...durableNonce(100), ...latestNonce(200),
        'eth_blockNumber',
      ],
      [
        ...selection(100, 215), ...latestNonce(215),
        ...importChecks(),
        ...selection(100, 216), ...latestNonce(216),
        ...send(!unacknowledged), 'eth_blockNumber',
      ],
      [
        ...selection(100, 223), ...durableAttempt(100, 217),
        ...firstInclusion(223, 217), ...latestNonce(223),
        ...importChecks(),
        ...selection(100, 224), ...durableAttempt(100, 217),
        ...retained(217), ...latestNonce(224), ...send(), 'eth_blockNumber',
      ],
      [
        ...selection(100, 254, true), ...durableAttempt(100, 217),
        ...retained(217), ...firstInclusion(254, 225), ...latestNonce(254),
        'eth_blockNumber',
      ],
      [
        ...selection(100, 284, true), ...durableAttempt(100, 217),
        ...retained(217), ...retained(225), ...latestNonce(284), 'eth_blockNumber',
      ],
      [
        ...selection(250, 314, true), ...durableAttempt(250, 217),
        ...durableAttempt(250, 225), ...latestNonce(314), 'eth_blockNumber',
        header(250), 'eth_getLogs:101-250',
        ...deploymentAndStored(), 'eth_call:getBeacon',
        ...deploymentAndStored(), 'eth_call:getBeacon',
        'eth_call:isStored', 'eth_call:isStored', header(250),
      ],
      [
        ...selection(250, 404, true), ...durableNonce(250), ...latestNonce(404),
        'eth_blockNumber',
      ],
    ]);

    const discovery = result.work.filter((item) => item.context.kind === 'discovery');

    expect(discovery).toHaveLength(14);

    for (const item of discovery) {
      expect(item.calls).toHaveLength(2);
      expect(item.calls[0]).toBe('eth_blockNumber');
      expect(item.calls[1]!.startsWith('eth_getLogs:')).toBe(true);
    }

    const calls = result.work.flatMap((item) => item.calls);
    const preparation = calls.filter((call) => call === 'wallet:prepareTransactionRequest');
    const provider = calls.filter((call) => call !== 'wallet:prepareTransactionRequest');

    expect(preparation).toHaveLength(2);
    expect(provider).toHaveLength(unacknowledged ? 225 : 227);
  });
});

describe('fatal completion failures through the running daemon', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['recovery', 'consumer', 'scheduled'] as const)(
    'escapes the %s path without subsequent work or publication',
    async (completionFault) => {
      const result = await loadedFixture(false, {
        secondRequest: false,
        completionFault,
      });

      expect(result.fault.faulted).toBe(true);
      expect(isSignerRestartFailure(result.fault.escaped)).toBe(true);

      if (completionFault === 'recovery') {
        expect(result.fault.escaped)
          .toBeInstanceOf(SignerRestartRequiredError);
      } else {
        expect(result.fault.escaped).toMatchObject({
          name: 'TransactionSubmissionError',
          cause: expect.any(SignerRestartRequiredError),
        });
      }

      expect(result.fault).toMatchObject({
        savesAfterFault: 0,
        checkpointsAfterFault: 0,
        completedAfterFault: 0,
        sleepsAfterFault: 0,
        callsAfterFault: [],
        detached: true,
      });
      expect(result.sent).toEqual([]);
    },
  );
});
