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
  type BeaconRecoveryObservation,
  type BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import {
  readSignerRuntimeObservation,
  type SignerRuntimeObservation,
} from '../state/read-signer-runtime-observation.js';

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

  /** 
   * Synchronous diagnostic observer, including startup recovery.
   * Notification does not itself authorize snapshot publication.
   */
  readonly onRecoveryCompleted?: (
    observation: BeaconRecoveryObservation,
  ) => void;

  /**
   * Called once during opening if the journal is initialized.
   * When startup polling is enabled, called after that wait succeeds.
   * 
   * The supplied function reads public runtime state without advancing it.
   * The callback is synchronous and must not perform transaction work.
   */
  readonly onInitialized?: (
    readObservation: () => SignerRuntimeObservation,
  ) => void;

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

  const manager = await openSignerRuntime({
    identity: {
      chainId: config.chain.id,
      signer: config.account.address,
    },
    log,
    createErrorSummary,
    retry: broadcastRetry,
    publicClient,
    walletClient,
    account: config.account,
    readChainHeads,
    maxBlockRange,
    checkpointFile: options.checkpointFile,
    env: options.env ?? process.env,
    ...(options.onRecoveryCompleted === undefined
      ? {}
      : { onRecoveryCompleted: options.onRecoveryCompleted }),
  });

  const submitter = createBeaconSubmitter({
    publicClient,
    manager,
    readChainHeads,
    signal,
  });

  if (options.startupPollIntervalMs !== undefined) {
    await waitForSignerJournal({
      manager,
      submitter,
      pollIntervalMs: options.startupPollIntervalMs,
      signal,
    });
  }

  if (
    options.onInitialized !== undefined &&
    manager.status.journalInitialized
  ) {
    try {
      options.onInitialized(
        () => readSignerRuntimeObservation(manager),
      );
    } catch {
      // Diagnostic setup must not replace successful signer startup.
    }
  }

  return submitter;
}