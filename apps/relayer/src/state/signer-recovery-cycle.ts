import type {
  BlockAnchor,
} from '../chain/block-anchor.js';

import type {
  SignerInclusionInspection,
} from '../chain/inspect-signer-inclusions.js';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  BroadcastRetrySchedule,
} from './broadcast-retry-schedule.js';

import type {
  DurableRecoverySchedule,
} from './durable-recovery-schedule.js';

import {
  isDurableRecoveryComplete,
} from './is-durable-recovery-complete.js';

import type {
  SignerCoordinator,
  BroadcastAttemptResult,
  RecoverSignerOptions,
  SignerRecoveryResult,
} from './signer-coordinator.js';

export interface SignerRecoveryCycleOptions {
  readonly coordinator: SignerCoordinator;
  readonly schedule: BroadcastRetrySchedule;
  readonly durableSchedule?: DurableRecoverySchedule;
}

export interface RunSignerRecoveryCycleOptions
  extends RecoverSignerOptions {
  /**
   * Current head for retained-attempt inclusion checks.
   * anchor remains the durable recovery anchor.
   */
  readonly head?: Readonly<BlockAnchor>;
  readonly signal?: AbortSignal;
}

export interface SignerRecoveryCycleResult {
  /**
   * Final durable recovery result, or an explicit indication that
   * an eligible completed pass was reused.
   */
  readonly inspection:
    | SignerRecoveryResult
    | {
        readonly status: 'skipped';
        readonly reason: 'unchanged-durable-state';
      };
  readonly broadcast: BroadcastAttemptResult | null;
  readonly inclusions: SignerInclusionInspection | null;

  /** Timing only. A due retry still requires coordinator authorization */
  readonly retryDelayMs: number | null;
}

/**
 * Advances one signer's recovery and, when eligible and due, sends its
 * recorded transaction once. Reuse one instance across daemon cycles to
 * preserve backoff.
 */
export class SignerRecoveryCycle {
  private readonly coordinator: SignerCoordinator;
  private readonly schedule: BroadcastRetrySchedule;
  private readonly durableSchedule:
    DurableRecoverySchedule | undefined;

  private busy = false;
  private completedDurableRevision: string | undefined;

  constructor(options: SignerRecoveryCycleOptions) {
    this.coordinator = options.coordinator;
    this.schedule = options.schedule;
    this.durableSchedule = options.durableSchedule;
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

      const head = options.head === undefined
        ? undefined
        : Object.freeze({
          blockNumber: options.head.blockNumber,
          blockHash: options.head.blockHash,
        });

      const recovery: RecoverSignerOptions = {
        publicClient: options.publicClient,
        anchor: {
          blockNumber: options.anchor.blockNumber,
          blockHash: options.anchor.blockHash,
        },
        maxBlockRange: options.maxBlockRange,
      };

      if (
        head !== undefined &&
        (
          typeof head.blockNumber !== 'bigint' ||
          head.blockNumber < 0n ||
          head.blockNumber >= (1n << 256n) ||
          !isFixedHex(head.blockHash, 32) ||
          head.blockNumber < recovery.anchor.blockNumber ||
          (
            head.blockNumber === recovery.anchor.blockNumber &&
            head.blockHash.toLowerCase() !==
              recovery.anchor.blockHash.toLowerCase()
          )
        )
      ) {
        throw new TypeError('Invalid signer recovery head.');
      }

      signal?.throwIfAborted();

      this.schedule.track(this.retryAttempt);

      if (this.coordinator.status.persistenceState === 'failed') {
        await this.coordinator.retryPersistence(cycle);

        this.schedule.track(this.retryAttempt);
      }

      signal?.throwIfAborted();

      const status = this.coordinator.status;
      const durableSchedule = this.durableSchedule;

      const canReuseDurablePass =
        durableSchedule !== undefined &&
        head !== undefined &&
        status.recoveryComplete &&
        status.inclusionChecksComplete &&
        status.persistenceState === 'idle' &&
        !status.blockers.includes('unattributed-signer-activity') &&
        !status.blockers.includes('conflict-search-exhausted') &&
        this.completedDurableRevision ===
          this.coordinator.durableRecoveryRevision &&
        !durableSchedule.isDue(recovery.anchor);

      let inspection: SignerRecoveryCycleResult['inspection'];

      if (canReuseDurablePass) {
        inspection = {
          status: 'skipped',
          reason: 'unchanged-durable-state',
        };
      } else {
        // Once a new pass starts, an earlier completion must not survive
        // an incomplete result or a failed operation.
        this.invalidateDurableRecovery();

        // Bound work by the queue captured after any persistence retry.
        // A missing or empty journal still needs one recovery pass.
        const maxRecoveryPasses = Math.max(
          1,
          this.coordinator.attempts.length,
        );

        let result = await this.coordinator.recover(
          recovery,
          cycle,
        );

        for (
          let pass = 1;
          pass < maxRecoveryPasses &&
          result.status === 'resolution-available' &&
          this.coordinator.attempts.length > 0;
          pass += 1
        ) {
          signal?.throwIfAborted();

          result = await this.coordinator.recover(
            recovery,
            cycle,
          );
        }

        inspection = result;

        const completedStatus = this.coordinator.status;

        if (
          durableSchedule !== undefined &&
          isDurableRecoveryComplete(result, {
            recoveryComplete: completedStatus.recoveryComplete,
            persistenceState: completedStatus.persistenceState,
            attempts: this.coordinator.attempts,
          })
        ) {
          durableSchedule.recordCompleted(recovery.anchor);

          this.completedDurableRevision =
            this.coordinator.durableRecoveryRevision;
        }
      }

      signal?.throwIfAborted();

      let inclusions: SignerInclusionInspection | null = null;

      if (
        this.coordinator.status.recoveryComplete &&
        (
          head !== undefined ||
          this.coordinator.attempts.length === 0
        )
      ) {
        inclusions = await this.coordinator.checkInclusions({
          publicClient: recovery.publicClient,
          head: head ?? recovery.anchor,
          ...(head === undefined
            ? {}
            : { maxReplacementBlockRange: recovery.maxBlockRange }),
        }, cycle);
      }

      if (
        inclusions === null ||
        inclusions.status !== 'inspected' ||
        !inclusions.inclusionChecksComplete
      ) {
        this.invalidateDurableRecovery();
      }

      // Inclusion inspection may change which attempt needs a retry.
      const attempt = this.retryAttempt;

      this.schedule.track(attempt);

      signal?.throwIfAborted();

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
        inclusions,
        broadcast,
        retryDelayMs: this.schedule.delayMs,
      });
    } catch (error) {
      this.invalidateDurableRecovery();
      throw error;
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

  private invalidateDurableRecovery(): void {
    this.completedDurableRevision = undefined;
    this.durableSchedule?.invalidate();
  }
}