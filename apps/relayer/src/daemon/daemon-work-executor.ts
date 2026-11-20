export type DaemonWorkKind = 'full' | 'discovery';

export interface ExecutedDaemonWork<T> {
  readonly kind: DaemonWorkKind;
  readonly value: T;
}

/**
 * Holds due work for one serial owner. Requesting work never executes it.
 * Deadlines are monotonic milliseconds supplied by the caller, not wall time.
 */
export class DaemonWorkExecutor {
  private readonly deadlines = new Map<DaemonWorkKind, number>();
  private running = false;
  private lastStarted: DaemonWorkKind | undefined;

  request(
    kind: DaemonWorkKind,
    dueAt: number,
  ): void {
    this.validateTime(dueAt);

    const previous = this.deadlines.get(kind);

    if (previous === undefined || dueAt < previous) {
      this.deadlines.set(kind, dueAt);
    }
  }

  get nextDeadline(): number | null {
    let earliest: number | null = null;

    for (const deadline of this.deadlines.values()) {
      if (earliest === null || deadline < earliest) {
        earliest = deadline;
      }
    }

    return earliest;
  }

  async runNext<T>(
    now: number,
    action: (kind: DaemonWorkKind) => Promise<T>,
  ): Promise<ExecutedDaemonWork<T> | undefined> {
    this.validateTime(now);

    if (this.running) {
      throw new Error('Daemon work is already running.');
    }

    const full = this.deadlines.get('full');
    const discovery = this.deadlines.get('discovery');

    const fullDue = full !== undefined && full <= now;
    const discoveryDue = discovery !== undefined && discovery <= now;

    let kind: DaemonWorkKind;

    if (fullDue && discoveryDue) {
      // Alternate when both are overdue so neither continuation monopolizes
      // execution. The first tie favors discovery.
      kind = this.lastStarted === 'discovery' ? 'full' : 'discovery';
    } else if (fullDue) {
      kind = 'full';
    } else if (discoveryDue) {
      kind = 'discovery';
    } else {
      return undefined;
    }

    const deadline = this.deadlines.get(kind)!;

    // Consume before awaiting. A trigger arriving during the action creates
    // new pending work and cannot be erased by this action's completion.
    this.deadlines.delete(kind);
    this.running = true;
    this.lastStarted = kind;

    try {
      const value = await action(kind);

      return { kind, value };
    } catch (error) {
      // Failure is not completion. Preserve the original due work as well as
      // any earlier trigger that arrived while it was running. Retry timing
      // belongs to the owner; this class never starts a retry itself.
      this.request(kind, deadline);

      throw error;
    } finally {
      this.running = false;
    }
  }

  private validateTime(
    value: number,
  ): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('Invalid daemon work time.');
    }
  }
}
