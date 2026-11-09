import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
  type Hash,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  SignedRelayerTransaction,
} from '../../src/chain/sign-prepared-transaction.js';

import {
  planAttemptPreparation,
} from '../../src/state/plan-attempt-preparation.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const EXISTING_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-10-04T00:01:00.000Z';

function anchorAt(blockNumber: bigint) {
  return {
    blockNumber,
    blockHash:
      `0x${blockNumber.toString(16).padStart(64, '0')}` as Hash,
  };
}

function observationAt(blockNumber: bigint, nonce: bigint) {
  return {
    anchor: anchorAt(blockNumber),
    nonce,
  };
}

async function sign(
  nonce: number,
): Promise<SignedRelayerTransaction> {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  return {
    nonce: BigInt(nonce),
    transactionHash: keccak256(signedTransaction),
    signedTransaction,
  };
}

function emptySnapshot(): TransactionJournalSnapshot {
  return {
    version: 1,
    identity: IDENTITY,
    baseline: observationAt(100n, 4n),
    lastObservation: observationAt(100n, 4n),
    nextNonce: 4n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: [],
  };
}

async function retainedSnapshot(): Promise<TransactionJournalSnapshot> {
  const signed = await sign(4);
  const snapshot = emptySnapshot();

  return {
    ...snapshot,
    lastObservation: observationAt(105n, 5n),
    nextNonce: 5n,
    attempts: [{
      attemptId: EXISTING_ID,
      workId: 'test-work:existing',
      nonce: 4n,
      createdAt: '2026-10-04T00:00:00.000Z',
      signedTransactions: [{
        transactionHash: signed.transactionHash,
        signedTransaction: signed.signedTransaction,
      }],
      phase: 'included',
      inclusion: {
        outcome: 'success',
        transactionHash: signed.transactionHash,
        inclusion: anchorAt(102n),
        observedAt: anchorAt(105n),
      },
      replacementSearch: {
        exhausted: null,
        lowerBound: snapshot.baseline,
        searchedThrough: null,
      },
    }],
  };
}

function plan(
  snapshot: TransactionJournalSnapshot,
  signed: SignedRelayerTransaction,
  workId = 'test-work:new',
) {
  return planAttemptPreparation({
    identity: IDENTITY,
    snapshot,
    attemptId: NEW_ID,
    workId,
    createdAt: CREATED_AT,
    signed,
  });
}

describe('attempt preparation planning', () => {
  it('allocates the next nonce and records exact signed bytes without advancing durable progress', async () => {
    const snapshot = emptySnapshot();
    const signed = await sign(4);
    const beforeSnapshot = structuredClone(snapshot);
    const beforeSigned = structuredClone(signed);

    const next = plan(snapshot, signed);

    expect(next).toEqual({
      ...snapshot,
      nextNonce: 5n,
      attempts: [{
        attemptId: NEW_ID,
        workId: 'test-work:new',
        nonce: 4n,
        createdAt: CREATED_AT,
        signedTransactions: [{
          transactionHash: signed.transactionHash,
          signedTransaction: signed.signedTransaction,
        }],
        phase: 'signed',
        inclusion: null,
        replacementSearch: {
          exhausted: null,
          lowerBound: snapshot.lastObservation,
          searchedThrough: null,
        },
      }],
    });
    expect(next.durableNextNonce).toBe(4n);

    expect(snapshot).toEqual(beforeSnapshot);
    expect(signed).toEqual(beforeSigned);
  });

  it('appends after retained inclusion and uses the last observation as the new search lower bound', async () => {
    const snapshot = await retainedSnapshot();
    const signed = await sign(5);
    const beforeSnapshot = structuredClone(snapshot);
    const beforeSigned = structuredClone(signed);

    const next = plan(snapshot, signed);

    expect(next.nextNonce).toBe(6n);
    expect(next.durableNextNonce).toBe(4n);
    expect(next.baseline).toEqual(snapshot.baseline);
    expect(next.lastObservation).toEqual(snapshot.lastObservation);
    expect(next.repairs).toEqual(snapshot.repairs);

    expect(next.attempts).toHaveLength(2);
    expect(next.attempts[0]).toEqual(snapshot.attempts[0]);
    expect(next.attempts[1]).toEqual({
      attemptId: NEW_ID,
      workId: 'test-work:new',
      nonce: 5n,
      createdAt: CREATED_AT,
      signedTransactions: [{
        transactionHash: signed.transactionHash,
        signedTransaction: signed.signedTransaction,
      }],
      phase: 'signed',
      inclusion: null,
      replacementSearch: {
        exhausted: null,
        lowerBound: snapshot.lastObservation,
        searchedThrough: null,
      },
    });

    expect(snapshot).toEqual(beforeSnapshot);
    expect(signed).toEqual(beforeSigned);
  });

  it('rejects a signed nonce that skips the next allocation', async () => {
    const snapshot = emptySnapshot();
    const signed = await sign(5);
    const beforeSnapshot = structuredClone(snapshot);
    const beforeSigned = structuredClone(signed);

    expect(() => plan(snapshot, signed)).toThrow();

    expect(snapshot).toEqual(beforeSnapshot);
    expect(signed).toEqual(beforeSigned);
  });

  it('rejects duplicate retained work without modifying the existing attempt', async () => {
    const snapshot = await retainedSnapshot();
    const signed = await sign(5);
    const beforeSnapshot = structuredClone(snapshot);
    const beforeSigned = structuredClone(signed);

    expect(() => plan(
      snapshot,
      signed,
      'test-work:existing',
    )).toThrow();

    expect(snapshot).toEqual(beforeSnapshot);
    expect(signed).toEqual(beforeSigned);
  });
});