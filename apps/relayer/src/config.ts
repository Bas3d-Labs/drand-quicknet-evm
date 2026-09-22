import {
  resolve,
} from 'node:path';

import process from 'node:process';

import {
  defineChain,
  type Chain,
  type Hex,
} from 'viem';

import {
  nonceManager,
  privateKeyToAccount,
} from 'viem/accounts';

import {
  robinhoodTestnet,
} from 'viem/chains';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  RelayerConfigError,
  type ConfigSetting,
} from './config-errors.js';

import {
  loadCustomNetworkDescriptor,
} from './custom-network-config.js';

import {
  loadRegistryDeployment,
} from './deployment.js';

import type {
  FinalityPolicy,
} from './finality-policy.js';

import {
  isFixedHex,
} from './hex.js';

import {
  RELAYER_NETWORK_PRESETS,
  type RelayerNetworkPreset,
} from './network-presets.js';

import {
  UsageError,
} from './usage-error.js';

export {
  RELAYER_NETWORK_PRESETS,
  type RelayerNetworkPreset,
};

export type NetworkSource =
  | {
      type: 'preset';
      network: RelayerNetworkPreset;
    }
  | {
      type: 'custom';
      configFile: string;
    };

interface NetworkPresetConfig {
  chain: Chain;
  rpcUrlEnv: ConfigSetting;
  deploymentManifestUrl: URL;
  finality: FinalityPolicy;
}

const NETWORK_PRESETS: Record<RelayerNetworkPreset, NetworkPresetConfig> = {
  'robinhood-testnet': {
    chain: robinhoodTestnet,
    rpcUrlEnv: 'ROBINHOOD_TESTNET_RPC_URL',
    deploymentManifestUrl:
      new URL(
        '../../../deployments/robinhood-testnet.json',
        import.meta.url,
      ),
    finality: {
      type: 'safe',
    },
  },
};

export interface ResolvedNetworkConfig {
  network: string;
  chain: Chain;
  rpcUrl: string;
  deployment: RegistryDeployment;
  finality: FinalityPolicy;
}

export interface RelayerConfig extends ResolvedNetworkConfig {
  account: ReturnType<typeof privateKeyToAccount>;
}

export interface LoadRelayerConfigOptions {
  source: NetworkSource;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadRelayerConfig(
  options: LoadRelayerConfigOptions,
): Promise<RelayerConfig> {
  const {
    source,
    env = process.env
  } = options;

  const privateKey = parsePrivateKey(
    requireEnvironmentVariable(
      env,
      'PRIVATE_KEY',
    ),
  );

  const network = await resolveNetworkConfig(source, env);
  let account: RelayerConfig['account'];

  try {
    // keep existing account creation and nonce-manager options.
    account = privateKeyToAccount(privateKey, {
      nonceManager
    });
  } catch (cause) {
    throw new RelayerConfigError(
      'INVALID_PRIVATE_KEY',
      'PRIVATE_KEY',
      { cause },
    );
  }

  return {
    ...network,
    account,
  };
}

export function parseRelayerNetworkPreset(
  value: string
): RelayerNetworkPreset {
  for (const network of RELAYER_NETWORK_PRESETS) {
    if (value === network) {
      return network;
    }
  }

  throw new UsageError('UNSUPPORTED_NETWORK');
}

async function resolveNetworkConfig(
  source: NetworkSource,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedNetworkConfig> {
  switch (source.type) {
    case 'preset':
      return resolveNetworkPreset(source.network, env);

    case 'custom':
      return resolveCustomNetwork(source.configFile, env);
  }
}

async function resolveNetworkPreset(
  network: RelayerNetworkPreset,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedNetworkConfig> {
  const preset = NETWORK_PRESETS[network];
  
  const rpcUrl = requireEnvironmentVariable(env, preset.rpcUrlEnv);
  validateRpcUrl(rpcUrl, preset.rpcUrlEnv);

  const deployment = await loadRegistryDeployment({
    manifestUrl: preset.deploymentManifestUrl,
    expectedChainId: preset.chain.id,
  });

  return {
    network,
    chain: preset.chain,
    rpcUrl,
    deployment,
    finality: preset.finality,
  };
}

async function resolveCustomNetwork(
  configFile: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedNetworkConfig> {
  const descriptor = await loadCustomNetworkDescriptor(configFile);

  const rpcUrl = requireEnvironmentVariable(env, 'QUICKNET_RPC_URL');
  validateRpcUrl(rpcUrl, 'QUICKNET_RPC_URL');

  const chainDefinition: Chain = {
    id: descriptor.chain.id,
    name: descriptor.chain.name,
    nativeCurrency: descriptor.chain.nativeCurrency,
    rpcUrls: {
      default: {
        http: [
          rpcUrl,
        ],
      },
    },
  };

  if (descriptor.chain.testnet !== undefined) {
    chainDefinition.testnet = descriptor.chain.testnet;
  }

  const chain = defineChain(chainDefinition);

  return {
    network: descriptor.name,
    chain,
    rpcUrl,
    deployment: descriptor.deployment,
    finality: descriptor.finality,
  };
}

export interface ResolveNetworkConfigPathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}

export function resolveNetworkConfigPath(
  value: string,
  options: ResolveNetworkConfigPathOptions = {}
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const initCwd = env.INIT_CWD?.trim();

  let baseDir = cwd;

  if (initCwd !== undefined && initCwd.length > 0) {
    baseDir = initCwd;
  }

  return resolve(baseDir, value);
}

function requireEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: ConfigSetting,
): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new RelayerConfigError('MISSING_REQUIRED_SETTING', name);
  }

  return value.trim();
}

function validateRpcUrl(
  value: string,
  setting: ConfigSetting,
): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new RelayerConfigError('INVALID_RPC_URL', setting);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayerConfigError('UNSUPPORTED_RPC_PROTOCOL', setting);
  }
}

function parsePrivateKey(
  value: string,
): Hex {
  if (!isFixedHex(value, 32)) {
    throw new RelayerConfigError('INVALID_PRIVATE_KEY', 'PRIVATE_KEY');
  }

  return value as Hex;
}