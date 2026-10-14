import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  planNonceSync,
  type PlanNonceSyncOptions,
} from '../../src/state/plan-nonce-sync.js';

import type {
  JournalAttempt,
  JournalNonceRepair,
} from '../../src/state/transaction-journal.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as const;

const IDENTITY = {
  chainId: 4663,
  signer: '0x1111111111111111111111111111111111111111',
} as const;

const AT = '2026-10-12T12:00:00.000Z';

function observation(nonce: bigint, blockNumber = 100n) {
  return {
    anchor: {
      blockNumber,
      blockHash: HASH,
    },
    nonce,
  };
}

function fixture(): PlanNonceSyncOptions {
  return {
    identity: IDENTITY,
    snapshot: {
      version: 1,
      identity: IDENTITY,
      baseline: observation(4n, 90n),
      lastObservation: observation(8n),
      nextNonce: 4n,
      durableNextNonce: 4n,
      attempts: [],
      repairs: [],
    },
    observation: observation(8n, 110n),
    latestNonce: 8n,
    pendingNonce: 8n,
    at: AT,
  };
}

describe('planNonceSync', () => {
  it('plans a forward repair while preserving the baseline and input', () => {
    const input = fixture();
    const before = structuredClone(input);

    const result = planNonceSync(input);

    expect(result.status).toBe('repair-available');

    if (result.status !== 'repair-available') {
      throw new Error('Expected a repair plan.');
    }

    expect(result.snapshot).toEqual({
      ...input.snapshot,
      lastObservation: input.observation,
      nextNonce: 8n,
      durableNextNonce: 8n,
      repairs: [{
        kind: 'sync-nonce',
        at: AT,
        previousNextNonce: 4n,
        nextNonce: 8n,
        observation: input.observation,
      }],
    });

    expect(result.snapshot.baseline).toEqual(input.snapshot.baseline);
    expect(result.snapshot.attempts).toEqual([]);
    expect(result.repair).toBe(result.snapshot.repairs[0]);
    expect(input).toEqual(before);

    for (const value of [
      result,
      result.snapshot,
      result.snapshot.repairs,
      result.repair,
      result.repair.observation,
      result.repair.observation.anchor,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('detects forward activity without requiring a previously persisted blocker', () => {
    const input = fixture();

    expect(planNonceSync({
      ...input,
      snapshot: {
        ...input.snapshot,
        lastObservation: observation(4n),
      },
    }).status).toBe('repair-available');
  });

  it('returns a no-op when allocation already matches the observations', () => {
    const input = fixture();

    expect(planNonceSync({
      ...input,
      snapshot: {
        ...input.snapshot,
        nextNonce: 8n,
        durableNextNonce: 8n,
      },
    })).toEqual({
      status: 'already-synchronized',
    });
  });

  it.each(['latestNonce', 'pendingNonce'] as const)(
    'defers when %s disagrees',
    (field) => {
      expect(planNonceSync({
        ...fixture(),
        [field]: 9n,
      })).toEqual({
        status: 'deferred',
        reason: 'nonce-count-mismatch',
      });
    },
  );

  it('refuses to move below previously recorded signer activity', () => {
    expect(planNonceSync({
      ...fixture(),
      observation: observation(6n, 110n),
      latestNonce: 6n,
      pendingNonce: 6n,
    })).toEqual({
      status: 'refused',
      reason: 'nonce-regression',
    });
  });

  it('refuses to move below journal allocation', () => {
    const input = fixture();

    expect(planNonceSync({
      ...input,
      snapshot: {
        ...input.snapshot,
        nextNonce: 9n,
        durableNextNonce: 9n,
      },
    })).toEqual({
      status: 'refused',
      reason: 'nonce-regression',
    });
  });

  it('refuses an observation older than the retained observation', () => {
    expect(planNonceSync({
      ...fixture(),
      observation: observation(8n, 99n),
    })).toEqual({
      status: 'refused',
      reason: 'anchor-regression',
    });
  });

  it('refuses a conflicting hash at the retained observation block', () => {
    expect(planNonceSync({
      ...fixture(),
      observation: {
        anchor: {
          blockNumber: 100n,
          blockHash: OTHER_HASH,
        },
        nonce: 8n,
      },
    })).toEqual({
      status: 'refused',
      reason: 'anchor-conflict',
    });
  });

  it('retains only the newest eight repairs in insertion order', () => {
    const input = fixture();

    const repairs: JournalNonceRepair[] = Array.from(
      { length: 8 },
      (_, index) => ({
        kind: 'sync-nonce',
        at: AT,
        previousNextNonce: BigInt(index + 4),
        nextNonce: BigInt(index + 5),
        observation: observation(BigInt(index + 5)),
      }),
    );

    const result = planNonceSync({
      ...input,
      snapshot: {
        ...input.snapshot,
        nextNonce: 12n,
        durableNextNonce: 12n,
        lastObservation: observation(14n),
        repairs,
      },
      observation: observation(14n, 110n),
      latestNonce: 14n,
      pendingNonce: 14n,
      // Clock regression must not reorder repair history.
      at: '2026-10-11T12:00:00.000Z',
    });

    if (result.status !== 'repair-available') {
      throw new Error('Expected a repair plan.');
    }

    expect(result.snapshot.repairs).toHaveLength(8);
    expect(result.snapshot.repairs.slice(0, 7)).toEqual(repairs.slice(1));
    expect(result.repair.previousNextNonce).toBe(12n);
    expect(result.repair.nextNonce).toBe(14n);
    expect(result.snapshot.repairs[7]).toBe(result.repair);
  });

  it('rejects a mismatched expected journal identity', () => {
    expect(() => planNonceSync({
      ...fixture(),
      identity: {
        ...IDENTITY,
        chainId: 46630,
      },
    })).toThrow(TypeError);
  });

  it.each([-1n, 1n << 256n])(
    'rejects an out-of-range nonce: %s',
    (nonce) => {
      expect(() => planNonceSync({
        ...fixture(),
        pendingNonce: nonce,
      })).toThrow('Invalid nonce sync count.');
    },
  );

  it('rejects an invalid repair timestamp', () => {
    expect(() => planNonceSync({
      ...fixture(),
      at: 'invalid',
    })).toThrow('Invalid nonce sync timestamp.');
  });

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)(
    'refuses a retained %s attempt',
    (phase) => {
      const input = fixture();

      const common = {
        attemptId: '11111111-1111-4111-8111-111111111111',
        workId: 'test-work:4',
        nonce: 4n,
        createdAt: AT,
        signedTransactions: [{
          transactionHash: HASH,
          // Structural fixture; this planner does not verify signatures.
          signedTransaction: `0x${'ab'.repeat(64)}` as const,
        }] as const,
        replacementSearch: null,
      };

      const attempt: JournalAttempt = phase === 'included'
        ? {
            ...common,
            phase,
            inclusion: {
              outcome: 'success',
              transactionHash: HASH,
              inclusion: {
                blockNumber: 101n,
                blockHash: HASH,
              },
              observedAt: {
                blockNumber: 105n,
                blockHash: HASH,
              },
            },
          }
        : {
            ...common,
            phase,
            inclusion: null,
          };

      const options: PlanNonceSyncOptions = {
        ...input,
        snapshot: {
          ...input.snapshot,
          nextNonce: 5n,
          durableNextNonce: 4n,
          attempts: [attempt],
        },
      };

      const before = structuredClone(options);

      expect(planNonceSync(options)).toEqual({
        status: 'refused',
        reason: 'retained-attempts',
      });

      expect(options).toEqual(before);
    },
  );
});