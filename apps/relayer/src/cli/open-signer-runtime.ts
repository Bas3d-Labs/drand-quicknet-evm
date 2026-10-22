import {
  join,
  resolve,
} from 'node:path';

import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  assertSignerBootstrapState,
} from '../state/assert-signer-bootstrap-state.js';

import {
  BroadcastRetrySchedule,
  type BroadcastRetryScheduleOptions,
} from '../state/broadcast-retry-schedule.js';

import type {
  PersistenceBoundaryHook,
} from '../state/durable-replace.js';

import {
  FileTransactionJournalStore,
} from '../state/file-transaction-journal-store.js';

import {
  DEFAULT_JOURNAL_BOUNDS,
  validateJournalBounds,
} from '../state/journal-bounds.js';

import {
  captureJournalIdentity,
  journalFilename,
} from '../state/journal-identity.js';

import {
  assertServiceLockHeld,
} from '../state/service-lock.js';

import {
  SignerCoordinator,
} from '../state/signer-coordinator.js';

import {
  SignerRecoveryCycle,
} from '../state/signer-recovery-cycle.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

export interface OpenSignerRuntimeOptions {
  readonly identity: JournalIdentity;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly retry: BroadcastRetryScheduleOptions;
  readonly onPersistenceBoundary?: PersistenceBoundaryHook;
  readonly checkpointFile?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SignerRuntime {
  readonly coordinator: SignerCoordinator;
  readonly recovery: SignerRecoveryCycle;
}

/**
 * Opens the command's signer journal and creates its recovery cycle.
 * A missing journal may initialize during recovery only after passing
 * the command's prior-state check.
 *
 * Call once per signer while holding the service lock. Commands sharing
 * a chain and signer must use the same state directory.
 */
export async function openSignerRuntime(
  options: OpenSignerRuntimeOptions,
): Promise<SignerRuntime> {
  const bounds = DEFAULT_JOURNAL_BOUNDS;

  validateJournalBounds(bounds);

  const identity = captureJournalIdentity(options.identity);

  const {
    log,
    createErrorSummary,
  } = options;

  const schedule = new BroadcastRetrySchedule(options.retry);

  const env = options.env ?? process.env;

  const configuredCheckpointFile =
    options.checkpointFile ?? env.QUICKNET_CHECKPOINT_FILE;

  if (
    configuredCheckpointFile !== undefined &&
    configuredCheckpointFile.trim().length === 0
  ) {
    throw new TypeError('Invalid checkpoint file path.');
  }

  const resolvedCheckpointFile =
    configuredCheckpointFile === undefined
      ? undefined
      : resolve(configuredCheckpointFile);

  const ownership = assertServiceLockHeld({
    env,
    ...(resolvedCheckpointFile === undefined
      ? {}
      : { checkpointFile: resolvedCheckpointFile }),
  });

  const { stateDirectory } = ownership;

  const filePath = join(
    stateDirectory,
    journalFilename(identity),
  );

  await assertSignerBootstrapState(filePath, ownership);

  const store = await FileTransactionJournalStore.open({
    filePath,
    identity,
    bounds,
    ...(options.onPersistenceBoundary === undefined
      ? {}
      : { onPersistenceBoundary: options.onPersistenceBoundary }),
  });

  const coordinator = await SignerCoordinator.create({
    identity,
    store,
    maxRetainedAttempts: bounds.maxRetainedAttempts,
    log,
    createErrorSummary,
  });

  const unresolved = coordinator.attempts.find(
    (attempt) => attempt.phase !== 'included',
  );

  schedule.track(unresolved ?? null);

  return Object.freeze({
    coordinator,
    recovery: new SignerRecoveryCycle({
      coordinator,
      schedule,
    }),
  });
}