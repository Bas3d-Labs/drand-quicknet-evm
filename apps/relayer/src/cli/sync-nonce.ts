import {
  join,
} from 'node:path';

import {
  isDeepStrictEqual,
} from 'node:util';

import type {
  PublicClient,
} from 'viem';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import {
  inspectNonceSync,
} from '../chain/inspect-nonce-sync.js';

import {
  FileTransactionJournalStore,
} from '../state/file-transaction-journal-store.js';

import {
  captureJournalIdentity,
  journalFilename,
} from '../state/journal-identity.js';

import {
  planNonceSync,
  type NonceSyncPlan,
} from '../state/plan-nonce-sync.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../state/service-lock.js';

import type {
  JournalIdentity,
  JournalNonceRepair,
  TransactionJournalRead,
  TransactionJournalSnapshot,
} from '../state/transaction-journal.js';

export interface SyncNonceOptions {
  readonly publicClient: PublicClient;
  readonly identity: JournalIdentity;
  readonly finality: FinalityPolicy;
  readonly apply: boolean;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export type SyncNonceResult =
  | NonceSyncPlan
  | {
      readonly status: 'refused';
      readonly reason: 'journal-missing' | 'journal-changed';
    }
  | {
      readonly status: 'deferred';
      readonly reason: 'anchor-changed';
    }
  | {
      readonly status: 'applied';
      readonly repair: JournalNonceRepair;
    };

/**
 * Inspects or applies a forward nonce repair under service ownership.
 * 
 * Preview never opens a writeable store. Apply opens one only after
 * establishing repair eligibility and rechecking the loaded snapshot.
 */
export async function syncNonce(
  options: SyncNonceOptions,
): Promise<SyncNonceResult> {
  const {
    publicClient,
    signal,
    apply,
  } = options;

  const identity = captureJournalIdentity(options.identity);

  const finality = { ...options.finality };
  const env = { ...(options.env ?? process.env) };
  const now = options.now ?? (() => new Date());

  signal?.throwIfAborted();

  const ownership = assertServiceLockHeld({ env });

  // Pin subsequent checks to the verified canonical directory.
  env.QUICKNET_STATE_DIR = ownership.stateDirectory;

  const filePath = join(
    ownership.stateDirectory,
    journalFilename(identity),
  );

  const storeOptions = {
    filePath,
    identity,
  };

  function verifyOwnership(): void {
    const current = assertServiceLockHeld({ env });

    if (
      current.stateDirectory !== ownership.stateDirectory ||
      current.dev !== ownership.dev ||
      current.ino !== ownership.ino
    ) {
      throw new ServiceLockNotHeldError('descriptor');
    }
  }

  const initial = await FileTransactionJournalStore.read(storeOptions);

  signal?.throwIfAborted();

  if (initial.kind === 'missing') {
    return {
      status: 'refused',
      reason: 'journal-missing',
    };
  }

  // Any retained attempt rules out this repair before RPC inspection.
  if (initial.snapshot.attempts.length !== 0) {
    return {
      status: 'refused',
      reason: 'retained-attempts',
    };
  }

  const inspection = await inspectNonceSync({
    publicClient,
    identity,
    finality,
    ...(signal === undefined ? {} : { signal }),
  });

  signal?.throwIfAborted();

  if (inspection.status === 'anchor-changed') {
    return {
      status: 'deferred',
      reason: 'anchor-changed',
    };
  }

  const plan = planNonceSync({
    snapshot: initial.snapshot,
    identity,
    observation: inspection.observation,
    latestNonce: inspection.latestNonce,
    pendingNonce: inspection.pendingNonce,
    at: now().toISOString(),
  });

  signal?.throwIfAborted();

  if (!apply || plan.status !== 'repair-available') {
    return plan;
  }

  // open() can clean temporary files and rewrite the existing journal.
  // Check for intervening changes before allowing those operations.
  verifyOwnership();

  const beforeOpen = await FileTransactionJournalStore.read(storeOptions);

  signal?.throwIfAborted();

  if (!matchesSnapshot(beforeOpen, initial.snapshot)) {
    return {
      status: 'refused',
      reason: 'journal-changed',
    };
  }

  verifyOwnership();

  const store = await FileTransactionJournalStore.open(storeOptions);

  signal?.throwIfAborted();
  verifyOwnership();

  // Compare the complete validated snapshot, including repair history.
  const beforeSave = await store.load();

  signal?.throwIfAborted();

  if (!matchesSnapshot(beforeSave, initial.snapshot)) {
    return {
      status: 'refused',
      reason: 'journal-changed',
    };
  }

  verifyOwnership();

  // Once persistence begins, await its actual outcome. A signal must not
  // turn a committed repair into an interrupted result or replace a
  // persistence failure with a cancellation error.
  await store.save(plan.snapshot);

  return {
    status: 'applied',
    repair: plan.repair,
  };
}

function matchesSnapshot(
  read: TransactionJournalRead,
  expected: TransactionJournalSnapshot,
): boolean {
  return (
    read.kind === 'present' &&
    isDeepStrictEqual(read.snapshot, expected)
  );
}