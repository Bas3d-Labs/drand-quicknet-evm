import {
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';

import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';

const LOCK_FILENAME = 'relayer.flock';

const REASONS = [
  'platform',
  'state-directory',
  'lock-file',
  'descriptor',
] as const;

export type ServiceLockReason = typeof REASONS[number];

export interface AssertServiceLockHeldOptions {
  env?: NodeJS.ProcessEnv;
  checkpointFile?: string;
}

const failures = new WeakMap<object, ServiceLockReason>();

export class ServiceLockNotHeldError extends Error {
  constructor(reason: ServiceLockReason) {
    if (!REASONS.includes(reason)) {
      throw new TypeError('Invalid service lock reason.');
    }

    super('Required relayer service lock was not verified.');
    this.name = 'ServiceLockNotHeldError';

    failures.set(this, reason);
  }
}

export function serviceLockReason(
  error:unknown,
): ServiceLockReason | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  return failures.get(error);
}

/// Verifies ownership inherited from the Linux service launcher.
///
/// Checks the immediate state directory's type and world-write mode.
/// Trusted, stable ancestors and a local filesystem are deployment
/// assumptions; this function does not validate them.
///
/// Never remove or replace relayer.flock while a writer may be running.
///
/// Returns the canonical state directory. Does not acquire or release
/// ownership and must not close the inherited descriptor.
export function assertServiceLockHeld(
  options: AssertServiceLockHeldOptions = {},
): string {
  if (process.platform !== 'linux') {
    throw new ServiceLockNotHeldError('platform');
  }

  const env = options.env ?? process.env;
  let reason: ServiceLockReason = 'state-directory';

  try {
    const configuredDirectory = env.QUICKNET_STATE_DIR ?? './state';
    if (configuredDirectory.trim().length === 0) {
      throw new ServiceLockNotHeldError(reason);
    }

    const stateDirectory = realpathSync(
      resolve(configuredDirectory),
    );

    const directory = statSync(stateDirectory);

    if (
      !directory.isDirectory() ||
      (directory.mode & 0o002) !== 0
    ) {
      throw new ServiceLockNotHeldError(reason);
    }

    if (options.checkpointFile !== undefined) {
      assertCheckpointPlacement(
        options.checkpointFile,
        stateDirectory,
      );
    }

    reason = 'lock-file';

    const expected = lstatSync(
      join(stateDirectory, LOCK_FILENAME),
      { bigint: true },
    );

    if (
      !expected.isFile() ||
      expected.nlink !== 1n
    ) {
      throw new ServiceLockNotHeldError(reason);
    }

    reason = 'descriptor';

    for (const name of readdirSync('/proc/self/fd')) {
      if (!isDecimalDigits(name)) {
        continue;
      }

      const fd = Number(name);
      if (!Number.isSafeInteger(fd) || fd < 0) {
        continue;
      }

      try {
        const actual = fstatSync(fd, { bigint: true });

        if (
          actual.dev !== expected.dev ||
          actual.ino !== expected.ino
        ) {
          continue;
        }

        // Open mode is not ownership evidence. The launcher uses a
        // write-only append descriptor. Identity and exclusive flock
        // metadata establish ownership.
        const info = readFileSync(
          `/proc/self/fdinfo/${fd}`,
          'utf8',
        );

        if (hasExclusiveFlock(info)) {
          // Borrow the inherited descriptor. Do not close it, wrap it
          // in a FileHandle, or pass it to children through stdio.
          return stateDirectory;
        }
      } catch {
        // An unrelated descriptor may disappear during enumeration.
      }
    }
  } catch {
    // Expose only the fixed failure stage, never paths or OS errors.
  }

  throw new ServiceLockNotHeldError(reason);
}

function assertCheckpointPlacement(
  value: string,
  stateDirectory: string,
): void {
  if (value.trim().length === 0) {
    throw new ServiceLockNotHeldError('state-directory');
  }

  const checkpointFile = resolve(value);

  // Containment alone is insufficient: overlapping state roots could
  // otherwise protect the same checkpoint with different service locks.
  if (
    realpathSync(dirname(checkpointFile)) !== stateDirectory ||
    basename(checkpointFile) === LOCK_FILENAME
  ) {
    throw new ServiceLockNotHeldError('state-directory');
  }

  try {
    const file = lstatSync(checkpointFile);
    if (!file.isFile() || file.nlink !== 1) {
      throw new ServiceLockNotHeldError('state-directory');
    }
  } catch (error) {
    // A new checkpoint may not exist yet.
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
}

function isDecimalDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }

  return true;
}

function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';

  for (const character of line) {
    if (character === ' ' || character === '\t') {
      if (current.length > 0) {
        fields.push(current);
        current = '';
      }

      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    fields.push(current);
  }

  return fields;
}

function hasExclusiveFlock(fdinfo: string): boolean {
  for (const line of fdinfo.split('\n')) {
    if (!line.startsWith('lock:')) {
      continue;
    }

    const fields = splitFields(line);

    // lock: <n>: FLOCK ADVISORY WRITE <pid> <maj:min:ino> 0 EOF
    //
    // Identity is checked separately using lstat/fstat device and inode.
    // The PID and textual device/inode fields are informational here.
    if (
      fields.length === 9 &&
      fields[0] === 'lock:' &&
      fields[2] === 'FLOCK' &&
      fields[3] === 'ADVISORY' &&
      fields[4] === 'WRITE' &&
      fields[7] === '0' &&
      fields[8] === 'EOF'
    ) {
      return true;
    }
  }

  return false;
}