import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toHex,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  createDaemonStatusPublisher,
} from '../../src/daemon/daemon-status-publisher.js';

import {
  FutureRoundScheduler,
} from '../../src/daemon/future-round-scheduler.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createBeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import {
  createRoundImporter,
} from '../../src/rounds/create-round-importer.js';

import type {
  writeDaemonStatusFile,
} from '../../src/state/file-daemon-status-store.js';

import {
  readSignerRuntimeObservation,
} from '../../src/state/read-signer-runtime-observation.js';

import {
  StoredFactNonceConflictError,
} from '../../src/state/stored-fact-nonce-conflict.js';

import {
  TransactionManager,
  submissionRecording,
} from '../../src/state/transaction-manager.js';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const mocks = vi.hoisted(() => ({
  fetchBeacon: vi.fn(),
}));

vi.mock('../../src/rounds/fetch-beacon-with-retry.js', () => ({
  fetchQuicknetBeaconWithRetry: mocks.fetchBeacon,
}));

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const REGISTRY = `0x${'22'.repeat(20)}` as const;

const VERIFIER = `0x${'33'.repeat(20)}` as const;

const REGISTRY_CODE = '0x6000';

const VERIFIER_CODE = '0x6001';

const CHAIN_ID = 46630;

const ROUND = 100n;

function anchor(blockNumber: bigint) {
  return {
    blockNumber,
    blockHash: toHex(blockNumber, { size: 32 }),
  };
}

async function fixture(options: { preparationConflict?: boolean } = {}) {
  const attempts: JournalAttempt[] = [];

  const retainedCount = options.preparationConflict ? 1 : 16;

  for (let nonce = 0; nonce < retainedCount; nonce += 1) {
    const signedTransaction = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: CHAIN_ID,
      nonce,
      to: REGISTRY,
      data: '0x1234',
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    const transactionHash = keccak256(signedTransaction);

    attempts.push({
      attemptId: `00000000-0000-4000-8000-${String(nonce + 1).padStart(12, '0')}`,
      workId: `retained:${nonce}`,
      nonce: BigInt(nonce),
      createdAt: '2026-01-01T00:00:00.000Z',
      phase: 'included',
      signedTransactions: [{
        signedTransaction,
        transactionHash,
      }],
      replacementSearch: options.preparationConflict ? {
        lowerBound: {
          anchor: anchor(130n),
          nonce: 0n,
        },
        searchedThrough: null,
        exhausted: null,
      } : null,
      inclusion: {
        outcome: 'success',
        transactionHash,
        inclusion: anchor(110n),
        observedAt: anchor(130n),
      },
    });
  }

  let snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: {
      chainId: CHAIN_ID,
      signer: ACCOUNT.address,
    },
    baseline: {
      anchor: anchor(100n),
      nonce: 0n,
    },
    lastObservation: {
      anchor: anchor(130n),
      nonce: BigInt(retainedCount),
    },
    nextNonce: BigInt(retainedCount),
    durableNextNonce: 0n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts,
  };

  const methods: string[] = [];

  const client = createPublicClient({
    cacheTime: 0,
    transport: custom({
      async request({ method, params }) {
        methods.push(method);

        const values = params as readonly unknown[] | undefined;

        if (method === 'eth_blockNumber') {
          return toHex(130n);
        }

        if (method === 'eth_getBlockByNumber') {
          let height = 100n;

          if (values?.[0] !== 'safe') {
            height = BigInt(String(values?.[0]));
          }

          return {
            number: toHex(height),
            hash: anchor(height).blockHash,
            parentHash: anchor(height - 1n).blockHash,
            timestamp: '0x6955b900',
            transactions: [],
          };
        }

        if (method === 'eth_getTransactionCount') {
          return values?.[1] === toHex(100n) ? '0x0' : toHex(retainedCount);
        }

        if (method === 'eth_getTransactionReceipt') {
          const hash = values?.[0] as Hash;

          expect(attempts.some((attempt) =>
            attempt.signedTransactions[0].transactionHash === hash,
          )).toBe(true);

          return {
            transactionHash: hash,
            blockNumber: toHex(110n),
            blockHash: anchor(110n).blockHash,
            status: '0x1',
            transactionIndex: '0x0',
            from: ACCOUNT.address,
            to: REGISTRY,
            contractAddress: null,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x2',
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            type: '0x2',
          };
        }

        if (method === 'eth_chainId') {
          return toHex(CHAIN_ID);
        }

        if (method === 'eth_getCode') {
          if (String(values?.[0]).toLowerCase() === REGISTRY) {
            return REGISTRY_CODE;
          }

          expect(String(values?.[0]).toLowerCase()).toBe(VERIFIER);

          return VERIFIER_CODE;
        }

        if (method === 'eth_call') {
          const call = values?.[0] as { data: Hex };

          const { functionName } = decodeFunctionData({
            abi: drandQuicknetBeaconRegistryAbi,
            data: call.data,
          });

          if (functionName === 'verifier') {
            return encodeFunctionResult({
              abi: drandQuicknetBeaconRegistryAbi,
              functionName,
              result: VERIFIER,
            });
          }

          if (functionName === 'verifierCodehash') {
            return keccak256(VERIFIER_CODE);
          }

          if (functionName === 'isStored') {
            return toHex(0n, { size: 32 });
          }

          expect(functionName).toBe('submitBeacon');

          return toHex(1n, { size: 32 });
        }

        throw new Error(`Unexpected RPC method: ${method}`);
      },
    }, {
      retryCount: 0,
    }),
  });

  const readChainHeads = async () => ({
    latestBlock: await client.getBlockNumber(),
    durableBlock: (await client.getBlock({ blockTag: 'safe' })).number,
  });

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const prepareTransactionRequest = vi.fn(async () => ({
    type: 'eip1559' as const,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }));

  const manager = await TransactionManager.create({
    identity: snapshot.identity,
    store: {
      load: async () => ({
        kind: 'present',
        snapshot,
      }),
      save: async (next) => {
        snapshot = next;
      },
    },
    maxRetainedAttempts: 16,
    publicClient: client,
    walletClient: {
      prepareTransactionRequest,
    } as unknown as WalletClient,
    account: {
      ...ACCOUNT,
      signTransaction,
    },
    readChainHeads,
    maxBlockRange: 2000n,
    durableRecovery: {
      refreshIntervalMs: 30_000,
      now: () => 0,
    },
    retry: {
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      now: () => 0,
    },
    log: createRelayerLog({
      chainId: CHAIN_ID,
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
  });

  const submitter = createBeaconSubmitter({
    publicClient: client,
    manager,
    readChainHeads,
  });

  const deployment = {
    chainId: CHAIN_ID,
    address: REGISTRY,
    runtimeCodehash: keccak256(REGISTRY_CODE),
    verifierAddress: VERIFIER,
    verifierRuntimeCodehash: keccak256(VERIFIER_CODE),
  };

  const bindRoundImporter = createRoundImporter({
    publicClient: client,
    account: ACCOUNT,
    deployment,
    deferFutureRounds: true,
    now: () => Number(roundScheduledTime(ROUND) * 1000n),
  });

  const waiting = new FutureRoundScheduler({
    chainId: CHAIN_ID,
    registry: REGISTRY,
    now: () => Number(roundScheduledTime(ROUND) * 1000n),
  });

  waiting.offer({
    consumer: REGISTRY,
    round: ROUND,
    blockNumber: 120n,
    transactionHash: anchor(120n).blockHash,
    logIndex: 0,
  }, roundScheduledTime(ROUND));

  const cycleOptions = {
    publicClient: client,
    submitter,
    bindRoundImporter,
    deployment,
    waiting,
    checkpointStore: {
      load: async () => undefined,
      save: vi.fn(),
    },
    consumers: [],
    startBlock: 1n,
    maxBlockRange: 2000n,
    finality: {
      type: 'safe' as const,
    },
    softCursors: new Map(),
  };

  methods.length = 0;

  return {
    options: cycleOptions,
    methods,
    manager,
    signTransaction,
    prepareTransactionRequest,
    snapshot: () => snapshot,
  };
}

function counts(methods: readonly string[]) {
  const result: Record<string, number> = {};

  for (const method of methods) {
    result[method] = (result[method] ?? 0) + 1;
  }

  return result;
}

describe('closed-gate scheduled RPC cost', () => {
  it('skips importer RPCs and pre-submit recovery, preserving cycle recovery', async () => {
    mocks.fetchBeacon.mockReset().mockResolvedValue({
      round: ROUND,
      signature: `0x${'ff'.repeat(48)}`,
    });

    const before = await fixture();

    // Pre-skip cycle ordering with no consumers: recover, then dispatch regardless
    // of the report. Use real importer, submitter, manager and recovery throughout.
    const recovery = await before.options.submitter.recover();

    expect(recovery.state.primaryReason).toBe('retention-capacity-reached');

    const commonRecovery = [...before.methods];

    const pass = await before.options.waiting.dispatch(
      before.options.bindRoundImporter({ submitter: before.options.submitter }),
    );

    expect(pass.blocked).toBe(true);
    expect(mocks.fetchBeacon).toHaveBeenCalledTimes(1);
    expect(before.options.waiting.size).toBe(1);
    expect(before.signTransaction).not.toHaveBeenCalled();

    mocks.fetchBeacon.mockClear();

    const after = await fixture();

    const result = await runDaemonCycle(after.options);

    expect(result.scheduled).toBeUndefined();
    expect(after.methods).toEqual(commonRecovery);
    expect(after.options.waiting.size).toBe(1);
    expect(after.manager.status.primaryReason).toBe('retention-capacity-reached');
    expect(after.signTransaction).not.toHaveBeenCalled();
    expect(mocks.fetchBeacon).not.toHaveBeenCalled();
    expect(after.options.checkpointStore.save).not.toHaveBeenCalled();

    expect(counts(before.methods)).toEqual({
      eth_blockNumber: 2,
      eth_getBlockByNumber: 51,
      eth_getTransactionReceipt: 33,
      eth_getTransactionCount: 3,
      eth_chainId: 2,
      eth_getCode: 4,
      eth_call: 7,
    });

    expect(counts(after.methods)).toEqual({
      eth_blockNumber: 1,
      eth_getBlockByNumber: 28,
      eth_getTransactionReceipt: 17,
      eth_getTransactionCount: 2,
    });

    expect(before.methods).toHaveLength(102);
    expect(after.methods).toHaveLength(48);
  });
});


describe('scheduled preparation conflict retry', () => {
  it('keeps unrecorded work queued and retries through submit on the next cycle', async () => {
    mocks.fetchBeacon.mockReset().mockResolvedValue({
      round: ROUND,
      signature: `0x${'ff'.repeat(48)}`,
    });

    const t = await fixture({ preparationConflict: true });

    const retained = structuredClone(t.snapshot().attempts);

    const write = vi.fn<typeof writeDaemonStatusFile>().mockResolvedValue(undefined);

    const onFailure = vi.fn();

    const publisher = createDaemonStatusPublisher({
      identity: t.snapshot().identity,
      runId: '11111111-1111-4111-8111-111111111111',
      write,
      onFailure,
    });

    publisher.onInitialized(() => readSignerRuntimeObservation(t.manager));
    publisher.onSchedulerInitialized((at) => t.options.waiting.observe(at));

    let queuedWorkId: string | undefined;

    for (const cycle of [1, 2]) {
      // Recovery and inclusion checks reopen the gate. Preparation then finds
      // that copying lastObservation would contradict the retained lower bound.
      if (cycle === 2) {
        const previous = t.manager.status.storedFactDispute;

        await t.options.submitter.recover();
        await publisher.publish();

        expect(t.manager.status.open).toBe(true);
        expect(t.manager.status.storedFactDispute).toEqual(previous);
        expect(write.mock.calls.at(-1)?.[0].snapshot.storedFactDispute).toEqual(previous);
      }

      const result = await runDaemonCycle(t.options);

      await publisher.publish();

      expect(onFailure).not.toHaveBeenCalled();
      expect(write.mock.calls.at(-1)?.[0].snapshot.storedFactDispute).toMatchObject({
        origin: 'preparation',
        detail: { reason: 'stored-fact-nonce-conflict' },
      });

      expect(result.scheduled).toMatchObject({
        attempted: 1,
        handedOff: 0,
        failed: true,
      });

      const outcome = result.scheduled?.outcomes[0];

      if (outcome?.status !== 'failed') {
        throw new Error('Expected the scheduled submission failure.');
      }

      if (queuedWorkId === undefined) {
        queuedWorkId = outcome.entry.workId;
      }

      expect(outcome.entry.workId).toBe(queuedWorkId);
      expect(outcome.error).toMatchObject({
        name: 'TransactionSubmissionError',
        message: 'Transaction submission did not complete.',
        cause: expect.any(StoredFactNonceConflictError),
      });
      expect(submissionRecording(outcome.error)).toEqual({ status: 'none' });
      expect(t.options.submitter.findRetainedWork(queuedWorkId)).toBeNull();
      expect(t.snapshot().attempts).toEqual(retained);
      expect(t.snapshot().nextNonce).toBe(1n);
      expect(t.options.waiting.size).toBe(1);
      expect(t.options.waiting.sleepMilliseconds(1000, result.scheduled)).toBe(1000);
      expect(t.manager.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        persistenceState: 'idle',
      });
      expect(t.manager.status.blockers).toContain('recovery-incomplete');
      expect(t.manager.status.blockers).not.toContain('persistence-failure');
      expect(t.prepareTransactionRequest).toHaveBeenCalledTimes(cycle);
      expect(mocks.fetchBeacon).toHaveBeenCalledTimes(cycle);
      expect(t.signTransaction).not.toHaveBeenCalled();
      expect(t.methods).not.toContain('eth_sendRawTransaction');
      expect(t.options.checkpointStore.save).not.toHaveBeenCalled();
    }
  });
});
