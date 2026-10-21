import {
  validateFetchTimeoutMs,
} from '../config/fetch-config.js'; 

import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  validateReceiptTimeoutMs,
} from '../config/receipt-config.js';

import type {
  ImportQuicknetRoundResult,
} from './import-round.js';

import {
  importQuicknetRoundWhenAvailable,
  type ImportQuicknetRoundWhenAvailableOptions,
} from './import-round-when-available.js';

export type CreateRoundImporterOptions = Readonly<Pick<
  ImportQuicknetRoundWhenAvailableOptions,
  | 'publicClient'
  | 'account'
  | 'deployment'
  | 'receiptTimeoutMs'
  | 'fetchTimeoutMs'
>>;

export type BindRoundImporterOptions = Readonly<Pick<
  ImportQuicknetRoundWhenAvailableOptions,
  | 'submitter'
  | 'onProgress'
  | 'signal'
>>;

export type RoundImporter = (
  round: bigint,
) => Promise<ImportQuicknetRoundResult>;

export type RoundImporterBinder = (
  options:BindRoundImporterOptions,
) => RoundImporter;

/**
 * Captures stable import dependencies.
 * 
 * Each scan binds its progress callback and the current cycle's
 * submitter before passing the resulting importer to the processor.
 */
export function createRoundImporter(
  options: CreateRoundImporterOptions,
): RoundImporterBinder {
  const {
    publicClient,
    account,
    deployment,
    receiptTimeoutMs,
    fetchTimeoutMs,
  } = options;

  validateReceiptTimeoutMs(
    receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
  );

  if (fetchTimeoutMs !== undefined) {
    validateFetchTimeoutMs(fetchTimeoutMs);
  }

  return function bindRoundImporter(
    binding: BindRoundImporterOptions,
  ): RoundImporter {
    const {
      submitter,
      onProgress,
      signal,
    } = binding;

    return function importRound(
      round: bigint,
    ): Promise<ImportQuicknetRoundResult> {
      const importOptions: ImportQuicknetRoundWhenAvailableOptions = {
        publicClient,
        account,
        deployment,
        submitter,
        round,
        onProgress,
      };

      if (receiptTimeoutMs !== undefined) {
        importOptions.receiptTimeoutMs = receiptTimeoutMs;
      }

      if (fetchTimeoutMs !== undefined) {
        importOptions.fetchTimeoutMs = fetchTimeoutMs;
      }

      if (signal !== undefined) {
        importOptions.signal = signal;
      }

      return importQuicknetRoundWhenAvailable(importOptions);
    }
  }
}