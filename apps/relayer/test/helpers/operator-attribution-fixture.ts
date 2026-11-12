import {
  vi,
  type Mock,
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  OperatorAttributionRequest,
} from '../../src/state/operator-attribution.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

export const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

export const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

export const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

export const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

export const HINT_HASH = `0x${'bb'.repeat(32)}` as const;

export const OTHER_HASH = `0x${'cc'.repeat(32)}` as const;

export function anchor(
  blockNumber: bigint,
) {
  return {
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hash,
  };
}

export const DURABLE = anchor(104n);

export async function fixture(
  factHeight: bigint | null = 100n,
  cursorHeight: bigint | null = 102n,
): Promise<TransactionJournalSnapshot> {
  const signedTransaction = await ACCOUNT.signTransaction({
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    type: 'eip1559',
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const lowerBound = {
    anchor: anchor(98n),
    nonce: 4n,
  };

  let exhausted = null;

  let searchedThrough = null;

  if (factHeight !== null) {
    exhausted = {
      anchor: anchor(factHeight),
      nonce: 5n,
    };
  }

  if (cursorHeight !== null) {
    searchedThrough = anchor(cursorHeight);
  }

  return {
    version: 1,
    identity: IDENTITY,
    baseline: lowerBound,
    lastObservation: {
      anchor: DURABLE,
      nonce: 5n,
    },
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [{
      attemptId: ATTEMPT_ID,
      workId: 'hint:4',
      nonce: 4n,
      createdAt: '2026-11-12T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      replacementSearch: {
        lowerBound,
        searchedThrough,
        exhausted,
      },
    }],
  };
}

export function request(
  height = 101n,
): OperatorAttributionRequest {
  return {
    hint: {
      attemptId: ATTEMPT_ID,
      transactionHash: HINT_HASH,
      blockNumber: height,
    },
    requestId: REQUEST_ID,
    operator: 'operator',
    at: '2026-11-12T00:00:00.000Z',
    finality: {
      type: 'safe',
    },
  };
}

export function client(
  height = 101n,
): {
  publicClient: PublicClient;
  calls: string[];
  getBlock: Mock<PublicClient['getBlock']>;
  getTransactionReceipt: Mock<PublicClient['getTransactionReceipt']>;
  getTransactionCount: Mock<PublicClient['getTransactionCount']>;
  getTransaction: Mock<PublicClient['getTransaction']>;
  sendRawTransaction: Mock<PublicClient['sendRawTransaction']>;
} {
  const calls: string[] = [];

  const getBlock = vi.fn<PublicClient['getBlock']>().mockImplementation(async (input) => {
    const number = input!.blockNumber!;

    const full = input?.includeTransactions === true;

    calls.push(`${number}:${full}`);

    const transactions: {
      hash: Hash;
      from: typeof ACCOUNT.address;
      nonce: number;
    }[] = [];

    if (full && number === height) {
      transactions.push({
        hash: HINT_HASH,
        from: ACCOUNT.address,
        nonce: 4,
      });
    }

    return {
      number,
      hash: anchor(number).blockHash,
      parentHash: anchor(number - 1n).blockHash,
      transactions,
    } as never;
  });

  const getTransactionReceipt = vi.fn<PublicClient['getTransactionReceipt']>()
    .mockImplementation(async ({ hash }) => {
      calls.push('receipt');

      throw new TransactionReceiptNotFoundError({
        hash,
      });
    });

  const getTransactionCount = vi.fn<PublicClient['getTransactionCount']>()
    .mockImplementation(async () => {
      calls.push('nonce');

      return 5;
    });

  const getTransaction = vi.fn<PublicClient['getTransaction']>()
    .mockResolvedValue({
      blockNumber: height,
    } as never);

  const sendRawTransaction = vi.fn<PublicClient['sendRawTransaction']>();

  const publicClient = {
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    getTransaction,
    sendRawTransaction,
  } as unknown as PublicClient;

  return {
    publicClient,
    calls,
    getBlock,
    getTransactionReceipt,
    getTransactionCount,
    getTransaction,
    sendRawTransaction,
  };
}
