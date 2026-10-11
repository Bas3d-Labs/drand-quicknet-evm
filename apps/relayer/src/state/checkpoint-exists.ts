import {
  lstat,
} from 'node:fs/promises';

/**
 * Checks for prior checkpoint state without opening, repairing, or
 * creating the checkpoint store.
 * 
 * Call while holding the service lock, before checkpoint initialization.
 * Any existing entry counts as prior state, including a dangling symlink.
 * Only ENOENT establishes absense. Other filesystem errors propogate.
 */
export async function checkpointExists(
  filePath: string,
): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }

    throw error;
  }
}