import {
  join,
} from 'node:path';

import {
  isFixedHex,
} from '../shared/hex.js';

import {
  FileTransactionJournalStore,
} from '../state/file-transaction-journal-store.js';

import {
  projectJournalStatus,
  type JournalStatus,
} from '../state/project-journal-status.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../state/service-lock.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

export interface ReadJournalStatusOptions {
  readonly identity: JournalIdentity;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Reads journal status under verified service ownership.
 */
export async function readJournalStatus(
  options: ReadJournalStatusOptions,
): Promise<JournalStatus> {
  const identity = Object.freeze({
    chainId: options.identity.chainId,
    signer: options.identity.signer,
  });

  if (
    !Number.isSafeInteger(identity.chainId) ||
    identity.chainId <= 0 ||
    !isFixedHex(identity.signer, 20)
  ) {
    throw new TypeError('Invalid journal identity.');
  }

  const env = { ...(options.env ?? process.env) };
  const { signal } = options;

  signal?.throwIfAborted();

  const ownership = assertServiceLockHeld({ env });
  env.QUICKNET_STATE_DIR = ownership.stateDirectory;

  const filePath = join(
    ownership.stateDirectory,
    `transaction-journal-${identity.chainId}-${identity.signer.toLowerCase()}.json`,
  );

  const read = await FileTransactionJournalStore.read({
    filePath,
    identity,
  });

  signal?.throwIfAborted();

  const current = assertServiceLockHeld({ env });

  if (
    current.stateDirectory !== ownership.stateDirectory ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino
  ) {
    throw new ServiceLockNotHeldError('descriptor');
  }

  return projectJournalStatus(read);
}