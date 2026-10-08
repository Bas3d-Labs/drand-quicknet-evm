import type {
  SignerRecoveryInspection,
} from '../chain/inspect-signer-recovery.js';

import type {
  BroadcastRetrySchedule,
} from './broadcast-retry-schedule.js';

import type {
  SignerCoordinator,
  BroadcastAttemptResult,
  RecoverSignerOptions,
} from './signer-coordinator.js';

export interface SignerRecoveryCycleOptions {
  readonly coordinator: SignerCoordinator;
  readonly schedule: BroadcastRetrySchedule;
}

export interface RunSignerRecoveryCycleOptions
  extends RecoverSignerOptions {
  readonly signal?: AbortSignal;
}

export interface SignerRecoveryCycleResult {
  readonly inspection: SignerRecoveryInspection;
  readonly broadcast: BroadcastAttemptResult | null;

  /** Timing only. A due retry still requires coordinator authorization */
  readonly retryDelayMs: number | null;
}

/**
 * Advances one signer's recovery and, when eligible and due, sends its
 * recorded transaction once. Reuse one instance across daemon cycles to
 * preserve backoff.
 */
export class SignerRecoveryCycle {
  private busy = false;

  private readonly coordinator: SignerCoordinator;
  private readonly schedule: BroadcastRetrySchedule;

  constructor(options: SignerRecoveryCycleOptions) {
    this.coordinator = options.coordinator;
    this.schedule = options.schedule;
  }

  /**
   * Retries pending persistence before inspecting chain state. Cancellation
   * is checked between operations. It does not interrupt an in-flight RPC
   * or journal write.
   */
  async run(
    options: RunSignerRecoveryCycleOptions,
    cycle?: number,
  ): Promise<SignerRecoveryCycleResult> {
    if (this.busy) {
      throw new Error('Signer recovery cycle is already in progress.');
    }

    this.busy = true;

    try {
      const signal = options.signal;

      let recovery: RecoverSignerOptions = {
        publicClient: options.publicClient,
        anchor: {
          blockNumber: options.anchor.blockNumber,
          blockHash: options.anchor.blockHash,
        },
        maxBlockRange: options.maxBlockRange,
      };

      if (options.bootstrap !== undefined) {
        recovery = {
          ...recovery,
          bootstrap: {
            expectedNonce: options.bootstrap.expectedNonce,
            confirmNoUntrackedTransactions:
              options.bootstrap.confirmNoUntrackedTransactions,
          },
        };
      }

      signal?.throwIfAborted();

      this.schedule.track(this.retryAttempt);

      if (this.coordinator.status.persistenceState === 'failed') {
        await this.coordinator.retryPersistence(cycle);

        this.schedule.track(this.retryAttempt);
      }

      signal?.throwIfAborted();

      const inspection = await this.coordinator.recover(
        recovery,
        cycle,
      );

      const attempt = this.retryAttempt;

      this.schedule.track(attempt);

      signal?.throwIfAborted();

      if (
        this.coordinator.status.recoveryComplete &&
        this.coordinator.attempts.length === 0
      ) {
        await this.coordinator.checkInclusions({
          publicClient: recovery.publicClient,
          head: recovery.anchor,
        }, cycle);

        signal?.throwIfAborted();
      }

      let broadcast: BroadcastAttemptResult | null = null;

      if (
        attempt !== null &&
        this.coordinator.canBroadcast &&
        this.schedule.claim(attempt.attemptId)
      ) {
        broadcast = await this.coordinator.broadcastAttempt({
          publicClient: recovery.publicClient,
          attemptId: attempt.attemptId,
        }, cycle);
      }

      return Object.freeze({
        inspection,
        broadcast,
        retryDelayMs: this.schedule.delayMs,
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Included records remain retained for durable resolution but are not
   * broadcast retry candidates.
   */
  private get retryAttempt() {
    return this.coordinator.attempts.find(
      (attempt) => attempt.phase !== 'included'
    ) ?? null;
  }
}