import type {
  Hash,
} from 'viem';

import {
  FileTransactionJournalStore,
  type FileTransactionJournalStoreOptions,
} from './file-transaction-journal-store.js';

import {
  journalSnapshotDigest,
} from './operator-attribution.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
  type VerifiedServiceLock,
} from './service-lock.js';

import {
  SignerCoordinator,
  type SignerCoordinatorOptions,
} from './signer-coordinator.js';

import type {
  TransactionJournalRead,
} from './transaction-journal.js';

interface GuardedOperatorApplyOptions<T> {
  readonly coordinator: Omit<SignerCoordinatorOptions, 'store'>;
  readonly initial: TransactionJournalRead;
  readonly storeOptions: FileTransactionJournalStoreOptions;
  readonly snapshotDigest: Hash;
  readonly journalChangedMessage: string;
  readonly verifyOwnership: () => void;
  readonly signal: AbortSignal | undefined;
  readonly recover: (coordinator: SignerCoordinator) => Promise<T | undefined>;
}

export function operatorOwnershipVerifier(
  env: NodeJS.ProcessEnv,
  ownership: VerifiedServiceLock | undefined,
): () => void {
  return () => {
    const current = assertServiceLockHeld({
      env,
    });

    if (
      ownership === undefined ||
      current.stateDirectory !== ownership.stateDirectory ||
      current.dev !== ownership.dev ||
      current.ino !== ownership.ino
    ) {
      throw new ServiceLockNotHeldError('descriptor');
    }
  };
}

/** Keep pre-opening refusals separate from retryable persistence failures. */
export async function guardedOperatorApply<T>(
  options: GuardedOperatorApplyOptions<T>,
): Promise<{
  readonly coordinator: SignerCoordinator;
  readonly result: T | undefined;
}> {
  const { initial, storeOptions, verifyOwnership, signal } = options;

  // Opening a file store can rewrite storage. Defer it until the coordinator
  // has verified the fresh proposal against the ticket, immediately before save.
  let writable: FileTransactionJournalStore | undefined;

  let openingStarted = false;

  let preWriteFailure: { readonly error: unknown } | undefined;

  const coordinator = await SignerCoordinator.create({
    ...options.coordinator,
    store: {
      load: async () => initial,
      async save(next) {
        verifyOwnership();

        if (writable === undefined) {
          try {
            if (!openingStarted) {
              signal?.throwIfAborted();
            }

            const current = await FileTransactionJournalStore.read(storeOptions);

            if (
              current.kind !== 'present' ||
              journalSnapshotDigest(current.snapshot) !== options.snapshotDigest
            ) {
              throw new Error(options.journalChangedMessage);
            }

            verifyOwnership();

            if (!openingStarted) {
              signal?.throwIfAborted();
            }
          } catch (error) {
            // Preserve a failed pre-opening condition rather than retrying it
            // as a save failure. Cancellation is checked only before opening starts.
            preWriteFailure = {
              error,
            };
            throw error;
          }

          openingStarted = true;
          writable = await FileTransactionJournalStore.open(storeOptions);
        }

        verifyOwnership();
        await writable.save(next);
      },
    },
  });

  let result: T | undefined;

  try {
    result = await options.recover(coordinator);
  } catch (error) {
    if (preWriteFailure !== undefined) {
      throw preWriteFailure.error;
    }

    if (coordinator.status.persistenceState !== 'failed') {
      throw error;
    }

    // Retry only the coordinator's retained exact write, never re-plan on failure.
    // Once persistence starts, cancellation cannot replace its actual outcome.
    verifyOwnership();
    await coordinator.retryPersistence();
  }

  return {
    coordinator,
    result,
  };
}
