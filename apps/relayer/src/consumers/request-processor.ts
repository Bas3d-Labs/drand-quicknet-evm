import type {
  Account,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  RoundImportProgress,
} from '../diagnostics/operation-context.js';

import type {
  BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import type {
  CompletedImportResult,
  PendingImportResult,
} from '../rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../rounds/import-round-when-available.js';

import type {
  SignerBlocker,
} from '../state/signer-gate.js';

import type {
  QuicknetRandomnessRequest,
} from './request-events.js';

export interface ProcessQuicknetRequestsOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  submitter: BeaconSubmitter;
  deployment: RegistryDeployment;
  requests: readonly QuicknetRandomnessRequest[];
  receiptTimeoutMs?: number;
  onProgress?: ((progress: RoundImportProgress) => void) | undefined;
  onCompleted?:
    | ((result: ProcessedQuicknetRound) => void)
    | undefined;
  onIncomplete?:
    | ((outcome: IncompleteQuicknetRoundOutcome) => void)
    | undefined;
}

export interface ProcessedQuicknetRound {
  round: bigint;
  result: CompletedImportResult;
}

export interface ProcessQuicknetRequestsResult {
  rounds: readonly ProcessedQuicknetRound[];
}

export type QuicknetRoundOutcome = {
  round: bigint;
  firstRequestBlock: bigint;
} & (
  | {
      status: 'completed';
      result: CompletedImportResult;
    }
  | {
      status: 'pending';
      result: PendingImportResult;
    }
  | {
      status: 'failed';
      error: unknown;
    }
  | {
      status: 'deferred';
      reason: 'earlier-import-failed';
    }
  | {
      status: 'deferred';
      reason: 'signer-unavailable';
      blocker: SignerBlocker;
    }
);

export type IncompleteQuicknetRoundOutcome = Extract<
  QuicknetRoundOutcome,
  | { 
      status: 'pending';
    }
  | { 
      status: 'deferred';
      reason: 'signer-unavailable';
    }
>;

export async function processQuicknetRequestsWithOutcomes(
  options: ProcessQuicknetRequestsOptions,
): Promise<readonly QuicknetRoundOutcome[]> {
  const firstBlocks = new Map<bigint, bigint>();

  for (const request of options.requests) {
    const previous = firstBlocks.get(request.round);

    if (
      previous === undefined ||
      request.blockNumber < previous
    ) {
      firstBlocks.set(request.round, request.blockNumber);
    }
  }

  const outcomes: QuicknetRoundOutcome[] = [];

  function recordIncomplete(outcome: IncompleteQuicknetRoundOutcome): void {
    outcomes.push(outcome);

    try {
      options.onIncomplete?.(outcome);
    } catch {
      // Reporting must not interrupt request processing.
    }
  }

  let failed = false;
  let signerUnavailable: SignerBlocker | undefined;

  for (const [round, firstRequestBlock] of firstBlocks) {
    if (failed) {
      outcomes.push({
        round,
        firstRequestBlock,
        status: 'deferred',
        reason: 'earlier-import-failed',
      });

      continue;
    }

    if (signerUnavailable !== undefined) {
      recordIncomplete({
        round,
        firstRequestBlock,
        status: 'deferred',
        reason: 'signer-unavailable',
        blocker: signerUnavailable,
      });

      continue;
    }

    try {
      const result = await importQuicknetRoundWhenAvailable({
        publicClient: options.publicClient,
        walletClient: options.walletClient,
        account: options.account,
        submitter: options.submitter,
        deployment: options.deployment,
        round,
        ...(options.receiptTimeoutMs !== undefined
          ? { receiptTimeoutMs: options.receiptTimeoutMs }
          : {}),
        onProgress: options.onProgress,
      });

      if (result.status === 'pending') {
        recordIncomplete({
          round,
          firstRequestBlock,
          status: 'pending',
          result,
        });

        continue;
      }

      if (result.status === 'deferred') {
        signerUnavailable = result.blocker;

        recordIncomplete({
          round,
          firstRequestBlock,
          status: 'deferred',
          reason: result.reason,
          blocker: result.blocker,
        });

        continue;
      }

      outcomes.push({
        round,
        firstRequestBlock,
        status: 'completed',
        result,
      });

      try {
        options.onCompleted?.({ round, result });
      } catch {
        // Reporting must not replace a successful import.
      }
    } catch (error) {
      outcomes.push({
        round,
        firstRequestBlock,
        status: 'failed',
        error,
      });

      failed = true;
    }
  }

  return outcomes;
}

export async function processQuicknetRequests(
  options: ProcessQuicknetRequestsOptions,
): Promise<ProcessQuicknetRequestsResult> {
  const outcomes = await processQuicknetRequestsWithOutcomes(options);
  const rounds: ProcessedQuicknetRound[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      throw outcome.error;
    }

    if (outcome.status === 'completed') {
      rounds.push({
        round: outcome.round,
        result: outcome.result,
      });
    }
  }

  return { rounds };
}