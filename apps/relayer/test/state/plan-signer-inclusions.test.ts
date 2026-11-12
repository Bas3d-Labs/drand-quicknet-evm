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
  SignerInclusionInspection,
} from '../../src/chain/inspect-signer-inclusions.js';

import {
  planSignerInclusions,
} from '../../src/state/plan-signer-inclusions.js';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

type Inspected = Extract<
  SignerInclusionInspection,
  { status: 'inspected' }
>;

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

async function createSnapshot(): Promise<TransactionJournalSnapshot> {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  return {
    version: 1,
    identity: IDENTITY,
    baseline: observationAt(100n, 4n),
    lastObservation: observationAt(100n, 4n),
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      workId: 'test-work:4',
      nonce: 4n,
      createdAt: '2026-10-04T00:00:00.000Z',
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: null,
    }],
  };
}

function includedAttempt(
  attempt: JournalAttempt,
): JournalAttempt {
  return {
    ...attempt,
    phase: 'included',
    inclusion: {
      outcome: 'success',
      transactionHash: attempt.signedTransactions[0].transactionHash,
      inclusion: anchorAt(102n),
      observedAt: anchorAt(105n),
    },
  };
}

function plan(
  snapshot: TransactionJournalSnapshot,
  inspection: Inspected,
  unattributedActivity = false,
) {
  return planSignerInclusions({
    identity: IDENTITY,
    snapshot,
    inspection,
    unattributedActivity,
  });
}

describe('signer inclusion planning', () => {
  it('records inclusion without removing the attempt or advancing nonce counters', async () => {
    const snapshot = await createSnapshot();
    const inspection: Inspected = {
      observations: [],
      status: 'inspected',
      observation: observationAt(105n, 5n),
      attempts: [includedAttempt(snapshot.attempts[0]!)],
      inclusionChecksComplete: true,
      broadcastAttemptId: null,
    };

    const beforeSnapshot = structuredClone(snapshot);
    const beforeInspection = structuredClone(inspection);

    const next = plan(snapshot, inspection);

    expect(next).toEqual({
      ...snapshot,
      lastObservation: inspection.observation,
      attempts: inspection.attempts,
    });
    expect(next.nextNonce).toBe(5n);
    expect(next.durableNextNonce).toBe(4n);
    expect(next.attempts).toHaveLength(1);

    expect(snapshot).toEqual(beforeSnapshot);
    expect(inspection).toEqual(beforeInspection);
  });

  it('preserves higher unattributed activity while accepting inclusion updates', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(110n, 7n),
    };
    const inspection: Inspected = {
      observations: [],
      status: 'inspected',
      observation: observationAt(105n, 5n),
      attempts: [includedAttempt(snapshot.attempts[0]!)],
      inclusionChecksComplete: true,
      broadcastAttemptId: null,
    };

    const beforeSnapshot = structuredClone(snapshot);
    const beforeInspection = structuredClone(inspection);

    const next = plan(snapshot, inspection, true);

    expect(next).toEqual({
      ...snapshot,
      attempts: inspection.attempts,
    });
    expect(next.lastObservation).toEqual(
      observationAt(110n, 7n),
    );

    expect(snapshot).toEqual(beforeSnapshot);
    expect(inspection).toEqual(beforeInspection);
  });

  it('accepts a newer equal-nonce observation while unattributed activity remains', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(110n, 7n),
    };
    const inspection: Inspected = {
      observations: [],
      status: 'inspected',
      observation: observationAt(115n, 7n),
      attempts: snapshot.attempts,
      inclusionChecksComplete: false,
      broadcastAttemptId: null,
    };

    const next = plan(snapshot, inspection, true);

    expect(next).toEqual({
      ...snapshot,
      lastObservation: inspection.observation,
    });
  });

  it('accepts a lower observation when excess-activity preservation is not active', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(110n, 5n),
    };
    const inspection: Inspected = {
      observations: [],
      status: 'inspected',
      observation: observationAt(115n, 4n),
      attempts: snapshot.attempts,
      inclusionChecksComplete: false,
      broadcastAttemptId: snapshot.attempts[0]!.attemptId,
    };

    const next = plan(snapshot, inspection);

    expect(next).toEqual({
      ...snapshot,
      lastObservation: inspection.observation,
    });
  });

  it('records invalidated inclusion without rolling back allocation or dropping signed bytes', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(105n, 5n),
      attempts: [includedAttempt(original.attempts[0]!)],
    };

    const invalidated: JournalAttempt = {
      ...snapshot.attempts[0]!,
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
    };

    const inspection: Inspected = {
      observations: [],
      status: 'inspected',
      observation: observationAt(110n, 4n),
      attempts: [invalidated],
      inclusionChecksComplete: false,
      broadcastAttemptId: invalidated.attemptId,
    };

    const beforeSnapshot = structuredClone(snapshot);
    const beforeInspection = structuredClone(inspection);

    const next = plan(snapshot, inspection);

    expect(next).toEqual({
      ...snapshot,
      lastObservation: inspection.observation,
      attempts: [invalidated],
    });
    expect(next.nextNonce).toBe(5n);
    expect(next.durableNextNonce).toBe(4n);
    expect(next.attempts[0]!.signedTransactions).toEqual(
      original.attempts[0]!.signedTransactions,
    );

    expect(snapshot).toEqual(beforeSnapshot);
    expect(inspection).toEqual(beforeInspection);
  });
});