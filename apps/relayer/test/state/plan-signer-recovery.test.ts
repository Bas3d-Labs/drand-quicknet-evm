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
  SignerRecoveryInspection,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import type {
  JournalAttempt,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

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
  const attempts: JournalAttempt[] = [];

  for (const nonce of [4, 5]) {
    const signedTransaction = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: IDENTITY.chainId,
      nonce,
      gas: 21_000n,
      to: ACCOUNT.address,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    attempts.push({
      attemptId: `11111111-1111-4111-8111-11111111111${nonce}`,
      workId: `test-work:${nonce}`,
      nonce: BigInt(nonce),
      createdAt: '2026-10-04T00:00:00.000Z',
      signedTransactions: [{
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      }],
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: null,
    });
  }

  return {
    version: 1,
    identity: IDENTITY,
    baseline: observationAt(100n, 4n),
    lastObservation: observationAt(100n, 4n),
    nextNonce: 6n,
    durableNextNonce: 4n,
    repairs: [],
    attempts,
  };
}

function plan(
  snapshot: TransactionJournalSnapshot,
  inspection: SignerRecoveryInspection,
  unattributedActivity = false,
) {
  return planSignerRecovery({
    identity: IDENTITY,
    snapshot,
    inspection,
    unattributedActivity,
  });
}

describe('signer recovery planning', () => {
  it.each([
    'anchor-changed',
    'nonce-behind-journal',
    'inconsistent-observations',
  ] as const)('leaves the journal unchanged after %s', async (status) => {
    const snapshot = await createSnapshot();
    const before = structuredClone(snapshot);

    let inspection: SignerRecoveryInspection;

    if (status === 'anchor-changed') {
      inspection = {
        status,
        observedAnchor: anchorAt(105n),
      };
    } else {
      inspection = {
        status,
        observation: observationAt(105n, 3n),
      };
    }

    expect(plan(snapshot, inspection)).toEqual({
      kind: 'unchanged',
      reason: 'inspection-not-committable',
    });
    expect(snapshot).toEqual(before);
  });

  it.each([
    {
      status: 'boundary-changed',
      boundary: 'lower-bound',
      observedAnchor: anchorAt(100n),
    },
    {
      status: 'anchor-behind-search',
    },
  ] as const)(
    'classifies $status before considering higher-observation preservation',
    async (search) => {
      const original = await createSnapshot();
      const snapshot: TransactionJournalSnapshot = {
        ...original,
        lastObservation: observationAt(110n, 7n),
      };
      const before = structuredClone(snapshot);

      const result = plan(snapshot, {
        status: 'unresolved',
        observation: observationAt(105n, 5n),
        receipt: {
          status: 'receipt-not-found',
        },
        search,
      }, true);

      expect(result).toEqual({
        kind: 'unchanged',
        reason: 'inspection-not-committable',
      });
      expect(snapshot).toEqual(before);
    },
  );

  it.each(['success', 'reverted'] as const)(
    'removes only the oldest attempt after %s',
    async (outcome) => {
      const snapshot = await createSnapshot();
      const before = structuredClone(snapshot);
      const oldest = snapshot.attempts[0]!;
      const transactionHash =
        oldest.signedTransactions[0].transactionHash;

      const inspection: SignerRecoveryInspection = {
        status: 'resolution-available',
        observation: observationAt(105n, 5n),
        evidence: {
          outcome,
          transactionHash,
          anchor: anchorAt(105n),
          inclusion: anchorAt(102n),
        },
      };

      const result = plan(snapshot, inspection);

      expect(result.kind).toBe('persist');
      if (result.kind !== 'persist') {
        throw new Error('Expected a persistence plan.');
      }

      expect(result.snapshot.nextNonce).toBe(6n);
      expect(result.snapshot.durableNextNonce).toBe(5n);
      expect(result.snapshot.attempts).toEqual([
        snapshot.attempts[1],
      ]);
      expect(result.snapshot.lastObservation).toEqual(
        inspection.observation,
      );
      expect(result.completion).toEqual({
        kind: 'resolution',
        event: {
          signer: IDENTITY.signer,
          attemptId: oldest.attemptId,
          transactionHash,
          nonce: 4n,
          resolution: inspection.evidence,
        },
      });
      expect(snapshot).toEqual(before);
    },
  );

  it('preserves higher unattributed activity while resolving the oldest attempt', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(110n, 7n),
    };
    const before = structuredClone(snapshot);

    const result = plan(snapshot, {
      status: 'resolution-available',
      observation: observationAt(105n, 5n),
      evidence: {
        outcome: 'success',
        transactionHash:
          snapshot.attempts[0]!.signedTransactions[0].transactionHash,
        anchor: anchorAt(105n),
        inclusion: anchorAt(102n),
      },
    }, true);

    expect(result.kind).toBe('persist');
    if (result.kind !== 'persist') {
      throw new Error('Expected a persistence plan.');
    }

    expect(result.snapshot.lastObservation).toEqual(
      snapshot.lastObservation,
    );
    expect(result.snapshot.nextNonce).toBe(6n);
    expect(result.snapshot.durableNextNonce).toBe(5n);
    expect(result.snapshot.attempts).toEqual([
      snapshot.attempts[1],
    ]);
    expect(snapshot).toEqual(before);
  });

  it('does not overwrite higher unattributed activity with an unresolved observation', async () => {
    const original = await createSnapshot();
    const snapshot: TransactionJournalSnapshot = {
      ...original,
      lastObservation: observationAt(110n, 7n),
    };
    const before = structuredClone(snapshot);

    const result = plan(snapshot, {
      status: 'unresolved',
      observation: observationAt(105n, 5n),
      receipt: {
        status: 'receipt-not-found',
      },
      search: null,
    }, true);

    expect(result).toEqual({
      kind: 'unchanged',
      reason: 'preserved-higher-observation',
    });
    expect(snapshot).toEqual(before);
  });

  it.each([
    { through: 102n, scanned: 2n, remaining: 3n, exhausted: false },
    { through: 105n, scanned: 5n, remaining: 0n, exhausted: true },
  ])(
    'records search progress without resolving; exhausted: $exhausted',
    async ({ through, scanned, remaining, exhausted }) => {
      const snapshot = await createSnapshot();
      const before = structuredClone(snapshot);
      const observation = observationAt(105n, 5n);

      const result = plan(snapshot, {
        status: 'unresolved',
        observation,
        receipt: {
          status: 'receipt-not-found',
        },
        search: {
          status: 'not-found',
          searchedThrough: anchorAt(through),
          scannedBlocks: scanned,
          remainingBlocks: remaining,
        },
      });

      expect(result.kind).toBe('persist');
      if (result.kind !== 'persist') {
        throw new Error('Expected a persistence plan.');
      }

      expect(result.completion).toEqual({
        kind: 'search-progress',
        exhausted,
      });
      expect(result.snapshot.nextNonce).toBe(6n);
      expect(result.snapshot.durableNextNonce).toBe(4n);
      expect(result.snapshot.lastObservation).toEqual(observation);
      expect(result.snapshot.attempts).toEqual([
        {
          ...snapshot.attempts[0],
          replacementSearch: {
            lowerBound: snapshot.lastObservation,
            searchedThrough: anchorAt(through),
          },
        },
        snapshot.attempts[1],
      ]);
      expect(snapshot).toEqual(before);
    },
  );

  it('rejects resolution evidence belonging to a later attempt', async () => {
    const snapshot = await createSnapshot();
    const before = structuredClone(snapshot);

    expect(() => plan(snapshot, {
      status: 'resolution-available',
      observation: observationAt(105n, 6n),
      evidence: {
        outcome: 'success',
        transactionHash:
          snapshot.attempts[1]!.signedTransactions[0].transactionHash,
        anchor: anchorAt(105n),
        inclusion: anchorAt(102n),
      },
    })).toThrow('Invalid attempt resolution evidence.');

    expect(snapshot).toEqual(before);
  });
});
