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
import { waitForQuicknetRound } from './wait-for-round.js';

export interface ImportQuicknetRoundWhenAvailableOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  round: bigint;
  maxFetchAttempts?: number;
  fetchRetryDelayMs?: number;
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

  const registry = createRegistryReader({
    client: publicClient,
    deployment,
  });
  await registry.verifyDeployment();

  if (await registry.isStored(round)) {
    const randomness = await registry.getBeacon(round);
    return {
      status: 'already-stored',
      round,
      randomness,
    };
  }

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

  const beacon = await fetchQuicknetBeaconWithRetry(fetchOptions);

  return importQuicknetRound({
    publicClient,
    walletClient,
    account,
    deployment,
    round,
    beacon,
  });
}