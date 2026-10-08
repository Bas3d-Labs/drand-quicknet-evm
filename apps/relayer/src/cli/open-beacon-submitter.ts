import type {
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import type {
  RelayerConfig,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  createBeaconSubmitter,
  type BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import {
  openSignerRuntime,
} from './open-signer-runtime.js';

export interface OpenBeaconSubmitterOptions {
  readonly config: RelayerConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly log: ScopedRelayerLog;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Opens one signer runtime while the command holds the service lock.
 * The returned submitter is shared across the command's imports.
 */
export async function openBeaconSubmitter(
  options: OpenBeaconSubmitterOptions,
): Promise<BeaconSubmitter> {
  const {
    config,
    publicClient,
    walletClient,
    log,
    readChainHeads,
    maxBlockRange,
    signal,
  } = options;

  const {
    broadcastRetry,
    createErrorSummary,
  } = config;

  if (
    broadcastRetry === undefined ||
    createErrorSummary === undefined
  ) {
    throw new Error('Signer runtime configuration is missing.');
  }

  const runtime = await openSignerRuntime({
    identity: {
      chainId: config.chain.id,
      signer: config.account.address,
    },
    log,
    createErrorSummary,
    retry: broadcastRetry,
    env: options.env ?? process.env,
  });

  return createBeaconSubmitter({
    publicClient,
    walletClient,
    account: config.account,
    coordinator: runtime.coordinator,
    recovery: runtime.recovery,
    readChainHeads,
    maxBlockRange,
    signal,
  });
}