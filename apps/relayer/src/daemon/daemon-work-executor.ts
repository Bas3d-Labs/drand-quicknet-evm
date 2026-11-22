export type DaemonWorkKind = 'full' | 'discovery';

export interface DaemonWorkDeadlines {
  readonly full: number | null;
  readonly discovery: number | null;
}

export interface ExecutedDaemonWork<T> {
  readonly kind: DaemonWorkKind;
  readonly value: T;
}

/**
 * Holds due work for one serial owner. Replacing deadlines never executes work.
 * Deadlines are monotonic milliseconds supplied by the caller, not wall time.
 */
export class DaemonWorkExecutor {
  private readonly deadlines = new Map<DaemonWorkKind, number>();
  private running = false;
  private lastStarted: DaemonWorkKind | undefined;

  /** Replace the owner's entire projection between executions. */
  replace(
    deadlines: DaemonWorkDeadlines,
  ): void {
    if (this.running) {
      throw new Error('Daemon work is already running.');
    }

    const { full, discovery } = deadlines;

    // Validate both before mutating either pending kind.
    if (full !== null) {
      this.validateTime(full);
    }

    if (discovery !== null) {
      this.validateTime(discovery);
    }

    this.deadlines.clear();

    if (full !== null) {
      this.deadlines.set('full', full);
    }

    if (discovery !== null) {
      this.deadlines.set('discovery', discovery);
    }

    // lastStarted survives replacement, including an empty projection.
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

    // Consume before awaiting. The owner applies observations and replaces
    // the projection only after execution has completed.
    this.deadlines.delete(kind);
    this.running = true;
    this.lastStarted = kind;

    try {
      const value = await action(kind);

      return { kind, value };
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
