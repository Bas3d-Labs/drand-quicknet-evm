import type {
  Address,
} from 'viem';

import {
  classifySchedulerBlockers,
} from './classify-scheduler-blockers.js';

import type {
  DaemonWorkDeadlines,
} from './daemon-work-executor.js';

import {
  DaemonWorkObligations,
  type WorkCapture,
  type WorkObligation,
} from './daemon-work-obligations.js';

import type {
  DispatchObservation,
  WaitTransition,
  WaitingEntry,
} from './future-round-scheduler.js';

export interface SchedulingState {
  readonly open: boolean;
  readonly blockers: readonly string[];
  readonly retainedCount: number;
}

/** One owner of obligations. No execution, clocks, timers or provider calls. */
export class DaemonLoopSchedule {
  private readonly owner: DaemonWorkObligations;
  private periodic: WorkObligation;
  private discoveryRoundAt: number;
  private readonly discovery = new Map<Address, WorkObligation>();
  private readonly durable = new Map<Address, WorkObligation>();
  private readonly durableAtStart = new Set<string>();
  private readonly releases = new Map<string, {
    entry: WaitingEntry;
    obligation: WorkObligation;
  }>();

  constructor(
    private readonly pollIntervalMs: number,
    startedAt: number,
  ) {
    // 3b deliberately retains the ordinary poll cadence for both populations.
    this.owner = new DaemonWorkObligations(pollIntervalMs, {
      idleIntervalMs: pollIntervalMs,
      retainedIntervalMs: pollIntervalMs,
    });

    this.periodic = this.owner.observe('periodic', 'inspection', startedAt);

    this.discoveryRoundAt = startedAt;
  }

  transition(
    event: WaitTransition,
  ): void {
    if (event.kind === 'started') {
      this.releases.set(event.entry.workId, {
        entry: event.entry,
        obligation: this.owner.observe(event.entry.workId, 'release', 0),
      });

      return;
    }

    const previous = this.releases.get(event.entry.workId);

    if (previous !== undefined) {
      this.owner.complete(previous.obligation);

      this.releases.delete(event.entry.workId);
    }
  }

  deadlines(
    now: number,
    wall: number,
    state: SchedulingState,
  ): DaemonWorkDeadlines {
    let full = this.deadline(this.periodic);

    for (const reference of this.durable.values()) {
      full = this.earlier(full, this.deadline(reference));
    }

    if (this.permitsReleaseWake(state)) {
      for (const { entry, obligation } of this.releases.values()) {
        const deadline = this.deadline(obligation);

        if (deadline === null) {
          continue;
        }

        const remaining = entry.releaseTime * 1000n - BigInt(wall);

        let releaseAt = now;

        if (remaining > 0n) {
          // Far-future rounds only need another wall-clock check after poll.
          const bounded = remaining < BigInt(this.pollIntervalMs)
            ? remaining
            : BigInt(this.pollIntervalMs);

          releaseAt += Number(bounded);
        }

        full = this.earlier(full, Math.max(deadline, releaseAt));
      }
    }

    return {
      full,
      discovery: this.earlier(
        this.discoveryRoundAt,
        this.owner.nextDeadline('discovery'),
      ),
    };
  }

  captureFull(
    now: number,
    wall: number,
  ): WorkCapture {
    this.durableAtStart.clear();

    for (const reference of this.durable.values()) {
      this.durableAtStart.add(reference.identity);
    }

    const capture = this.owner.capture('full', now);

    return {
      ...capture,
      obligations: capture.obligations.filter((reference) => {
        const release = this.releases.get(reference.identity);

        return release === undefined || release.entry.releaseTime * 1000n <= BigInt(wall);
      }),
    };
  }

  discoveryDue(
    consumer: Address,
    now: number,
  ): boolean {
    const reference = this.discovery.get(consumer);

    if (reference === undefined) {
      return this.discoveryRoundAt <= now;
    }

    const deadline = this.deadline(reference);

    // Individual entries exist only for continuation or failed-work retry.
    // Ordinary rounds include every consumer whose retry is eligible.
    return deadline !== null && deadline <= now;
  }

  discoveryFinished(
    consumer: Address,
    completedAt: number,
    capped: boolean,
  ): void {
    const previous = this.discovery.get(consumer);

    if (previous !== undefined) {
      this.owner.complete(previous);

      this.discovery.delete(consumer);
    }

    if (capped) {
      // No remembered soft target: this pass stopped short of its own head.
      this.discovery.set(consumer, this.owner.observe(
        `discovery:${consumer}`,
        'discovery',
        completedAt,
      ));
    }
  }

  discoveryFailed(
    consumer: Address,
    startedAt: number,
    completedAt: number,
  ): void {
    const reference = this.discovery.get(consumer) ?? this.owner.observe(
      `discovery:${consumer}`,
      'discovery',
      startedAt,
    );

    this.discovery.set(consumer, reference);

    this.owner.fail({
      kind: 'discovery',
      startedAt,
      obligations: [reference],
    }, completedAt, {
      retainedCount: 0,
      releasedBehindRecoveryClearableBlockers: false,
    });
  }

  discoveryPassFinished(
    startedAt: number,
    completedAt: number,
  ): void {
    if (this.discoveryRoundAt <= startedAt) {
      // All healthy consumers share this completion-relative ordinary clock.
      // A continuation/retry between ordinary rounds does not postpone it.
      this.discoveryRoundAt = completedAt + this.pollIntervalMs;
    }
  }

  durableTarget(
    consumer: Address,
    nextBlock: bigint,
    head: bigint,
    now: number,
  ): bigint {
    let reference = this.durable.get(consumer);

    if (reference !== undefined && this.owner.scanNextBlock(reference) !== nextBlock) {
      reference = this.owner.replaceScan(reference, 'checkpoint-reload', nextBlock, now);

      if (reference === undefined) {
        this.durable.delete(consumer);
      } else {
        this.durable.set(consumer, reference);
      }
    }

    // A lower head is availability only, not permission to clear a continuation.
    if (nextBlock <= head) {
      reference = this.owner.observeScan(
        `durable:${consumer}`,
        'durable-continuation',
        nextBlock,
        head,
        now,
      );

      this.durable.set(consumer, reference);
    }

    return reference === undefined ? head : this.owner.scanTarget(reference)!;
  }

  durableFinished(
    consumer: Address,
    nextBlock: bigint,
    now: number,
  ): void {
    const reference = this.durable.get(consumer);

    if (reference === undefined) {
      return;
    }

    const previous = this.owner.scanNextBlock(reference)!;

    if (nextBlock <= previous) {
      // No progress cannot create an immediate continuation. Existing obligations
      // are delayed only by fullFinished's captured, eligible set.
      this.durableFailed(consumer);
      return;
    }

    const next = this.owner.scanProgress(reference, nextBlock, now);

    if (next === undefined) {
      this.durable.delete(consumer);
    } else {
      this.durable.set(consumer, next);
    }
  }

  fullFinished(
    capture: WorkCapture,
    completedAt: number,
    state: SchedulingState,
    dispatch: ReadonlyMap<string, DispatchObservation>,
    recoveryFailed: boolean,
  ): void {
    const clearable = classifySchedulerBlockers(state.blockers).recoveryClearableOnly;

    for (const reference of capture.obligations) {
      if (this.owner.get(reference) === undefined) {
        continue;
      }

      const release = this.releases.get(reference.identity);

      if (release !== undefined) {
        const fact = dispatch.get(reference.identity);

        if (fact?.disposition === 'remainder' || fact?.disposition === 'clock-deferred') {
          continue;
        }

        if (!recoveryFailed && state.open) {
          // Includes explicit waiting/failure and entries never attempted behind them.
          this.owner.waiting(reference, completedAt);

          continue;
        }
      }

      this.owner.fail({ ...capture, obligations: [reference] }, completedAt, {
        retainedCount: state.retainedCount,
        releasedBehindRecoveryClearableBlockers: release !== undefined && clearable,
      });
    }

    const periodicWasCaptured = capture.obligations.some((reference) => (
      reference.identity === this.periodic.identity &&
      reference.generation === this.periodic.generation
    ));

    if (!recoveryFailed || periodicWasCaptured) {
      this.owner.complete(this.periodic);
      this.periodic = this.owner.observe(
        'periodic',
        'inspection',
        completedAt + this.pollIntervalMs,
      );
    }
  }

  durableFailed(
    consumer: Address,
  ): void {
    const reference = this.durable.get(consumer);

    if (reference !== undefined && !this.durableAtStart.has(reference.identity)) {
      // A first scan that made no progress earns no continuation. The ordinary
      // full-work deadline retries it. Existing backoff belongs to the capture.
      this.owner.complete(reference);

      this.durable.delete(consumer);
    }
  }

  private permitsReleaseWake(
    state: SchedulingState,
  ): boolean {
    return state.open || classifySchedulerBlockers(state.blockers).recoveryClearableOnly;
  }

  private deadline(
    reference: WorkObligation,
  ): number | null {
    const current = this.owner.get(reference);

    if (current === undefined) {
      return null;
    }

    return Math.max(current.dueAt, current.eligibleAt);
  }

  private earlier(
    first: number | null,
    second: number | null,
  ): number | null {
    if (first === null) {
      return second;
    }

    if (second === null) {
      return first;
    }

    return Math.min(first, second);
  }
}
