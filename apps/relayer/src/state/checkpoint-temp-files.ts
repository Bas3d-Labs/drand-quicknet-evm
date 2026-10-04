import {
  lstat,
  readdir,
  unlink,
} from 'node:fs/promises';

import {
  basename,
  dirname,
  join,
} from 'node:path';

import {
  isUuidV4
} from '../shared/uuid.js';

// Requires exclusive service ownership and a trusted state directory.
// Call during initialization, before any checkpoint writes begin.
export async function removeCheckpointTempFiles(
  checkpointFile: string,
): Promise<void> {
  const directory = dirname(checkpointFile);
  const checkpointName = basename(checkpointFile);

  for (const name of await readdir(directory)) {
    if (!isCheckpointTempName(name, checkpointName)) {
      continue;
    }

    const candidate = join(directory, name);

    try {
      const file = await lstat(candidate);
      if (!file.isFile() || file.nlink !== 1) {
        continue;
      }

      // Never recurse or follow a candidate symlink.
      await unlink(candidate);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
}

function isCheckpointTempName(
  name: string,
  checkpointName: string,
): boolean {
  const parts = name.split('.');
  if (parts.pop() !== 'tmp') {
    return false;
  }

  const uuid = parts.pop();
  const pid = parts.pop();

  if (parts.join('.') !== checkpointName) {
    return false;
  }

  return isProcessId(pid) && isUuidV4(uuid);
}

function isProcessId(
  value: string | undefined,
): boolean {
  if (
    value === undefined ||
    value.length === 0 ||
    value[0] === '0'
  ) {
    return false;
  }

  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }

  return Number.isSafeInteger(Number(value));
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
}