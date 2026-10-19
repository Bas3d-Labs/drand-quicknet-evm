import {
  constants,
} from 'node:fs';

import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from 'node:fs/promises';

import {
  join,
  resolve,
} from 'node:path';

import {
  TextDecoder,
} from 'node:util';

import {
  readDaemonStatusSnapshot,
  type DaemonStatusSnapshot,
} from './daemon-status-snapshot.js';

import {
  durableReplace,
} from './durable-replace.js';

import {
  captureJournalIdentity,
} from './journal-identity.js';

import {
  readFilePrefix,
} from './read-file-prefix.js';

import {
  assertServiceLockHeld,
  DAEMON_STATUS_FILENAME,
  ServiceLockNotHeldError,
} from './service-lock.js';

import type {
  JournalIdentity,
} from './transaction-journal.js';

export const MAX_DAEMON_STATUS_BYTES = 16_384;

export interface ReadDaemonStatusFileOptions {
  readonly identity: JournalIdentity;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WriteDaemonStatusFileOptions
  extends ReadDaemonStatusFileOptions {
  readonly snapshot: DaemonStatusSnapshot;
}

/**
 * Publishes a complete snapshot under verified service ownership.
 * 
 * The caller must serialize publications and start publishing only after
 * signer initialization. This function never cleans orphan files.
 */
export async function writeDaemonStatusFile(
  options: WriteDaemonStatusFileOptions,
): Promise<void> {
  const snapshot = readDaemonStatusSnapshot(
    options.snapshot,
    options.identity,
  );

  const contents = JSON.stringify(snapshot) + '\n';

  if (Buffer.byteLength(contents, 'utf8') > MAX_DAEMON_STATUS_BYTES) {
    throw new Error('Daemon status snapshot exceeds its size limit.');
  }

  const env = { ...(options.env ?? process.env) };
  const ownership = assertServiceLockHeld({ env });
  env.QUICKNET_STATE_DIR = ownership.stateDirectory;

  const filePath = join(
    ownership.stateDirectory,
    DAEMON_STATUS_FILENAME,
  );

  // Refuse aliases or unexpected destination types before replacement.
  try {
    const existing = await lstat(filePath);

    if (!existing.isFile() || existing.nlink !== 1) {
      throw new Error('Invalid daemon status destination.');
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error('Daemon status destination could not be validated.');
    }
  }

  const current = assertServiceLockHeld({ env });

  if (
    current.stateDirectory !== ownership.stateDirectory ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino
  ) {
    throw new ServiceLockNotHeldError('descriptor');
  }

  try {
    await durableReplace(filePath, contents);
  } catch {
    throw new Error(
      'Daemon status publication did not complete. ' +
      'The on-disk outcome may be uncertain.'
    );
  }
}

/**
 * Reads the last published snapshot without acquiring service ownership.
 * 
 * The writer atomically replaces the file. Readers validate the opened
 * inode and may observe either complete version during replacement.
 * A successful read does not establish current daemon liveness.
 */
export async function readDaemonStatusFile(
  options: ReadDaemonStatusFileOptions,
): Promise<DaemonStatusSnapshot | null> {
  const identity = captureJournalIdentity(options.identity);

  const configuredDirectory =
    (options.env ?? process.env).QUICKNET_STATE_DIR ?? './state';

  if (configuredDirectory.trim().length === 0) {
    throw new Error('Invalid daemon status directory.');
  }

  let directory: string;

  try {
    directory = await realpath(resolve(configuredDirectory));
    const info = await stat(directory);

    if (!info.isDirectory() || (info.mode & 0o002) !== 0) {
      throw new Error('Invalid daemon status directory.');
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw new Error('Daemon status directory could not be validated.');
  }

  let file: FileHandle;

  try {
    file = await open(
      join(directory, DAEMON_STATUS_FILENAME),
      constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw new Error('Daemon status file could not be opened.');
  }

  let failed = false;

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_DAEMON_STATUS_BYTES
    ) {
      throw new Error('Invalid daemon status file.');
    }

    const buffer = await readFilePrefix(
      (buffer, offset, length, position) =>
        file.read(buffer, offset, length, position),
      MAX_DAEMON_STATUS_BYTES + 1,
    );

    if (buffer.length > MAX_DAEMON_STATUS_BYTES) {
      throw new Error('Daemon status file exceeds its size limit.');
    }

    const contents = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(buffer);

    return readDaemonStatusSnapshot(
      JSON.parse(contents),
      identity
    );
  } catch {
    failed = true;
    throw new Error('Daemon status file could not be read or validated.');
  } finally {
    try {
      await file.close();
    } catch {
      if (!failed) {
        throw new Error('Daemon status file could not be closed.');
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
  );
}