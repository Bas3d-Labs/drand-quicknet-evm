import {
  formatEther,
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

export function formatDaemonStartupSummary(
  summary: DaemonStartupSummary,
): string {
  const lines = [
    'Relayer daemon starting',
    '',
    `Network:           ${summary.network}`,
    `Chain ID:          ${summary.chainId}`,
    `RPC origin:        ${summary.rpcOrigin}`,
    `Signer:            ${summary.signer}`,
    `Signer balance:    ${formatEther(summary.signerBalance)} ETH`,
    `Registry:          ${summary.registry}`,
    `Registry codehash: ${summary.registryRuntimeCodehash}`,
    `Finality:          ${formatFinality(summary.finality)}`,
    `Latest head:       ${summary.latestHead}`,
    `Durable head:      ${summary.durableHead}`,
    `Checkpoint:        ${summary.checkpointFile}`,
    `Start block:       ${summary.startBlock}`,
    `Max block range:   ${summary.maxBlockRange}`,
    `Poll interval:     ${summary.pollIntervalMs} ms`,
    'Consumers:',
  ];

  for (const consumer of summary.consumers) {
    const nextBlock = summary.durableNextBlocks.get(consumer);

    lines.push(
      nextBlock === undefined
        ? `  - ${consumer}`
        : `  - ${consumer} (next durable block: ${nextBlock})`
    );
  }

  return lines.join('\n');
}

function formatFinality(
  policy: FinalityPolicy
): string {
  switch (policy.type) {
    case 'safe':
      return 'safe';

    case 'finalized':
      return 'finalized';

    case 'confirmations':
      return `${policy.confirmations} confirmations`;
  }
}

function formatRpcOrigin(
  value: string
): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}