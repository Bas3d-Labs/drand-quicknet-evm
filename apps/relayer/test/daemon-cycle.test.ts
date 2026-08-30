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
  type SoftScanCursor,
} from '../src/daemon-iteration.js';

import type {
  FinalityPolicy,
} from '../src/finality-policy.js';
import { robinhoodTestnet } from 'viem/chains';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';
const CONSUMER_C: Address = '0x3333333333333333333333333333333333333333';

const REGISTRY_ADDRESS: Address = '0x4444444444444444444444444444444444444444';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  
const ORACLE_ADDRESS = '0x5555555555555555555555555555555555555555';
const ORACLE_RUNTIME_CODEHASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;
const CHECKPOINT_STORE = {} as CheckpointStore;

const FINALITY: FinalityPolicy = {
  type: 'safe',
};

const DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
  oracleAddress: ORACLE_ADDRESS,
  oracleRuntimeCodehash: ORACLE_RUNTIME_CODEHASH,
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
  consumer: Address,
  softNextBlock: bigint,
): RunDaemonIterationResult {
  return {
    status: 'caught-up',
    consumer,
    latestBlock: 1_500n,
    durableBlock: 1_200n,
    durableNextBlock: 1_201n,
    durableHeadRegressed: false,
    softCursor: {
      nextBlock: softNextBlock,
    },
    durableScan: undefined,
    softScan: undefined,
  };
}

function processedResult(
  consumer: Address,
  softNextBlock: bigint,
): RunDaemonIterationResult {
  return {
    status: 'processed',
    consumer,
    latestBlock: 1_500n,
    durableBlock: 1_200n,
    durableNextBlock: 1_201n,
    durableHeadRegressed: false,
    softCursor: {
      nextBlock: softNextBlock,
    },
    durableScan: undefined,
    softScan: {
      fromBlock: 1_201n,
      toBlock: softNextBlock - 1n,
      nextBlock: softNextBlock,
      processing: {
        rounds: [],
      },
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
    const softCursors =
      new Map<Address, SoftScanCursor>();

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors,
      });

    expect(result).toEqual({
      consumers: [],
    });

    expect(
      runDaemonIteration,
    ).not.toHaveBeenCalled();

    expect(
      softCursors.size,
    ).toBe(
      0
    );
  });

  it('runs one iteration for one consumer without an existing soft cursor', async () => {
    const iteration =
      caughtUpResult(
        CONSUMER_A,
        1_501n,
      );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      iteration
    );

    const softCursors =
      new Map<Address, SoftScanCursor>();

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [
          VALIDATED_CONSUMER_A,
        ],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors,
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
      finality: FINALITY,
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

  it('passes an existing soft cursor to the consumer iteration', async () => {
    const existingCursor: SoftScanCursor = {
      nextBlock: 1_400n,
    };

    const iteration =
      caughtUpResult(
        CONSUMER_A,
        1_501n,
      );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      iteration
    );

    const softCursors =
      new Map<Address, SoftScanCursor>([
        [
          CONSUMER_A,
          existingCursor,
        ],
      ]);

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

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
      finality: FINALITY,
      softCursor: existingCursor,
    });
  });

  it('stores the returned soft cursor after a successful iteration', async () => {
    const iteration =
      processedResult(
        CONSUMER_A,
        1_501n,
      );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      iteration
    );

    const softCursors =
      new Map<Address, SoftScanCursor>();

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

    expect(
      softCursors.get(
        CONSUMER_A
      ),
    ).toEqual({
      nextBlock: 1_501n,
    });
  });

  it('replaces an existing soft cursor after a successful iteration', async () => {
    const softCursors =
      new Map<Address, SoftScanCursor>([
        [
          CONSUMER_A,
          {
            nextBlock: 1_300n,
          },
        ],
      ]);

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      processedResult(
        CONSUMER_A,
        1_501n,
      )
    );

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

    expect(
      softCursors.get(
        CONSUMER_A
      ),
    ).toEqual({
      nextBlock: 1_501n,
    });
  });

  it('forwards shared daemon options to every consumer iteration', async () => {
    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        caughtUpResult(
          CONSUMER_A,
          1_501n,
        )
      )
      .mockResolvedValueOnce(
        caughtUpResult(
          CONSUMER_B,
          1_501n,
        )
      );

    const softCursors =
      new Map<Address, SoftScanCursor>();

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
      finality: FINALITY,
      softCursors,
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
        finality: FINALITY,
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
        finality: FINALITY,
      },
    );
  });

  it('passes the correct soft cursor to each consumer', async () => {
    const cursorA: SoftScanCursor = {
      nextBlock: 1_300n,
    };

    const cursorB: SoftScanCursor = {
      nextBlock: 1_400n,
    };

    const softCursors =
      new Map<Address, SoftScanCursor>([
        [
          CONSUMER_A,
          cursorA,
        ],
        [
          CONSUMER_B,
          cursorB,
        ],
      ]);

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        caughtUpResult(
          CONSUMER_A,
          1_501n,
        )
      )
      .mockResolvedValueOnce(
        caughtUpResult(
          CONSUMER_B,
          1_501n,
        )
      );

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
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        consumer: CONSUMER_A,
        softCursor: cursorA,
      }),
    );

    expect(
      runDaemonIteration,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        consumer: CONSUMER_B,
        softCursor: cursorB,
      }),
    );
  });

  it('preserves configured consumer order', async () => {
    const iterationB =
      caughtUpResult(
        CONSUMER_B,
        1_501n,
      );

    const iterationA =
      caughtUpResult(
        CONSUMER_A,
        1_501n,
      );

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        iterationB
      )
      .mockResolvedValueOnce(
        iterationA
      );

    const softCursors =
      new Map<Address, SoftScanCursor>();

    const result =
      await runDaemonCycle({
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
        finality: FINALITY,
        softCursors,
      });

    expect(
      result.consumers.map(
        (consumer) =>
          consumer.consumer.address
      )
    ).toEqual([
      CONSUMER_B,
      CONSUMER_A,
    ]);
  });

  it('preserves a caught-up iteration result', async () => {
    const iteration =
      caughtUpResult(
        CONSUMER_A,
        2_001n,
      );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      iteration
    );

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [
          VALIDATED_CONSUMER_A,
        ],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
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
    const iteration =
      processedResult(
        CONSUMER_A,
        1_501n,
      );

    vi.mocked(
      runDaemonIteration,
    ).mockResolvedValue(
      iteration
    );

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [
          VALIDATED_CONSUMER_A,
        ],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
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
    const failure =
      new Error(
        'Consumer iteration failed.',
      );

    vi.mocked(
      runDaemonIteration,
    ).mockRejectedValue(
      failure
    );

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [
          VALIDATED_CONSUMER_A,
        ],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
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
    ).mockRejectedValue(
      failure
    );

    const result =
      await runDaemonCycle({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [
          VALIDATED_CONSUMER_A,
        ],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
      });

    const consumerResult =
      result.consumers[0];

    expect(
      consumerResult,
    ).toBeDefined();

    if (
      consumerResult === undefined ||
      consumerResult.status !== 'failed'
    ) {
      throw new Error(
        'Expected a failed consumer result.'
      );
    }

    expect(
      consumerResult.error
    ).toBe(
      failure
    );
  });

  it('does not create a soft cursor when a consumer iteration fails', async () => {
    vi.mocked(
      runDaemonIteration,
    ).mockRejectedValue(
      new Error(
        'Consumer iteration failed.',
      )
    );

    const softCursors =
      new Map<Address, SoftScanCursor>();

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

    expect(
      softCursors.has(
        CONSUMER_A
      ),
    ).toBe(
      false
    );
  });

  it('preserves an existing soft cursor when a consumer iteration fails', async () => {
    const existingCursor: SoftScanCursor = {
      nextBlock: 1_400n,
    };

    const softCursors =
      new Map<Address, SoftScanCursor>([
        [
          CONSUMER_A,
          existingCursor,
        ],
      ]);

    vi.mocked(
      runDaemonIteration,
    ).mockRejectedValue(
      new Error(
        'Consumer iteration failed.',
      )
    );

    await runDaemonCycle({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [
        VALIDATED_CONSUMER_A,
      ],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      softCursors,
    });

    expect(
      softCursors.get(
        CONSUMER_A
      ),
    ).toBe(
      existingCursor
    );
  });

  it('continues processing later consumers after one consumer fails', async () => {
    const failure =
      new Error(
        'Consumer B failed.',
      );

    const iterationA =
      processedResult(
        CONSUMER_A,
        1_501n,
      );

    const iterationC =
      processedResult(
        CONSUMER_C,
        1_601n,
      );

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        iterationA
      )
      .mockRejectedValueOnce(
        failure
      )
      .mockResolvedValueOnce(
        iterationC
      );

    const softCursors =
      new Map<Address, SoftScanCursor>();

    const result =
      await runDaemonCycle({
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
        finality: FINALITY,
        softCursors,
      });

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(
      3
    );

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

    expect(
      softCursors.get(
        CONSUMER_A
      ),
    ).toEqual({
      nextBlock: 1_501n,
    });

    expect(
      softCursors.has(
        CONSUMER_B
      ),
    ).toBe(
      false
    );

    expect(
      softCursors.get(
        CONSUMER_C
      ),
    ).toEqual({
      nextBlock: 1_601n,
    });
  });

  it('preserves a failed consumer cursor while updating successful consumers', async () => {
    const existingCursorB: SoftScanCursor = {
      nextBlock: 1_350n,
    };

    const softCursors =
      new Map<Address, SoftScanCursor>([
        [
          CONSUMER_B,
          existingCursorB,
        ],
      ]);

    vi.mocked(
      runDaemonIteration,
    )
      .mockResolvedValueOnce(
        processedResult(
          CONSUMER_A,
          1_501n,
        )
      )
      .mockRejectedValueOnce(
        new Error(
          'Consumer B failed.',
        )
      )
      .mockResolvedValueOnce(
        processedResult(
          CONSUMER_C,
          1_601n,
        )
      );

    await runDaemonCycle({
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
      finality: FINALITY,
      softCursors,
    });

    expect(
      softCursors.get(
        CONSUMER_A
      ),
    ).toEqual({
      nextBlock: 1_501n,
    });

    expect(
      softCursors.get(
        CONSUMER_B
      ),
    ).toBe(
      existingCursorB
    );

    expect(
      softCursors.get(
        CONSUMER_C
      ),
    ).toEqual({
      nextBlock: 1_601n,
    });
  });

  it('processes consumers sequentially', async () => {
    let resolveFirst:
      | ((value: RunDaemonIterationResult) => void)
      | undefined;

    const firstResult =
      caughtUpResult(
        CONSUMER_A,
        1_501n,
      );

    const secondResult =
      caughtUpResult(
        CONSUMER_B,
        1_501n,
      );

    const firstPromise =
      new Promise<RunDaemonIterationResult>(
        (resolve) => {
          resolveFirst =
            resolve;
        },
      );

    vi.mocked(
      runDaemonIteration,
    )
      .mockReturnValueOnce(
        firstPromise
      )
      .mockResolvedValueOnce(
        secondResult
      );

    const cycle =
      runDaemonCycle({
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
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
      });

    await Promise.resolve();

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(
      1
    );

    if (resolveFirst === undefined) {
      throw new Error(
        'Expected first consumer resolver to be initialized.'
      );
    }

    resolveFirst(
      firstResult
    );

    const result =
      await cycle;

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(
      2
    );

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

    const failure =
      new Error(
        'Consumer A failed.',
      );

    const secondResult =
      caughtUpResult(
        CONSUMER_B,
        1_501n,
      );

    const firstPromise =
      new Promise<RunDaemonIterationResult>(
        (_resolve, reject) => {
          rejectFirst =
            reject;
        },
      );

    vi.mocked(
      runDaemonIteration,
    )
      .mockReturnValueOnce(
        firstPromise
      )
      .mockResolvedValueOnce(
        secondResult
      );

    const cycle =
      runDaemonCycle({
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
        finality: FINALITY,
        softCursors:
          new Map<Address, SoftScanCursor>(),
      });

    await Promise.resolve();

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(
      1
    );

    if (rejectFirst === undefined) {
      throw new Error(
        'Expected first consumer rejector to be initialized.'
      );
    }

    rejectFirst(
      failure
    );

    const result =
      await cycle;

    expect(
      runDaemonIteration,
    ).toHaveBeenCalledTimes(
      2
    );

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