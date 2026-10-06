import { join } from 'node:path';

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

export interface OpenSignerRuntimeOptions {
  readonly identity: JournalIdentity;
  readonly log: ScopedRelayerLog;
  readonly createErrorSummary: ErrorSummaryFactory;
  readonly retry: BroadcastRetryScheduleOptions;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SignerRuntime {
  readonly coordinator: SignerCoordinator;
  readonly recovery: SignerRecoveryCycle;
}

/**
 * Opens the command's signer journal and creates the recovery cycle it
 * will reuse through its lifetime. A missing journal remains missing
 * until recovery receives explicit bootstrap authorization.
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

  const stateDirectory = assertServiceLockHeld({
    env: options.env ?? process.env,
  });

  const filePath = join(
    stateDirectory,
    `transaction-journal-${identity.chainId}-${identity.signer.toLowerCase()}.json`,
  );

  const store = await FileTransactionJournalStore.open({
    filePath,
    identity,
  });

  const coordinator = await SignerCoordinator.create({
    identity,
    store,
    log,
    createErrorSummary,
  });

  schedule.track(coordinator.attempt);

  return Object.freeze({
    coordinator,
    recovery: new SignerRecoveryCycle({
      coordinator,
      schedule,
    }),
  });
}