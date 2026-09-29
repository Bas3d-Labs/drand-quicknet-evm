import {
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';

import {
  createRegistryReader,
  type RegistryDeployment
} from '@based-labs/drand-quicknet-registry';

import {
  fetchQuicknetBeaconWithRetry,
  type FetchQuicknetBeaconWithRetryOptions,
} from './fetch-beacon-with-retry.js';

import {
  importQuicknetRound,
  type ImportQuicknetRoundResult,
} from './import-round.js';

import {
  waitForQuicknetRound
} from './wait-for-round.js';

import {
  reportImportProgress,
  type RoundImportProgress,
} from '../diagnostics/operation-context.js';

export interface ImportQuicknetRoundWhenAvailableOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
  maxFetchAttempts?: number;
  fetchRetryDelayMs?: number;
  onProgress?: ((progress: RoundImportProgress) => void) | undefined;
}

export async function importQuicknetRoundWhenAvailable(
  options: ImportQuicknetRoundWhenAvailableOptions
): Promise<ImportQuicknetRoundResult> {
  const {
    publicClient,
    walletClient,
    account,
    deployment,
    round,
    maxFetchAttempts,
    fetchRetryDelayMs,
  } = options;

  if (round <= 0n) {
    throw new RangeError('Quicknet round must be greater than zero.');
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'verify-deployment',
  });

  const registry = createRegistryReader({
    client: publicClient,
    deployment,
  });
  await registry.verifyDeployment();

  reportImportProgress(options.onProgress, {
    round,
    phase: 'check-stored',
  });

  if (await registry.isStored(round)) {
    const randomness = await registry.getBeacon(round);
    return {
      status: 'already-stored',
      round,
      randomness,
    };
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'wait-for-beacon',
  });

  await waitForQuicknetRound({round});

  const fetchOptions: FetchQuicknetBeaconWithRetryOptions = {
    round,
  };

  if (maxFetchAttempts !== undefined) {
    fetchOptions.maxAttempts = maxFetchAttempts;
  }

  if (fetchRetryDelayMs !== undefined) {
    fetchOptions.retryDelayMs = fetchRetryDelayMs;
  }

  reportImportProgress(options.onProgress, {
    round,
    phase: 'fetch-beacon',
  });

  const beacon = await fetchQuicknetBeaconWithRetry(fetchOptions);

  return importQuicknetRound({
    publicClient,
    walletClient,
    account,
    deployment,
    round,
    beacon,
    onProgress: options.onProgress,
  });
}