import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  robinhoodTestnet,
} from 'viem/chains';

import type {
  Hex,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const deploymentMocks = vi.hoisted(() => ({
  loadRegistryDeployment: vi.fn(),
}));

vi.mock(
  '../src/deployment.js',
  () => deploymentMocks,
);

import {
  loadRelayerConfig,
  parseRelayerNetwork,
  RELAYER_NETWORKS,
} from '../src/config.js';

const RPC_URL = 'https://rpc.example.com';
const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const REGISTRY_DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: '0x1111111111111111111111111111111111111111',
  runtimeCodehash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const EXPECTED_MANIFEST_URL =
  new URL(
    '../../../deployments/robinhood-testnet.json',
    import.meta.url,
  );

function createEnvironment(
  overrides: Readonly<
    Record<
      string,
      string | undefined
    >
  > = {},
): Readonly<
  Record<
    string,
    string | undefined
  >
> {
  return {
    ROBINHOOD_TESTNET_RPC_URL:
      RPC_URL,
    PRIVATE_KEY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  deploymentMocks.loadRegistryDeployment
    .mockResolvedValue(
      REGISTRY_DEPLOYMENT,
    );
});

describe('RELAYER_NETWORKS', () => {
  it('contains Robinhood Testnet', () => {
    expect(
      RELAYER_NETWORKS,
    ).toContain(
      'robinhood-testnet',
    );
  });
});

describe('parseRelayerNetwork', () => {
  it('parses a supported network', () => {
    expect(
      parseRelayerNetwork(
        'robinhood-testnet',
      ),
    ).toBe(
      'robinhood-testnet',
    );
  });

  it('rejects an unsupported network', () => {
    expect(() =>
      parseRelayerNetwork(
        'unknown-network',
      ),
    ).toThrow(
      'Unsupported network: unknown-network. Supported networks: robinhood-testnet'
    );
  });

  it('does not normalize network names', () => {
    expect(() =>
      parseRelayerNetwork(
        'ROBINHOOD-TESTNET',
      ),
    ).toThrow(
      'Unsupported network: ROBINHOOD-TESTNET.'
    );
  });
});

describe('loadRelayerConfig', () => {
  it('loads a valid relayer configuration', async () => {
    const config =
      await loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment(),
      });

    expect(
      config.network,
    ).toBe(
      'robinhood-testnet',
    );

    expect(
      config.chain,
    ).toBe(
      robinhoodTestnet,
    );

    expect(
      config.rpcUrl,
    ).toBe(
      RPC_URL,
    );

    expect(
      config.deployment,
    ).toBe(
      REGISTRY_DEPLOYMENT,
    );
  });

  it('creates the account from PRIVATE_KEY', async () => {
    const config =
      await loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment(),
      });

    const expectedAccount =
      privateKeyToAccount(
        PRIVATE_KEY,
      );

    expect(
      config.account.address,
    ).toBe(
      expectedAccount.address,
    );

    expect(
      config.account.type,
    ).toBe(
      expectedAccount.type,
    );
  });

  it('loads the deployment manifest for the selected network', async () => {
    await loadRelayerConfig({
      network:
        'robinhood-testnet',
      env:
        createEnvironment(),
    });

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).toHaveBeenCalledOnce();

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).toHaveBeenCalledWith({
      manifestUrl:
        EXPECTED_MANIFEST_URL,
      expectedChainId:
        robinhoodTestnet.id,
    });
  });

  it('propagates deployment loader failures', async () => {
    const error =
      new Error(
        'Deployment manifest is invalid.',
      );

    deploymentMocks
      .loadRegistryDeployment
      .mockRejectedValue(
        error,
      );

    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment(),
      }),
    ).rejects.toBe(
      error,
    );
  });

  it('requires the network RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              undefined,
          }),
      }),
    ).rejects.toThrow(
      'Missing required environment variable: ROBINHOOD_TESTNET_RPC_URL.'
    );

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });

  it('rejects an empty RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              '',
          }),
      }),
    ).rejects.toThrow(
      'Missing required environment variable: ROBINHOOD_TESTNET_RPC_URL.'
    );
  });

  it('rejects a whitespace-only RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              '   ',
          }),
      }),
    ).rejects.toThrow(
      'Missing required environment variable: ROBINHOOD_TESTNET_RPC_URL.'
    );
  });

  it('trims the RPC URL', async () => {
    const config =
      await loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              `  ${RPC_URL}  `,
          }),
      });

    expect(
      config.rpcUrl,
    ).toBe(
      RPC_URL,
    );
  });

  it('accepts an HTTPS RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              'https://rpc.example.com',
          }),
      }),
    ).resolves.toBeDefined();
  });

  it('accepts an HTTP RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              'http://localhost:8545',
          }),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects an invalid RPC URL', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              'not-a-url',
          }),
      }),
    ).rejects.toThrow(
      'Invalid RPC URL.',
    );

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });

  it('rejects an unsupported RPC protocol', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL:
              'ws://rpc.example.com',
          }),
      }),
    ).rejects.toThrow(
      'Unsupported RPC URL protocol: ws:.',
    );

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });

  it('requires PRIVATE_KEY', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              undefined,
          }),
      }),
    ).rejects.toThrow(
      'Missing required environment variable: PRIVATE_KEY.'
    );

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });

  it('rejects an empty PRIVATE_KEY', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY: '',
          }),
      }),
    ).rejects.toThrow(
      'Missing required environment variable: PRIVATE_KEY.'
    );
  });

  it('rejects a private key without a 0x prefix', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              '11'.repeat(32),
          }),
      }),
    ).rejects.toThrow(
      'PRIVATE_KEY must be a 32-byte hex value.',
    );

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });

  it('rejects a private key shorter than 32 bytes', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              `0x${'11'.repeat(31)}`,
          }),
      }),
    ).rejects.toThrow(
      'PRIVATE_KEY must be a 32-byte hex value.',
    );
  });

  it('rejects a private key longer than 32 bytes', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              `0x${'11'.repeat(33)}`,
          }),
      }),
    ).rejects.toThrow(
      'PRIVATE_KEY must be a 32-byte hex value.',
    );
  });

  it('rejects non-hex characters in PRIVATE_KEY', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              `0x${'gg'.repeat(32)}`,
          }),
      }),
    ).rejects.toThrow(
      'PRIVATE_KEY must be a 32-byte hex value.',
    );
  });

  it('trims PRIVATE_KEY before parsing it', async () => {
    const config =
      await loadRelayerConfig({
        network:
          'robinhood-testnet',
        env:
          createEnvironment({
            PRIVATE_KEY:
              `  ${PRIVATE_KEY}  `,
          }),
      });

    expect(
      config.account.address,
    ).toBe(
      privateKeyToAccount(
        PRIVATE_KEY,
      ).address,
    );
  });

  it('validates operator configuration before loading the deployment', async () => {
    await expect(
      loadRelayerConfig({
        network:
          'robinhood-testnet',
        env: {},
      }),
    ).rejects.toThrow();

    expect(
      deploymentMocks
        .loadRegistryDeployment,
    ).not.toHaveBeenCalled();
  });
});