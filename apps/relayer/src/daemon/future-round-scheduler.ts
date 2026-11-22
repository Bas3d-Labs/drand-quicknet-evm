import type {
  Address,
} from 'viem';

import type {
  QuicknetRandomnessRequest,
} from '../consumers/request-events.js';

import type {
  WaitingRequestScheduling,
} from '../consumers/request-processor.js';

import {
  isOperationCancelled,
} from '../execution/is-operation-cancelled.js';

import {
  createBeaconWorkId,
} from '../rounds/beacon-work-identity.js';

import type {
  RoundImporter,
} from '../rounds/create-round-importer.js';

import type {
  ImportQuicknetRoundResult,
} from '../rounds/import-round.js';

import {
  waitingRound,
} from '../rounds/round-release.js';

export const MAX_WAITING_ROUNDS = 1_024;
export const MAX_SCHEDULED_DISPATCHES = 16;

export interface WaitingEntry {
  readonly workId: string;
  readonly registry: Address;
  readonly request: QuicknetRandomnessRequest;
  readonly releaseTime: bigint;
  readonly enteredAt: number;
  readonly source: 'durable' | 'soft';
}

interface QueuedEntry extends WaitingEntry {
  lastFailure: bigint;
  blockedReported: boolean;
}

export type WaitTransition =
  | {
      kind: 'started';
      entry: WaitingEntry;
    }
  | {
      kind: 'evicted';
      entry: WaitingEntry;
    }
  | {
      kind: 'released';
      entry: WaitingEntry;
      disposition: ImportQuicknetRoundResult['status'];
    };

export type ScheduledOutcome =
  | {
      entry: WaitingEntry;
      status: 'returned';
      result: ImportQuicknetRoundResult;
      reportDeferred?: boolean;
    }
  | {
      entry: WaitingEntry;
      status: 'failed';
      error: unknown;
    };

export interface ScheduledPass {
  attempted: number;
  handedOff: number;
  failed: boolean;
  blocked?: boolean;
  outcomes: ScheduledOutcome[];
}

export interface DispatchObservation {
  readonly workId: string;
  readonly disposition:
    | 'completed'
    | 'waiting'
    | 'blocked'
    | 'failed'
    | 'clock-deferred'
    | 'remainder';
  readonly handedOff: number;
}

export interface QueueAdmission {
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly workId: string;
}

interface SchedulerOptions {
  chainId: number;
  registry: Address;
  now?: () => number;
  onTransition?: ((event: WaitTransition) => void) | undefined;
  onDispatch?: ((fact: DispatchObservation) => void) | undefined;
}

/** Ephemeral acceleration only. Checkpoints remain the discovery guarantee. */
export class FutureRoundScheduler implements WaitingRequestScheduling {
  private readonly entries = new Map<string, QueuedEntry>();
  private readonly now: () => number;
  private failureSequence = 0n;
  private rejected = 0n;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get rejectedOffers(): bigint {
    return this.rejected;
  }

  /** Captured without dispatch or mutation, using the publication's one clock read. */
  observe(captureTimeMs: number) {
    if (!Number.isSafeInteger(captureTimeMs)) {
      throw new TypeError('Invalid scheduler observation time.');
    }

    const seconds = BigInt(Math.floor(captureTimeMs / 1000));

    let dueCount = 0;

    for (const entry of this.entries.values()) {
      if (entry.releaseTime <= seconds) {
        dueCount += 1;
      }
    }

    return Object.freeze({
      queuedCount: this.entries.size,
      dueCount,
      limit: MAX_WAITING_ROUNDS,
      rejectedOffers: this.rejected.toString(),
    });
  }

  classify(round: bigint) {
    return waitingRound(round, this.now);
  }

  offer(
    request: QuicknetRandomnessRequest,
    releaseTime: bigint,
    source: 'durable' | 'soft' = 'soft',
  ): void {
    this.admit(request, releaseTime, source);
  }

  admit(
    request: QuicknetRandomnessRequest,
    releaseTime: bigint,
    source: 'durable' | 'soft' = 'soft',
  ): QueueAdmission {
    const workId = createBeaconWorkId({
      chainId: this.options.chainId,
      registry: this.options.registry,
      round: request.round,
    });

    if (this.entries.has(workId)) {
      return { status: 'duplicate', workId };
    }

    const entry: QueuedEntry = {
      workId,
      registry: this.options.registry,
      request: { ...request },
      releaseTime,
      enteredAt: this.now(),
      source,
      lastFailure: 0n,
      blockedReported: false,
    };

    if (this.entries.size === MAX_WAITING_ROUNDS) {
      const furthest = [...this.entries.values()].sort(releaseOrder).at(-1)!;

      if (releaseOrder(entry, furthest) >= 0) {
        this.rejected += 1n;

        return { status: 'rejected', workId };
      }

      this.entries.delete(furthest.workId);

      this.report({
        kind: 'evicted',
        entry: furthest,
      });
    }

    this.entries.set(workId, entry);

    this.report({
      kind: 'started',
      entry,
    });

    return { status: 'accepted', workId };
  }

  async dispatch(
    importRound: RoundImporter,
    signal?: AbortSignal,
  ): Promise<ScheduledPass> {
    const pass: ScheduledPass = {
      attempted: 0,
      handedOff: 0,
      failed: false,
      outcomes: [],
    };

    const now = BigInt(this.now());

    // Never-failed entries first; rotate failures by their last failed turn.
    // Eviction remains release-ordered, independently of retry ordering.
    const allDue = [...this.entries.values()]
      .filter((entry) => entry.releaseTime * 1000n <= now)
      .sort((a, b) => {
        if (a.lastFailure < b.lastFailure) {
          return -1;
        }

        if (a.lastFailure > b.lastFailure) {
          return 1;
        }

        return releaseOrder(a, b);
      });

    const due = allDue.slice(0, MAX_SCHEDULED_DISPATCHES);

    let clockDeferred = false;

    for (const entry of due) {
      signal?.throwIfAborted();

      // Recheck after previous dispatches: wall time can move backwards.
      if (this.classify(entry.request.round) !== undefined) {
        clockDeferred = true;

        this.reportDispatch(entry.workId, 'clock-deferred', pass.handedOff);

        continue;
      }

      pass.attempted += 1;

      try {
        const result = await importRound(entry.request.round);

        if (result.status === 'waiting') {
          this.reportDispatch(entry.workId, 'waiting', pass.handedOff);

          continue;
        }

        if (result.status === 'deferred' && result.reason === 'signer-unavailable') {
          // All admission blockers are signer-wide; per-work already-retained is not.
          pass.blocked = true;

          pass.outcomes.push({
            entry,
            status: 'returned',
            result,
            reportDeferred: !entry.blockedReported,
          });

          // Best-effort reporting is attempted only once per queue episode.
          entry.blockedReported = true;

          this.reportDispatch(entry.workId, 'blocked', pass.handedOff);

          break;
        }

        this.entries.delete(entry.workId);

        pass.handedOff += 1;

        pass.outcomes.push({
          entry,
          status: 'returned',
          result,
        });

        this.reportDispatch(entry.workId, 'completed', pass.handedOff);

        this.report({
          kind: 'released',
          entry,
          disposition: result.status,
        });
      } catch (error) {
        if (isOperationCancelled(error, signal)) {
          throw error;
        }

        this.failureSequence += 1n;
        entry.lastFailure = this.failureSequence;
        pass.failed = true;

        // One thrown dispatch ends this pass. Its entry stays queued.
        pass.outcomes.push({
          entry,
          status: 'failed',
          error,
        });

        this.reportDispatch(entry.workId, 'failed', pass.handedOff);

        break;
      }
    }

    if (
      this.options.onDispatch !== undefined &&
      pass.handedOff > 0 &&
      !pass.failed &&
      !pass.blocked &&
      !clockDeferred
    ) {
      // These were due at selection and excluded solely by the dispatch cap.
      // Release time must still be checked again before a later dispatch.
      for (const entry of allDue.slice(MAX_SCHEDULED_DISPATCHES)) {
        if (this.entries.has(entry.workId)) {
          this.reportDispatch(entry.workId, 'remainder', pass.handedOff);
        }
      }
    }

    return pass;
  }

  sleepMilliseconds(pollIntervalMs: number, pass?: ScheduledPass): number {
    // Failed recovery, signer blockage and all-failed passes must not spin.
    if (
      pass === undefined ||
      pass.blocked === true ||
      (pass.failed && pass.handedOff === 0)
    ) {
      return pollIntervalMs;
    }

    const now = BigInt(this.now());

    let delay = BigInt(pollIntervalMs);

    for (const entry of this.entries.values()) {
      const remaining = entry.releaseTime * 1000n - now;

      if (remaining <= 0n) {
        if (pass.handedOff > 0) {
          return 0;
        }
      } else if (remaining < delay) {
        delay = remaining;
      }
    }

    // The result is bounded by the validated poll interval, never by a lead.
    return Number(delay);
  }

  private reportDispatch(
    workId: string,
    disposition: DispatchObservation['disposition'],
    handedOff: number,
  ): void {
    const observer = this.options.onDispatch;

    if (observer === undefined) {
      return;
    }

    try {
      observer(Object.freeze({ workId, disposition, handedOff }));
    } catch {
      // Observation delivery must not alter dispatch or its return value.
    }
  }

  private report(event: WaitTransition): void {
    try {
      this.options.onTransition?.(event);
    } catch {
      // Scheduling never depends on delivery of diagnostics.
    }
  }
}

function releaseOrder(a: WaitingEntry, b: WaitingEntry): number {
  if (a.releaseTime < b.releaseTime) {
    return -1;
  }

  if (a.releaseTime > b.releaseTime) {
    return 1;
  }

  if (a.workId < b.workId) {
    return -1;
  }

  if (a.workId > b.workId) {
    return 1;
  }

  return 0;
}
