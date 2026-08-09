import process from 'node:process';
import { type Chain, getAddress, isHex, size, type Hex } from 'viem';
import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';

export const RELAYER_NETWORKS = [
  'robinhood-testnet',
] as const;

export type RelayerNetwork = (typeof RELAYER_NETWORKS)[number];

interface NetworkConfig {
  chain: Chain;
  rpcUrlEnv: string;
  deploymentManifestUrl: URL;
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
  },
};

interface DeploymentManifest {
  chainId?: unknown;
  registry?: {
    address?: unknown;
    runtimeCodehash?: unknown;
  };
}

export interface RelayerConfig {
  network: RelayerNetwork;
  chain: Chain;
  rpcUrl: string;
  account: ReturnType<typeof privateKeyToAccount>;
  deployment: RegistryDeployment;
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
  const deployment = await loadRegistryDeployment(networkConfig);

  return {
    network,
    chain: networkConfig.chain,
    rpcUrl,
    account,
    deployment,
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

async function loadRegistryDeployment(
  networkConfig: NetworkConfig,
): Promise<RegistryDeployment> {
  let contents: string;
  try {
    contents = await readFile(networkConfig.deploymentManifestUrl, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read deployment manifest: ${networkConfig.deploymentManifestUrl.pathname}.`,
      {
        cause: error,
      },
    );
  }

  let manifest: DeploymentManifest;
  try {
    manifest = JSON.parse(contents) as DeploymentManifest;
  } catch (error) {
    throw new Error(
      `Invalid deployment manifest JSON: ${networkConfig.deploymentManifestUrl.pathname}.`,
      {
        cause: error,
      }
    );
  }

  const chainId = parseChainId(manifest.chainId);
  if (chainId !== networkConfig.chain.id) {
    throw new Error(
      `Deployment manifest chain mismatch: expected ${networkConfig.chain.id}, received ${chainId}.`
    );
  }

  if (
    manifest.registry === undefined ||
    manifest.registry === null ||
    typeof manifest.registry !== 'object'
  ) {
    throw new Error('Invalid deployment manifest: missing registry.');
  }

  const address = parseRegistryAddress(manifest.registry.address);
  const runtimeCodehash = parseBytes32(
    manifest.registry.runtimeCodehash,
    'registry.runtimeCodehash',
  );

  return {
    chainId,
    address,
    runtimeCodehash,
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

  if (url.protocol !== 'http' && url.protocol !== 'https:') {
    throw new Error(`Unsupported RPC URL protocol: ${url.protocol}.`);
  }
}

function parsePrivateKey(value: string): Hex {
  if (!isHex(value, {strict: true}) || size(value) !== 32) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex value.');
  }

  return value as Hex;
}

function parseChainId(
  value: unknown,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      'Invalid deployment manifest: chainId must be a positive integer.'
    );
  }

  return value;
}

function parseRegistryAddress(
  value: unknown
): RegistryDeployment['address'] {
  if (typeof value !== 'string') {
    throw new Error(
      'Invalid deployment manifest: registry.address must be a valid address.'
    );
  }

  try {
    return getAddress(value);
  } catch {
    throw new Error(
      'Invalid deployment manifest: registry.address must be a valid address.'
    );
  }
}

function parseBytes32(
  value: unknown,
  field: string,
): Hex {
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new Error(
      `Invalid deployment manifest: ${field} must be a 32-byte 0x-prefixed hex value.`
    );
  }

  return value as Hex;
}