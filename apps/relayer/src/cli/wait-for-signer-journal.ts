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
  SignerCoordinator,
} from '../state/signer-coordinator.js';

export interface WaitForSignerJournalOptions {
  readonly coordinator: Pick<
    SignerCoordinator,
    'journalInitialized'
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
    coordinator,
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

  while (!coordinator.journalInitialized) {
    const result = await submitter.recover();

    signal?.throwIfAborted();

    if (coordinator.journalInitialized) {
      return;
    }

    if (
      result.inspection.status !== 'bootstrap-deferred' &&
      result.inspection.status !== 'anchor-changed'
    ) {
      throw new Error(
        'Signer recovery completed without initializing the journal.'
      );
    }

    await sleep(pollIntervalMs, signal);

    signal?.throwIfAborted();
  }
}