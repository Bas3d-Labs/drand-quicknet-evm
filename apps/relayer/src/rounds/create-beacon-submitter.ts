import type {
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import {
  recoverSignerAtHeads,
} from '../state/recover-signer-at-heads.js';

import type {
  BroadcastAttemptResult,
  SignerCoordinator,
} from '../state/signer-coordinator.js';

import type {
  SignerBlocker,
} from '../state/signer-gate.js';

import type {
  SignerRecoveryCycle,
  SignerRecoveryCycleResult,
} from '../state/signer-recovery-cycle.js';

import {
  submitBeaconTransaction,
  type SubmitBeaconTransactionOptions,
} from './submit-beacon-transaction.js';

export type BeaconSubmissionRequest =
  SubmitBeaconTransactionOptions['request'];

export type BeaconSubmissionResult =
  | BroadcastAttemptResult
  | {
      /**
       * Fresh recovery completed, but the signer gate remained closed.
       * No new attempt was prepared for this submission.
       */
      readonly status: 'signer-unavailable';
      readonly blocker: SignerBlocker;
    };

export interface BeaconSubmitter {
  recover(cycle?: number): Promise<SignerRecoveryCycleResult>;

  submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<BeaconSubmissionResult>;
}

export interface BeaconRecoveryObservation {
  readonly retryDelayMs: number | null;
}

export interface CreateBeaconSubmitterOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: LocalAccount;
  readonly coordinator: SignerCoordinator;
  readonly recovery: SignerRecoveryCycle;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;

  /**
   * Synchronous diagnostic observer called after successful recovery.
   * Also observes recovery performed internally before submission.
   * Must not perform transaction work.
   */
  readonly onRecoveryCompleted?: (
    observation: BeaconRecoveryObservation,
  ) => void;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Binds imports to one command-owned signer coordinator and retry schedule.
 * Each submission performs fresh recovery before allocating another nonce.
 */
export function createBeaconSubmitter(
  options: CreateBeaconSubmitterOptions,
): BeaconSubmitter {
  const {
    publicClient,
    walletClient,
    account,
    coordinator,
    recovery: recoveryCycle,
    readChainHeads,
    maxBlockRange,
    signal,
  } = options;

  async function recover(
    cycle?: number,
  ): Promise<SignerRecoveryCycleResult> {
    const result = await recoverSignerAtHeads({
      publicClient,
      recovery: recoveryCycle,
      readChainHeads,
      maxBlockRange,
      signal,
    }, cycle);

    try {
      options.onRecoveryCompleted?.(Object.freeze({
        retryDelayMs: result.retryDelayMs,
      }));
    } catch {
      // Diagnostic observers must not replace a recovery outcome.
    }

    return result;
  }

  async function submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<BeaconSubmissionResult> {
    await recover(cycle);

    signal?.throwIfAborted();

    const status = coordinator.status;

    if (!status.open) {
      if (status.primaryReason === null) {
        throw new Error('Signer gate is closed without a reported blocker.');
      }

      return {
        status: 'signer-unavailable',
        blocker: status.primaryReason,
      };
    }

    return submitBeaconTransaction({
      publicClient,
      walletClient,
      account,
      coordinator,
      request,
      signal,
    }, cycle);
  }

  return Object.freeze({
    recover,
    submit,
  });
}