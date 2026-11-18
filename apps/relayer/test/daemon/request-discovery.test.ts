import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  runDaemonIteration,
} from '../../src/daemon/daemon-iteration.js';

import type {
  RequestDiscovery,
} from '../../src/diagnostics/request-discovery.js';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  RoundImporter,
} from '../../src/rounds/create-round-importer.js';

const registry = vi.hoisted(() => ({
  isStored: vi.fn(),
}));

vi.mock('@based-labs/drand-quicknet-registry', () => ({
  createRegistryReader: () => registry,
}));

const CONSUMER = '0x1111111111111111111111111111111111111111';

const HASH = `0x${'ab'.repeat(32)}` as const;

const DEPLOYMENT: RegistryDeployment = {
  chainId: 46630,
  address: CONSUMER,
  runtimeCodehash: HASH,
  verifierAddress: CONSUMER,
  verifierRuntimeCodehash: HASH,
};

async function exercise(
  observer: boolean,
  throws: boolean,
) {
  const calls: unknown[] = [];
  const order: string[] = [];
  const observations: {
    scanType: string;
    observation: RequestDiscovery;
  }[] = [];

  registry.isStored.mockImplementation(async (...args: unknown[]) => {
    calls.push(['isStored', ...args]);

    return true;
  });

  const publicClient = {
    async getBlock(
      options: { blockNumber: bigint },
    ) {
      calls.push(['getBlock', options]);

      return {
        number: options.blockNumber,
        hash: HASH,
      };
    },

    async getLogs(
      options: {
        fromBlock: bigint;
        toBlock: bigint;
      },
    ) {
      calls.push(['getLogs', options]);

      return [{
        address: CONSUMER,
        args: {
          round: options.fromBlock,
        },
        blockNumber: options.fromBlock,
        blockHash: HASH,
        transactionHash: HASH,
        logIndex: 0,
      }];
    },
  } as unknown as PublicClient;

  const importRound: RoundImporter = async (round) => {
    order.push(`import:${round}`);

    return {
      status: 'already-stored',
      round,
      randomness: HASH,
    };
  };

  const save = vi.fn();

  const result = await runDaemonIteration({
    publicClient,
    deployment: DEPLOYMENT,
    consumer: CONSUMER,
    startBlock: 100n,
    maxBlockRange: 100n,
    finality: {
      type: 'safe',
    },
    readChainHeads: async () => ({
      latestBlock: 101n,
      durableBlock: 100n,
    }),
    checkpointStore: {
      load: async () => 100n,
      save,
    },
    bindRoundImporter: () => importRound,
    submitter: {} as BeaconSubmitter,
    ...(observer ? {
      onRequestDiscovered(
        scanType: 'durable' | 'soft',
        observation: RequestDiscovery,
      ) {
        order.push(`observe:${observation.round}`);
        observations.push({
          scanType,
          observation,
        });

        if (throws) {
          throw new Error('diagnostic failure');
        }
      },
    } : {}),
  });

  return {
    calls,
    order,
    observations,
    result,
    saves: save.mock.calls,
  };
}

describe('discovery through real decoding, scanning and processing', () => {
  it.each([false, true])(
    'preserves RPC sequence and checkpoints (observer throws: %s)',
    async (throws) => {
      const baseline = await exercise(false, false);
      const observed = await exercise(true, throws);

      expect(observed.calls).toEqual(baseline.calls);

      expect(observed.result).toEqual(baseline.result);

      expect(observed.saves).toEqual([[CONSUMER, 101n]]);

      expect(observed.saves).toEqual(baseline.saves);

      expect(observed.order).toEqual([
        'observe:100',
        'import:100',
        'observe:101',
        'import:101',
      ]);

      expect(
        observed.observations.map((entry) => entry.scanType),
      ).toEqual(['durable', 'soft']);

      expect(
        observed.observations.every(
          (entry) => entry.observation.blockHash === HASH,
        ),
      ).toBe(true);
    },
  );
});
