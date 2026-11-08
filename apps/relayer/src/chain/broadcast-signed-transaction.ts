import type {
  Hash,
  Hex,
  PublicClient,
} from 'viem';

import {
  isFixedHex,
} from '../shared/hex.js';

export interface BroadcastSignedTransactionOptions {
  readonly publicClient: PublicClient;
  readonly signedTransaction: Hex;
  readonly transactionHash: Hash;
}

type BroadcastFailure =
  | {
      readonly observation: 'request-error';
      readonly error: unknown;
    }
  | {
      readonly observation: 'invalid-response';
    }
  | {
      readonly observation: 'hash-mismatch';
      readonly returnedTransactionHash: Hash;
    };

export type SignedTransactionBroadcastResult =
  | {
      readonly status: 'acknowledged';
    }
  | {
      readonly status: 'not-acknowledged';
      readonly failure: BroadcastFailure;
    };

/**
 * Sends recorded signed bytes once, with transport retries disabled.
 * 
 * Acknowledgement does not establish inclusion or execution. Request errors
 * remain internal evidence for protected diagnostics.
 */
export async function broadcastSignedTransaction(
  options: BroadcastSignedTransactionOptions,
): Promise<SignedTransactionBroadcastResult> {
  const {
    publicClient,
    signedTransaction,
    transactionHash
  } = options;

  let returnedHash: unknown;

  try {
    returnedHash = await publicClient.request({
      method: 'eth_sendRawTransaction',
      params: [signedTransaction],
    }, {
      retryCount: 0,
    });
  } catch (error) {
    return {
      status: 'not-acknowledged',
      failure: {
        observation: 'request-error',
        error,
      },
    };
  }

  if (!isFixedHex(returnedHash, 32)) {
    return {
      status: 'not-acknowledged',
      failure: {
        observation: 'invalid-response',
      },
    };
  }

  if (returnedHash.toLowerCase() !== transactionHash.toLowerCase()) {
    return {
      status: 'not-acknowledged',
      failure: {
        observation: 'hash-mismatch',
        returnedTransactionHash: returnedHash,
      },
    };
  }

  return {
    status: 'acknowledged',
  };
}