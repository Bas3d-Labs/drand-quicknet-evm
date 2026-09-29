import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RpcRequestError,
  type Account,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  runDaemonCycle,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemonIteration,
  type SoftScanCursor,
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

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY: Address =
  '0x3333333333333333333333333333333333333333';

const TOKEN = 'failure-context-canary';
const RPC_URL = `https://rpc.example/${TOKEN}`;

function fixture() {
  const getBlock = vi.fn().mockResolvedValue({
    number: 1_100n,
  });

  const getBlockNumber = vi.fn().mockResolvedValue(1_200n);
  const getLogs = vi.fn().mockResolvedValue([]);
  const load = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn().mockResolvedValue(undefined);

  const options = {
    publicClient: {
      getBlock,
      getBlockNumber,
      getLogs,
    } as unknown as PublicClient,
    walletClient: {} as WalletClient,
    account: {} as Account,
    deployment: {
      address: REGISTRY,
    } as RegistryDeployment,
    checkpointStore: { load, save },
    consumers: [
      { address: CONSUMER_A, registry: REGISTRY },
      { address: CONSUMER_B, registry: REGISTRY },
    ],
    startBlock: 1_000n,
    maxBlockRange: 100n,
    finality: { type: 'safe' as const },
    softCursors: new Map<Address, SoftScanCursor>(),
  };

  return {
    options,
    getBlock,
    getLogs,
    load,
    save,
  };
}

function providerFailure() {
  return new RpcRequestError({
    body: {
      method: 'eth_getLogs',
    },
    url: RPC_URL,
    error: {
      code: -32000,
      message:
        `historical state is not available; token=${TOKEN}`,
    },
  });
}

describe('daemon failure context', () => {
  it('logs scan context and scrubbed evidence while continuing other consumers', async () => {
    const { options, getLogs, save } = fixture();
    const error = providerFailure();
    const cursor = { nextBlock: 1_150n };

    options.softCursors.set(CONSUMER_A, cursor);
    getLogs.mockRejectedValueOnce(error);

    const result = await runDaemonCycle(options);
    const failed = result.consumers[0];

    if (failed?.status !== 'failed') {
      throw new Error('Expected consumer failure.');
    }

    expect(failed.error).toBe(error);
    expect(failed.operation).toEqual({
      name: 'scan-requests',
      scanType: 'durable',
      fromBlock: 1_000n,
      throughBlock: 1_100n,
      maxBlockRange: 100n,
    });
    expect(failed.decision).toBe('continue-cycle');
    expect(result.consumers[1]?.status).toBe('success');
    expect(options.softCursors.get(CONSUMER_A)).toBe(cursor);
    expect(save).not.toHaveBeenCalledWith(
      CONSUMER_A,
      expect.anything(),
    );

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
          rpcUrls: [RPC_URL],
        }),
      },
    });

    createDaemonLogger({ logger }).onCycle(result);

    const records = lines.map((line) => JSON.parse(line));
    const record = records.find(
      (entry) => entry.event === 'consumer_failed',
    );

    expect(record).toMatchObject({
      consumer: CONSUMER_A,
      operation: {
        name: 'scan-requests',
        scanType: 'durable',
        fromBlock: '1000',
        throughBlock: '1100',
        maxBlockRange: '100',
      },
      decision: 'continue-cycle',
      err: {
        code: -32000,
        message:
          'historical state is not available; token=[REDACTED]',
      },
    });

    expect(lines.join('')).not.toContain(TOKEN);
  });

  it.each([
    'load-checkpoint',
    'read-chain-heads',
    'save-checkpoint',
  ] as const)(
    'reports %s without replacing the original error',
    async (name) => {
      const { options, load, getBlock, save } = fixture();
      const error = new Error('operation failed');

      if (name === 'load-checkpoint') {
        load.mockRejectedValueOnce(error);
      }

      if (name === 'read-chain-heads') {
        getBlock.mockRejectedValueOnce(error);
      }

      if (name === 'save-checkpoint') {
        save.mockRejectedValueOnce(error);
      }

      const result = await runDaemonCycle(options);
      const failed = result.consumers[0];

      if (failed?.status !== 'failed') {
        throw new Error('Expected consumer failure.');
      }

      expect(failed.error).toBe(error);
      expect(failed.operation?.name).toBe(name);
      expect(result.consumers[1]?.status).toBe('success');
    },
  );

  it('reports a soft-scan failure after durable progress was saved', async () => {
    const { options, getLogs, save } = fixture();
    const cursor = { nextBlock: 1_150n };

    options.softCursors.set(CONSUMER_A, cursor);

    getLogs
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(providerFailure());

    const result = await runDaemonCycle(options);
    const failed = result.consumers[0];

    if (failed?.status !== 'failed') {
      throw new Error('Expected consumer failure.');
    }

    expect(failed.operation).toEqual({
      name: 'scan-requests',
      scanType: 'soft',
      fromBlock: 1_150n,
      throughBlock: 1_200n,
      maxBlockRange: 100n,
    });

    expect(save).toHaveBeenCalledWith(CONSUMER_A, 1_100n);
    expect(options.softCursors.get(CONSUMER_A)).toBe(cursor);
  });

  it('ignores observer failures without changing processing', async () => {
    const { options, save } = fixture();

    const onOperation = vi.fn(() => {
      throw new Error('observer failed');
    });

    const result = await runDaemonIteration({
      ...options,
      consumer: CONSUMER_A,
      onOperation,
    });

    expect(result.status).toBe('processed');
    expect(onOperation).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(CONSUMER_A, 1_100n);
  });
});