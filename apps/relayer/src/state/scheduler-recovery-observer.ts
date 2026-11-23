export interface SchedulerInspectionCompletion {
  /** Sampled after head selection. Single-owner execution must prevent an intervening broadcast acknowledgement. */
  readonly startedAt: number;
  readonly completedAt: number;
  readonly recoveryComplete: boolean;
  readonly inclusionChecksComplete: boolean;
  readonly persistenceIdle: boolean;
  readonly retainedCount: number;
}

/** Internal, synchronous observations. These never grant authorization. */
export interface SchedulerRecoveryObserver {
  /** Monotonic milliseconds, shared with the scheduler obligation owner. */
  readonly now: () => number;
  readonly onInspectionCompleted?: (
    fact: SchedulerInspectionCompletion,
  ) => void;
}
