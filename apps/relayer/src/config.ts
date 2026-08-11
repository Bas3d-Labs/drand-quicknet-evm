import process from 'node:process';
import { type Chain, isHex, size, type Hex } from 'viem';
import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';
import { loadRegistryDeployment } from './deployment.js';
import type { FinalityPolicy } from './finality-policy.js';

export const RELAYER_NETWORKS = [
  'robinhood-testnet',
] as const;
export type RelayerNetwork = (typeof RELAYER_NETWORKS)[number];

interface NetworkConfig {
  chain: Chain;
  rpcUrlEnv: string;
  deploymentManifestUrl: URL;
  finality: FinalityPolicy;
}

const NETWORK_CONFIGS: Record<
  RelayerNetwork,
  NetworkConfig
> = {
  'robinhood-testnet': {
    chain: robinhoodTestnet,
    rpcUrlEnv: 'ROBINHOOD_TESTNET_RPC_URL',
    deploymentManifestUrl: new URL(
      '../../../deployments/robinhood-testnet.json',
      import.meta.url,
    ),
    finality: {
      type: 'safe',
    },
  },
} satisfies Record<RelayerNetwork, NetworkConfig>;

export interface RelayerConfig {
  network: RelayerNetwork;
  chain: Chain;
  rpcUrl: string;
  account: ReturnType<typeof privateKeyToAccount>;
  deployment: RegistryDeployment;
  finality: FinalityPolicy;
}

export interface LoadRelayerConfigOptions {
  network: RelayerNetwork;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadRelayerConfig(
  options: LoadRelayerConfigOptions,
): Promise<RelayerConfig> {
  const {
    network,
    env = process.env
  } = options;

  const networkConfig = NETWORK_CONFIGS[network];
  
  const rpcUrl = requireEnvironmentVariable(
    env,
    networkConfig.rpcUrlEnv,
  );
  validateRpcUrl(rpcUrl);

  const privateKey = parsePrivateKey(
    requireEnvironmentVariable(
      env,
      'PRIVATE_KEY',
    ),
  );

  const account = privateKeyToAccount(privateKey);
  const deployment = await loadRegistryDeployment({
    manifestUrl: networkConfig.deploymentManifestUrl,
    expectedChainId: networkConfig.chain.id,
  });

  return {
    network,
    chain: networkConfig.chain,
    rpcUrl,
    account,
    deployment,
    finality: networkConfig.finality,
  };
}

export function parseRelayerNetwork(value: string): RelayerNetwork {
  for (const network of RELAYER_NETWORKS) {
    if (value === network) {
      return network;
    }
  }

  throw new Error(
    `Unsupported network: ${value}. Supported networks: ${RELAYER_NETWORKS.join(', ')}`
  );
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