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
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

vi.mock(
  '../src/daemon-iteration.js',
  () => ({
    runDaemonIteration: vi.fn(),
  }),
);

import type {
  CheckpointStore,
} from '../src/checkpoint.js';

import type {
  ValidatedQuicknetConsumer,
} from '../src/consumer.js';

import {
  runDaemonCycle,
} from '../src/daemon-cycle.js';

import {
  runDaemonIteration,
  type RunDaemonIterationResult,
} from '../src/daemon-iteration.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';
const CONSUMER_C: Address = '0x3333333333333333333333333333333333333333';

const REGISTRY_ADDRESS: Address = '0x4444444444444444444444444444444444444444';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;
const CHECKPOINT_STORE = {} as CheckpointStore;

const DEPLOYMENT: RegistryDeployment = {
  chainId: 46630,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
};

const VALIDATED_CONSUMER_A: ValidatedQuicknetConsumer = {
  address: CONSUMER_A,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMER_B: ValidatedQuicknetConsumer = {
  address: CONSUMER_B,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMER_C: ValidatedQuicknetConsumer = {
  address: CONSUMER_C,
  registry: REGISTRY_ADDRESS,
};

function caughtUpResult(
  nextBlock: bigint,
  headBlock: bigint,
): RunDaemonIterationResult {
  return {
    status: 'caught-up',
    consumer: CONSUMER_A,
    headBlock,
    nextBlock,
  };
}

function processedResult(
  consumer: Address,
  fromBlock: bigint,
  toBlock: bigint,
  nextBlock: bigint,
  headBlock: bigint,
): RunDaemonIterationResult {
  return {
    status: 'processed',
    consumer,
    headBlock,
    fromBlock,
    toBlock,
    nextBlock,
    processing: {
      rounds: [],
    },
  };
}

describe('runDaemonCycle', () => {
  beforeEach(() => {
    vi.mocked(
      runDaemonIteration,
    ).mockReset();
  });

  it('returns an empty result for an empty consumer list', async () => {
    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      consumers: [],
    });

    expect(
      runDaemonIteration,
    ).not.toHaveBeenCalled();
  });

  it('runs one iteration for one consumer', async () => {
    const iteration = caughtUpResult(
      1_001n,
      1_000n,
    );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(iteration);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledOnce();

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumer: CONSUMER_A,
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration,
        },
      ],
    });
  });

  it('forwards shared daemon options to every consumer iteration', async () => {
    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        caughtUpResult(
          1_001n,
          1_000n,
        )
      )
      .mockResolvedValueOnce({
        status: 'caught-up',
        consumer: CONSUMER_B,
        headBlock: 1_000n,
        nextBlock: 1_001n,
      });

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
        VALIDATED_CONSUMER_B,
      ],
      startBlock: 500n,
      maxBlockRange: 250n,
    });

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumer: CONSUMER_A,
        startBlock: 500n,
        maxBlockRange: 250n,
      },
    );

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumer: CONSUMER_B,
        startBlock: 500n,
        maxBlockRange: 250n,
      },
    );
  });

  it('preserves configured consumer order', async () => {
    const iterationB: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_B,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    };

    const iterationA: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_A,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    };

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(iterationB)
      .mockResolvedValueOnce(iterationA);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_B,
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(
      result.consumers.map(
        (consumer) => consumer.consumer.address
      )
    ).toEqual([
      CONSUMER_B,
      CONSUMER_A,
    ]);

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        consumer: CONSUMER_B,
      }),
    );

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        consumer: CONSUMER_A,
      }),
    );
  });

  it('preserves a caught-up iteration result', async () => {
    const iteration: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_A,
      headBlock: 2_000n,
      nextBlock: 2_001n,
    };

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(iteration);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration,
        },
      ],
    });
  });

  it('preserves a processed iteration result', async () => {
    const iteration = processedResult(
      CONSUMER_A,
      1_000n,
      1_099n,
      1_100n,
      1_500n,
    );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(iteration);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration,
        },
      ],
    });
  });

  it('captures a consumer iteration failure', async () => {
    const failure = new Error('Consumer iteration failed.');

    vi.mocked(
      runDaemonIteration,
    ).mockRejectedValue(failure);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(result).toEqual({
      consumers: [
        {
          status: 'failed',
          consumer: VALIDATED_CONSUMER_A,
          error: failure,
        },
      ],
    });
  });

  it('preserves the original consumer failure object', async () => {
    const failure = {
      code: 'TEST_FAILURE',
      message: 'Something failed.',
    };

    vi.mocked(
      runDaemonIteration,
    ).mockRejectedValue(failure);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    const consumerResult =
      result.consumers[0];

    expect(consumerResult).toBeDefined();

    if (
      consumerResult === undefined ||
      consumerResult.status !== 'failed'
    ) {
      throw new Error('Expected a failed consumer result.');
    }

    expect(
      consumerResult.error
    ).toBe(
      failure
    );
  });

  it('continues processing later consumers after one consumer fails', async () => {
    const failure = new Error('Consumer B failed.');

    const iterationA = processedResult(
      CONSUMER_A,
      1_000n,
      1_099n,
      1_100n,
      1_500n,
    );

    const iterationC = processedResult(
      CONSUMER_C,
      1_000n,
      1_099n,
      1_100n,
      1_500n,
    );

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(iterationA)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(iterationC);

    const result = await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
        VALIDATED_CONSUMER_B,
        VALIDATED_CONSUMER_C,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(3);

    expect(result).toEqual({
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration: iterationA,
        },
        {
          status: 'failed',
          consumer: VALIDATED_CONSUMER_B,
          error: failure,
        },
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_C,
          iteration: iterationC,
        },
      ],
    });
  });

  it('processes consumers sequentially', async () => {
    let resolveFirst:
      | ((value: RunDaemonIterationResult) => void)
      | undefined;

    const firstResult: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_A,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    };

    const secondResult: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_B,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    };

    const firstPromise =
      new Promise<RunDaemonIterationResult>((resolve) => {
        resolveFirst = resolve;
      });

    vi.mocked(
      runDaemonIteration,
    )
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(secondResult);

    const cycle = runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
        VALIDATED_CONSUMER_B,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    await Promise.resolve();

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(1);

    if (resolveFirst === undefined) {
      throw new Error('Expected first consumer resolver to be initialized.');
    }

    resolveFirst(firstResult);

    const result = await cycle;

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      consumers: [
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_A,
          iteration: firstResult,
        },
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_B,
          iteration: secondResult,
        },
      ],
    });
  });

  it('continues sequentially after a failed consumer', async () => {
    let rejectFirst:
      | ((reason?: unknown) => void)
      | undefined;

    const failure = new Error('Consumer A failed.');

    const secondResult: RunDaemonIterationResult = {
      status: 'caught-up',
      consumer: CONSUMER_B,
      headBlock: 1_000n,
      nextBlock: 1_001n,
    };

    const firstPromise =
      new Promise<RunDaemonIterationResult>((_resolve, reject) => {
        rejectFirst = reject;
      });

    vi.mocked(
      runDaemonIteration,
    )
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(secondResult);

    const cycle = runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
        VALIDATED_CONSUMER_B,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
    });

    await Promise.resolve();

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(1);

    if (rejectFirst === undefined) {
      throw new Error('Expected first consumer rejector to be initialized.');
    }

    rejectFirst(failure);

    const result = await cycle;

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      consumers: [
        {
          status: 'failed',
          consumer: VALIDATED_CONSUMER_A,
          error: failure,
        },
        {
          status: 'success',
          consumer: VALIDATED_CONSUMER_B,
          iteration: secondResult,
        },
      ],
    });
  });
});