import {
  keccak256,
  type Hash,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const FACT_ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

export const FACT_IDENTITY = { chainId: 4663, signer: FACT_ACCOUNT.address };

export function factAnchor(blockNumber: bigint) {
  return {
    blockNumber,
    blockHash: `0x${'ab'.repeat(31)}${Number(blockNumber).toString(16).padStart(2, '0')}` as Hash,
  };
}

export function factObservation(blockNumber: bigint, nonce: bigint) {
  return { anchor: factAnchor(blockNumber), nonce };
}

export async function searchFactFixture(
  nonces = [4, 5],
): Promise<TransactionJournalSnapshot> {
  const attempts: JournalAttempt[] = [];

  for (const nonce of nonces) {
    const signedTransaction = await FACT_ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: FACT_IDENTITY.chainId,
      nonce,
      gas: 21_000n,
      to: FACT_ACCOUNT.address,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    attempts.push({
      attemptId: `11111111-1111-4111-8111-11111111111${nonce}`,
      workId: `test-work:${nonce}`,
      nonce: BigInt(nonce),
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      replacementSearch: {
        lowerBound: factObservation(100n, BigInt(nonces[0]!)),
        searchedThrough: null,
        exhausted: null,
      },
    });
  }

  return {
    version: 1,
    identity: FACT_IDENTITY,
    baseline: factObservation(100n, BigInt(nonces[0]!)),
    lastObservation: factObservation(100n, BigInt(nonces[0]!)),
    nextNonce: 6n,
    durableNextNonce: BigInt(nonces[0]!),
    repairs: [],
    ledger: { outcomes: [], obligations: [] },
    attempts,
  };
}


export const FACT_CONFLICT = {
  reason: 'stored-fact-nonce-conflict' as const,
  anchor: factAnchor(120n),
  first: {
    attemptId: '11111111-1111-4111-8111-111111111114',
    kind: 'exhausted' as const,
    nonce: 6n,
    source: 'candidate' as const,
  },
  second: {
    attemptId: '11111111-1111-4111-8111-111111111115',
    kind: 'lowerBound' as const,
    nonce: 5n,
    source: 'retained' as const,
  },
};
