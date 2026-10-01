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

type UUIDv4 = string & { readonly __brand: unique symbol };

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUuidV4(value: string | undefined): value is UUIDv4 {
  if (value === undefined || value.length !== 36) {
    return false;
  }

  return UUID_V4_REGEX.test(value);
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
}