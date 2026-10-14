import type {
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';

import {
  submitTransaction,
  type SubmitTransactionResult,
} from '../execution/submit-transaction.js';

import type {
  SignerCoordinator,
} from '../state/signer-coordinator.js';

import {
  createBeaconWorkId,
} from './beacon-work-identity.js';

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
 * Compose the exact-round work identity, encode the selected beacon call,
 * and delegate transaction execution.
 * 
 * A retained-work result does not establish beacon fulfillment or
 * authorize broadcasting the retained attempt.
 */
export async function submitBeaconTransaction(
  options: SubmitBeaconTransactionOptions,
  cycle?: number,
): Promise<SubmitTransactionResult> {
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

  const workId = createBeaconWorkId({
    chainId: coordinator.chainId,
    registry: request.address,
    round: request.args[0],
  });

  const call = encodeBeaconSubmission(request);

  return submitTransaction({
    publicClient,
    walletClient,
    account,
    coordinator,
    call: {
      ...call,
      gas: request.gas,
    },
    workId,
    signal,
  }, cycle);
}