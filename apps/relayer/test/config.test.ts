import {
  resolve,
} from 'node:path';

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
  Address,
  Hex,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CustomNetworkDescriptor,
} from '../src/custom-network-config.js';

import {
  resolveNetworkConfigPath,
} from '../src/config.js';

const deploymentMocks = vi.hoisted(() => ({
  loadRegistryDeployment: vi.fn(),
}));

const customNetworkMocks = vi.hoisted(() => ({
  loadCustomNetworkDescriptor: vi.fn(),
}));

vi.mock(
  '../src/deployment.js',
  () => deploymentMocks,
);

vi.mock(
  '../src/custom-network-config.js',
  () => customNetworkMocks,
);

import {
  loadRelayerConfig,
  parseRelayerNetworkPreset,
  RELAYER_NETWORK_PRESETS,
} from '../src/config.js';

const RPC_URL = 'https://rpc.example.com';
const CUSTOM_RPC_URL = 'https://custom-rpc.example.com';
const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;

const CUSTOM_CHAIN_ID = 12_345;

const REGISTRY_ADDRESS: Address =
  '0x1111111111111111111111111111111111111111';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_ADDRESS: Address =
  '0x2222222222222222222222222222222222222222';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const MINIMUM_LEAD_ROUNDS = 5n;

const REGISTRY_DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
  minimumLeadRounds: MINIMUM_LEAD_ROUNDS,
};

const CUSTOM_REGISTRY_DEPLOYMENT: RegistryDeployment = {
  chainId: CUSTOM_CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
  minimumLeadRounds: MINIMUM_LEAD_ROUNDS,
};

const CUSTOM_NETWORK_DESCRIPTOR: CustomNetworkDescriptor = {
  version: 1,
  name: 'example-mainnet',
  chain: {
    id: CUSTOM_CHAIN_ID,
    name: 'Example Chain',
    nativeCurrency: {
      name: 'Example',
      symbol: 'EX',
      decimals: 18,
    },
    testnet: false,
  },
  deployment: CUSTOM_REGISTRY_DEPLOYMENT,
  finality: {
    type: 'confirmations',
    confirmations: 20n,
  },
};

const CUSTOM_CONFIG_FILE =
  './networks/example-mainnet.json';

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
    ROBINHOOD_TESTNET_RPC_URL: RPC_URL,
    QUICKNET_RPC_URL: CUSTOM_RPC_URL,
    PRIVATE_KEY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  deploymentMocks
    .loadRegistryDeployment
    .mockResolvedValue(
      REGISTRY_DEPLOYMENT,
    );

  customNetworkMocks
    .loadCustomNetworkDescriptor
    .mockResolvedValue(
      CUSTOM_NETWORK_DESCRIPTOR,
    );
});

describe('RELAYER_NETWORK_PRESETS', () => {
  it('contains Robinhood Testnet', () => {
    expect(
      RELAYER_NETWORK_PRESETS,
    ).toContain(
      'robinhood-testnet',
    );
  });
});

describe('parseRelayerNetworkPreset', () => {
  it('parses a supported network preset', () => {
    expect(
      parseRelayerNetworkPreset(
        'robinhood-testnet',
      ),
    ).toBe(
      'robinhood-testnet',
    );
  });

  it('rejects an unsupported network preset', () => {
    expect(() =>
      parseRelayerNetworkPreset(
        'unknown-network',
      ),
    ).toThrow(
      'Unsupported network preset: unknown-network. Supported presets: robinhood-testnet'
    );
  });

  it('does not normalize network preset names', () => {
    expect(() =>
      parseRelayerNetworkPreset(
        'ROBINHOOD-TESTNET',
      ),
    ).toThrow(
      'Unsupported network preset: ROBINHOOD-TESTNET. Supported presets: robinhood-testnet'
    );
  });
});

describe('loadRelayerConfig', () => {
  describe('preset network', () => {
    it('loads a valid relayer configuration', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment(),
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

      expect(
        config.finality,
      ).toEqual({
        type: 'safe',
      });
    });

    it('configures Robinhood Testnet with safe finality', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment(),
        });

      expect(
        config.chain,
      ).toBe(
        robinhoodTestnet,
      );

      expect(
        config.finality,
      ).toEqual({
        type: 'safe',
      });
    });

    it('does not allow operator configuration to override preset finality', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            QUICKNET_FINALITY: 'finalized',
          }),
        });

      expect(
        config.finality,
      ).toEqual({
        type: 'safe',
      });
    });

    it('loads the deployment manifest for the selected preset', async () => {
      await loadRelayerConfig({
        source: {
          type: 'preset',
          network: 'robinhood-testnet',
        },
        env: createEnvironment(),
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

      expect(
        customNetworkMocks
          .loadCustomNetworkDescriptor,
      ).not.toHaveBeenCalled();
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
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment(),
        }),
      ).rejects.toBe(
        error,
      );
    });

    it('requires the preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: undefined,
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

    it('rejects an empty preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: '',
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: ROBINHOOD_TESTNET_RPC_URL.'
      );
    });

    it('rejects a whitespace-only preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: '   ',
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: ROBINHOOD_TESTNET_RPC_URL.'
      );
    });

    it('trims the preset RPC URL', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: `  ${RPC_URL}  `,
          }),
        });

      expect(
        config.rpcUrl,
      ).toBe(
        RPC_URL,
      );
    });

    it('accepts an HTTPS preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: 'https://rpc.example.com',
          }),
        }),
      ).resolves.toBeDefined();
    });

    it('accepts an HTTP preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: 'http://localhost:8545',
          }),
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an invalid preset RPC URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
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

    it('rejects an unsupported preset RPC protocol', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: 'ws://rpc.example.com',
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
  });

  describe('custom network', () => {
    it('loads a valid custom network configuration', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment(),
        });

      expect(
        config.network,
      ).toBe(
        'example-mainnet',
      );

      expect(
        config.chain.id,
      ).toBe(
        CUSTOM_CHAIN_ID,
      );

      expect(
        config.chain.name,
      ).toBe(
        'Example Chain',
      );

      expect(
        config.chain.nativeCurrency,
      ).toEqual({
        name: 'Example',
        symbol: 'EX',
        decimals: 18,
      });

      expect(
        config.chain.testnet,
      ).toBe(
        false,
      );

      expect(
        config.rpcUrl,
      ).toBe(
        CUSTOM_RPC_URL,
      );

      expect(
        config.deployment,
      ).toBe(
        CUSTOM_REGISTRY_DEPLOYMENT,
      );

      expect(
        config.finality,
      ).toEqual({
        type: 'confirmations',
        confirmations: 20n,
      });
    });

    it('constructs the custom chain with the configured RPC URL', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment(),
        });

      expect(
        config.chain.rpcUrls
          .default.http,
      ).toEqual([
        CUSTOM_RPC_URL,
      ]);
    });

    it('loads the selected custom network config file', async () => {
      await loadRelayerConfig({
        source: {
          type: 'custom',
          configFile: CUSTOM_CONFIG_FILE,
        },
        env: createEnvironment(),
      });

      expect(
        customNetworkMocks
          .loadCustomNetworkDescriptor,
      ).toHaveBeenCalledOnce();

      expect(
        customNetworkMocks
          .loadCustomNetworkDescriptor,
      ).toHaveBeenCalledWith(
        CUSTOM_CONFIG_FILE,
      );

      expect(
        deploymentMocks
          .loadRegistryDeployment,
      ).not.toHaveBeenCalled();
    });

    it('propagates custom network loader failures', async () => {
      const error =
        new Error(
          'Custom network config is invalid.',
        );

      customNetworkMocks
        .loadCustomNetworkDescriptor
        .mockRejectedValue(
          error,
        );

      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment(),
        }),
      ).rejects.toBe(
        error,
      );
    });

    it('requires QUICKNET_RPC_URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: undefined,
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: QUICKNET_RPC_URL.'
      );
    });

    it('rejects an empty QUICKNET_RPC_URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: '',
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: QUICKNET_RPC_URL.'
      );
    });

    it('rejects a whitespace-only QUICKNET_RPC_URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: '   ',
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: QUICKNET_RPC_URL.'
      );
    });

    it('trims QUICKNET_RPC_URL', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: `  ${CUSTOM_RPC_URL}  `,
          }),
        });

      expect(
        config.rpcUrl,
      ).toBe(
        CUSTOM_RPC_URL,
      );

      expect(
        config.chain.rpcUrls
          .default.http,
      ).toEqual([
        CUSTOM_RPC_URL,
      ]);
    });

    it('rejects an invalid QUICKNET_RPC_URL', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: 'not-a-url',
          }),
        }),
      ).rejects.toThrow(
        'Invalid RPC URL.',
      );
    });

    it('rejects an unsupported custom RPC protocol', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_RPC_URL: 'ws://rpc.example.com',
          }),
        }),
      ).rejects.toThrow(
        'Unsupported RPC URL protocol: ws:.',
      );
    });

    it('uses finality from the custom network descriptor', async () => {
      const descriptor = {
        ...CUSTOM_NETWORK_DESCRIPTOR,
        finality: {
          type: 'finalized',
        } as const,
      };

      customNetworkMocks
        .loadCustomNetworkDescriptor
        .mockResolvedValue(
          descriptor,
        );

      const config =
        await loadRelayerConfig({
          source: {
            type: 'custom',
            configFile: CUSTOM_CONFIG_FILE,
          },
          env: createEnvironment({
            QUICKNET_FINALITY: 'safe',
          }),
        });

      expect(
        config.finality,
      ).toEqual({
        type: 'finalized',
      });
    });
  });

  describe('account configuration', () => {
    it('creates the account from PRIVATE_KEY', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment(),
        });

      const expectedAccount = privateKeyToAccount(PRIVATE_KEY);
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

    it('requires PRIVATE_KEY', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: undefined,
          }),
        }),
      ).rejects.toThrow(
        'Missing required environment variable: PRIVATE_KEY.'
      );

      expect(
        deploymentMocks
          .loadRegistryDeployment,
      ).not.toHaveBeenCalled();

      expect(
        customNetworkMocks
          .loadCustomNetworkDescriptor,
      ).not.toHaveBeenCalled();
    });

    it('rejects an empty PRIVATE_KEY', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
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
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: '11'.repeat(32),
          }),
        }),
      ).rejects.toThrow(
        'PRIVATE_KEY must be a 32-byte hex value.'
      );

      expect(
        deploymentMocks
          .loadRegistryDeployment,
      ).not.toHaveBeenCalled();
    });

    it('rejects a private key shorter than 32 bytes', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: `0x${'11'.repeat(31)}`,
          }),
        }),
      ).rejects.toThrow(
        'PRIVATE_KEY must be a 32-byte hex value.'
      );
    });

    it('rejects a private key longer than 32 bytes', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: `0x${'11'.repeat(33)}`,
          }),
        }),
      ).rejects.toThrow(
        'PRIVATE_KEY must be a 32-byte hex value.'
      );
    });

    it('rejects non-hex characters in PRIVATE_KEY', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: `0x${'gg'.repeat(32)}`,
          }),
        }),
      ).rejects.toThrow(
        'PRIVATE_KEY must be a 32-byte hex value.'
      );
    });

    it('trims PRIVATE_KEY before parsing it', async () => {
      const config =
        await loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: createEnvironment({
            PRIVATE_KEY: `  ${PRIVATE_KEY}  `,
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

    it('validates operator configuration before loading network configuration', async () => {
      await expect(
        loadRelayerConfig({
          source: {
            type: 'preset',
            network: 'robinhood-testnet',
          },
          env: {},
        }),
      ).rejects.toThrow();

      expect(
        deploymentMocks
          .loadRegistryDeployment,
      ).not.toHaveBeenCalled();

      expect(
        customNetworkMocks
          .loadCustomNetworkDescriptor,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('resolveNetworkConfigPath', () => {
  const repositoryRoot = resolve('/workspace/drand-quicknet-evm');
  const packageCwd = resolve(repositoryRoot, 'apps/relayer');

  it('resolves a relative path against INIT_CWD when available', () => {
    expect(
      resolveNetworkConfigPath(
        'networks/examples/robinhood-testnet-custom.json',
        {
          env: {
            INIT_CWD: repositoryRoot,
          },
          cwd: packageCwd,
        }
      )
    ).toBe(
      resolve(
        repositoryRoot,
        'networks/examples/robinhood-testnet-custom.json'
      )
    );
  });

  it('falls back to the process working directory when INIT_CWD is unavailable', () => {
    expect(
      resolveNetworkConfigPath(
        '../../networks/examples/robinhood-testnet-custom.json',
        {
          env: {},
          cwd: packageCwd,
        }
      )
    ).toBe(
      resolve(
        repositoryRoot,
        'networks/examples/robinhood-testnet-custom.json'
      )
    );
  });

  it('falls back to the process working directory when INIT_CWD is empty', () => {
    expect(
      resolveNetworkConfigPath(
        '../../networks/examples/robinhood-testnet-custom.json',
        {
          env: {
            INIT_CWD: '   ',
          },
          cwd: packageCwd,
        }
      )
    ).toBe(
      resolve(
        repositoryRoot,
        'networks/examples/robinhood-testnet-custom.json'
      )
    );
  });

  it('preserves an absolute path', () => {
    const configPath = resolve(
      repositoryRoot,
      'networks/examples/robinhood-testnet-custom.json'
    );

    expect(
      resolveNetworkConfigPath(
        configPath,
        {
          env: {
            INIT_CWD: repositoryRoot,
          },
          cwd: packageCwd,
        }
      )
    ).toBe(
      configPath
    );
  });
});