import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
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

const daemonStartupMocks = vi.hoisted(() => ({
  collectDaemonStartupSummary: vi.fn(),
  formatDaemonStartupSummary: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet-registry',
  () => ({
    verifyRegistryDeployment: vi.fn(),
  }),
);

vi.mock(
  '../src/clients.js',
  () => ({
    createRelayerClients: vi.fn(),
  }),
);

vi.mock(
  '../src/daemon-config.js',
  () => ({
    loadDaemonConfig: vi.fn(),
  }),
);

vi.mock(
  '../src/daemon-startup.js',
  () => daemonStartupMocks,
);

vi.mock(
  '../src/daemon.js',
  () => ({
    runDaemon: vi.fn(),
  }),
);

vi.mock(
  '../src/file-checkpoint-store.js',
  () => ({
    FileCheckpointStore: vi.fn(),
  }),
);

vi.mock(
  '../src/validate-consumers.js',
  () => ({
    validateQuicknetConsumers: vi.fn(),
  }),
);

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
  collectDaemonStartupSummary,
  formatDaemonStartupSummary,
} from '../src/daemon-startup.js';

import {
  runDaemon,
} from '../src/daemon.js';

import {
  FileCheckpointStore,
} from '../src/file-checkpoint-store.js';

import {
  validateQuicknetConsumers,
} from '../src/validate-consumers.js';

const CONSUMER_A = '0x1111111111111111111111111111111111111111';
const CONSUMER_B = '0x2222222222222222222222222222222222222222';

const REGISTRY_ADDRESS = '0x3333333333333333333333333333333333333333';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
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

const STARTUP_SUMMARY = {
  network: 'robinhood-testnet',
} as never;
const FORMATTED_STARTUP_SUMMARY = 'Relayer daemon starting\n...';

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
    vi.mocked(
      loadDaemonConfig,
    ).mockReset();

    vi.mocked(
      createRelayerClients,
    ).mockReset();

    vi.mocked(
      verifyRegistryDeployment,
    ).mockReset();

    vi.mocked(
      validateQuicknetConsumers,
    ).mockReset();

    vi.mocked(
      FileCheckpointStore,
    ).mockReset();

    vi.mocked(
      runDaemon,
    ).mockReset();

    vi.mocked(
      loadDaemonConfig,
    ).mockResolvedValue(
      DAEMON_CONFIG,
    );

    vi.mocked(
      createRelayerClients,
    ).mockReturnValue({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
    });

    vi.mocked(
      verifyRegistryDeployment,
    ).mockResolvedValue();

    vi.mocked(
      validateQuicknetConsumers,
    ).mockResolvedValue(
      VALIDATED_CONSUMERS,
    );

    vi.mocked(
      collectDaemonStartupSummary,
    ).mockReset();

    vi.mocked(
      formatDaemonStartupSummary,
    ).mockReset();

    vi.mocked(
      collectDaemonStartupSummary,
    ).mockResolvedValue(
      STARTUP_SUMMARY,
    );

    vi.mocked(
      formatDaemonStartupSummary,
    ).mockReturnValue(
      FORMATTED_STARTUP_SUMMARY,
    );

    vi.mocked(
      runDaemon,
    ).mockResolvedValue();
  });

  it('loads daemon configuration for the requested network', async () => {
    const env = {
      QUICKNET_CONSUMERS: CONSUMER_A,
      QUICKNET_START_BLOCK: '123456',
      QUICKNET_CHECKPOINT_FILE: './state/checkpoint.json',
    };

    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });

    expect(
      loadDaemonConfig,
    ).toHaveBeenCalledOnce();

    expect(
      loadDaemonConfig,
    ).toHaveBeenCalledWith({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      env,
    });
  });

  it('omits env when no environment is provided', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      loadDaemonConfig,
    ).toHaveBeenCalledWith({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });
  });

  it('creates relayer clients from the daemon configuration', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      createRelayerClients,
    ).toHaveBeenCalledOnce();

    expect(
      createRelayerClients,
    ).toHaveBeenCalledWith(
      DAEMON_CONFIG,
    );
  });

  it('verifies the configured registry deployment', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      verifyRegistryDeployment,
    ).toHaveBeenCalledOnce();

    expect(
      verifyRegistryDeployment,
    ).toHaveBeenCalledWith(
      PUBLIC_CLIENT,
      DEPLOYMENT,
    );
  });

  it('validates the configured consumers', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      validateQuicknetConsumers,
    ).toHaveBeenCalledOnce();

    expect(
      validateQuicknetConsumers,
    ).toHaveBeenCalledWith({
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
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      FileCheckpointStore,
    ).toHaveBeenCalledOnce();

    expect(
      FileCheckpointStore,
    ).toHaveBeenCalledWith({
      filePath: './state/checkpoint.json',
      deployment: DEPLOYMENT,
    });
  });

  it('starts the daemon with the validated consumers and configured settings', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    const checkpointStore = vi.mocked(FileCheckpointStore).mock.instances[0];
    expect(checkpointStore).toBeDefined();

    expect(
      runDaemon,
    ).toHaveBeenCalledOnce();

    expect(
      runDaemon,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumers: VALIDATED_CONSUMERS,
      startBlock: 123_456n,
      maxBlockRange: 2_000n,
      finality: {
        type: 'safe',
      },
      pollIntervalMs: 1_000,
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

    expect(
      loadDaemonConfig,
    ).toHaveBeenCalledWith({
      source,
    });
  });

  it('forwards the abort signal to the daemon', async () => {
    const controller = new AbortController();

    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
      signal: controller.signal,
    });

    const checkpointStore = vi.mocked(FileCheckpointStore).mock.instances[0];
    expect(checkpointStore).toBeDefined();

    expect(
      runDaemon,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      checkpointStore,
      consumers: VALIDATED_CONSUMERS,
      startBlock: 123_456n,
      maxBlockRange: 2_000n,
      pollIntervalMs: 1_000,
      finality: {
        type: 'safe',
      },
      signal: controller.signal,
    });
  });

  it('does not start later components when configuration loading fails', async () => {
    const failure = new Error('Daemon configuration failed.');

    vi.mocked(
      loadDaemonConfig,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
      }),
    ).rejects.toBe(
      failure
    );

    expect(
      createRelayerClients,
    ).not.toHaveBeenCalled();

    expect(
      verifyRegistryDeployment,
    ).not.toHaveBeenCalled();

    expect(
      validateQuicknetConsumers,
    ).not.toHaveBeenCalled();

    expect(
      FileCheckpointStore,
    ).not.toHaveBeenCalled();

    expect(
      runDaemon,
    ).not.toHaveBeenCalled();
  });

  it('does not validate consumers or start the daemon when deployment verification fails', async () => {
    const failure = new Error('Registry verification failed.');

    vi.mocked(
      verifyRegistryDeployment,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
      }),
    ).rejects.toBe(
      failure
    );

    expect(
      validateQuicknetConsumers,
    ).not.toHaveBeenCalled();

    expect(
      FileCheckpointStore,
    ).not.toHaveBeenCalled();

    expect(
      runDaemon,
    ).not.toHaveBeenCalled();
  });

  it('does not create the checkpoint store or start the daemon when consumer validation fails', async () => {
    const failure = new Error('Consumer validation failed.');

    vi.mocked(
      validateQuicknetConsumers,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
      }),
    ).rejects.toBe(
      failure
    );

    expect(
      FileCheckpointStore,
    ).not.toHaveBeenCalled();

    expect(
      runDaemon,
    ).not.toHaveBeenCalled();
  });

  it('propagates daemon failures', async () => {
    const failure = new Error('Daemon failed.');

    vi.mocked(
      runDaemon,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      runDaemonCommand({ 
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
      }),
    ).rejects.toBe(
      failure
    );
  });

  it('verifies the deployment before validating consumers', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      firstInvocationOrder(
        vi.mocked(verifyRegistryDeployment),
      )
    ).toBeLessThan(
      firstInvocationOrder(
        vi.mocked(validateQuicknetConsumers),
      )
    );
  });

  it('validates consumers before creating the checkpoint store', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      firstInvocationOrder(
        vi.mocked(validateQuicknetConsumers),
      )
    ).toBeLessThan(
      firstInvocationOrder(
        vi.mocked(FileCheckpointStore),
      )
    );
  });

  it('creates the checkpoint store before starting the daemon', async () => {
    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      firstInvocationOrder(
        vi.mocked(FileCheckpointStore),
      )
    ).toBeLessThan(
      firstInvocationOrder(
        vi.mocked(runDaemon),
      )
    );
  });

  it('collects and prints the daemon startup summary', async () => {
    const consoleLog =
      vi.spyOn(
        console,
        'log',
      ).mockImplementation(
        () => {},
      );

    await runDaemonCommand({
      source: {
        type: 'preset',
        network: 'robinhood-testnet',
      },
    });

    expect(
      collectDaemonStartupSummary,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      config: DAEMON_CONFIG,
    });

    expect(
      formatDaemonStartupSummary,
    ).toHaveBeenCalledWith(
      STARTUP_SUMMARY,
    );

    expect(
      consoleLog,
    ).toHaveBeenCalledWith(
      FORMATTED_STARTUP_SUMMARY,
    );

    consoleLog.mockRestore();
  });

  it('does not start the daemon when startup summary collection fails', async () => {
    const failure =
      new Error('Startup summary failed.');

    vi.mocked(
      collectDaemonStartupSummary,
    ).mockRejectedValue(
      failure,
    );

    await expect(
      runDaemonCommand({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
      }),
    ).rejects.toBe(
      failure
    );

    expect(
      runDaemon,
    ).not.toHaveBeenCalled();
  });
});