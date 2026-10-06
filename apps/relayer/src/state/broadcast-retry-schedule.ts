import {
  performance,
} from 'node:perf_hooks';

import {
  isUuidV4,
} from '../shared/uuid.js';

import type {
  JournalAttempt,
} from './transaction-journal.js';

const MAX_DELAY_MS = 2_147_483_647;

export interface BroadcastRetryScheduleOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly now?: () => number;
}

/**
 * Spaces broadcast attempts without delaying receipt reconciliation.
 * The caller claims a due send immediately before asking the coordinator
 * to broadcast. A claim advances the schedule even if that operation fails.
 * 
 * This is process-local timing state. After restart, an attempt that
 * may have been broadcast waits the initial delay and starts a new backoff.
 */
export class BroadcastRetrySchedule {
  private attemptId: string | undefined;
  private dueAt = 0;
  private nextDelayMs: number;
  private lastNow = 0;

  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;

  constructor(options: BroadcastRetryScheduleOptions) {
    const {
      initialDelayMs,
      maxDelayMs,
    } = options;

    if (
      !Number.isSafeInteger(initialDelayMs) ||
      initialDelayMs <= 0 ||
      !Number.isSafeInteger(maxDelayMs) ||
      maxDelayMs < initialDelayMs ||
      maxDelayMs > MAX_DELAY_MS
    ) {
      throw new RangeError('Invalid broadcast retry delays.');
    }

    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.nextDelayMs = initialDelayMs;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Tracks the current journal attempt. Repeated observations preserve
   * its schedule. Null clears it after the journal no longer has an attempt.
   */
  track(
    attempt: Pick<JournalAttempt, 'attemptId' | 'phase'> | null,
  ): void {
    if (attempt === null) {
      this.attemptId = undefined;
      this.dueAt = 0;
      this.nextDelayMs = this.initialDelayMs;
      return;
    }

    const {
      attemptId,
      phase,
    } = attempt;

    if (
      !isUuidV4(attemptId) ||
      (
        phase !== 'signed' &&
        phase !== 'broadcast-may-have-occurred'
      )
    ) {
      throw new TypeError('Invalid broadcast retry attempt.');
    }

    if (attemptId === this.attemptId) {
      return;
    }

    const now = this.readNow();
    let dueAt = now;

    if (phase === 'broadcast-may-have-occurred') {
      dueAt += this.initialDelayMs;
    }

    this.attemptId = attemptId;
    this.dueAt = dueAt;
    this.nextDelayMs = this.initialDelayMs;
  }

  /**
   * Milliseconds until a send is due, or null when no attempt is tracked.
   */
  get delayMs(): number | null {
    if (this.attemptId === undefined) {
      return null;
    }

    return Math.max(
      0,
      Math.ceil(this.dueAt - this.readNow()),
    );
  }

  /**
   * Reserves one due send for the matching attempt and schedules the next
   * opportunity. This controls timing only. The coordinator decides
   * whether broadcasting is allowed by the journal and recovery state.
   */
  claim(attemptId: string): boolean {
    if (
      this.attemptId === undefined ||
      attemptId !== this.attemptId
    ) {
      return false;
    }

    const now = this.readNow();
    if (now < this.dueAt) {
      return false;
    }

    this.dueAt = now + this.nextDelayMs;

    this.nextDelayMs = Math.min(
      this.maxDelayMs,
      this.nextDelayMs * 2,
    );

    return true;
  }

  private readNow(): number {
    let value: number;

    try {
      value = this.now();
    } catch {
      throw new Error('Could not read the broadcast retry clock.');
    }

    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - this.maxDelayMs
    ) {
      throw new RangeError('Invalid broadcast retry clock.');
    }

    this.lastNow = Math.max(this.lastNow, value);

    return this.lastNow;
  }
}