import {
  lstat,
  readdir,
} from 'node:fs/promises';

import {
  join,
} from 'node:path';

import {
  priorSignerStateError,
} from '../diagnostics/signer-journal-errors.js';

import {
  LOCK_FILENAME,
  ServiceLockNotHeldError,
  type VerifiedServiceLock,
} from './service-lock.js';

/**
 * Checks first-use eligibility before the journal store can clean up
 * temporary files.
 * 
 * Call once during startup while holding verified service ownership.
 * Existing journal entries are left to the journal store to validate.
 * Trusted, stable state-directory ancestors remain a requirement.
 */
export async function assertSignerBootstrapState(
  journalFile: string,
  ownership: VerifiedServiceLock,
): Promise<void> {
  try {
    await lstat(journalFile);
    return;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const names = await readdir(ownership.stateDirectory);

  // Validate ownership before classifying other entries as prior state.
  if (!names.includes(LOCK_FILENAME)) {
    throw new ServiceLockNotHeldError('lock-file');
  }

  const lock = await lstat(
    join(ownership.stateDirectory, LOCK_FILENAME),
    { bigint: true },
  ).catch(() => {
    throw new ServiceLockNotHeldError('lock-file');
  });

  if (!lock.isFile() || lock.nlink !== 1n) {
    throw new ServiceLockNotHeldError('lock-file');
  }

  if (
    lock.dev !== ownership.dev ||
    lock.ino !== ownership.ino
  ) {
    throw new ServiceLockNotHeldError('descriptor');
  }

  if (names.some((name) => name !== LOCK_FILENAME)) {
    throw priorSignerStateError();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
  );
}