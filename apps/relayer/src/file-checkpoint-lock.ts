import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  CheckpointLock,
  CheckpointLockHandle,
} from './checkpoint-lock.js';

const CHECKPOINT_LOCK_VERSION = 1;

// limit retries when a lock disappears between EEXIST and reading it
const ACQUIRE_MAX_ATTEMPTS = 5;

// retry briefly because the lock file may be visible before its contents
// have finished being written
const READ_STATE_ATTEMPTS = 3;
const READ_STATE_RETRY_DELAY_MS = 20;

export interface CheckpointLockOwner {
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

interface FileCheckpointLockState extends CheckpointLockOwner {
  version: number;
}

interface CheckpointLockState extends CheckpointLockOwner {
  version: number;
}

type CheckpointLockLiveness =
  | 'alive'
  | 'stale'
  | 'unknown-host';

export class CheckpointLockError extends Error {
  readonly lockPath: string;

  constructor(message: string, lockPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.lockPath = lockPath;
  }
}

export class CheckpointLockHeldError extends CheckpointLockError {
  readonly owner: CheckpointLockOwner;
  readonly sameHost: boolean;

  constructor(
    lockPath: string,
    owner: CheckpointLockOwner,
    sameHost: boolean,
  ) {
      super(
      sameHost
        ? `Checkpoint lock ${lockPath} is held by running process ` +
            `${owner.pid} since ${owner.acquiredAt}. Another relayer ` +
            `appears to be using this checkpoint; stop it before starting ` +
            `a new one.`
        : `Checkpoint lock ${lockPath} was acquired by process ` +
            `${owner.pid} on host ${owner.hostname} at ${owner.acquiredAt}; ` +
            `liveness cannot be verified from this host. If that relayer ` +
            `is gone, verify on ${owner.hostname} and remove the lock ` +
            `file manually.`,
      lockPath,
    );
    this.owner = owner;
    this.sameHost = sameHost;
  }
}

export class CheckpointLockStaleError extends CheckpointLockError {
  readonly owner: CheckpointLockOwner;
  
  constructor(lockPath: string, owner: CheckpointLockOwner) {
    super(
      `Checkpoint lock ${lockPath} is stale: owning process ${owner.pid} ` +
        `on this host is no longer running (acquired ${owner.acquiredAt}). ` +
        `Verify no relayer is using this checkpoint, then remove the lock ` +
        `file manually.`,
      lockPath,
    );
    this.owner = owner;
  }
}

export class CheckpointLockUnvalidatableError extends CheckpointLockError {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(
      `Checkpoint lock ${lockPath} exists but its contents could not be ` +
        `validated; it may be left over from a crash during lock ` +
        `publication. Verify no relayer is running, then remove the lock ` +
        `file manually.`,
      lockPath,
      options,
    );
  }
}

export interface FileCheckpointLockOptions {
  checkpointFile: string;
}

/**
 * Local-filesystem, single-host lock for a checkpoint file.
 *
 * PID and hostname are used only for diagnostics and same-host stale
 * detection. Shared/network filesystems and distributed coordination are
 * intentionally unsupported.
 *
 * Stale locks are never removed automatically.
 *
 * Invariant: normal code must never remove or replace a lock it did not
 * acquire.
 */
export class FileCheckpointLock implements CheckpointLock {
  private readonly lockPath: string;

  constructor(options: FileCheckpointLockOptions) {
    if (options.checkpointFile.length === 0) {
      throw new Error('Checkpoint file path must not be empty.');
    }

    // Match FileCheckpointStore's path validation.
    this.lockPath = `${options.checkpointFile}.lock`;
  }

  async acquire(): Promise<CheckpointLockHandle> {
    const ownerId = randomUUID();
    const state: FileCheckpointLockState = {
      version: CHECKPOINT_LOCK_VERSION,
      ownerId,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };

    try {
      await mkdir(dirname(this.lockPath), { recursive: true });
    } catch (cause) {
      throw new CheckpointLockError(
        `Failed to create directory for checkpoint lock ${this.lockPath}.`,
        this.lockPath,
        { cause },
      );
    }

    for (let attempt = 1; attempt <= ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.createLock(state);
        return this.createHandle(ownerId);
      } catch (cause) {
        if (!isNodeError(cause) || cause.code !== 'EEXIST') {
          throw new CheckpointLockError(
            `Failed to acquire checkpoint lock ${this.lockPath}.`,
            this.lockPath,
            { cause },
          );
        }
      }

      let existing: FileCheckpointLockState;
      try {
        existing = await this.readLockStateWithRetry();
      } catch (cause) {
        // The holder released after our failed exclusive create. Retry.
        if (isNodeError(cause) && cause.code === 'ENOENT') {
          continue;
        }

        throw new CheckpointLockUnvalidatableError(
          this.lockPath,
          { cause },
        );
      }

      throw this.classifyExistingLock(existing);
    }

    throw new CheckpointLockError(
      `Failed to acquire checkpoint lock ${this.lockPath}: gave up after ` +
        `${ACQUIRE_MAX_ATTEMPTS} attempts while it was concurrently ` +
        `acquired and released.`,
      this.lockPath,
    );
  }

  private createHandle(ownerId: string): CheckpointLockHandle {
    let releasing: Promise<void> | undefined;

    return {
      release: (): Promise<void> => {
        // Concurrent release calls must share one removal operation.
        releasing ??= this.releaseOwnedLock(ownerId).catch(
          (cause: unknown) => {
            releasing = undefined;
            throw cause;
          },
        );

        return releasing;
      },
    };
  }

  private async createLock(state: FileCheckpointLockState): Promise<void> {
    const handle = await open(this.lockPath, 'wx', 0o600);

    try {
      const contents = `${JSON.stringify(state, null, 2)}\n`;

      await handle.writeFile(
        contents,
        { encoding: 'utf8' },
      );

      // fsync is unnecessary because lock metadata does not need to survive
      // a machine crash.
      await handle.close();
    } catch (cause) {
      // Acquisition never completed, so clean up the published lock.
      await handle.close().catch(() => {
        // Preserve the original failure.
      });

      await rm(this.lockPath, { force: true }).catch(() => {
        // Preserve the original failure.
      });

      throw cause;
    }
  }

  private async readLockStateWithRetry(): Promise<FileCheckpointLockState> {
    let lastFailure: unknown;

    for (let attempt = 1; attempt <= READ_STATE_ATTEMPTS; attempt += 1) {
      try {
        return await readLockStateFile(this.lockPath);
      } catch (cause) {
        // Let acquire() re-race if the lock disappeared.
        if (isNodeError(cause) && cause.code === 'ENOENT') {
          throw cause;
        }

        lastFailure = cause;

        if (attempt < READ_STATE_ATTEMPTS) {
          await delay(READ_STATE_RETRY_DELAY_MS);
        }
      }
    }

    throw lastFailure;
  }

  private classifyExistingLock(
    state: FileCheckpointLockState,
  ): CheckpointLockError {
    const owner: CheckpointLockOwner = {
      ownerId: state.ownerId,
      pid: state.pid,
      hostname: state.hostname,
      acquiredAt: state.acquiredAt,
    };

    let liveness: CheckpointLockLiveness;
    try {
      liveness = classifyOwnerLiveness(owner);
    } catch (cause) {
      return new CheckpointLockError(
        `Failed to determine liveness of process ${owner.pid} holding ` +
          `checkpoint lock ${this.lockPath}.`,
        this.lockPath,
        { cause },
      );
    }

    switch (liveness) {
      case 'unknown-host':
        return new CheckpointLockHeldError(
          this.lockPath,
          owner,
          false,
        );

      case 'alive':
        return new CheckpointLockHeldError(
          this.lockPath,
          owner,
          true,
        );

      case 'stale':
        return new CheckpointLockStaleError(
          this.lockPath,
          owner,
        );
    }
  }

  /**
   * Safe while no external actor removes or replaces a live lock.
   *
   * The ownerId check cannot protect against replacement between the check
   * and rm(), so normal code must never break another owner's lock.
   */
  private async releaseOwnedLock(ownerId: string): Promise<void> {
    let state: FileCheckpointLockState;

    try {
      state = await readLockStateFile(this.lockPath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === 'ENOENT') {
        return;
      }

      throw new CheckpointLockError(
        `Failed to read checkpoint lock ${this.lockPath} while releasing it.`,
        this.lockPath,
        { cause },
      );
    }

    if (state.ownerId !== ownerId) {
      throw new CheckpointLockError(
        `Checkpoint lock ${this.lockPath} is no longer owned by this ` +
          `relayer; refusing to remove it.`,
        this.lockPath,
      );
    }

    try {
      await rm(this.lockPath);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === 'ENOENT') {
        return;
      }

      throw new CheckpointLockError(
        `Failed to release checkpoint lock ${this.lockPath}.`,
        this.lockPath,
        { cause },
      );
    }
  }
}

async function readLockStateFile(
  lockPath: string,
): Promise<FileCheckpointLockState> {
  const contents = await readFile(lockPath, 'utf8');

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new Error(
      `Checkpoint lock ${lockPath} contains invalid JSON.`,
      { cause },
    );
  }

  return parseLockState(value);
}

function classifyOwnerLiveness(
  owner: CheckpointLockOwner,
): CheckpointLockLiveness {
  // A PID on another host cannot be checked from this process.
  if (owner.hostname !== hostname()) {
    return 'unknown-host';
  }

  return isProcessAlive(owner.pid)
    ? 'alive'
    : 'stale';
}

function isNodeError(
  value: unknown,
): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    'code' in value
  );
}

function parseLockState(value: unknown): FileCheckpointLockState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Checkpoint lock state must be an object.');
  }

  const state = value as Record<string, unknown>;

  if (state.version !== CHECKPOINT_LOCK_VERSION) {
    throw new Error(
      `Unsupported checkpoint lock version: ${String(state.version)}.`,
    );
  }

  if (
    typeof state.ownerId !== 'string' ||
    state.ownerId.length === 0
  ) {
    throw new Error('Checkpoint lock contains an invalid ownerId.');
  }

  if (
    typeof state.pid !== 'number' ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0
  ) {
    throw new Error('Checkpoint lock contains an invalid pid.');
  }

  if (
    typeof state.hostname !== 'string' ||
    state.hostname.length === 0
  ) {
    throw new Error('Checkpoint lock contains an invalid hostname.');
  }

  if (
    typeof state.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(state.acquiredAt))
  ) {
    throw new Error('Checkpoint lock contains an invalid acquiredAt.');
  }

  return {
    version: CHECKPOINT_LOCK_VERSION,
    ownerId: state.ownerId,
    pid: state.pid,
    hostname: state.hostname,
    acquiredAt: state.acquiredAt,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (!isNodeError(cause)) {
      throw cause;
    }

    if (cause.code === 'ESRCH') {
      return false;
    }

    if (cause.code === 'EPERM') {
      return true;
    }

    throw new Error(
      `Failed to determine whether checkpoint lock process ${pid} is alive.`,
      { cause },
    );
  }
}