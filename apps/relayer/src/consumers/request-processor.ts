import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  isOperationCancelled
} from '../execution/is-operation-cancelled.js';

import type {
  TerminalRoundReason,
} from '../rounds/terminal-round-reason.js';

import {
  terminalRoundReason,
} from '../rounds/terminal-round-reason.js';

import type {
  RoundImporter,
} from '../rounds/create-round-importer.js';

import type {
  CompletedImportResult,
  PendingImportResult,
} from '../rounds/import-round.js';

import type {
  TransactionAdmissionReason,
} from '../state/transaction-manager-types.js';

import type {
  QuicknetRandomnessRequest,
} from './request-events.js';

import type {
  WaitingRoundResult,
} from '../rounds/round-release.js';

export interface WaitingRequestScheduling {
  classify(round: bigint): WaitingRoundResult | undefined;
  offer(
    request: QuicknetRandomnessRequest,
    releaseTime: bigint,
    source?: 'durable' | 'soft',
  ): void;
}

export interface ProcessQuicknetRequestsOptions {
  importRound: RoundImporter;
  requests: readonly QuicknetRandomnessRequest[];
  waiting?: WaitingRequestScheduling | undefined;
  waitingSource?: 'durable' | 'soft';
  onCompleted?:
    | ((result: ProcessedQuicknetRound) => void)
    | undefined;
  onIncomplete?:
    | ((outcome: IncompleteQuicknetRoundOutcome) => void)
    | undefined;
  onUnfulfillable?: ((
    request: QuicknetRandomnessRequest,
    reason: TerminalRoundReason,
  ) => void) | undefined;
  signal?: AbortSignal;
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
  | WaitingRoundResult
  | {
      status: 'unfulfillable';
      reason: TerminalRoundReason;
    }
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
      blocker: TransactionAdmissionReason;
    }
  | {
      status: 'deferred';
      reason: 'already-retained';
      attemptId: string;
      workId: string;
    }
);

export type IncompleteQuicknetRoundOutcome = Extract<
  QuicknetRoundOutcome,
  | { 
      status: 'pending';
    }
  | { 
      status: 'deferred';
      reason: 'signer-unavailable' | 'already-retained';
    }
>;

export async function processQuicknetRequestsWithOutcomes(
  options: ProcessQuicknetRequestsOptions,
): Promise<readonly QuicknetRoundOutcome[]> {
  options.signal?.throwIfAborted();

  const firstBlocks = new Map<bigint, bigint>();

  const representatives = new Map<bigint, QuicknetRandomnessRequest>();

  for (const request of options.requests) {
    const reason = terminalRoundReason(request.round);

    if (reason !== undefined) {
      try {
        options.onUnfulfillable?.(request, reason);
      } catch {
        // Best-effort reporting never changes terminal classification.
      }
    }

    const previous = firstBlocks.get(request.round);

    if (
      previous === undefined ||
      request.blockNumber < previous
    ) {
      firstBlocks.set(request.round, request.blockNumber);
      representatives.set(request.round, request);
    }
  }

  const outcomes: QuicknetRoundOutcome[] = [];

  function recordIncomplete(
    outcome: IncompleteQuicknetRoundOutcome,
  ): void {
    if (outcome.status === 'deferred' && outcome.reason === 'signer-unavailable') {
      options.waiting?.offer(
        representatives.get(outcome.round)!,
        roundScheduledTime(outcome.round),
        options.waitingSource,
      );
    }

    outcomes.push(outcome);

    try {
      options.onIncomplete?.(outcome);
    } catch {
      // Reporting must not interrupt request processing.
    }
  }

  let failed = false;
  let signerUnavailable: TransactionAdmissionReason | undefined;

  for (const [round, firstRequestBlock] of firstBlocks) {
    const reason = terminalRoundReason(round);

    if (reason !== undefined) {
      outcomes.push({
        round,
        firstRequestBlock,
        status: 'unfulfillable',
        reason,
      });

      continue;
    }

    const waiting = options.waiting?.classify(round);

    if (waiting !== undefined) {
      options.waiting!.offer(
        representatives.get(round)!,
        waiting.releaseTime,
        options.waitingSource,
      );

      outcomes.push({
        ...waiting,
        firstRequestBlock,
      });

      continue;
    }

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
      const result = await options.importRound(round);

      if (result.status === 'waiting') {
        options.waiting?.offer(
          representatives.get(round)!,
          result.releaseTime,
          options.waitingSource,
        );

        outcomes.push({
          ...result,
          firstRequestBlock,
        });

        continue;
      }

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
        if (result.reason === 'signer-unavailable') {
          signerUnavailable = result.blocker;

          recordIncomplete({
            round,
            firstRequestBlock,
            status: 'deferred',
            reason: 'signer-unavailable',
            blocker: result.blocker,
          });
        } else {
          recordIncomplete({
            round,
            firstRequestBlock,
            status: 'deferred',
            reason: 'already-retained',
            attemptId: result.attemptId,
            workId: result.workId,
          });
        }

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
      if (isOperationCancelled(error, options.signal)) {
        throw error;
      }

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
    switch (outcome.status) {
      case 'failed':
        throw outcome.error;
      case 'completed':
        rounds.push({
          round: outcome.round,
          result: outcome.result,
        });
        break;
      case 'waiting':
      case 'unfulfillable':
      case 'pending':
      case 'deferred':
        break;
      default:
        outcome satisfies never;
    }
  }

  return { rounds };
}