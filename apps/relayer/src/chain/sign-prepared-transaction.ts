import {
  keccak256,
  parseTransaction,
  serializeTransaction,
  type AccessList,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';

import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  JournalAttempt,
  JournalIdentity,
  JournalSignedTransaction,
} from '../state/transaction-journal.js';

import {
  verifyJournalAttempt,
} from '../state/transaction-journal-verification.js';

export type PreparedRelayerTransaction = {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
} & (
  | {
      readonly type: 'legacy';
      readonly gasPrice: bigint;
    }
  | {
      readonly type: 'eip2930';
      readonly gasPrice: bigint;
      readonly accessList: AccessList;
    }
  | {
      readonly type: 'eip1559';
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
      readonly accessList?: AccessList;
    }
);

export interface SignPreparedTransactionOptions {
  readonly identity: JournalIdentity;
  readonly nonce: bigint;
  readonly account: LocalAccount;
  readonly transaction: PreparedRelayerTransaction;
}

export type SignedRelayerTransaction = JournalSignedTransaction & {
  readonly nonce: bigint;
};

/**
 * Signs a prepared transaction with the journal's chain and nonce, then
 * checks that the returned bytes contain the requested transaction.
 */
export async function signPreparedTransaction(
  options: SignPreparedTransactionOptions,
): Promise<SignedRelayerTransaction> {
  try {
    const identity = {
      chainId: options.identity.chainId,
      signer: options.identity.signer,
    };

    const nonce = options.nonce;
    const account = options.account;
    const transaction = options.transaction;

    if (
      !Number.isSafeInteger(identity.chainId) ||
      identity.chainId <= 0 ||
      !isFixedHex(identity.signer, 20) ||
      account.type !== 'local' ||
      account.address.toLowerCase() !== identity.signer.toLowerCase() ||
      typeof nonce !== 'bigint' ||
      nonce < 0n ||
      nonce > BigInt(Number.MAX_SAFE_INTEGER) ||
      !isFixedHex(transaction.to, 20) ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data) ||
      typeof transaction.value !== 'bigint' ||
      transaction.value < 0n ||
      typeof transaction.gas !== 'bigint' ||
      transaction.gas <= 0n
    ) {
      throw new TypeError();
    }

    const common = {
      chainId: identity.chainId,
      nonce: Number(nonce),
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      gas: transaction.gas,
    };

    let unsigned: Hex;

    switch (transaction.type) {
      case 'legacy':
      case 'eip2930': {
        if (
          typeof transaction.gasPrice !== 'bigint' ||
          transaction.gasPrice < 0n
        ) {
          throw new TypeError();
        }

        if (transaction.type === 'legacy') {
          unsigned = serializeTransaction({
            ...common,
            type: 'legacy',
            gasPrice: transaction.gasPrice,
          });
        } else {
          unsigned = serializeTransaction({
            ...common,
            type: 'eip2930',
            gasPrice: transaction.gasPrice,
            accessList: transaction.accessList,
          });
        }

        break;
      }
      
      case 'eip1559':
        if (
          typeof transaction.maxFeePerGas !== 'bigint' ||
          typeof transaction.maxPriorityFeePerGas !== 'bigint' ||
          transaction.maxPriorityFeePerGas < 0n ||
          transaction.maxFeePerGas < transaction.maxPriorityFeePerGas
        ) {
          throw new TypeError();
        }

        unsigned = serializeTransaction({
          ...common,
          type: 'eip1559',
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
          accessList: transaction.accessList,
        });

        break;

      default:
        throw new TypeError();
    }

    const signedTransaction = await account.signTransaction(
      parseTransaction(unsigned),
    );

    const signed = Object.freeze({
      nonce,
      transactionHash: keccak256(signedTransaction),
      signedTransaction,
    });

    await verifyJournalAttempt(identity, {
      nonce: signed.nonce,
      signedTransactions: [{
        transactionHash: signed.transactionHash,
        signedTransaction: signed.signedTransaction,
      }],
    });

    const parsed = parseTransaction(signedTransaction);

    const actualUnsigned = serializeTransaction({
      ...parsed,
      r: undefined,
      s: undefined,
      v: undefined,
      yParity: undefined,
    });

    if (actualUnsigned.toLowerCase() !== unsigned.toLowerCase()) {
      throw new TypeError();
    }

    return signed
  } catch {
    throw new Error('Could not sign the prepared relayer transaction.');
  }
}