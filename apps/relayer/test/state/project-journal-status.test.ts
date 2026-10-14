import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  projectJournalStatus,
} from '../../src/state/project-journal-status.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

const SIGNER = `0x${'ab'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
const AT = '2026-10-12T12:00:00.000Z';

function snapshot(): TransactionJournalSnapshot {
  return {
    version: 1,
    identity: {
      chainId: 4663,
      signer: SIGNER,
    },
    baseline: {
      anchor: {
        blockNumber: 90n,
        blockHash: HASH,
      },
      nonce: 4n,
    },
    lastObservation: {
      anchor: {
        blockNumber: 110n,
        blockHash: HASH,
      },
      nonce: 8n,
    },
    nextNonce: 8n,
    durableNextNonce: 8n,
    repairs: [{
      kind: 'sync-nonce',
      at: AT,
      previousNextNonce: 4n,
      nextNonce: 8n,
      observation: {
        anchor: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        nonce: 8n,
      },
    }],
    attempts: [],
  };
}

describe('projectJournalStatus', () => {
  it('reports a missing journal without claiming readiness', () => {
    expect(projectJournalStatus({ kind: 'missing' })).toEqual({
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    });
  });

  it('projects allocation and repair history into JSON-safe fields', () => {
    const result = projectJournalStatus({
      kind: 'present',
      snapshot: snapshot(),
    });

    expect(result).toEqual({
      source: 'journal',
      journal: 'present',
      gate: 'unknown',
      identity: {
        chainId: 4663,
        signer: SIGNER,
      },
      baseline: {
        anchor: {
          blockNumber: '90',
          blockHash: HASH,
        },
        nonce: '4',
      },
      lastObservation: {
        anchor: {
          blockNumber: '110',
          blockHash: HASH,
        },
        nonce: '8',
      },
      nextNonce: '8',
      durableNextNonce: '8',
      attempts: [],
      repairs: [{
        kind: 'sync-nonce',
        at: AT,
        previousNextNonce: '4',
        nextNonce: '8',
        observation: {
          anchor: {
            blockNumber: '110',
            blockHash: HASH,
          },
          nonce: '8',
        },
      }],
    });

    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('excludes signed bytes and undeclared fields without mutating input', () => {
    // This projection test uses synthetic bytes. Signature verification
    // belongs to the journal reader, upstream of this function.
    const signedBytes = '0xdeadbeef' as const;
    const canary = 'must-not-appear-in-status';
    const workId = ' work:e\u0301 ';
    const base = snapshot();

    const input = {
      ...base,
      nextNonce: 9n,
      extra: canary,
      identity: {
        ...base.identity,
        extra: canary,
      },
      attempts: [{
        attemptId: 'attempt-1',
        workId,
        nonce: 8n,
        createdAt: AT,
        phase: 'signed' as const,
        signedTransactions: [{
          transactionHash: HASH,
          signedTransaction: signedBytes,
          extra: canary,
        }] as const,
        replacementSearch: null,
        inclusion: null,
        extra: canary,
      }],
    };

    const before = structuredClone(input);

    const result = projectJournalStatus({
      kind: 'present',
      snapshot: input,
    });

    expect(result.journal).toBe('present');

    if (result.journal !== 'present') {
      throw new Error('Expected a present journal.');
    }

    expect(result.attempts).toEqual([{
      attemptId: 'attempt-1',
      workId,
      nonce: '8',
      createdAt: AT,
      phase: 'signed',
      transactionHashes: [HASH],
    }]);

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(signedBytes);
    expect(serialized).not.toContain('signedTransaction');
    expect(serialized).not.toContain(canary);
    expect(input).toEqual(before);

    // The result must not retain mutable references into journal state.
    input.identity.chainId = 999;
    input.attempts[0]!.workId = 'different-work';

    expect(result.identity.chainId).toBe(4663);
    expect(result.attempts[0]!.workId).toBe(workId);
  });
});