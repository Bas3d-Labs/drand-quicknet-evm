import type {
  Address,
  Hash,
  Hex,
} from 'viem';

import type {
  SignerBlocker,
} from './signer-gate.js';

export type TransactionAdmissionReason = SignerBlocker;

export interface TransactionManagerOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly cycle?: number | undefined;
}

export interface TransactionManagerAnchor {
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
}

export interface ReconcileTransactionsOptions
  extends TransactionManagerOperationOptions {
  readonly head: Readonly<TransactionManagerAnchor>;
  readonly durable: Readonly<TransactionManagerAnchor>; 
}

export interface TransactionWork {
  readonly workId: string;

  readonly call: {
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
    readonly gas?: bigint | undefined;
  };
}

export interface SubmitTransactionWorkOptions
  extends TransactionManagerOperationOptions {
  readonly work: TransactionWork;
}

export interface RetainedTransactionIdentity {
  readonly workId: string;
  readonly attemptId: string;
}

export interface TransactionBroadcastOutcome
  extends RetainedTransactionIdentity {
  readonly transactionHash: Hash;
  readonly nonce: bigint;
  readonly status: 'acknowledged' | 'not-acknowledged';
}

export type SubmitTransactionWorkResult =
  | {
      readonly status: 'submitted';
      readonly broadcast: TransactionBroadcastOutcome;
    }
  | {
      readonly status: 'deferred';
      readonly primaryReason: TransactionAdmissionReason;
      readonly reasons: readonly [
        TransactionAdmissionReason,
        ...TransactionAdmissionReason[],
      ];
    }
  | {
      readonly status: 'already-retained';
      readonly retained: RetainedTransactionIdentity;
    };

/**
 * Describes recording at the point submission failed. An uncertain write
 * may already be visible in storage, so its identity must come from the
 * retained pending snapshot.
 */
export type SubmissionRecording =
  | {
      readonly status: 'none';
    }
  | {
      readonly status: 'uncertain';
      readonly attempt: RetainedTransactionIdentity;
    }
  | {
      readonly status: 'retained';
      readonly attempt: RetainedTransactionIdentity;
    };