import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

export interface DurableRecoveryScheduleOptions {
  readonly refreshIntervalMs: number;

  /** Monotonic time in milliseconds. */
  readonly now: () => number;
}

/**
 * Schedules durable recovery by anchor changes and elapsed time.
 */
export class DurableRecoverySchedule {
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;

  private completed:
    | {
        readonly anchor: Readonly<BlockAnchor>;
        readonly at: number;
      }
    | undefined;

  constructor(
    options: DurableRecoveryScheduleOptions,
  ) {
    if (
      !Number.isSafeInteger(options.refreshIntervalMs) ||
      options.refreshIntervalMs <= 0
    ) {
      throw new TypeError('Invalid durable recovery refresh interval.');
    }

    this.refreshIntervalMs = options.refreshIntervalMs;
    this.now = options.now;
  }

  isDue(
    anchor: Readonly<BlockAnchor>,
  ): boolean {
    const completed = this.completed;
    if (completed === undefined) {
      return true;
    }

    if (
      anchor.blockNumber !== completed.anchor.blockNumber ||
      anchor.blockHash.toLowerCase() !== 
        completed.anchor.blockHash.toLowerCase()
    ) {
      return true;
    }

    const elapsed = this.now() - completed.at;

    // An unusable clock must not suppress recovery.
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      return true;
    }

    return elapsed >= this.refreshIntervalMs;
  }

  /**
   * Records completion for the journal state evaluted by the caller.
   */
  recordCompleted(
    anchor: Readonly<BlockAnchor>,
  ): void {
    const at = this.now();

    if (!Number.isFinite(at)) {
      this.invalidate();
      return;
    }

    this.completed = {
      anchor: Object.freeze({
        blockNumber: anchor.blockNumber,
        blockHash: anchor.blockHash,
      }),
      at,
    };
  }

  invalidate(): void {
    this.completed = undefined;
  }
}