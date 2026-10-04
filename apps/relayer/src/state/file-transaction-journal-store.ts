import {
  constants,
} from 'node:fs';

import {
  open,
  type FileHandle,
} from 'node:fs/promises';

import {
  resolve,
} from 'node:path';

import {
  TextDecoder,
} from 'node:util';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  removeCheckpointTempFiles as removeJournalTempFiles,
} from './checkpoint-temp-files.js';

import {
  durableReplace,
} from './durable-replace.js';

import type {
  JournalIdentity,
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
  MAX_JOURNAL_BYTES,
} from './transaction-journal-serialization.js';

import {
  validateJournalSnapshotStructure,
} from './transaction-journal-validation.js';

export interface FileTransactionJournalStoreOptions {
  readonly filePath: string;
  readonly identity: JournalIdentity;
}

/**
 * File-backed journal requiring exclusive signer ownership and an
 * existing, trusted state directory.
 * 
 * Successful saves include file and directory synchoronization.
 * Failed saves mya leave the requested snapshot visible on disk.
 * 
 * The coordinator owns the persistence-failure latch. A subsequent
 * load must never be interpreted as confirmation that a failed save
 * completed durably.
 */
export class FileTransactionJournalStore
  implements TransactionJournalStore
{
  private readonly filePath: string;
  private readonly identity: JournalIdentity;
  private operations: Promise<void> = Promise.resolve();

  private constructor(
    options: FileTransactionJournalStoreOptions,
  ) {
    if (
      typeof options.filePath !== 'string' ||
      options.filePath.length === 0
    ) {
      throw new TypeError('Invalid journal file path.');
    }

    const { chainId, signer } = options.identity;

    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !isFixedHex(signer, 20)
    ) {
      throw new TypeError('Invalid journal identity.');
    }

    this.filePath = resolve(options.filePath);
    this.identity = Object.freeze({
      chainId,
      signer,
    });
  }

  /**
   * Validates existing state, removes owned orphaned temporary files,
   * and durably rewrites any existing snapshot before returning.
   */
  static async open(
    options: FileTransactionJournalStoreOptions,
  ): Promise<FileTransactionJournalStore> {
    const store = new FileTransactionJournalStore(options);
    const current = await store.load();

    try {
      await removeJournalTempFiles(store.filePath);
    } catch {
      throw new Error('Journal temporary-file cleanup failed.');
    }

    if (current.kind === 'present') {
      // A previous process may have exited between rename and directory
      // synchoronization. Establish durability in this process through
      // a fresh replacement.
      await store.save(current.snapshot);
    }

    return store;
  }

  async load(): Promise<TransactionJournalRead> {
    return this.exclusive(async () => {
      let contents: string | undefined;

      try {
        contents = await readBoundedJournal(this.filePath);
      } catch (cause) {
        throw new Error(
          'Transaction journal could not be loaded.',
          { cause },
        );
      }

      if (contents === undefined) {
        return {
          kind: 'missing',
        };
      }

      try {
        const snapshot = await decodeJournalSnapshot(
          contents,
          this.identity,
        );

        return {
          kind: 'present',
          snapshot,
        };
      } catch (cause) {
        throw new Error(
          'Transaction journal could not be decoded.',
          { cause },
        );
      }
    });
  }

  async save(snapshot: TransactionJournalSnapshot): Promise<void> {
    try {
      // Capture before waiting for another operation. A caller must not
      // be able to mutate a queued writer's state.
      const captured = validateJournalSnapshotStructure(
        snapshot,
        this.identity,
      );

      await this.exclusive(async () => {
        const contents = await encodeJournalSnapshot(
          captured,
          this.identity,
        );

        // No equality shortcut and no cached "already saved" state.
        // Retrying always creates a fresh durable replacement.
        await durableReplace(this.filePath, contents);
      });
    } catch {
      throw new Error(
        'Journal persistence did not complete. ' +
        'The on-disk outcome may be uncertain.'
      );
    }
  }

  private exclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.operations.then(operation);

    this.operations = pending.then(
      () => undefined,
      () => undefined,
    );

    return pending;
  }
}

type JournalFileOperation = 'open' | 'stat' | 'read' | 'close';

const FILE_ERROR_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EBADF',
  'EINTR',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

async function readBoundedJournal(
  filePath: string,
): Promise<string | undefined> {
  let file: FileHandle;

  try {
    file = await open(
      filePath,
      constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    );
  } catch (cause) {
    const failure = fileOperationError('open', cause);
    if (failure.code === 'ENOENT') {
      return undefined;
    }

    throw failure;
  }

  let failed = false;

  try {
    const stat = await fileOperation('stat', () => file.stat());
    if (!stat.isFile()) {
      throw new Error('Journal path is not a regular file.');
    }

    if (stat.size > MAX_JOURNAL_BYTES) {
      throw new Error('Journal file exceeds its size limit.');
    }

    // The extra byte distinguishes an exactly-full file from an
    // oversized file, including one that grew after stat().
    const buffer = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    let length = 0;

    while (length < buffer.length) {
      const result = await fileOperation('read', () => file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      ));

      if (result.bytesRead === 0) {
        break;
      }

      length += result.bytesRead;
    }

    if (length > MAX_JOURNAL_BYTES) {
      throw new Error('Journal file exceeds its size limit.');
    }

    try {
      return new TextDecoder('utf-8', {
        fatal: true,
      }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error('Journal file contains invalid UTF-8.');
    }
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    try {
      await fileOperation('close', () => file.close());
    } catch (cause) {
      // A cleanup failure must not replace the original read failure.
      if (!failed) {
        throw cause;
      }
    }
  }
}

async function fileOperation<T>(
  operation: JournalFileOperation,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw fileOperationError(operation, cause);
  }
}

function fileOperationError(
  operation: JournalFileOperation,
  cause: unknown,
): Error & { code?: string } {
  let code: string | undefined;

  try {
    if (typeof cause === 'object' && cause !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');

      if (
        descriptor !== undefined &&
        Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'string' &&
        FILE_ERROR_CODES.has(descriptor.value)
      ) {
        code = descriptor.value;
      }
    }
  } catch {
    // Reflection failure must not expose the original exception.
  }

  let message = `Journal file ${operation} failed.`;

  if (code !== undefined) {
    message = `Journal file ${operation} failed (${code}).`;
  }

  const error: Error & { code?: string } = new Error(message);
  if (code !== undefined) {
    error.code = code;
  }

  return error;
}