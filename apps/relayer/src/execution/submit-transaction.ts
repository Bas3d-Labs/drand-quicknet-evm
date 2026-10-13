import type {
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';

import {
  prepareRelayerTransaction,
  type PrepareRelayerTransactionOptions,
} from '../chain/prepare-relayer-transaction.js';

import type {
  BroadcastAttemptResult,
  PrepareAttemptResult,
  SignerCoordinator,
} from '../state/signer-coordinator.js';

export type TransactionCall = Pick<
  PrepareRelayerTransactionOptions,
  'to' | 'data' | 'value' | 'gas'
>;

export type SubmitTransactionResult =
  | BroadcastAttemptResult
  | Extract<PrepareAttemptResult, { status: 'already-retained' }>;

export interface SubmitTransactionOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: LocalAccount;
  readonly coordinator: SignerCoordinator;
  readonly call: TransactionCall;
  readonly workId: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Prepare fees, durably record the signed transaction, then broadcast
 * through the coordinator.
 * 
 * The caller supplies an already-selected call and completes signer
 * recovery before entering this path. The coordinator remains responsible
 * for authorizing preparation and broadcasting.
 * 
 * Cancellation is checked between operations. A recorded attempt remains
 * in the journal if cancellation prevents starting the broadcast.
 * 
 * A broadcast result does not establish receipt success or work fulfillment.
 */
export async function submitTransaction(
  options: SubmitTransactionOptions,
  cycle?: number,
): Promise<SubmitTransactionResult> {
  const {
    publicClient,
    walletClient,
    account,
    coordinator,
    call,
    workId,
    signal,
  } = options;

  signal?.throwIfAborted();

  if (!coordinator.status.open) {
    throw new Error(
      'The signer gate must be open before submitting a transaction.'
    );
  }

  const transaction = await prepareRelayerTransaction({
    walletClient,
    signer: account.address,
    ...call,
  });

  signal?.throwIfAborted();

  // The coordinator rechecks the gate after asynchronous preparation.
  const attempt = await coordinator.prepareAttempt({
    account,
    transaction,
    workId,
  }, cycle);

  signal?.throwIfAborted();

  if (attempt.status === 'already-retained') {
    return attempt;
  }

  return coordinator.broadcastAttempt({
    publicClient,
    attemptId: attempt.attemptId,
  }, cycle);
}