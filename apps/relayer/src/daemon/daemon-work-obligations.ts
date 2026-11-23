import type {
  DaemonWorkKind,
} from './daemon-work-executor.js';

const INSPECTION_RETRY_INTERVAL_MS = 15_000;
const DURABLE_SCAN_RETRY_INTERVAL_MS = 15_000;
const RELEASED_WORK_RETRY_INTERVAL_MS = 15_000;
const WAITING_RETRY_CAP_MS = 15_000;

export interface DaemonInspectionCadence {
  readonly idleIntervalMs: number;
  readonly retainedIntervalMs: number;
}

export type DaemonWorkReason =
  | 'inspection'
  | 'release'
  | 'blocked-work'
  | 'durable-continuation'
  | 'soft-continuation'
  | 'discovery';

export interface ObligationReference {
  readonly identity: string;
  readonly generation: number;
}

export interface WorkObligation extends ObligationReference {
  readonly reason: DaemonWorkReason;
  readonly kind: DaemonWorkKind;
  readonly dueAt: number;
  readonly eligibleAt: number;
}

export interface WorkCapture {
  readonly kind: DaemonWorkKind;
  readonly startedAt: number;
  readonly obligations: readonly ObligationReference[];
}

export interface CompletedInspection {
  readonly completedAt: number;
  readonly recoveryComplete: boolean;
  readonly inclusionChecksComplete: boolean;
  readonly persistenceIdle: boolean;
  readonly retainedCount: number;
}

function assertTime(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('Invalid obligation time.');
  }
}

function assertPopulation(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid retained count.');
  }
}

function kindFor(reason: DaemonWorkReason): DaemonWorkKind {
  if (reason === 'discovery' || reason === 'soft-continuation') {
    return 'discovery';
  }

  return 'full';
}

/** In-memory bookkeeping only. No clocks, timers, RPCs or execution. */
export class DaemonWorkObligations {
  private readonly pending = new Map<string, WorkObligation>();

  private generation = 0;

  private readonly scans = new Map<string, {
    target: bigint;
    latestTarget: bigint;
    nextBlock: bigint;
  }>();

  private readonly cadence: DaemonInspectionCadence;

  constructor(
    private readonly pollIntervalMs: number,
    cadence: DaemonInspectionCadence,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError('Invalid obligation poll interval.');
    }

    const { idleIntervalMs, retainedIntervalMs } = cadence;

    if (
      !Number.isSafeInteger(idleIntervalMs) ||
      idleIntervalMs <= 0 ||
      !Number.isSafeInteger(retainedIntervalMs) ||
      retainedIntervalMs <= 0
    ) {
      throw new TypeError('Invalid obligation inspection cadence.');
    }

    this.cadence = Object.freeze({ idleIntervalMs, retainedIntervalMs });
  }

  observe(
    identity: string,
    reason: DaemonWorkReason,
    dueAt: number,
  ): WorkObligation {
    assertTime(dueAt);

    if (identity.length === 0) {
      throw new TypeError('Invalid obligation identity.');
    }

    const previous = this.pending.get(identity);

    if (previous !== undefined) {
      if (previous.reason !== reason) {
        throw new TypeError('Obligation identity changed reason.');
      }

      const updated = Object.freeze({
        ...previous,
        dueAt: Math.min(previous.dueAt, dueAt),
      });

      this.pending.set(identity, updated);

      return updated;
    }

    if (this.generation === Number.MAX_SAFE_INTEGER) {
      throw new Error('Obligation generations exhausted.');
    }

    const created = Object.freeze({
      identity,
      generation: ++this.generation,
      reason,
      kind: kindFor(reason),
      dueAt,
      eligibleAt: 0,
    });

    this.pending.set(identity, created);

    return created;
  }

  get(reference: ObligationReference): WorkObligation | undefined {
    const current = this.pending.get(reference.identity);

    if (current?.generation === reference.generation) {
      return current;
    }

    return undefined;
  }

  nextDeadline(kind: DaemonWorkKind): number | null {
    let next: number | null = null;

    for (const obligation of this.pending.values()) {
      if (obligation.kind !== kind) {
        continue;
      }

      const deadline = Math.max(obligation.dueAt, obligation.eligibleAt);

      if (next === null || deadline < next) {
        next = deadline;
      }
    }

    return next;
  }

  capture(kind: DaemonWorkKind, startedAt: number): WorkCapture {
    assertTime(startedAt);

    const obligations: ObligationReference[] = [];

    for (const obligation of this.pending.values()) {
      if (
        obligation.kind === kind &&
        obligation.dueAt <= startedAt &&
        obligation.eligibleAt <= startedAt
      ) {
        obligations.push(Object.freeze({
          identity: obligation.identity,
          generation: obligation.generation,
        }));
      }
    }

    return Object.freeze({
      kind,
      startedAt,
      obligations: Object.freeze(obligations),
    });
  }

  /** Apply demonstrated completion/cancellation before failure settlement. */
  complete(reference: ObligationReference): boolean {
    if (this.get(reference) === undefined) {
      return false;
    }

    this.pending.delete(reference.identity);
    this.scans.delete(reference.identity);

    return true;
  }

  fail(
    capture: WorkCapture,
    completedAt: number,
  ): void {
    assertTime(completedAt);

    if (completedAt < capture.startedAt) {
      throw new TypeError('Failure precedes execution.');
    }

    for (const reference of capture.obligations) {
      const current = this.get(reference);

      if (current !== undefined) {
        this.delay(reference, completedAt + this.failureDelay(current));
      }
    }
  }

  /** Re-attempted work can fail before its ordinary deadline was due. */
  retry(
    reference: ObligationReference,
    completedAt: number,
  ): void {
    assertTime(completedAt);

    const current = this.get(reference);

    if (current === undefined) {
      return;
    }

    const retryAt = completedAt + this.failureDelay(current);

    assertTime(retryAt);

    this.observe(current.identity, current.reason, retryAt);
    this.delay(reference, retryAt);
  }

  /** Preserve explicit dispatch outcomes when another part of a cycle fails. */
  settle(
    capture: WorkCapture,
    completedAt: number,
    dispatch: readonly {
      readonly reference: ObligationReference;
      readonly outcome: 'completed' | 'waiting' | 'remainder';
      readonly handedOff: number;
    }[],
  ): void {
    assertTime(completedAt);

    if (completedAt < capture.startedAt) {
      throw new TypeError('Completion precedes execution.');
    }

    const seen = new Set<string>();

    for (const item of dispatch) {
      assertPopulation(item.handedOff);

      if (seen.has(item.reference.identity)) {
        throw new TypeError('Duplicate dispatch outcome.');
      }

      seen.add(item.reference.identity);

      const current = this.get(item.reference);

      if (
        current !== undefined &&
        current.reason !== 'release' &&
        current.reason !== 'blocked-work'
      ) {
        throw new TypeError('Invalid dispatch obligation.');
      }

      if (item.outcome === 'remainder' && item.handedOff === 0) {
        throw new TypeError('Dispatch continuation requires progress.');
      }
    }

    for (const item of dispatch) {
      this.dispatchOutcome(item.reference, item.outcome, item.handedOff, completedAt);
    }

    const obligations = capture.obligations.filter((reference) => {
      const hasOutcome = dispatch.some((item) => (
        item.reference.identity === reference.identity &&
        item.reference.generation === reference.generation
      ));

      return !hasOutcome;
    });

    this.fail({ ...capture, obligations }, completedAt);
  }

  /** Explicit waiting outcome, not a failure or a dispatch remainder. */
  waiting(reference: ObligationReference, completedAt: number): void {
    assertTime(completedAt);

    const eligibleAt = completedAt + Math.min(
      this.pollIntervalMs,
      WAITING_RETRY_CAP_MS,
    );

    assertTime(eligibleAt);

    this.delay(reference, eligibleAt);
  }

  inspection(
    reference: ObligationReference,
    facts: CompletedInspection,
  ): WorkObligation | undefined {
    assertTime(facts.completedAt);

    assertPopulation(facts.retainedCount);

    const current = this.get(reference);

    if (current === undefined || current.reason !== 'inspection') {
      return undefined;
    }

    if (
      facts.recoveryComplete !== true ||
      facts.inclusionChecksComplete !== true ||
      facts.persistenceIdle !== true
    ) {
      return undefined;
    }

    let delay = this.cadence.idleIntervalMs;

    if (facts.retainedCount > 0) {
      delay = this.cadence.retainedIntervalMs;
    }

    const dueAt = facts.completedAt + delay;

    assertTime(dueAt);

    this.complete(reference);

    return this.observe(current.identity, current.reason, dueAt);
  }

  discoveryCompleted(
    reference: ObligationReference,
    completedAt: number,
  ): WorkObligation | undefined {
    assertTime(completedAt);

    const current = this.get(reference);

    if (current?.reason !== 'discovery') {
      return undefined;
    }

    const dueAt = completedAt + this.pollIntervalMs;

    assertTime(dueAt);

    this.complete(reference);

    return this.observe(current.identity, current.reason, dueAt);
  }

  observeScan(
    identity: string,
    reason: 'durable-continuation' | 'soft-continuation',
    nextBlock: bigint,
    target: bigint,
    dueAt: number,
  ): WorkObligation {
    assertTime(dueAt);

    if (nextBlock < 0n || target < nextBlock) {
      throw new TypeError('Invalid scan remainder.');
    }

    const scan = this.scans.get(identity);

    if (scan !== undefined && scan.nextBlock !== nextBlock) {
      throw new TypeError('Report scan progress before observing another target.');
    }

    const obligation = this.observe(identity, reason, dueAt);

    if (scan === undefined) {
      this.scans.set(identity, { target, latestTarget: target, nextBlock });
    } else if (target > scan.latestTarget) {
      // A new head cannot replace the active target or its failure delay.
      scan.latestTarget = target;
    }

    return obligation;
  }

  scanNextBlock(reference: ObligationReference): bigint | undefined {
    if (this.get(reference) === undefined) {
      return undefined;
    }

    return this.scans.get(reference.identity)?.nextBlock;
  }

  scanTarget(reference: ObligationReference): bigint | undefined {
    if (this.get(reference) === undefined) {
      return undefined;
    }

    return this.scans.get(reference.identity)?.target;
  }

  scanProgress(
    reference: ObligationReference,
    nextBlock: bigint,
    completedAt: number,
  ): WorkObligation | undefined {
    assertTime(completedAt);

    const current = this.get(reference);
    const scan = this.scans.get(reference.identity);

    if (current === undefined || scan === undefined) {
      return undefined;
    }

    if (nextBlock <= scan.nextBlock || nextBlock > scan.target + 1n) {
      throw new TypeError('Invalid bounded scan progress.');
    }

    let target = scan.target;

    if (nextBlock > target) {
      target = scan.latestTarget;
    }

    const latestTarget = scan.latestTarget;

    this.complete(reference);

    if (nextBlock > target) {
      return undefined;
    }

    const next = this.observe(current.identity, current.reason, completedAt);

    this.scans.set(current.identity, { target, latestTarget, nextBlock });

    this.delay(next, current.eligibleAt);

    return this.get(next);
  }

  /** Replace an authoritative cursor jump, never an ordinary head refresh. */
  replaceScan(
    reference: ObligationReference,
    reason: 'soft-normalization' | 'checkpoint-reload',
    nextBlock: bigint,
    observedAt: number,
  ): WorkObligation | undefined {
    assertTime(observedAt);

    const current = this.get(reference);
    const scan = this.scans.get(reference.identity);

    if (current === undefined || scan === undefined) {
      return undefined;
    }

    if (
      nextBlock < 0n ||
      nextBlock === scan.nextBlock ||
      (
        reason === 'soft-normalization' &&
        (current.reason !== 'soft-continuation' || nextBlock < scan.nextBlock)
      ) ||
      (reason === 'checkpoint-reload' && current.reason !== 'durable-continuation') ||
      (reason !== 'soft-normalization' && reason !== 'checkpoint-reload')
    ) {
      throw new TypeError('Invalid scan cursor replacement.');
    }

    let target = scan.target;

    if (nextBlock > target) {
      target = scan.latestTarget;
    }

    // Check before retiring the old generation so a refused replacement
    // cannot lose the existing obligation.
    if (nextBlock <= target && this.generation === Number.MAX_SAFE_INTEGER) {
      throw new Error('Obligation generations exhausted.');
    }

    this.complete(reference);

    if (nextBlock > target) {
      return undefined;
    }

    const replacement = this.observe(
      current.identity,
      current.reason,
      Math.min(current.dueAt, observedAt),
    );

    this.scans.set(current.identity, {
      target,
      latestTarget: scan.latestTarget,
      nextBlock,
    });

    this.delay(replacement, current.eligibleAt);

    return this.get(replacement);
  }

  dispatchOutcome(
    reference: ObligationReference,
    outcome: 'completed' | 'waiting' | 'remainder',
    handedOff: number,
    completedAt: number,
  ): void {
    assertTime(completedAt);

    assertPopulation(handedOff);

    const current = this.get(reference);

    if (current === undefined) {
      return;
    }

    if (current.reason !== 'release' && current.reason !== 'blocked-work') {
      throw new TypeError('Invalid dispatch obligation.');
    }

    if (outcome === 'completed') {
      this.complete(reference);
    } else if (outcome === 'waiting') {
      // Even mixed-progress cycles delay explicitly waiting items.
      this.waiting(reference, completedAt);
    } else if (handedOff === 0) {
      throw new TypeError('Dispatch continuation requires progress.');
    }

    // An unattempted remainder stays due. It never clears existing backoff.
  }

  private failureDelay(obligation: WorkObligation): number {
    if (obligation.kind === 'discovery') {
      return this.pollIntervalMs;
    }

    if (obligation.reason === 'inspection') {
      return INSPECTION_RETRY_INTERVAL_MS;
    }

    if (obligation.reason === 'durable-continuation') {
      return DURABLE_SCAN_RETRY_INTERVAL_MS;
    }

    return RELEASED_WORK_RETRY_INTERVAL_MS;
  }

  private delay(reference: ObligationReference, eligibleAt: number): void {
    assertTime(eligibleAt);

    const current = this.get(reference);

    if (current === undefined) {
      return;
    }

    this.pending.set(current.identity, Object.freeze({
      ...current,
      eligibleAt: Math.max(current.eligibleAt, eligibleAt),
    }));
  }
}
