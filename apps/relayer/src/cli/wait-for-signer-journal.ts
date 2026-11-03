import type {
  BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import {
  sleepFor,
} from '../shared/sleep-for.js';

import type {
  TransactionManager,
} from '../state/transaction-manager.js';

export interface WaitForSignerJournalOptions {
  readonly manager: Pick<
    TransactionManager,
    'status'
  >;
  readonly submitter: Pick<BeaconSubmitter, 'recover'>;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/**
 * Waits for first-use journal initialization before checkpoint creation.
 * 
 * Existing journals return immediately, even when the signer is blocked.
 * Deferred bootstrap and anchor changes are retried at the polling interval.
 * RPC and persistence failures propagate to the caller.
 */
export async function waitForSignerJournal(
  options: WaitForSignerJournalOptions,
): Promise<void> {
  const {
    manager,
    submitter,
    pollIntervalMs,
    signal,
  } = options;

  if (
    !isPositiveSafeInteger(pollIntervalMs) ||
    pollIntervalMs > 2_147_483_647
  ) {
    throw new TypeError('Invalid signer startup polling interval.');
  }

  const sleep = options.sleep ?? sleepFor;

  signal?.throwIfAborted();

  while (!manager.status.journalInitialized) {
    const result = await submitter.recover();

    signal?.throwIfAborted();

    if (manager.status.journalInitialized) {
      return;
    }

    if (
      result.recoveryStatus !== 'bootstrap-deferred' &&
      result.recoveryStatus !== 'anchor-changed'
    ) {
      throw new Error(
        'Signer recovery completed without initializing the journal.'
      );
    }

    await sleep(pollIntervalMs, signal);

    signal?.throwIfAborted();
  }
}