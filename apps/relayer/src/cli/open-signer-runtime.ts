import {
  join,
  resolve,
} from 'node:path';

import {
  performance,
} from 'node:perf_hooks';

import type {
  ErrorSummaryFactory,
} from '../config/config.js';

import type {
  ScopedRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  assertSignerBootstrapState,
} from '../state/assert-signer-bootstrap-state.js';

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
  TransactionManager,
  validateTransactionRetryOptions,
  type TransactionManagerOptions,
} from '../state/transaction-manager.js';

import type {
  JournalIdentity,
} from '../state/transaction-journal.js';

const DURABLE_RECOVERY_REFRESH_INTERVAL_MS = 60_000;

export interface OpenSignerRuntimeOptions
  extends Pick<
    TransactionManagerOptions,
    | 'publicClient'
    | 'walletClient'
    | 'account'
    | 'readChainHeads'
    | 'maxBlockRange'
    | 'onRecoveryCompleted'
  > {
  readonly identity: JournalIdentity;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly retry: TransactionManagerOptions['retry'];
  readonly onPersistenceBoundary?: PersistenceBoundaryHook;
  readonly checkpointFile?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Opens the command's signer journal and privately owned transaction manager.
 * A missing journal may initialize during recovery only after passing
 * the command's prior-state check.
 *
 * Call once per signer while holding the service lock. Commands sharing
 * a chain and signer must use the same state directory.
 */
export async function openSignerRuntime(
  options: OpenSignerRuntimeOptions,
): Promise<TransactionManager> {
  const bounds = DEFAULT_JOURNAL_BOUNDS;

  validateJournalBounds(bounds);

  const identity = captureJournalIdentity(options.identity);

  validateTransactionRetryOptions(options.retry);

  const {
    log,
    createErrorSummary,
  } = options;

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

  return TransactionManager.create({
    identity,
    store,
    maxRetainedAttempts: bounds.maxRetainedAttempts,
    log,
    createErrorSummary,
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    account: options.account,
    readChainHeads: options.readChainHeads,
    maxBlockRange: options.maxBlockRange,
    retry: options.retry,
    durableRecovery: {
      refreshIntervalMs: DURABLE_RECOVERY_REFRESH_INTERVAL_MS,
      now: () => performance.now(),
    },
    ...(options.onRecoveryCompleted === undefined
      ? {}
      : { onRecoveryCompleted: options.onRecoveryCompleted }),
  });
}