import process from 'node:process';

import {
  defineChain,
  isHex,
  size,
  type Chain,
  type Hex,
} from 'viem';

import {
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  robinhoodTestnet,
} from 'viem/chains';

import {
  loadCustomNetworkDescriptor,
} from './custom-network-config.js';

import {
  loadRegistryDeployment,
} from './deployment.js';

import type {
  FinalityPolicy,
} from './finality-policy.js';

export const RELAYER_NETWORK_PRESETS = [
  'robinhood-testnet',
] as const;
export type RelayerNetworkPreset = (typeof RELAYER_NETWORK_PRESETS)[number];

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
  rpcUrlEnv: string;
  deploymentManifestUrl: URL;
  finality: FinalityPolicy;
}

const NETWORK_RESETS: Record<RelayerNetworkPreset, NetworkPresetConfig> = {
  'robinhood-testnet': {
    chain: robinhoodTestnet,
    rpcUrlEnv:
      'ROBINHOOD_TESTNET_RPC_URL',
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

  return {
    ...network,
    account: privateKeyToAccount(privateKey),
  };
}

export function parseRelayerNetworkPreset(value: string): RelayerNetworkPreset {
  for (const network of RELAYER_NETWORK_PRESETS) {
    if (value === network) {
      return network;
    }
  }

  throw new Error(
    `Unsupported network preset: ${value}. Supported presets: ${RELAYER_NETWORK_PRESETS.join(', ')}`
  );
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
  const preset = NETWORK_RESETS[network];
  
  const rpcUrl = requireEnvironmentVariable(env, preset.rpcUrlEnv);
  validateRpcUrl(rpcUrl);

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
  validateRpcUrl(rpcUrl);

  const chain =  defineChain({
    id: descriptor.chain.id,
    name: descriptor.chain.name,
    nativeCurrency:
      descriptor.chain.nativeCurrency,
    rpcUrls: {
      default: {
        http: [
          rpcUrl,
        ],
      },
    },
    ...(descriptor.chain.testnet === undefined
    ? {}
    : {
        testnet: descriptor.chain.testnet,
      }),
  });

  return {
    network: descriptor.name,
    chain,
    rpcUrl,
    deployment: descriptor.deployment,
    finality: descriptor.finality,
  };
}

function requireEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }

  return value.trim();
}

function validateRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid RPC URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported RPC URL protocol: ${url.protocol}.`);
  }
}

function parsePrivateKey(value: string): Hex {
  if (!isHex(value, {strict: true}) || size(value) !== 32) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex value.');
  }

  return value as Hex;
}