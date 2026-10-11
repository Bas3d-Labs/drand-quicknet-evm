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
  isFixedHex,
} from '../shared/hex.js';

import {
  assertSignerBootstrapState,
} from '../state/assert-signer-bootstrap-state.js';

import {
  BroadcastRetrySchedule,
  type BroadcastRetryScheduleOptions,
} from '../state/broadcast-retry-schedule.js';

import {
  FileTransactionJournalStore,
} from '../state/file-transaction-journal-store.js';

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

// Preserve one-at-a-time inclusion allocation until command-level queue
// configuration and head inclusion orchestration are wired.
const MAX_RETAINED_ATTEMPTS = 1;

export interface OpenSignerRuntimeOptions {
  readonly identity: JournalIdentity;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly retry: BroadcastRetryScheduleOptions;
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
  const identity = Object.freeze({
    chainId: options.identity.chainId,
    signer: options.identity.signer,
  });

  const {
    log,
    createErrorSummary,
  } = options;

  if (
    !Number.isSafeInteger(identity.chainId) ||
    identity.chainId <= 0 ||
    !isFixedHex(identity.signer, 20)
  ) {
    throw new TypeError('Invalid journal identity.');
  }

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
    `transaction-journal-${identity.chainId}-${identity.signer.toLowerCase()}.json`,
  );

  await assertSignerBootstrapState(filePath, ownership);

  const store = await FileTransactionJournalStore.open({
    filePath,
    identity,
  });

  const coordinator = await SignerCoordinator.create({
    identity,
    store,
    maxRetainedAttempts: MAX_RETAINED_ATTEMPTS,
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