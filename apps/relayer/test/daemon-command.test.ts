import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Address,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  robinhoodTestnet,
} from 'viem/chains';

import {
  verifyRegistryDeployment,
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const checkpointLockHandleMocks = vi.hoisted(() => ({
  release: vi.fn(),
}));

const checkpointLockMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

const checkpointStoreMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

const daemonLoggerMocks = vi.hoisted(() => ({
  onCycle: vi.fn(),
}));

const relayerLogMocks = vi.hoisted(() => ({
  consumerFailed: vi.fn(),
  durableHeadRegressed: vi.fn(),
  checkpointAdvanced: vi.fn(),
  roundImported: vi.fn(),
  roundAlreadyStored: vi.fn(),
  heartbeat: vi.fn(),
  loggingFailed: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet-registry',
  () => ({
    verifyRegistryDeployment: vi.fn(),
  }),
);

vi.mock('../src/clients.js', () => ({
  createRelayerClients: vi.fn(),
}));

vi.mock('../src/daemon-config.js', () => ({
  loadDaemonConfig: vi.fn(),
}));

vi.mock('../src/daemon-logging.js', () => ({
  createDaemonLogger: vi.fn(),
}));

vi.mock('../src/daemon-startup.js', () => ({
  collectDaemonStartupSummary: vi.fn(),
  formatDaemonStartupSummary: vi.fn(),
}));

vi.mock('../src/daemon.js', () => ({
  runDaemon: vi.fn(),
}));

vi.mock('../src/file-checkpoint-lock.js', () => ({
  FileCheckpointLock: vi.fn(
    function FileCheckpointLock() {
      return checkpointLockMocks;
    },
  ),
}));

vi.mock('../src/file-checkpoint-store.js', () => ({
  FileCheckpointStore: vi.fn(
    function FileCheckpointStore() {
      return checkpointStoreMocks;
    },
  ),
}));

vi.mock('../src/relayer-log.js', () => ({
  createRelayerLog: vi.fn(),
}));

vi.mock('../src/validate-consumers.js', () => ({
  validateQuicknetConsumers: vi.fn(),
}));

import {
  createRelayerClients,
} from '../src/clients.js';

import type {
  ValidatedQuicknetConsumer,
} from '../src/consumer.js';

import {
  runDaemonCommand,
} from '../src/daemon-command.js';

import {
  loadDaemonConfig,
  type DaemonConfig,
} from '../src/daemon-config.js';

import {
  createDaemonLogger,
} from '../src/daemon-logging.js';

import {
  collectDaemonStartupSummary,
  formatDaemonStartupSummary,
  type DaemonStartupSummary,
} from '../src/daemon-startup.js';

import {
  runDaemon,
} from '../src/daemon.js';

import {
  FileCheckpointLock,
} from '../src/file-checkpoint-lock.js';

import {
  FileCheckpointStore,
} from '../src/file-checkpoint-store.js';

import {
  createRelayerLog,
} from '../src/relayer-log.js';

import {
  validateQuicknetConsumers,
} from '../src/validate-consumers.js';

const SOURCE = {
  type: 'preset',
  network: 'robinhood-testnet',
} as const;

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const CHAIN_ID = robinhoodTestnet.id;

// Fixed test fixture; never use this account outside tests.
const PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);

const PUBLIC_CLIENT = {} as PublicClient;
const WALLET_CLIENT = {} as WalletClient;

const DAEMON_CONFIG: DaemonConfig = {
  network: 'robinhood-testnet',
  chain: robinhoodTestnet,
  rpcUrl: 'https://rpc.example.test',
  account: ACCOUNT,
  deployment: DEPLOYMENT,
  finality: {
    type: 'safe',
  },
  consumers: [
    CONSUMER_A,
    CONSUMER_B,
  ],
  startBlock: 123_456n,
  checkpointFile: './state/checkpoint.json',
  maxBlockRange: 2_000n,
  pollIntervalMs: 1_000,
};

const VALIDATED_CONSUMER_A: ValidatedQuicknetConsumer = {
  address: CONSUMER_A,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMER_B: ValidatedQuicknetConsumer = {
  address: CONSUMER_B,
  registry: REGISTRY_ADDRESS,
};

const VALIDATED_CONSUMERS = [
  VALIDATED_CONSUMER_A,
  VALIDATED_CONSUMER_B,
];

const STARTUP_SUMMARY: DaemonStartupSummary = {
  network: DAEMON_CONFIG.network,
  chainId: CHAIN_ID,
  rpcOrigin: 'https://rpc.example.test',
  signer: ACCOUNT.address,
  signerBalance: 1_000_000_000_000_000_000n,
  registry: REGISTRY_ADDRESS,
  registryRuntimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  finality: DAEMON_CONFIG.finality,
  latestHead: 123_600n,
  durableHead: 123_500n,
  consumers: DAEMON_CONFIG.consumers,
  checkpointFile: DAEMON_CONFIG.checkpointFile,
  startBlock: DAEMON_CONFIG.startBlock,
  maxBlockRange: DAEMON_CONFIG.maxBlockRange,
  pollIntervalMs: DAEMON_CONFIG.pollIntervalMs,
  durableNextBlocks: new Map<Address, bigint>(),
};

const FORMATTED_STARTUP_SUMMARY =
  'Relayer daemon starting\n...';

function firstInvocationOrder(
  mock: {
    mock: {
      invocationCallOrder: number[];
    };
  },
): number {
  const order = mock.mock.invocationCallOrder[0];

  if (order === undefined) {
    throw new Error('Expected mock to have been called.');
  }

  return order;
}

describe('runDaemonCommand', () => {
  beforeEach(() => {
    // Keep tests independent of the shell's logging configuration.
    vi.stubEnv('QUICKNET_LOG_LEVEL', undefined);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(loadDaemonConfig).mockReset();
    vi.mocked(createRelayerLog).mockReset();
    vi.mocked(createDaemonLogger).mockReset();
    vi.mocked(createRelayerClients).mockReset();
    vi.mocked(verifyRegistryDeployment).mockReset();
    vi.mocked(validateQuicknetConsumers).mockReset();
    vi.mocked(collectDaemonStartupSummary).mockReset();
    vi.mocked(formatDaemonStartupSummary).mockReset();
    vi.mocked(runDaemon).mockReset();

    // Preserve the constructor implementations declared in vi.mock.
    vi.mocked(FileCheckpointStore).mockClear();
    vi.mocked(FileCheckpointLock).mockClear();

    checkpointStoreMocks.load.mockReset();
    checkpointStoreMocks.save.mockReset();
    checkpointLockMocks.acquire.mockReset();
    checkpointLockHandleMocks.release.mockReset();
    daemonLoggerMocks.onCycle.mockReset();

    for (const mock of Object.values(relayerLogMocks)) {
      mock.mockReset();
    }

    vi.mocked(loadDaemonConfig).mockResolvedValue(
      DAEMON_CONFIG,
    );

    vi.mocked(createRelayerLog).mockReturnValue(
      relayerLogMocks,
    );

    vi.mocked(createDaemonLogger).mockReturnValue(
      daemonLoggerMocks,
    );

    vi.mocked(createRelayerClients).mockReturnValue({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
    });

    vi.mocked(verifyRegistryDeployment).mockResolvedValue(
      undefined,
    );

    vi.mocked(validateQuicknetConsumers).mockResolvedValue(
      VALIDATED_CONSUMERS,
    );

    checkpointStoreMocks.load.mockResolvedValue(undefined);
    checkpointStoreMocks.save.mockResolvedValue(undefined);

    checkpointLockMocks.acquire.mockResolvedValue(
      checkpointLockHandleMocks,
    );

    checkpointLockHandleMocks.release.mockResolvedValue(
      undefined,
    );

    vi.mocked(collectDaemonStartupSummary).mockResolvedValue(
      STARTUP_SUMMARY,
    );

    vi.mocked(formatDaemonStartupSummary).mockReturnValue(
      FORMATTED_STARTUP_SUMMARY,
    );

    vi.mocked(runDaemon).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('loads daemon configuration for the requested network', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await runDaemonCommand({
      source: SOURCE,
      env,
    });

    expect(loadDaemonConfig).toHaveBeenCalledOnce();

    expect(loadDaemonConfig).toHaveBeenCalledWith({
      source: SOURCE,
      env,
    });
  });

  it('omits env when no environment is provided', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(loadDaemonConfig).toHaveBeenCalledWith({
      source: SOURCE,
    });
  });

  it('creates the relayer logger with chain ID and default level', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(createRelayerLog).toHaveBeenCalledOnce();

    // Exact arguments prevent raw configuration from becoming bindings.
    expect(createRelayerLog).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      level: 'info',
    });
  });

  it('uses the log level from the supplied environment', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'error');

    await runDaemonCommand({
      source: SOURCE,
      env: {
        QUICKNET_LOG_LEVEL: 'debug',
      },
    });

    expect(createRelayerLog).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      level: 'debug',
    });
  });

  it('uses the process log level when no environment is supplied', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'warn');

    await runDaemonCommand({
      source: SOURCE,
    });

    expect(createRelayerLog).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      level: 'warn',
    });
  });

  it('defaults to info for an explicit environment without a log level', async () => {
    vi.stubEnv('QUICKNET_LOG_LEVEL', 'debug');

    await runDaemonCommand({
      source: SOURCE,
      env: {},
    });

    expect(createRelayerLog).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      level: 'info',
    });
  });

  it('delegates log-level validation to createRelayerLog', async () => {
    const invalidLevel = 'invalid-level-canary';

    await runDaemonCommand({
      source: SOURCE,
      env: {
        QUICKNET_LOG_LEVEL: invalidLevel,
      },
    });

    expect(createRelayerLog).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      level: invalidLevel,
    });
  });

  it('creates the daemon logger from the relayer logger', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(createDaemonLogger).toHaveBeenCalledOnce();

    expect(createDaemonLogger).toHaveBeenCalledWith({
      logger: relayerLogMocks,
    });
  });

  it('creates relayer clients from the daemon configuration', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(createRelayerClients).toHaveBeenCalledOnce();

    expect(createRelayerClients).toHaveBeenCalledWith(
      DAEMON_CONFIG,
    );
  });

  it('verifies the configured registry deployment', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(verifyRegistryDeployment).toHaveBeenCalledOnce();

    expect(verifyRegistryDeployment).toHaveBeenCalledWith(
      PUBLIC_CLIENT,
      DEPLOYMENT,
    );
  });

  it('validates the configured consumers', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(validateQuicknetConsumers).toHaveBeenCalledOnce();

    expect(validateQuicknetConsumers).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      deployment: DEPLOYMENT,
      consumers: [
        CONSUMER_A,
        CONSUMER_B,
      ],
    });
  });

  it('creates a checkpoint store for the configured deployment', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(FileCheckpointStore).toHaveBeenCalledOnce();

    expect(FileCheckpointStore).toHaveBeenCalledWith({
      filePath: './state/checkpoint.json',
      deployment: DEPLOYMENT,
    });
  });

  it('creates a checkpoint lock for the configured checkpoint file', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(FileCheckpointLock).toHaveBeenCalledOnce();

    expect(FileCheckpointLock).toHaveBeenCalledWith({
      checkpointFile: './state/checkpoint.json',
    });
  });

  it('acquires the checkpoint lock', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(checkpointLockMocks.acquire).toHaveBeenCalledOnce();
  });

  it('loads persisted checkpoints for the validated consumers', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(checkpointStoreMocks.load).toHaveBeenCalledTimes(2);

    expect(checkpointStoreMocks.load).toHaveBeenNthCalledWith(
      1,
      CONSUMER_A,
    );

    expect(checkpointStoreMocks.load).toHaveBeenNthCalledWith(
      2,
      CONSUMER_B,
    );
  });

  it('starts the daemon with the validated consumers and configured settings', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(runDaemon).toHaveBeenCalledOnce();

    expect(runDaemon).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore: checkpointStoreMocks,
      consumers: VALIDATED_CONSUMERS,
      startBlock: 123_456n,
      maxBlockRange: 2_000n,
      finality: {
               type: 'safe',
      },
      pollIntervalMs: 1_000,
      onCycle: daemonLoggerMocks.onCycle,
    });
  });

  it('passes a custom network source to daemon configuration', async () => {
    const source = {
      type: 'custom',
      configFile: './networks/example-mainnet.json',
    } as const;

    await runDaemonCommand({
      source,
    });

    expect(loadDaemonConfig).toHaveBeenCalledWith({
      source,
    });
  });

  it('forwards the abort signal to the daemon', async () => {
    const controller = new AbortController();

    await runDaemonCommand({
      source: SOURCE,
      signal: controller.signal,
    });

    expect(runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
    );

    const daemonOptions = vi.mocked(runDaemon).mock.calls[0]?.[0];

    expect(daemonOptions?.signal).toBe(controller.signal);
  });

  it('does not start later components when configuration loading fails', async () => {
    const failure = new Error('Daemon configuration failed.');

    vi.mocked(loadDaemonConfig).mockRejectedValueOnce(failure);

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(createRelayerLog).not.toHaveBeenCalled();
    expect(createDaemonLogger).not.toHaveBeenCalled();
    expect(createRelayerClients).not.toHaveBeenCalled();
    expect(verifyRegistryDeployment).not.toHaveBeenCalled();
    expect(validateQuicknetConsumers).not.toHaveBeenCalled();
    expect(FileCheckpointStore).not.toHaveBeenCalled();
    expect(FileCheckpointLock).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('does not start later components when logger initialization fails', async () => {
    const failure = new Error('Logging initialization failed.');

    vi.mocked(createRelayerLog).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(createDaemonLogger).not.toHaveBeenCalled();
    expect(createRelayerClients).not.toHaveBeenCalled();
    expect(verifyRegistryDeployment).not.toHaveBeenCalled();
    expect(validateQuicknetConsumers).not.toHaveBeenCalled();
    expect(FileCheckpointStore).not.toHaveBeenCalled();
    expect(FileCheckpointLock).not.toHaveBeenCalled();
    expect(checkpointLockMocks.acquire).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('does not validate consumers or start the daemon when deployment verification fails', async () => {
    const failure = new Error('Registry verification failed.');

    vi.mocked(verifyRegistryDeployment).mockRejectedValueOnce(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(validateQuicknetConsumers).not.toHaveBeenCalled();
    expect(FileCheckpointStore).not.toHaveBeenCalled();
    expect(FileCheckpointLock).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('does not create checkpoint components when consumer validation fails', async () => {
    const failure = new Error('Consumer validation failed.');

    vi.mocked(validateQuicknetConsumers).mockRejectedValueOnce(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(FileCheckpointStore).not.toHaveBeenCalled();
    expect(FileCheckpointLock).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('does not load checkpoints or release a lock when acquisition fails', async () => {
    const failure =
      new Error('Checkpoint lock acquisition failed.');

    checkpointLockMocks.acquire.mockRejectedValueOnce(failure);

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(checkpointStoreMocks.load).not.toHaveBeenCalled();
    expect(collectDaemonStartupSummary).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).not.toHaveBeenCalled();
  });

  it('releases the lock when checkpoint loading fails', async () => {
    const failure = new Error('Checkpoint loading failed.');

    checkpointStoreMocks.load.mockRejectedValueOnce(failure);

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(collectDaemonStartupSummary).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('propagates daemon failures and releases the lock', async () => {
    const failure = new Error('Daemon failed.');

    vi.mocked(runDaemon).mockRejectedValueOnce(failure);

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('initializes logging before creating clients or acquiring the lock', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    const loggerOrder = firstInvocationOrder(
      vi.mocked(createRelayerLog),
    );

    expect(loggerOrder).toBeLessThan(
      firstInvocationOrder(vi.mocked(createRelayerClients)),
    );

    expect(loggerOrder).toBeLessThan(
      firstInvocationOrder(checkpointLockMocks.acquire),
    );
  });

  it('verifies the deployment before validating consumers', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(
      firstInvocationOrder(vi.mocked(verifyRegistryDeployment)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(validateQuicknetConsumers)),
    );
  });

  it('validates consumers before creating the checkpoint store', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(
      firstInvocationOrder(vi.mocked(validateQuicknetConsumers)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(FileCheckpointStore)),
    );
  });

  it('creates the checkpoint store before creating the checkpoint lock', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(
      firstInvocationOrder(vi.mocked(FileCheckpointStore)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(FileCheckpointLock)),
    );
  });

  it('acquires the checkpoint lock before loading checkpoints', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(
      firstInvocationOrder(checkpointLockMocks.acquire),
    ).toBeLessThan(
      firstInvocationOrder(checkpointStoreMocks.load),
    );
  });

  it('creates the checkpoint store before starting the daemon', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(
      firstInvocationOrder(vi.mocked(FileCheckpointStore)),
    ).toBeLessThan(
      firstInvocationOrder(vi.mocked(runDaemon)),
    );
  });

  it('passes daemon cycle results to the daemon logger', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    const daemonOptions = vi.mocked(runDaemon).mock.calls[0]?.[0];

    expect(daemonOptions?.onCycle).toBe(daemonLoggerMocks.onCycle);
  });

  it('collects and prints the daemon startup summary', async () => {
    await runDaemonCommand({
      source: SOURCE,
    });

    expect(collectDaemonStartupSummary).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
      durableNextBlocks: new Map(),
    });

    expect(formatDaemonStartupSummary).toHaveBeenCalledWith(
      STARTUP_SUMMARY,
    );

    expect(console.log).toHaveBeenCalledOnce();

    expect(console.log).toHaveBeenCalledWith(
      FORMATTED_STARTUP_SUMMARY,
    );
  });

  it('includes persisted consumer checkpoints in the startup summary', async () => {
    checkpointStoreMocks.load
      .mockResolvedValueOnce(123_500n)
      .mockResolvedValueOnce(123_600n);

    await runDaemonCommand({
      source: SOURCE,
    });

    expect(collectDaemonStartupSummary).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
      durableNextBlocks: new Map([
        [CONSUMER_A, 123_500n],
        [CONSUMER_B, 123_600n],
      ]),
    });
  });

  it('releases the lock when startup summary collection fails', async () => {
    const failure = new Error('Startup summary failed.');

    vi.mocked(collectDaemonStartupSummary).mockRejectedValueOnce(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(formatDaemonStartupSummary).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('releases the lock when startup summary formatting fails', async () => {
    const failure = new Error('Startup formatting failed.');

    vi.mocked(formatDaemonStartupSummary).mockImplementationOnce(
      () => {
        throw failure;
      },
    );

    await expect(
      runDaemonCommand({
        source: SOURCE,
      }),
    ).rejects.toBe(failure);

    expect(console.log).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });

  it('releases the lock after the daemon finishes', async () => {
    let finishDaemon!: () => void;

    const daemonFinished = new Promise<void>((resolve) => {
      finishDaemon = resolve;
    });

    let markDaemonStarted!: () => void;

    const daemonStarted = new Promise<void>((resolve) => {
      markDaemonStarted = resolve;
    });

    vi.mocked(runDaemon).mockImplementationOnce(async () => {
      markDaemonStarted();
      await daemonFinished;
    });

    const command = runDaemonCommand({
      source: SOURCE,
    });

    try {
      await daemonStarted;

      expect(
        checkpointLockHandleMocks.release,
      ).not.toHaveBeenCalled();
    } finally {
      finishDaemon();
      await command;
    }

    expect(checkpointLockHandleMocks.release).toHaveBeenCalledOnce();
  });
});