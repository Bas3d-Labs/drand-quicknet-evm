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
  DEFAULT_RECEIPT_TIMEOUT_MS,
  validateReceiptTimeoutMs,
} from '../config/receipt-config.js';

import {
  reportImportProgress,
  type RoundImportProgress,
} from '../diagnostics/operation-context.js';

import type {
  BeaconSubmitter,
} from './create-beacon-submitter.js';

import {
  fetchQuicknetBeaconWithRetry,
  type FetchQuicknetBeaconWithRetryOptions,
} from './fetch-beacon-with-retry.js';

import {
  importQuicknetRound,
  type ImportQuicknetRoundOptions,
  type ImportQuicknetRoundResult,
} from './import-round.js';

import {
  waitForQuicknetRound
} from './wait-for-round.js';

export interface ImportQuicknetRoundWhenAvailableOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  submitter: BeaconSubmitter;
  deployment: RegistryDeployment;
  round: bigint;
  maxFetchAttempts?: number;
  fetchRetryDelayMs?: number;
  receiptTimeoutMs?: number;
  onProgress?: ((progress: RoundImportProgress) => void) | undefined;
  signal?: AbortSignal;
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

  const receiptTimeoutMs = validateReceiptTimeoutMs(
    options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
  );

  options.signal?.throwIfAborted();

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

  options.signal?.throwIfAborted();

  const stored = await registry.isStored(round);

  options.signal?.throwIfAborted();

  if (stored) {
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

  if (options.signal === undefined) {
    await waitForQuicknetRound({ round });
  } else {
    await waitForQuicknetRound({
      round,
      signal: options.signal,
    });
  }

  options.signal?.throwIfAborted();

  const fetchOptions: FetchQuicknetBeaconWithRetryOptions = {
    round,
  };

  if (options.signal !== undefined) {
    fetchOptions.signal = options.signal;
  }

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

  options.signal?.throwIfAborted();

  const importOptions: ImportQuicknetRoundOptions = {
    publicClient,
    walletClient,
    account,
    submitter: options.submitter,
    deployment,
    round,
    beacon,
    receiptTimeoutMs,
    onProgress: options.onProgress,
  };

  if (options.signal !== undefined) {
    importOptions.signal = options.signal;
  }

  return importQuicknetRound(importOptions);
}