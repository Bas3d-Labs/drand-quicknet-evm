import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  durableRecoveryRevision,
} from '../../src/state/durable-recovery-revision.js';

import type {
  CoordinatorBlocker,
} from '../../src/state/signer-gate.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;
const SIGNER = `0x${'11'.repeat(20)}` as const;

function anchor(blockNumber: bigint) {
  return {
    blockNumber,
    blockHash: HASH,
  };
}

function snapshot(): TransactionJournalSnapshot {
  const baseline = {
    anchor: anchor(100n),
    nonce: 4n,
  };

  return {
    version: 1,
    identity: {
      chainId: 4663,
      signer: SIGNER,
    },
    baseline,
    lastObservation: baseline,
    nextNonce: 6n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: [4n, 5n].map((nonce) => ({
      attemptId:
        '00000000-0000-4000-8000-'
        + nonce.toString().padStart(12, '0'),
      workId: `test-work:${nonce}`,
      nonce,
      createdAt: '2026-10-24T12:00:00.000Z',
      // Opaque bytes for a pure projection test. This helper does not
      // perform the journal boundary's signature validation.
      signedTransactions: [{
        transactionHash: HASH,
        signedTransaction: '0x01',
      }],
      phase: 'included',
      inclusion: {
        outcome: 'success',
        transactionHash: HASH,
        inclusion: anchor(105n + nonce - 4n),
        observedAt: anchor(110n),
      },
      replacementSearch: {
        lowerBound: baseline,
        searchedThrough: null,
      },
    })),
  };
}

function replacedSnapshot(): TransactionJournalSnapshot {
  const input = snapshot();

  return {
    ...input,
    attempts: input.attempts.map((attempt) => ({
      ...attempt,
      phase: 'included',
      inclusion: {
        outcome: 'replaced',
        replacementTransactionHash: OTHER,
        nonceAtAnchor: 6n,
        inclusion: anchor(105n + attempt.nonce - 4n),
        observedAt: anchor(110n),
      },
    })),
  };
}

function revision(
  input: TransactionJournalSnapshot,
  blockers: readonly CoordinatorBlocker[] = [],
): string {
  return durableRecoveryRevision(
    { kind: 'present', snapshot: input },
    new Set(blockers),
  );
}

describe('durable recovery revision', () => {
  it('ignores durable/latest nonce observation oscillation 4→6→4→6', () => {
    const input = snapshot();
    const before = revision(input);

    for (const nonce of [4n, 6n, 4n, 6n]) {
      expect(revision({
        ...input,
        lastObservation: {
          anchor: anchor(110n),
          nonce,
        },
      })).toBe(before);
    }
  });

  it('ignores creation time and inclusion observation refreshes', () => {
    const input = snapshot();
    const before = revision(input);

    const refreshed: TransactionJournalSnapshot = {
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (attempt.phase !== 'included') {
          throw new Error('Expected an included fixture attempt.');
        }

        return {
          ...attempt,
          createdAt: '2026-10-24T13:00:00.000Z',
          inclusion: {
            ...attempt.inclusion,
            observedAt: anchor(120n),
          },
        };
      }),
    };

    expect(revision(refreshed)).toBe(before);
  });

  it('compares content rather than object identity', () => {
    const input = snapshot();

    expect(revision(structuredClone(input))).toBe(revision(input));
  });

  it('normalizes hash casing throughout recovery evidence', () => {
    const input = snapshot();
    const upper = `0x${'AA'.repeat(32)}` as const;

    const changed: TransactionJournalSnapshot = {
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (
          attempt.phase !== 'included' ||
          attempt.inclusion.outcome === 'replaced' ||
          attempt.replacementSearch === null
        ) {
          throw new Error('Unexpected fixture evidence.');
        }

        return {
          ...attempt,
          signedTransactions: [{
            ...attempt.signedTransactions[0],
            transactionHash: upper,
          }],
          inclusion: {
            ...attempt.inclusion,
            transactionHash: upper,
            inclusion: {
              ...attempt.inclusion.inclusion,
              blockHash: upper,
            },
          },
          replacementSearch: {
            ...attempt.replacementSearch,
            lowerBound: {
              ...attempt.replacementSearch.lowerBound,
              anchor: {
                ...attempt.replacementSearch.lowerBound.anchor,
                blockHash: upper,
              },
            },
          },
        };
      }),
    };

    expect(revision(changed)).toBe(revision(input));
  });

  it.each(['nextNonce', 'durableNextNonce'] as const)(
    'changes when %s changes',
    (field) => {
      const input = snapshot();

      expect(revision({
        ...input,
        [field]: input[field] + 1n,
      })).not.toBe(revision(input));
    },
  );

  it('changes when the retained population changes', () => {
    const input = snapshot();

    expect(revision({
      ...input,
      attempts: input.attempts.slice(1),
    })).not.toBe(revision(input));
  });

  it('changes when inclusion evidence is invalidated', () => {
    const input = snapshot();

    expect(revision({
      ...input,
      attempts: input.attempts.map((attempt) => ({
        ...attempt,
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      })),
    })).not.toBe(revision(input));
  });

  it('changes when a candidate hash changes without a count change', () => {
    const input = snapshot();

    expect(revision({
      ...input,
      attempts: input.attempts.map((attempt) => ({
        ...attempt,
        signedTransactions: [{
          ...attempt.signedTransactions[0],
          transactionHash: OTHER,
        }],
      })),
    })).not.toBe(revision(input));
  });

  it('changes when an inclusion block hash changes', () => {
    const input = snapshot();

    expect(revision({
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (attempt.phase !== 'included') {
          throw new Error('Expected an included fixture attempt.');
        }

        return {
          ...attempt,
          inclusion: {
            ...attempt.inclusion,
            inclusion: {
              ...attempt.inclusion.inclusion,
              blockHash: OTHER,
            },
          },
        };
      }),
    })).not.toBe(revision(input));
  });

  it('changes when replacement search progress changes', () => {
    const input = snapshot();

    expect(revision({
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (attempt.replacementSearch === null) {
          throw new Error('Expected a replacement search.');
        }

        return {
          ...attempt,
          replacementSearch: {
            ...attempt.replacementSearch,
            searchedThrough: anchor(102n),
          },
        };
      }),
    })).not.toBe(revision(input));
  });

  it.each([
    'unattributed-signer-activity',
    'conflict-search-exhausted',
  ] as const)('changes when persistent blocker %s changes', (blocker) => {
    const input = snapshot();
    const unblocked = revision(input);
    const blocked = revision(input, [blocker]);

    expect(blocked).not.toBe(unblocked);
    expect(revision(input, [])).toBe(unblocked);
  });

  it('orders persistent blockers independently of insertion order', () => {
    const input = snapshot();

    expect(revision(input, [
      'unattributed-signer-activity',
      'conflict-search-exhausted',
    ])).toBe(revision(input, [
      'conflict-search-exhausted',
      'unattributed-signer-activity',
    ]));
  });

  it('distinguishes a missing journal from an initialized empty journal', () => {
    const missing: TransactionJournalRead = { kind: 'missing' };
    const input = snapshot();

    const empty: TransactionJournalSnapshot = {
      ...input,
      nextNonce: 4n,
      durableNextNonce: 4n,
      attempts: [],
    };

    expect(durableRecoveryRevision(
      missing,
      new Set<CoordinatorBlocker>(),
    )).not.toBe(revision(empty));
  });

  it('does not mutate the input', () => {
    const input = snapshot();
    const before = structuredClone(input);

    revision(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('preserves replaced evidence revision across observation refreshes', () => {
    const input = replacedSnapshot();

    const refreshed: TransactionJournalSnapshot = {
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (
          attempt.phase !== 'included' ||
          attempt.inclusion.outcome !== 'replaced'
        ) {
          throw new Error('Expected replacement evidence.');
        }

        return {
          ...attempt,
          inclusion: {
            ...attempt.inclusion,
            observedAt: anchor(120n),
          },
        };
      }),
    };

    expect(revision(refreshed)).toBe(revision(input));
  });

  it('normalizes replacement transaction hash casing', () => {
    const input = replacedSnapshot();

    const changed: TransactionJournalSnapshot = {
      ...input,
      attempts: input.attempts.map((attempt) => {
        if (
          attempt.phase !== 'included' ||
          attempt.inclusion.outcome !== 'replaced'
        ) {
          throw new Error('Expected replacement evidence.');
        }

        return {
          ...attempt,
          inclusion: {
            ...attempt.inclusion,
            replacementTransactionHash: `0x${'BB'.repeat(32)}`,
          },
        };
      }),
    };

    expect(revision(changed)).toBe(revision(input));
  });

  it.each(['replacementTransactionHash', 'nonceAtAnchor'] as const)(
    'changes when replacement evidence %s changes',
    (field) => {
      const input = replacedSnapshot();

      const changed: TransactionJournalSnapshot = {
        ...input,
        attempts: input.attempts.map((attempt) => {
          if (
            attempt.phase !== 'included' ||
            attempt.inclusion.outcome !== 'replaced'
          ) {
            throw new Error('Expected replacement evidence.');
          }

          if (field === 'replacementTransactionHash') {
            return {
              ...attempt,
              inclusion: {
                ...attempt.inclusion,
                replacementTransactionHash: `0x${'cc'.repeat(32)}`,
              },
            };
          }

          return {
            ...attempt,
            inclusion: {
              ...attempt.inclusion,
              nonceAtAnchor: 7n,
            },
          };
        }),
      };

      expect(revision(changed)).not.toBe(revision(input));
    },
  );
});