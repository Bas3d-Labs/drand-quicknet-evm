import type {
  TransactionManager,
} from '../state/transaction-manager.js';

import type {
  SubmitTransactionWorkResult,
} from '../state/transaction-manager-types.js';

import {
  createBeaconWorkId,
} from './beacon-work-identity.js';

import {
  encodeBeaconSubmission,
  type BeaconSubmissionRequest,
} from './encode-beacon-submission.js';

export interface SubmitBeaconTransactionOptions {
  readonly manager: Pick<TransactionManager, 'status' | 'submit'>;
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
): Promise<SubmitTransactionWorkResult> {
  const {
    manager,
    request,
    signal,
  } = options;

  signal?.throwIfAborted();

  const workId = createBeaconWorkId({
    chainId: manager.status.chainId,
    registry: request.address,
    round: request.args[0],
  });

  const call = encodeBeaconSubmission(request);

  return manager.submit({
    work: {
      workId,
      call: {
        ...call,
        gas: request.gas,
      },
    },
    signal,
    cycle,
  });
}