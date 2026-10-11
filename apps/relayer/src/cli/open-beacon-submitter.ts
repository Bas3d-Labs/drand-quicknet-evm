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

import {
  waitForSignerJournal,
} from './wait-for-signer-journal.js';

export interface OpenBeaconSubmitterOptions {
  readonly config: RelayerConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly log: ScopedRelayerLog;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;
  readonly checkpointFile?: string | undefined;

  /** Wait for first-use journal initialization before returning. */
  readonly startupPollIntervalMs?: number | undefined;
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
    checkpointFile: options.checkpointFile,
    env: options.env ?? process.env,
  });

  const submitter = createBeaconSubmitter({
    publicClient,
    walletClient,
    account: config.account,
    coordinator: runtime.coordinator,
    recovery: runtime.recovery,
    readChainHeads,
    maxBlockRange,
    signal,
  });

  if (options.startupPollIntervalMs !== undefined) {
    await waitForSignerJournal({
      coordinator: runtime.coordinator,
      submitter,
      pollIntervalMs: options.startupPollIntervalMs,
      signal,
    });
  }

  return submitter;
}