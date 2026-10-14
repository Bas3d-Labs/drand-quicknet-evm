import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  Address,
  Hash,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CompressedSignature,
} from '@based-labs/drand-quicknet';

import {
  runDaemon,
} from '../../src/daemon/daemon.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import {
  createRoundImporter,
} from '../../src/rounds/create-round-importer.js';

const mocks = vi.hoisted(() => ({
  createRegistryReader: vi.fn(),
  fetchBeacon: vi.fn(),
  fetchQuicknetBeaconWithRetry: vi.fn(),
  waitForQuicknetRound: vi.fn(),
  simulateBeaconSubmission: vi.fn(),
}));

vi.mock('@based-labs/drand-quicknet-registry', () => ({
  createRegistryReader: mocks.createRegistryReader,
}));

vi.mock('@based-labs/drand-quicknet', () => ({
  fetchBeacon: mocks.fetchBeacon,
}));

vi.mock('../../src/rounds/fetch-beacon-with-retry.js', () => ({
  fetchQuicknetBeaconWithRetry: mocks.fetchQuicknetBeaconWithRetry,
}));

vi.mock('../../src/rounds/wait-for-round.js', () => ({
  waitForQuicknetRound: mocks.waitForQuicknetRound,
}));

vi.mock('../../src/rounds/simulate-beacon-submission.js', () => ({
  simulateBeaconSubmission: mocks.simulateBeaconSubmission,
}));

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import type {
  SoftScanCursor,
} from '../../src/daemon/daemon-iteration.js';

import {
  createDaemonLogger,
} from '../../src/daemon/daemon-logging.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  importQuicknetRound,
} from '../../src/rounds/import-round.js';

import type {
  RoundImportProgress,
} from '../../src/diagnostics/operation-context.js';

const CONSUMER: Address =
  '0x1111111111111111111111111111111111111111';

const REGISTRY: Address =
  '0x2222222222222222222222222222222222222222';

const HASH: Hash = `0x${'33'.repeat(32)}`;
const RANDOMNESS = `0x${'44'.repeat(32)}`;
const ROUND = 32607411n;
const TOKEN = 'import-context-canary';

function fixture() {
  const verifyDeployment = vi.fn().mockResolvedValue(undefined);
  const isStored = vi.fn().mockResolvedValue(false);
  const getBeacon = vi.fn().mockResolvedValue(RANDOMNESS);

  mocks.createRegistryReader.mockReturnValue({
    verifyDeployment,
    isStored,
    getBeacon,
  });

  const beacon = {
    round: ROUND,
    signature: `0x${'55'.repeat(48)}` as CompressedSignature,
  };

  mocks.fetchBeacon.mockResolvedValue(beacon);
  mocks.fetchQuicknetBeaconWithRetry.mockResolvedValue(beacon);
  mocks.waitForQuicknetRound.mockResolvedValue(undefined);

  mocks.simulateBeaconSubmission.mockResolvedValue({
    request: {
      functionName: 'submitBeacon',
    },
    result: RANDOMNESS,
    submission: 'compressed',
    fallbackReason: 'witness-decode-failed',
  });

  const submitTransaction = vi.fn<BeaconSubmitter['submit']>()
    .mockResolvedValue({
      status: 'acknowledged',
      attemptId: '11111111-1111-4111-8111-111111111111',
      transactionHash: HASH,
      nonce: 4n,
    });

  const submitter: BeaconSubmitter = {
    recover: vi.fn<BeaconSubmitter['recover']>(),
    submit: submitTransaction,
  };

  const waitForTransactionReceipt = vi.fn().mockResolvedValue({
    status: 'success',
    transactionHash: HASH,
    blockNumber: 1200n,
  });

  const getLogs = vi.fn()
    .mockResolvedValueOnce([{
      address: CONSUMER,
      args: { round: ROUND },
      blockNumber: 1000n,
      transactionHash: HASH,
      logIndex: 0,
    }])
    .mockResolvedValue([]);

  const save = vi.fn().mockResolvedValue(undefined);

  const getBlock = vi.fn(async (
    request: {
      blockTag?: string;
      blockNumber?: bigint;
    },
  ) => {
    if (request.blockNumber !== undefined) {
      return {
        number: request.blockNumber,
        hash: HASH,
      };
    }

    if (request.blockTag === 'safe') {
      return {
        number: 1_100n,
        hash: HASH,
      };
    }

    throw new Error('Unexpected block request in test.');
  });

  const baseOptions = {
    publicClient: {
      getBlock,
      getBlockNumber: vi.fn().mockResolvedValue(1200n),
      getLogs,
      waitForTransactionReceipt,
    } as unknown as PublicClient,
    account: {} as Account,
    submitter,
    deployment: {
      address: REGISTRY,
    } as RegistryDeployment,
    checkpointStore: {
      load: vi.fn().mockResolvedValue(undefined),
      save,
    },
    consumers: [
      { address: CONSUMER, registry: REGISTRY },
    ],
    startBlock: 1000n,
    maxBlockRange: 100n,
    finality: { type: 'safe' as const },
    softCursors: new Map<Address, SoftScanCursor>(),
  };

  const options = {
    ...baseOptions,
    bindRoundImporter: createRoundImporter({
      publicClient: baseOptions.publicClient,
      account: baseOptions.account,
      deployment: baseOptions.deployment,
    }),
  };

  return {
    options,
    getBlock,
    getLogs,
    submitTransaction,
    waitForTransactionReceipt,
    verifyDeployment,
    isStored,
    getBeacon,
    save,
  };
}

describe('round import diagnostic context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    'verify-deployment',
    'check-stored',
    'wait-for-beacon',
    'fetch-beacon',
    'prepare-submission',
    'submit-transaction',
    'wait-for-receipt',
  ] as const)(
    'preserves %s failure identity, context and unfinished progress',
    async (phase) => {
      const fixtureState = fixture();
      const failure = new Error(`request failed; token=${TOKEN}`);

      const targets = {
        'verify-deployment': fixtureState.verifyDeployment,
        'check-stored': fixtureState.isStored,
        'wait-for-beacon': mocks.waitForQuicknetRound,
        'fetch-beacon': mocks.fetchQuicknetBeaconWithRetry,
        'prepare-submission': mocks.simulateBeaconSubmission,
        'submit-transaction': fixtureState.submitTransaction,
        'wait-for-receipt': fixtureState.waitForTransactionReceipt,
      };

      targets[phase].mockRejectedValueOnce(failure);

      const cursor = { nextBlock: 1150n };
      fixtureState.options.softCursors.set(CONSUMER, cursor);

      const result = await runDaemonCycle(fixtureState.options);
      const failed = result.consumers[0];

      if (failed?.status !== 'failed') {
        throw new Error('Expected import failure.');
      }

      expect(failed.error).toBe(failure);

      // A failed local import must still be checked at the durable anchor.
      expect(fixtureState.isStored).toHaveBeenCalledWith(
        ROUND,
        1_100n,
      );

      const anchorReads = fixtureState.getBlock.mock.calls.filter(
        ([request]) => request.blockNumber !== undefined,
      );

      expect(anchorReads).toEqual([
        [{ blockNumber: 1_100n }],
        [{ blockNumber: 1_100n }],
      ]);

      // The iteration stops after the durable import failure.
      expect(fixtureState.getLogs).toHaveBeenCalledOnce();

      expect(failed.reconciliation).toMatchObject({
        status: 'scanned',
        fulfillment: [
          {
            round: ROUND,
            firstRequestBlock: 1_000n,
            fulfillment: { status: 'not-stored' },
          },
        ],
        checkpoint: {
          status: 'verified',
          nextBlock: 1_000n,
        },
      });

      expect(failed.operation).toMatchObject({
        name: 'import-round',
        scanType: 'durable',
        fromBlock: 1_000n,
        toBlock: 1_099n,
        round: ROUND,
        phase,
      });

      if (phase === 'wait-for-receipt') {
        expect(failed.operation)
          .toHaveProperty('transactionHash', HASH);
      } else {
        expect(failed.operation)
          .not.toHaveProperty('transactionHash');
      }

      expect(fixtureState.save).not.toHaveBeenCalled();
      expect(fixtureState.options.softCursors.get(CONSUMER))
        .toBe(cursor);

      if (
        phase === 'submit-transaction' ||
        phase === 'wait-for-receipt'
      ) {
        expect(fixtureState.submitTransaction).toHaveBeenCalledOnce();
      } else {
        expect(fixtureState.submitTransaction).not.toHaveBeenCalled();
      }

      const lines: string[] = [];

      const logger = createRelayerLog({
        chainId: 4663,
        destination: {
          write(line) {
            lines.push(line);
          },
        },
        errorSummary: {
          scrubText: createScrubber({
            rpcUrls: [],
            secrets: [TOKEN],
          }),
        },
      });

      createDaemonLogger({ logger }).onCycle(result);

      const records = lines.map((line) => JSON.parse(line));
      const failures = records.filter(
        (record) => record.event === 'consumer_failed',
      );

      expect(failures).toHaveLength(1);

      const record = failures[0]!;

      expect(record.operation).toMatchObject({
        name: 'import-round',
        round: ROUND.toString(),
        phase,
        fromBlock: '1000',
        toBlock: '1099',
      });

      if (phase === 'wait-for-receipt') {
        expect(record.operation.transactionHash).toBe(HASH);
      }

      expect(record.err.message).toBe(
        'request failed; token=[REDACTED]',
      );
      expect(lines.join('')).not.toContain(TOKEN);
    },
  );

  it('reports post-receipt storage verification with the known hash', async () => {
    const fixtureState = fixture();

    fixtureState.getBeacon.mockResolvedValue(
      `0x${'66'.repeat(32)}`,
    );

    const result = await runDaemonCycle(fixtureState.options);
    const failed = result.consumers[0];

    if (failed?.status !== 'failed') {
      throw new Error('Expected import failure.');
    }

    expect(failed.operation).toMatchObject({
      name: 'import-round',
      scanType: 'durable',
      fromBlock: 1_000n,
      toBlock: 1_099n,
      phase: 'verify-stored-beacon',
      round: ROUND,
      transactionHash: HASH,
    });

    expect(fixtureState.save).not.toHaveBeenCalled();
    expect(fixtureState.submitTransaction).toHaveBeenCalledOnce();
  });

  it('reports direct-import phases and preserves successful behavior', async () => {
    const fixtureState = fixture();
    const progress: RoundImportProgress[] = [];

    const result = await importQuicknetRound({
      ...fixtureState.options,
      round: ROUND,
      onProgress(current) {
        progress.push(current);
      },
    });

    expect(result.status).toBe('imported');
    expect(progress.map((entry) => entry.phase)).toEqual([
      'verify-deployment',
      'check-stored',
      'fetch-beacon',
      'validate-beacon',
      'prepare-submission',
      'submit-transaction',
      'wait-for-receipt',
      'verify-stored-beacon',
    ]);

    expect(progress.every((entry) => entry.round === ROUND))
      .toBe(true);
    expect(fixtureState.submitTransaction).toHaveBeenCalledOnce();
  });

  it('does not let a throwing observer interrupt the transaction flow', async () => {
    const fixtureState = fixture();

    const onProgress = vi.fn(() => {
      throw new Error('observer failed');
    });

    const result = await importQuicknetRound({
      ...fixtureState.options,
      round: ROUND,
      onProgress,
    });

    expect(result.status).toBe('imported');
    expect(onProgress).toHaveBeenCalled();
    expect(fixtureState.submitTransaction).toHaveBeenCalledOnce();
    expect(fixtureState.waitForTransactionReceipt)
      .toHaveBeenCalledTimes(1);
  });

  it.each(['durable', 'soft'] as const)(
    'passes a custom receipt timeout through the %s daemon scan',
    async (scanType) => {
      const fixtureState = fixture();
      const controller = new AbortController();
      const event = {
        address: CONSUMER,
        args: { round: ROUND },
        blockNumber: scanType === 'durable' ? 1000n : 1101n,
        transactionHash: HASH,
        logIndex: 0,
      };

      fixtureState.getLogs.mockReset();
      fixtureState.getLogs.mockResolvedValue([]);

      if (scanType === 'soft') {
        fixtureState.getLogs.mockResolvedValueOnce([]);
      }

      fixtureState.getLogs.mockResolvedValueOnce([event]);

      await runDaemon({
        ...fixtureState.options,
        receiptTimeoutMs: 45_000,
        pollIntervalMs: 1_000,
        signal: controller.signal,
        readChainHeads: async () => ({
          latestBlock: 1200n,
          durableBlock: 1100n,
        }),
        onCycle: () => controller.abort(),
      });

      expect(fixtureState.waitForTransactionReceipt)
        .toHaveBeenCalledExactlyOnceWith({
          hash: HASH,
          timeout: 45_000,
        });

      expect(fixtureState.submitTransaction).toHaveBeenCalledOnce();
    },
  );

  it.each(['durable', 'soft'] as const)(
    'propagates shutdown from the %s round wait without submitting',
    async (scanType) => {
      const fixtureState = fixture();
      const controller = new AbortController();
      const reason = new Error('Shutdown requested.');
      const onCycle = vi.fn();
      const sleep = vi.fn();

      let requestBlock = 1000n;

      if (scanType === 'soft') {
        requestBlock = 1101n;
      }

      const event = {
        address: CONSUMER,
        args: { round: ROUND },
        blockNumber: requestBlock,
        transactionHash: HASH,
        logIndex: 0,
      };

      fixtureState.getLogs.mockReset();
      fixtureState.getLogs.mockResolvedValue([]);

      if (scanType === 'soft') {
        // Finish an empty durable scan before reaching the soft request.
        fixtureState.getLogs.mockResolvedValueOnce([]);
      }

      fixtureState.getLogs.mockResolvedValueOnce([event]);

      mocks.waitForQuicknetRound.mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });

      await expect(runDaemon({
        ...fixtureState.options,
        pollIntervalMs: 1_000,
        signal: controller.signal,
        readChainHeads: async () => ({
          latestBlock: 1200n,
          durableBlock: 1100n,
        }),
        onCycle,
        sleep,
      })).rejects.toBe(reason);

      expect(mocks.waitForQuicknetRound)
        .toHaveBeenCalledExactlyOnceWith({
          round: ROUND,
          signal: controller.signal,
        });

      expect(mocks.fetchQuicknetBeaconWithRetry).not.toHaveBeenCalled();
      expect(mocks.simulateBeaconSubmission).not.toHaveBeenCalled();
      expect(fixtureState.submitTransaction).not.toHaveBeenCalled();
      expect(fixtureState.waitForTransactionReceipt).not.toHaveBeenCalled();
      expect(onCycle).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();

      if (scanType === 'durable') {
        expect(fixtureState.save).not.toHaveBeenCalled();
        expect(fixtureState.getLogs).toHaveBeenCalledOnce();
      }
    },
  );
});