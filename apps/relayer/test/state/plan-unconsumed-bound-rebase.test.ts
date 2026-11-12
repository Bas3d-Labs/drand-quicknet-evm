import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import type {
  RequiredUnconsumedRebase,
} from '../../src/state/validate-unconsumed-bound-rebase.js';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const oldHash = `0x${'aa'.repeat(32)}` as const;
const newHash = `0x${'bb'.repeat(32)}` as const;
const anchor = (
  blockNumber: bigint,
  blockHash: `0x${string}` = newHash,
) => ({
  blockNumber,
  blockHash,
});

async function fixture() {
  const signedTransaction = await account.signTransaction({
    chainId: 4663,
    nonce: 4,
    gas: 21000n,
    to: account.address,
    type: 'eip1559',
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  const lowerBound = {
    anchor: anchor(98n, oldHash),
    nonce: 4n,
  };
  const fact = {
    anchor: anchor(100n, oldHash),
    nonce: 5n,
  };
  const observation = {
    anchor: anchor(104n),
    nonce: 4n,
  };
  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: {
      chainId: 4663,
      signer: account.address,
    },
    baseline: lowerBound,
    lastObservation: {
      anchor: anchor(130n, oldHash),
      nonce: 5n,
    },
    nextNonce: 5n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      workId: 'work:4',
      nonce: 4n,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      signedTransactions: [{
        signedTransaction,
        transactionHash: keccak256(signedTransaction),
      }],
      replacementSearch: {
        lowerBound,
        searchedThrough: fact.anchor,
        exhausted: fact,
      },
    }],
  };
  const inspection: RequiredUnconsumedRebase = {
    status: 'search-unconsumed-bound-rebase-required',
    attemptId: snapshot.attempts[0]!.attemptId,
    observation,
    observations: [anchor(98n), anchor(100n)],
    rebase: {
      opening: observation.anchor,
      closing: observation.anchor,
      lowerBound: structuredClone(lowerBound),
      fact: structuredClone(fact),
      observedLower: anchor(98n),
      observedFact: anchor(100n),
    },
  };
  const plan = (preserve = false) => planSignerRecovery({
    identity: snapshot.identity,
    snapshot,
    inspection,
    unattributedActivity: preserve,
  });

  return {
    snapshot,
    inspection,
    plan,
  };
}

describe('unconsumed bound rebase planner', () => {
  it.each([
    {
      preserve: false,
      included: false,
    },
    {
      preserve: true,
      included: false,
    },
    {
      preserve: false,
      included: true,
    },
  ])(
    'commits only the correction fields: %j',
    async ({ preserve, included }) => {
      const t = await fixture();

      if (preserve) {
        Object.assign(t.snapshot, {
          lastObservation: {
            anchor: anchor(130n, oldHash),
            nonce: 9n,
          },
        });
      }

      if (included) {
        Object.assign(t.snapshot.attempts[0]!, {
          phase: 'included',
          inclusion: {
            outcome: 'success',
            transactionHash: t.snapshot.attempts[0]!.signedTransactions[0].transactionHash,
            inclusion: anchor(106n),
            observedAt: anchor(110n),
          },
        });
      }

      const before = structuredClone(t.snapshot);
      const result = t.plan(preserve);

      expect(result.kind).toBe('persist');

      if (result.kind !== 'persist') {
        throw new Error('expected persistence');
      }

      let lastObservation = t.inspection.observation;

      if (preserve) {
        lastObservation = before.lastObservation;
      }

      expect(result.snapshot).toEqual({
        ...before,
        lastObservation,
        attempts: [{
          ...before.attempts[0]!,
          replacementSearch: {
            lowerBound: t.inspection.observation,
            searchedThrough: null,
            exhausted: null,
          },
        }],
      });
      expect(result.completion.kind).toBe('search-unconsumed-bound-rebase');

      const saved = structuredClone(result);

      Object.assign(t.inspection.rebase.observedFact, { blockHash: oldHash });

      expect(result).toEqual(saved);
      expect(t.snapshot).toEqual(before);
    },
  );

  it.each([
    'lower-nonce',
    'lower-hash',
    'fact-nonce',
    'fact-hash',
    'missing-fact',
    'canonical-lower',
    'canonical-fact',
    'closing',
    'opening',
    'nonce',
    'wrong-attempt',
    'missing-header',
    'conflicting-header',
    'above-D',
    'later-fact',
    'later-fact-above-D',
    'fact-at-D-nonce',
    'lower-at-D',
    'lower-above-D',
    'observed-lower-height',
    'observed-fact-height',
  ])(
    'refuses stale or invalid evidence: %s',
    async (fault) => {
      const t = await fixture();
      const e = t.inspection.rebase;

      switch (fault) {
        case 'lower-nonce':
          Object.assign(e.lowerBound, { nonce: 3n });
          break;
        case 'lower-hash':
          Object.assign(e.lowerBound, { anchor: anchor(98n) });
          break;
        case 'fact-nonce':
          Object.assign(e.fact, { nonce: 6n });
          break;
        case 'fact-hash':
          Object.assign(e.fact, { anchor: anchor(100n) });
          break;
        case 'missing-fact':
          Object.assign(t.snapshot.attempts[0]!.replacementSearch!, { exhausted: null });
          break;
        case 'canonical-lower':
          Object.assign(e, { observedLower: anchor(98n, oldHash) });
          break;
        case 'canonical-fact':
          Object.assign(e, { observedFact: anchor(100n, oldHash) });
          break;
        case 'closing':
          Object.assign(e, { closing: anchor(104n, oldHash) });
          break;
        case 'opening':
          Object.assign(e, { opening: anchor(104n, oldHash) });
          break;
        case 'nonce':
          Object.assign(t.inspection, {
            observation: {
              anchor: anchor(104n),
              nonce: 5n,
            },
          });
          break;
        case 'wrong-attempt':
          Object.assign(t.inspection, { attemptId: 'other' });
          break;
        case 'missing-header':
          Object.assign(t.inspection, { observations: [anchor(98n)] });
          break;
        case 'conflicting-header':
          Object.assign(t.inspection, {
            observations: [anchor(98n), anchor(100n), anchor(100n, oldHash)],
          });
          break;
        case 'above-D':
          Object.assign(t.inspection, {
            observations: [anchor(98n), anchor(100n), anchor(105n)],
          });
          break;
        case 'observed-lower-height':
          Object.assign(e, { observedLower: anchor(97n) });
          break;
        case 'observed-fact-height':
          Object.assign(e, { observedFact: anchor(101n) });
          break;
        case 'lower-at-D':
        case 'lower-above-D': {
          let height = 104n;

          if (fault === 'lower-above-D') {
            height = 105n;
          }

          const lowerBound = { anchor: anchor(height, oldHash), nonce: 4n };

          Object.assign(t.snapshot.attempts[0]!.replacementSearch!, { lowerBound });
          Object.assign(e, {
            lowerBound: structuredClone(lowerBound),
            observedLower: anchor(height),
          });
          break;
        }
        case 'later-fact-above-D':
        case 'fact-at-D-nonce': {
          let factAnchor = anchor(104n);

          if (fault === 'later-fact-above-D') {
            factAnchor = anchor(105n, oldHash);
          }

          Object.assign(t.snapshot, {
            attempts: [
              ...t.snapshot.attempts,
              {
                ...t.snapshot.attempts[0]!,
                attemptId: 'later',
                nonce: 5n,
                replacementSearch: {
                  lowerBound: t.snapshot.baseline,
                  searchedThrough: null,
                  exhausted: { anchor: factAnchor, nonce: 6n },
                },
              },
            ],
          });
          break;
        }
        case 'later-fact':
          Object.assign(t.snapshot, {
            attempts: [
              ...t.snapshot.attempts,
              {
                ...t.snapshot.attempts[0]!,
                attemptId: 'later',
                nonce: 5n,
                replacementSearch: {
                  lowerBound: t.snapshot.baseline,
                  searchedThrough: null,
                  exhausted: {
                    anchor: anchor(104n, oldHash),
                    nonce: 6n,
                  },
                },
              },
            ],
          });
          break;
      }

      expect(t.plan()).toEqual({
        kind: 'unchanged',
        reason: 'inspection-not-committable',
      });
    },
  );
});
