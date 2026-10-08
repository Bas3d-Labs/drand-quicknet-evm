import type {
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';

import {
  prepareRelayerTransaction,
} from '../chain/prepare-relayer-transaction.js';

import type {
  BroadcastAttemptResult,
  SignerCoordinator,
} from '../state/signer-coordinator.js';

import {
  encodeBeaconSubmission,
  type BeaconSubmissionRequest,
} from './encode-beacon-submission.js';

export interface SubmitBeaconTransactionOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: LocalAccount;
  readonly coordinator: SignerCoordinator;
  readonly request: BeaconSubmissionRequest & {
    readonly gas?: bigint | undefined;
  };
  readonly signal?: AbortSignal | undefined;
}

/**
 * Prepare fees, durably records the signed transaction, then broadcasts
 * through the coordinator.
 * 
 * Cancellation is checked between operations. A recorded attempt remains
 * in the journal if cancellation prevents starting the broadcast.
 */
export async function submitBeaconTransaction(
  options: SubmitBeaconTransactionOptions,
  cycle?: number,
): Promise<BroadcastAttemptResult> {
  const {
    publicClient,
    walletClient,
    account,
    coordinator,
    request,
    signal,
  } = options;

  signal?.throwIfAborted();

  if (!coordinator.status.open) {
    throw new Error('The signer gate must be open before submitting a beacon.');
  }

  const call = encodeBeaconSubmission(request);

  const transaction = await prepareRelayerTransaction({
    walletClient,
    signer: account.address,
    ...call,
    gas: request.gas,
  });

  signal?.throwIfAborted();

  // Rechecks the gate after asynchronous gas and fee preparation.
  const attempt = await coordinator.prepareAttempt({
    account,
    transaction,
  }, cycle);

  signal?.throwIfAborted();

  return coordinator.broadcastAttempt({
    publicClient,
    attemptId: attempt.attemptId,
  }, cycle);
}