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
  SignerRecoveryCycle,
  SignerRecoveryCycleResult,
} from '../state/signer-recovery-cycle.js';

import {
  submitBeaconTransaction,
  type SubmitBeaconTransactionOptions,
} from './submit-beacon-transaction.js';

export type BeaconSubmissionRequest =
  SubmitBeaconTransactionOptions['request'];

export interface BeaconSubmitter {
  recover(cycle?: number): Promise<SignerRecoveryCycleResult>;

  submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<BroadcastAttemptResult>;
}

export interface CreateBeaconSubmitterOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: LocalAccount;
  readonly coordinator: SignerCoordinator;
  readonly recovery: SignerRecoveryCycle;
  readonly readChainHeads: () => Promise<ChainHeads>;
  readonly maxBlockRange: bigint;
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
    return recoverSignerAtHeads({
      publicClient,
      recovery: recoveryCycle,
      readChainHeads,
      maxBlockRange,
      signal,
    }, cycle);
  }

  async function submit(
    request: BeaconSubmissionRequest,
    cycle?: number,
  ): Promise<BroadcastAttemptResult> {
    await recover(cycle);

    signal?.throwIfAborted();

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