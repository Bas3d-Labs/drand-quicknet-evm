import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWalletClient,
  custom,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';

import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

vi.mock('../src/deployment.js', () => ({
  loadRegistryDeployment: vi.fn(),
}));

vi.mock('../src/custom-network-config.js', () => ({
  loadCustomNetworkDescriptor: vi.fn(),
}));

import {
  loadRelayerConfig,
  parseRelayerNetworkPreset,
  RELAYER_NETWORK_PRESETS,
  resolveNetworkConfigPath,
} from '../src/config.js';

import {
  configDiagnostic,
  RelayerConfigError,
  type ConfigCode,
  type ConfigSetting,
} from '../src/config-errors.js';

import {
  loadCustomNetworkDescriptor,
  type CustomNetworkDescriptor,
} from '../src/custom-network-config.js';

import { loadRegistryDeployment } from '../src/deployment.js';
import { UsageError, usageCode } from '../src/usage-error.js';

const PRESET_SOURCE = {
  type: 'preset',
  network: 'robinhood-testnet',
} as const;

const CUSTOM_CONFIG_FILE = './networks/example-mainnet.json';

const CUSTOM_SOURCE = {
  type: 'custom',
  configFile: CUSTOM_CONFIG_FILE,
} as const;

const RPC_URL = 'https://rpc.example.com';
const CUSTOM_RPC_URL = 'https://custom-rpc.example.com';
const PRIVATE_KEY: Hex = `0x${'11'.repeat(32)}`;

const CUSTOM_CHAIN_ID = 12_345;

const REGISTRY_ADDRESS: Address =
  '0x1111111111111111111111111111111111111111';

const VERIFIER_ADDRESS: Address =
  '0x2222222222222222222222222222222222222222';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REGISTRY_DEPLOYMENT: RegistryDeployment = {
  chainId: robinhoodTestnet.id,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

const CUSTOM_REGISTRY_DEPLOYMENT: RegistryDeployment = {
  ...REGISTRY_DEPLOYMENT,
  chainId: CUSTOM_CHAIN_ID,
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

const EXPECTED_MANIFEST_URL = new URL(
  '../../../deployments/robinhood-testnet.json',
  import.meta.url,
);

type Environment = Readonly<Record<string, string | undefined>>;

function createEnvironment(
  overrides: Environment = {},
): Environment {
  return {
    ROBINHOOD_TESTNET_RPC_URL: RPC_URL,
    QUICKNET_RPC_URL: CUSTOM_RPC_URL,
    PRIVATE_KEY,
    ...overrides,
  };
}

async function expectConfigRejection(
  promise: Promise<unknown>,
  code: ConfigCode,
  setting: ConfigSetting,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the promise to reject.');
    },
    (failure: unknown) => failure,
  );

  expect(error).toBeInstanceOf(RelayerConfigError);
  expect(configDiagnostic(error)).toEqual({ code, setting });
}

beforeEach(() => {
  vi.mocked(loadRegistryDeployment)
    .mockReset()
    .mockResolvedValue(REGISTRY_DEPLOYMENT);

  vi.mocked(loadCustomNetworkDescriptor)
    .mockReset()
    .mockResolvedValue(CUSTOM_NETWORK_DESCRIPTOR);
});

describe('RELAYER_NETWORK_PRESETS', () => {
  it('contains Robinhood Testnet', () => {
    expect(RELAYER_NETWORK_PRESETS).toContain('robinhood-testnet');
  });
});

describe('parseRelayerNetworkPreset', () => {
  it('parses a supported network preset', () => {
    expect(
      parseRelayerNetworkPreset('robinhood-testnet'),
    ).toBe('robinhood-testnet');
  });

  it.each([
    {
      name: 'unsupported preset',
      value: 'unknown-network',
    },
    {
      name: 'uppercase preset',
      value: 'ROBINHOOD-TESTNET',
    },
  ])('rejects an $name with a registered diagnostic', ({ value }) => {
    let thrown: unknown;

    try {
      parseRelayerNetworkPreset(value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect(usageCode(thrown)).toBe('UNSUPPORTED_NETWORK');
  });
});

describe('loadRelayerConfig', () => {
  describe('preset network', () => {
    it('loads a valid relayer configuration', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment(),
      });

      expect(config.network).toBe('robinhood-testnet');
      expect(config.chain).toBe(robinhoodTestnet);
      expect(config.rpcUrl).toBe(RPC_URL);
      expect(config.deployment).toBe(REGISTRY_DEPLOYMENT);
      expect(config.finality).toEqual({ type: 'safe' });
    });

    it('configures Robinhood Testnet with safe finality', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment(),
      });

      expect(config.chain).toBe(robinhoodTestnet);
      expect(config.finality).toEqual({ type: 'safe' });
    });

    it('does not allow operator configuration to override preset finality', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment({
          QUICKNET_FINALITY: 'finalized',
        }),
      });

      expect(config.finality).toEqual({ type: 'safe' });
    });

    it('loads the deployment manifest for the selected preset', async () => {
      await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment(),
      });

      expect(loadRegistryDeployment).toHaveBeenCalledExactlyOnceWith({
        manifestUrl: EXPECTED_MANIFEST_URL,
        expectedChainId: robinhoodTestnet.id,
      });

      expect(loadCustomNetworkDescriptor).not.toHaveBeenCalled();
    });

    it('propagates deployment loader failures unchanged', async () => {
      const failure = new Error('Deployment manifest is invalid.');
      vi.mocked(loadRegistryDeployment).mockRejectedValue(failure);

      await expect(
        loadRelayerConfig({
          source: PRESET_SOURCE,
          env: createEnvironment(),
        }),
      ).rejects.toBe(failure);
    });

    it.each([
      { name: 'missing', value: undefined },
      { name: 'empty', value: '' },
      { name: 'whitespace-only', value: '   ' },
    ])('rejects a $name preset RPC URL', async ({ value }) => {
      await expectConfigRejection(
        loadRelayerConfig({
          source: PRESET_SOURCE,
          env: createEnvironment({
            ROBINHOOD_TESTNET_RPC_URL: value,
          }),
        }),
        'MISSING_REQUIRED_SETTING',
        'ROBINHOOD_TESTNET_RPC_URL',
      );

      expect(loadRegistryDeployment).not.toHaveBeenCalled();
    });

    it('trims the preset RPC URL', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment({
          ROBINHOOD_TESTNET_RPC_URL: `  ${RPC_URL}  `,
        }),
      });

      expect(config.rpcUrl).toBe(RPC_URL);
    });

    it.each([
      'https://rpc.example.com',
      'http://localhost:8545',
    ])('accepts preset RPC URL %s', async (rpcUrl) => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment({
          ROBINHOOD_TESTNET_RPC_URL: rpcUrl,
        }),
      });

      expect(config.rpcUrl).toBe(rpcUrl);
    });

    it.each([
      {
        value: 'not-a-url',
        code: 'INVALID_RPC_URL',
      },
      {
        value: 'ws://rpc.example.com',
        code: 'UNSUPPORTED_RPC_PROTOCOL',
      },
    ] as const)(
      'rejects preset RPC URL with $code',
      async ({ value, code }) => {
        await expectConfigRejection(
          loadRelayerConfig({
            source: PRESET_SOURCE,
            env: createEnvironment({
              ROBINHOOD_TESTNET_RPC_URL: value,
            }),
          }),
          code,
          'ROBINHOOD_TESTNET_RPC_URL',
        );

        expect(loadRegistryDeployment).not.toHaveBeenCalled();
      },
    );
  });

  describe('custom network', () => {
    it('loads a valid custom network configuration', async () => {
      const config = await loadRelayerConfig({
        source: CUSTOM_SOURCE,
        env: createEnvironment(),
      });

      expect(config.network).toBe('example-mainnet');
      expect(config.chain.id).toBe(CUSTOM_CHAIN_ID);
      expect(config.chain.name).toBe('Example Chain');

      expect(config.chain.nativeCurrency).toEqual({
        name: 'Example',
        symbol: 'EX',
        decimals: 18,
      });

      expect(config.chain.testnet).toBe(false);
      expect(config.rpcUrl).toBe(CUSTOM_RPC_URL);
      expect(config.deployment).toBe(CUSTOM_REGISTRY_DEPLOYMENT);

      expect(config.finality).toEqual({
        type: 'confirmations',
        confirmations: 20n,
      });
    });

    it('constructs the custom chain with the configured RPC URL', async () => {
      const config = await loadRelayerConfig({
        source: CUSTOM_SOURCE,
        env: createEnvironment(),
      });

      expect(config.chain.rpcUrls.default.http).toEqual([
        CUSTOM_RPC_URL,
      ]);
    });

    it('loads the selected custom network config file', async () => {
      await loadRelayerConfig({
        source: CUSTOM_SOURCE,
        env: createEnvironment(),
      });

      expect(
        loadCustomNetworkDescriptor,
      ).toHaveBeenCalledExactlyOnceWith(CUSTOM_CONFIG_FILE);

      expect(loadRegistryDeployment).not.toHaveBeenCalled();
    });

    it('propagates custom network loader failures unchanged', async () => {
      const failure = new Error('Custom network config is invalid.');

      vi.mocked(loadCustomNetworkDescriptor).mockRejectedValue(failure);

      await expect(
        loadRelayerConfig({
          source: CUSTOM_SOURCE,
          env: createEnvironment(),
        }),
      ).rejects.toBe(failure);
    });

    it.each([
      { name: 'missing', value: undefined },
      { name: 'empty', value: '' },
      { name: 'whitespace-only', value: '   ' },
    ])('rejects a $name QUICKNET_RPC_URL', async ({ value }) => {
      await expectConfigRejection(
        loadRelayerConfig({
          source: CUSTOM_SOURCE,
          env: createEnvironment({
            QUICKNET_RPC_URL: value,
          }),
        }),
        'MISSING_REQUIRED_SETTING',
        'QUICKNET_RPC_URL',
      );
    });

    it('trims QUICKNET_RPC_URL', async () => {
      const config = await loadRelayerConfig({
        source: CUSTOM_SOURCE,
        env: createEnvironment({
          QUICKNET_RPC_URL: `  ${CUSTOM_RPC_URL}  `,
        }),
      });

      expect(config.rpcUrl).toBe(CUSTOM_RPC_URL);

      expect(config.chain.rpcUrls.default.http).toEqual([
        CUSTOM_RPC_URL,
      ]);
    });

    it.each([
      {
        value: 'not-a-url',
        code: 'INVALID_RPC_URL',
      },
      {
        value: 'ws://rpc.example.com',
        code: 'UNSUPPORTED_RPC_PROTOCOL',
      },
    ] as const)(
      'rejects custom RPC URL with $code',
      async ({ value, code }) => {
        await expectConfigRejection(
          loadRelayerConfig({
            source: CUSTOM_SOURCE,
            env: createEnvironment({
              QUICKNET_RPC_URL: value,
            }),
          }),
          code,
          'QUICKNET_RPC_URL',
        );
      },
    );

    it('uses finality from the custom network descriptor', async () => {
      vi.mocked(loadCustomNetworkDescriptor).mockResolvedValue({
        ...CUSTOM_NETWORK_DESCRIPTOR,
        finality: { type: 'finalized' },
      });

      const config = await loadRelayerConfig({
        source: CUSTOM_SOURCE,
        env: createEnvironment({
          QUICKNET_FINALITY: 'safe',
        }),
      });

      expect(config.finality).toEqual({ type: 'finalized' });
    });
  });

  describe('account configuration', () => {
    it('creates the account from PRIVATE_KEY', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment(),
      });

      const expected = privateKeyToAccount(PRIVATE_KEY);

      expect(config.account.address).toBe(expected.address);
      expect(config.account.type).toBe(expected.type);
    });

    it.each([
      { name: 'missing', value: undefined },
      { name: 'empty', value: '' },
      { name: 'whitespace-only', value: '   ' },
    ])('rejects a $name PRIVATE_KEY', async ({ value }) => {
      await expectConfigRejection(
        loadRelayerConfig({
          source: PRESET_SOURCE,
          env: createEnvironment({
            PRIVATE_KEY: value,
          }),
        }),
        'MISSING_REQUIRED_SETTING',
        'PRIVATE_KEY',
      );

      expect(loadRegistryDeployment).not.toHaveBeenCalled();
      expect(loadCustomNetworkDescriptor).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'missing 0x prefix',
        value: '11'.repeat(32),
      },
      {
        name: 'shorter than 32 bytes',
        value: '0x' + '11'.repeat(31),
      },
      {
        name: 'longer than 32 bytes',
        value: '0x' + '11'.repeat(33),
      },
      {
        name: 'non-hex characters',
        value: '0x' + 'gg'.repeat(32),
      },
      {
        name: '63 hex digits',
        value: '0x' + '1'.repeat(63),
      },
    ])(
      'rejects PRIVATE_KEY with $name before loading the network',
      async ({ value }) => {
        await expectConfigRejection(
          loadRelayerConfig({
            source: PRESET_SOURCE,
            env: createEnvironment({
              PRIVATE_KEY: value,
            }),
          }),
          'INVALID_PRIVATE_KEY',
          'PRIVATE_KEY',
        );

        expect(loadRegistryDeployment).not.toHaveBeenCalled();
        expect(loadCustomNetworkDescriptor).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: 'zero',
        value: '0x' + '00'.repeat(32),
      },
      {
        name: 'out-of-range scalar',
        value: '0x' + 'ff'.repeat(32),
      },
    ])(
      'wraps a $name private key in a registered diagnostic',
      async ({ value }) => {
        await expectConfigRejection(
          loadRelayerConfig({
            source: PRESET_SOURCE,
            env: createEnvironment({
              PRIVATE_KEY: value,
            }),
          }),
          'INVALID_PRIVATE_KEY',
          'PRIVATE_KEY',
        );
      },
    );

    it('trims PRIVATE_KEY before parsing it', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment({
          PRIVATE_KEY: `  ${PRIVATE_KEY}  `,
        }),
      });

      expect(config.account.address).toBe(
        privateKeyToAccount(PRIVATE_KEY).address,
      );
    });

    it('validates required operator configuration before loading the network', async () => {
      await expectConfigRejection(
        loadRelayerConfig({
          source: PRESET_SOURCE,
          env: {},
        }),
        'MISSING_REQUIRED_SETTING',
        'PRIVATE_KEY',
      );

      expect(loadRegistryDeployment).not.toHaveBeenCalled();
      expect(loadCustomNetworkDescriptor).not.toHaveBeenCalled();
    });

    it('does not reuse a nonce when the RPC count stays stale', async () => {
      const config = await loadRelayerConfig({
        source: PRESET_SOURCE,
        env: createEnvironment(),
      });

      const manager = config.account.nonceManager;

      if (manager === undefined) {
        throw new Error(
          'Expected the relayer account to have a nonce manager.',
        );
      }

      const identity = {
        address: config.account.address,
        chainId: config.chain.id,
      };

      // Discard module-level nonce state from any earlier use of this account.
      manager.reset(identity);

      try {
        const nonces: number[] = [];

        const transport = custom({
          async request({ method, params }) {
            if (method === 'eth_getTransactionCount') {
              return '0x313';
            }

            if (method === 'eth_sendRawTransaction') {
              const serialized = params[0] as Hex;
              const transaction = parseTransaction(serialized);

              if (transaction.nonce === undefined) {
                throw new Error(
                  'Expected a nonce in the signed transaction.',
                );
              }

              nonces.push(transaction.nonce);

              return keccak256(serialized);
            }

            throw new Error(
              `Unexpected test RPC method: ${method}`,
            );
          },
        }, {
          retryCount: 0,
        });

        // Both clients share the account, as imports and settlements do.
        const first = createWalletClient({
          account: config.account,
          chain: config.chain,
          transport,
        });

        const second = createWalletClient({
          account: config.account,
          chain: config.chain,
          transport,
        });

        const request = {
          to: REGISTRY_ADDRESS,
          gas: 21_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          type: 'eip1559' as const,
        };

        await first.sendTransaction(request);
        await second.sendTransaction(request);

        expect(nonces).toEqual([787, 788]);
      } finally {
        manager.reset(identity);
      }
    });
  });
});

describe('resolveNetworkConfigPath', () => {
  const repositoryRoot = resolve('/workspace/drand-quicknet-evm');
  const packageCwd = resolve(repositoryRoot, 'apps/relayer');
  const relativePath = 'networks/examples/robinhood-testnet-custom.json';

  it('resolves a relative path against INIT_CWD when available', () => {
    expect(
      resolveNetworkConfigPath(relativePath, {
        env: { INIT_CWD: repositoryRoot },
        cwd: packageCwd,
      }),
    ).toBe(
      resolve(repositoryRoot, relativePath),
    );
  });

  it('falls back to the supplied working directory when INIT_CWD is unavailable', () => {
    expect(
      resolveNetworkConfigPath('../../' + relativePath, {
        env: {},
        cwd: packageCwd,
      }),
    ).toBe(
      resolve(repositoryRoot, relativePath),
    );
  });

  it('falls back to the supplied working directory when INIT_CWD is blank', () => {
    expect(
      resolveNetworkConfigPath('../../' + relativePath, {
        env: { INIT_CWD: '   ' },
        cwd: packageCwd,
      }),
    ).toBe(
      resolve(repositoryRoot, relativePath),
    );
  });

  it('preserves an absolute path', () => {
    const configPath = resolve(repositoryRoot, relativePath);

    expect(
      resolveNetworkConfigPath(configPath, {
        env: { INIT_CWD: repositoryRoot },
        cwd: packageCwd,
      }),
    ).toBe(configPath);
  });
});