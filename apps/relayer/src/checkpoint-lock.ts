/// Coordinates exclusive writer ownership for a checkpoint store.
///
/// A successful acquisition means the caller has exclusive writer
/// ownership until the returned handle is released.
export interface CheckpointLock {
  acquire(): Promise<CheckpointLockHandle>;
}

/// Represents ownership acquired from a CheckpointLock.
///
/// release() should be safe to call more than once.
export interface CheckpointLockHandle {
  release(): Promise<void>;
}