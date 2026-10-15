import {
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type {
  DaemonConfig,
} from '../config/daemon-config.js';

import {
  getDurableBlockNumber,
  type FinalityPolicy,
} from '../chain/finality-policy.js';

export interface DaemonStartupSummary {
  network: string;
  chainId: number;
  rpcOrigin: string;
  signer: Address;
  signerBalance: bigint;
  registry: Address;
  registryRuntimeCodehash: Hex;
  finality: FinalityPolicy;
  latestHead: bigint;
  durableHead: bigint;
  consumers: readonly Address[];
  checkpointFile: string;
  startBlock: bigint;
  maxBlockRange: bigint;
  pollIntervalMs: number;
  durableNextBlocks: ReadonlyMap<Address, bigint>;
}

export interface CollectDaemonStartupSummaryOptions {
  publicClient: PublicClient;
  config: DaemonConfig;
  durableNextBlocks?: ReadonlyMap<Address, bigint>;
}

export async function collectDaemonStartupSummary(
  options: CollectDaemonStartupSummaryOptions,
): Promise<DaemonStartupSummary> {
  const {
    publicClient,
    config,
    durableNextBlocks = new Map<Address, bigint>(),
  } = options;

  const [
    signerBalance,
    latestHead,
    durableHead,
  ] = await Promise.all([
    publicClient.getBalance({ address: config.account.address }),
    publicClient.getBlockNumber(),
    getDurableBlockNumber(publicClient, config.finality),
  ]);

  return {
    network: config.network,
    chainId: config.chain.id,
    rpcOrigin: formatRpcOrigin(config.rpcUrl),
    signer: config.account.address,
    signerBalance,
    registry: config.deployment.address,
    registryRuntimeCodehash: config.deployment.runtimeCodehash,
    finality: config.finality,
    latestHead,
    durableHead,
    consumers: config.consumers,
    checkpointFile: config.checkpointFile,
    startBlock: config.startBlock,
    maxBlockRange: config.maxBlockRange,
    pollIntervalMs: config.pollIntervalMs,
    durableNextBlocks,
  };
}

function formatRpcOrigin(
  value: string
): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}