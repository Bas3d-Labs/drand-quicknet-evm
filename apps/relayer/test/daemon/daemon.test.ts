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
  '../../src/daemon/daemon-cycle.js',
  () => ({
    runDaemonCycle: vi.fn(),
  }),
);

import type {
  CheckpointStore,
} from '../../src/state/checkpoint.js';

import type {
  ValidatedQuicknetConsumer,
} from '../../src/consumers/consumer.js';

import {
  runDaemonCycle,
  type RunDaemonCycleResult,
} from '../../src/daemon/daemon-cycle.js';

import {
  runDaemon,
} from '../../src/daemon/daemon.js';

import type {
  SoftScanCursor,
} from '../../src/daemon/daemon-iteration.js';

import type {
  FinalityPolicy,
} from '../../src/chain/finality-policy.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const CHAIN_ID = 12345;

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  
const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;
const ACCOUNT = {} as Account;
const CHECKPOINT_STORE = {} as CheckpointStore;

const FINALITY: FinalityPolicy = {
  type: 'safe',
};

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

const VALIDATED_CONSUMER_A: ValidatedQuicknetConsumer = {
  address: CONSUMER_A,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMER_B: ValidatedQuicknetConsumer = {
  address: CONSUMER_B,
  registry: REGISTRY_ADDRESS,
};

function caughtUpCycle(): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'success',
        consumer: VALIDATED_CONSUMER_A,
        iteration: {
          status: 'caught-up',
          consumer: CONSUMER_A,
          latestBlock: 1_500n,
          durableBlock: 1_200n,
          durableNextBlock: 1_201n,
          durableHeadRegressed: false,
          softCursor: {
            nextBlock: 1_501n,
          },
          durableScan: undefined,
          softScan: undefined,
        },
      },
    ],
  };
}

function processedCycle(): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'success',
        consumer: VALIDATED_CONSUMER_A,
        iteration: {
          status: 'processed',
          consumer: CONSUMER_A,
          latestBlock: 1_500n,
          durableBlock: 1_200n,
          durableNextBlock: 1_201n,
          durableHeadRegressed: false,
          softCursor: {
            nextBlock: 1_301n,
          },
          durableScan: undefined,
          softScan: {
            fromBlock: 1_201n,
            toBlock: 1_300n,
            nextBlock: 1_301n,
            processing: {
              rounds: [],
            },
          },
        },
      },
    ],
  };
}

function failedCycle(
  error: unknown,
): RunDaemonCycleResult {
  return {
    consumers: [
      {
        status: 'failed',
        consumer: VALIDATED_CONSUMER_A,
        error,
      },
    ],
  };
}

describe('runDaemon', () => {
  beforeEach(() => {
    vi.mocked(
      runDaemonCycle,
    ).mockReset();
  });

  it('rejects a zero pollIntervalMs', async () => {
    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(
      'pollIntervalMs must be a positive safe integer.'
    );

    expect(
      runDaemonCycle,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative pollIntervalMs', async () => {
    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: -1,
      })
    ).rejects.toThrow(
      'pollIntervalMs must be a positive safe integer.'
    );
  });

  it('rejects a fractional pollIntervalMs', async () => {
    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: 1.5,
      })
    ).rejects.toThrow(
      'pollIntervalMs must be a positive safe integer.'
    );
  });

  it('rejects a pollIntervalMs larger than the maximum safe integer', async () => {
    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: Number.MAX_SAFE_INTEGER + 1,
      })
    ).rejects.toThrow(
      'pollIntervalMs must be a positive safe integer.'
    );
  });

  it('does nothing when the signal is already aborted', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn();

    controller.abort();

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
    });

    expect(
      runDaemonCycle,
    ).not.toHaveBeenCalled();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('forwards daemon options to each cycle', async () => {
    const controller =
      new AbortController();

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      caughtUpCycle()
    );

    await runDaemon({
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
      pollIntervalMs: 1_000,
      signal: controller.signal,
      onCycle: () => {
        controller.abort();
      },
    });

    expect(
      runDaemonCycle,
    ).toHaveBeenCalledOnce();

    expect(
      runDaemonCycle,
    ).toHaveBeenCalledWith({
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
      softCursors:
        expect.any(Map),
    });
  });

  it('starts with an empty soft cursor map', async () => {
    const controller =
      new AbortController();

    let initialSize:
      number |
      undefined;

    vi.mocked(
      runDaemonCycle,
    ).mockImplementation(
      async (options) => {
        initialSize =
          options.softCursors.size;

        return caughtUpCycle();
      },
    );

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      onCycle: () => {
        controller.abort();
      },
    });

    expect(
      initialSize,
    ).toBe(
      0
    );
  });

  it('reuses the same soft cursor map across cycles', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn().mockResolvedValue(
        undefined
      );

    vi.mocked(
      runDaemonCycle,
    )
      .mockResolvedValueOnce(
        caughtUpCycle()
      )
      .mockResolvedValueOnce(
        caughtUpCycle()
      );

    let cycleCount = 0;

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        cycleCount += 1;

        if (cycleCount === 2) {
          controller.abort();
        }
      },
    });

    const firstCall =
      vi.mocked(
        runDaemonCycle
      ).mock.calls[0];

    const secondCall =
      vi.mocked(
        runDaemonCycle
      ).mock.calls[1];

    expect(
      firstCall,
    ).toBeDefined();

    expect(
      secondCall,
    ).toBeDefined();

    if (
      firstCall === undefined ||
      secondCall === undefined
    ) {
      throw new Error(
        'Expected two daemon cycle calls.'
      );
    }

    expect(
      firstCall[0].softCursors,
    ).toBe(
      secondCall[0].softCursors
    );
  });

  it('preserves soft cursor mutations across cycles', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn().mockResolvedValue(
        undefined
      );

    const cursor: SoftScanCursor = {
      nextBlock: 1_400n,
    };

    let observedCursor:
      SoftScanCursor |
      undefined;

    vi.mocked(
      runDaemonCycle,
    )
      .mockImplementationOnce(
        async (options) => {
          options.softCursors.set(
            CONSUMER_A,
            cursor
          );

          return caughtUpCycle();
        },
      )
      .mockImplementationOnce(
        async (options) => {
          observedCursor =
            options.softCursors.get(
              CONSUMER_A
            );

          return caughtUpCycle();
        },
      );

    let cycleCount = 0;

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        cycleCount += 1;

        if (cycleCount === 2) {
          controller.abort();
        }
      },
    });

    expect(
      observedCursor,
    ).toBe(
      cursor
    );
  });

  it('passes each cycle result to onCycle', async () => {
    const controller =
      new AbortController();

    const cycleResult =
      caughtUpCycle();

    const onCycle =
      vi.fn(() => {
        controller.abort();
      });

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      cycleResult
    );

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      onCycle,
    });

    expect(
      onCycle,
    ).toHaveBeenCalledOnce();

    expect(
      onCycle,
    ).toHaveBeenCalledWith(
      cycleResult
    );
  });

  it('immediately runs another cycle when progress was made', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn();

    vi.mocked(
      runDaemonCycle,
    )
      .mockResolvedValueOnce(
        processedCycle()
      )
      .mockResolvedValueOnce(
        caughtUpCycle()
      );

    let cycleCount = 0;

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        cycleCount += 1;

        if (cycleCount === 2) {
          controller.abort();
        }
      },
    });

    expect(
      runDaemonCycle,
    ).toHaveBeenCalledTimes(
      2
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('treats an empty successfully scanned range as progress', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn();

    const processedEmpty:
      RunDaemonCycleResult = {
        consumers: [
          {
            status: 'success',
            consumer:
              VALIDATED_CONSUMER_A,
            iteration: {
              status: 'processed',
              consumer: CONSUMER_A,
              latestBlock: 1_500n,
              durableBlock: 1_200n,
              durableNextBlock: 1_201n,
              durableHeadRegressed: false,
              softCursor: {
                nextBlock: 1_301n,
              },
              durableScan: undefined,
              softScan: {
                fromBlock: 1_201n,
                toBlock: 1_300n,
                nextBlock: 1_301n,
                processing: {
                  rounds: [],
                },
              },
            },
          },
        ],
      };

    vi.mocked(
      runDaemonCycle,
    )
      .mockResolvedValueOnce(
        processedEmpty
      )
      .mockResolvedValueOnce(
        caughtUpCycle()
      );

    let cycleCount = 0;

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        cycleCount += 1;

        if (cycleCount === 2) {
          controller.abort();
        }
      },
    });

    expect(
      runDaemonCycle,
    ).toHaveBeenCalledTimes(
      2
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('sleeps when every successful consumer is caught up', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn(async () => {
        controller.abort();
      });

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      caughtUpCycle()
    );

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 2_500,
      signal: controller.signal,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledOnce();

    expect(
      sleep,
    ).toHaveBeenCalledWith(
      2_500,
      controller.signal
    );
  });

  it('sleeps when the cycle only contains failures', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn(async () => {
        controller.abort();
      });

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      failedCycle(
        new Error(
          'Consumer failed.',
        )
      )
    );

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
    });

    expect(
      sleep,
    ).toHaveBeenCalledOnce();
  });

  it('does not sleep when at least one consumer made progress', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn();

    const cycleResult:
      RunDaemonCycleResult = {
        consumers: [
          {
            status: 'failed',
            consumer:
              VALIDATED_CONSUMER_A,
            error:
              new Error(
                'Consumer A failed.',
              ),
          },
          {
            status: 'success',
            consumer:
              VALIDATED_CONSUMER_B,
            iteration: {
              status: 'processed',
              consumer: CONSUMER_B,
              latestBlock: 1_500n,
              durableBlock: 1_200n,
              durableNextBlock: 1_201n,
              durableHeadRegressed: false,
              softCursor: {
                nextBlock: 1_301n,
              },
              durableScan: undefined,
              softScan: {
                fromBlock: 1_201n,
                toBlock: 1_300n,
                nextBlock: 1_301n,
                processing: {
                  rounds: [],
                },
              },
            },
          },
        ],
      };

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      cycleResult
    );

    await runDaemon({
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
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        controller.abort();
      },
    });

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('does not sleep when onCycle aborts the daemon', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn();

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      caughtUpCycle()
    );

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        controller.abort();
      },
    });

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('runs another cycle after sleeping when not aborted', async () => {
    const controller =
      new AbortController();

    const sleep =
      vi.fn().mockResolvedValue(
        undefined
      );

    vi.mocked(
      runDaemonCycle,
    )
      .mockResolvedValueOnce(
        caughtUpCycle()
      )
      .mockResolvedValueOnce(
        caughtUpCycle()
      );

    let cycleCount = 0;

    await runDaemon({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: CHECKPOINT_STORE,
      consumers: [VALIDATED_CONSUMER_A],
      startBlock: 1_000n,
      maxBlockRange: 100n,
      finality: FINALITY,
      pollIntervalMs: 1_000,
      signal: controller.signal,
      sleep,
      onCycle: () => {
        cycleCount += 1;

        if (cycleCount === 2) {
          controller.abort();
        }
      },
    });

    expect(
      runDaemonCycle,
    ).toHaveBeenCalledTimes(
      2
    );

    expect(
      sleep,
    ).toHaveBeenCalledOnce();
  });

  it('propagates an unexpected daemon cycle failure', async () => {
    const failure =
      new Error(
        'Daemon cycle failed.',
      );

    const onCycle =
      vi.fn();

    const sleep =
      vi.fn();

    vi.mocked(
      runDaemonCycle,
    ).mockRejectedValue(
      failure
    );

    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: 1_000,
        sleep,
        onCycle,
      })
    ).rejects.toBe(
      failure
    );

    expect(
      onCycle,
    ).not.toHaveBeenCalled();

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('propagates onCycle failures', async () => {
    const failure =
      new Error(
        'Cycle observer failed.',
      );

    const sleep =
      vi.fn();

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      caughtUpCycle()
    );

    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: 1_000,
        sleep,
        onCycle: () => {
          throw failure;
        },
      })
    ).rejects.toBe(
      failure
    );

    expect(
      sleep,
    ).not.toHaveBeenCalled();
  });

  it('propagates sleep failures', async () => {
    const failure =
      new Error(
        'Sleep failed.',
      );

    vi.mocked(
      runDaemonCycle,
    ).mockResolvedValue(
      caughtUpCycle()
    );

    await expect(
      runDaemon({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        checkpointStore: CHECKPOINT_STORE,
        consumers: [VALIDATED_CONSUMER_A],
        startBlock: 1_000n,
        maxBlockRange: 100n,
        finality: FINALITY,
        pollIntervalMs: 1_000,
        sleep: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(
      failure
    );
  });
});
