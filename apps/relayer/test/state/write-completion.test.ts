import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  describeWriteCompletion,
  type PendingWrite,
} from '../../src/state/write-completion.js';

import type {
  OperatorAttributedOutcome,
} from '../../src/state/transaction-journal.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const EVENT_SIGNER = `0x${'22'.repeat(20)}` as const;
const OLD_HASH = `0x${'33'.repeat(32)}` as const;
const OBSERVED_HASH = `0x${'44'.repeat(32)}` as const;
const REPLACEMENT_HASH = `0x${'55'.repeat(32)}` as const;
const DURABLE_HASH = `0x${'66'.repeat(32)}` as const;
const TRANSACTION_HASH = `0x${'77'.repeat(32)}` as const;
const FACT_HASH = `0x${'88'.repeat(32)}` as const;
const OBSERVED_FACT_HASH = `0x${'99'.repeat(32)}` as const;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

function attributedOutcome(): OperatorAttributedOutcome {
  return {
    kind: 'operator-attributed',
    requestId: REQUEST_ID,
    snapshotDigest: OLD_HASH,
    proposalDigest: OBSERVED_HASH,
    operator: 'test-operator',
    at: '2026-11-22T00:00:00.000Z',
    attemptId: ATTEMPT_ID,
    workId: 'test-work:4',
    nonce: 4n,
    candidateHashes: [TRANSACTION_HASH],
    durable: {
      anchor: { blockNumber: 200n, blockHash: DURABLE_HASH },
      nonce: 5n,
    },
    finality: { type: 'safe' },
    lowerBound: {
      anchor: { blockNumber: 100n, blockHash: OLD_HASH },
      nonce: 4n,
    },
    replacement: {
      transactionHash: REPLACEMENT_HASH,
      inclusion: { blockNumber: 150n, blockHash: REPLACEMENT_HASH },
    },
    priorSearch: {
      searchedThrough: null,
      exhausted: null,
    },
  };
}

describe('write completion descriptions', () => {
  it.each([
    ['bootstrap', 'reconcile-attempt'],
    ['prepared', 'prepare-attempt'],
    ['broadcast', 'broadcast-attempt'],
    ['observation', 'reconcile-attempt'],
    ['search-progress', 'reconcile-attempt'],
  ] as const)(
    'describes %s without an event or correction',
    (kind, operation) => {
      expect(describeWriteCompletion({ kind }, SIGNER)).toEqual({
        operation,
        terminalCorrection: false,
        event: null,
      });
    }
  );

  it('preserves the resolution event and its own signer', () => {
    const pending: PendingWrite = {
      kind: 'resolution',
      event: {
        signer: EVENT_SIGNER,
        attemptId: ATTEMPT_ID,
        transactionHash: TRANSACTION_HASH,
        nonce: 4n,
        resolution: {
          outcome: 'replaced',
          replacementTransactionHash: REPLACEMENT_HASH,
          nonceAtAnchor: 5n,
          anchor: { blockNumber: 200n, blockHash: DURABLE_HASH },
          inclusion: { blockNumber: 150n, blockHash: REPLACEMENT_HASH },
        },
      },
    };
    const before = structuredClone(pending);

    expect(describeWriteCompletion(pending, SIGNER)).toEqual({
      operation: 'reconcile-attempt',
      terminalCorrection: false,
      event: {
        kind: 'attemptResolved',
        fields: {
          signer: EVENT_SIGNER,
          attemptId: ATTEMPT_ID,
          transactionHash: TRANSACTION_HASH,
          nonce: 4n,
          resolution: {
            outcome: 'replaced',
            replacementTransactionHash: REPLACEMENT_HASH,
            nonceAtAnchor: 5n,
            anchor: { blockNumber: 200n, blockHash: DURABLE_HASH },
            inclusion: { blockNumber: 150n, blockHash: REPLACEMENT_HASH },
          },
        },
      },
    });
    expect(pending).toEqual(before);
  });

  it('describes operator acceptance using the supplied signer', () => {
    const { replacement, ...outcome } = attributedOutcome();
    const pending: PendingWrite = {
      kind: 'operator-acceptance',
      outcome: { ...outcome, kind: 'operator-accepted-unattributed' },
    };
    const before = structuredClone(pending);

    expect(describeWriteCompletion(pending, SIGNER)).toEqual({
      operation: 'reconcile-attempt',
      terminalCorrection: true,
      event: {
        kind: 'attemptOperatorAccepted',
        fields: {
          signer: SIGNER,
          requestId: REQUEST_ID,
          attemptId: ATTEMPT_ID,
          nonce: 4n,
          durableBlock: 200n,
          durableBlockHash: DURABLE_HASH,
        },
      },
    });
    expect(pending).toEqual(before);
  });

  it.each([
    [null, null, false, false],
    [160n, null, true, false],
    [null, 160n, true, false],
    [140n, 140n, false, true],
    [150n, 150n, true, false],
  ] as const)(
    'describes attribution with cursor %s and exhaustion %s',
    (cursor, exhaustion, supersededNoMatch, contradictsExhaustionNonce) => {
      const outcome = attributedOutcome();
      let searchedThrough = null;
      let exhausted = null;

      if (cursor !== null) {
        searchedThrough = { blockNumber: cursor, blockHash: OLD_HASH };
      }

      if (exhaustion !== null) {
        exhausted = {
          anchor: { blockNumber: exhaustion, blockHash: FACT_HASH },
          nonce: 5n,
        };
      }

      const pending: PendingWrite = {
        kind: 'operator-attribution',
        outcome: {
          ...outcome,
          priorSearch: { searchedThrough, exhausted },
        },
      };
      const before = structuredClone(pending);

      expect(describeWriteCompletion(pending, SIGNER)).toEqual({
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'attemptOperatorAttributed',
          fields: {
            signer: SIGNER,
            requestId: REQUEST_ID,
            attemptId: ATTEMPT_ID,
            transactionHash: REPLACEMENT_HASH,
            nonce: 4n,
            durableBlock: 200n,
            durableBlockHash: DURABLE_HASH,
            supersededNoMatch,
            contradictsExhaustionNonce,
          },
        },
      });
      expect(pending).toEqual(before);
    },
  );

  it.each([
    'searched-through-changed',
    'exhaustion-anchor-changed',
  ] as const)('describes search reset for %s', (reason) => {
    const pending: PendingWrite = {
      kind: 'search-reset',
      event: {
        signer: EVENT_SIGNER,
        attemptId: ATTEMPT_ID,
        nonce: 4n,
        reason,
        expectedBlock: 160n,
        expectedBlockHash: OLD_HASH,
        observedBlock: 160n,
        observedBlockHash: OBSERVED_HASH,
        durableBlock: 200n,
        durableBlockHash: DURABLE_HASH,
      },
    };
    const before = structuredClone(pending);

    expect(describeWriteCompletion(pending, SIGNER)).toEqual({
      operation: 'reconcile-attempt',
      terminalCorrection: true,
      event: {
        kind: 'searchReset',
        fields: {
          signer: EVENT_SIGNER,
          attemptId: ATTEMPT_ID,
          nonce: 4n,
          reason,
          expectedBlock: 160n,
          expectedBlockHash: OLD_HASH,
          observedBlock: 160n,
          observedBlockHash: OBSERVED_HASH,
          durableBlock: 200n,
          durableBlockHash: DURABLE_HASH,
        },
      },
    });
    expect(pending).toEqual(before);
  });

  it('describes an unconsumed-bound rebase and its invalidated fact', () => {
    const pending: PendingWrite = {
      kind: 'search-unconsumed-bound-rebase',
      event: {
        signer: EVENT_SIGNER,
        attemptId: ATTEMPT_ID,
        nonce: 4n,
        observation: {
          anchor: { blockNumber: 200n, blockHash: DURABLE_HASH },
          nonce: 4n,
        },
        evidence: {
          opening: { blockNumber: 200n, blockHash: DURABLE_HASH },
          closing: { blockNumber: 200n, blockHash: DURABLE_HASH },
          lowerBound: {
            anchor: { blockNumber: 100n, blockHash: OLD_HASH },
            nonce: 4n,
          },
          observedLower: { blockNumber: 100n, blockHash: OBSERVED_HASH },
          fact: {
            anchor: { blockNumber: 160n, blockHash: FACT_HASH },
            nonce: 5n,
          },
          observedFact: { blockNumber: 160n, blockHash: OBSERVED_FACT_HASH },
        },
      },
    };
    const before = structuredClone(pending);

    expect(describeWriteCompletion(pending, SIGNER)).toEqual({
      operation: 'reconcile-attempt',
      terminalCorrection: true,
      event: {
        kind: 'searchUnconsumedBoundRebased',
        fields: {
          signer: EVENT_SIGNER,
          attemptId: ATTEMPT_ID,
          nonce: 4n,
          oldLowerBlock: 100n,
          oldLowerBlockHash: OLD_HASH,
          oldLowerNonce: 4n,
          observedLowerBlockHash: OBSERVED_HASH,
          durableBlock: 200n,
          durableBlockHash: DURABLE_HASH,
          durableNonce: 4n,
          invalidatedFact: {
            expectedBlock: 160n,
            expectedBlockHash: FACT_HASH,
            observedBlock: 160n,
            observedBlockHash: OBSERVED_FACT_HASH,
          },
        },
      },
    });
    expect(pending).toEqual(before);
  });

  it.each([false, true])(
    'describes lower-bound replacement with invalidated fact: %s',
    (hasFact) => {
      let invalidatedFact = null;
      let expectedInvalidatedFact = null;

      if (hasFact) {
        invalidatedFact = {
          fact: {
            anchor: { blockNumber: 160n, blockHash: FACT_HASH },
            nonce: 5n,
          },
          observedAnchor: { blockNumber: 160n, blockHash: OBSERVED_FACT_HASH },
        };
        expectedInvalidatedFact = {
          expectedBlock: 160n,
          expectedBlockHash: FACT_HASH,
          observedBlock: 160n,
          observedBlockHash: OBSERVED_FACT_HASH,
        };
      }

      const pending: PendingWrite = {
        kind: 'search-lower-bound-replacement',
        event: {
          signer: EVENT_SIGNER,
          attemptId: ATTEMPT_ID,
          nonce: 4n,
          oldLowerBound: {
            anchor: { blockNumber: 100n, blockHash: OLD_HASH },
            nonce: 3n,
          },
          observedLower: { blockNumber: 100n, blockHash: OBSERVED_HASH },
          replacement: {
            anchor: { blockNumber: 140n, blockHash: REPLACEMENT_HASH },
            nonce: 4n,
          },
          durableObservation: {
            anchor: { blockNumber: 200n, blockHash: DURABLE_HASH },
            nonce: 5n,
          },
          probeCount: 3,
          invalidatedFact,
        },
      };
      const before = structuredClone(pending);

      expect(describeWriteCompletion(pending, SIGNER)).toEqual({
        operation: 'reconcile-attempt',
        terminalCorrection: true,
        event: {
          kind: 'searchLowerBoundReplaced',
          fields: {
            signer: EVENT_SIGNER,
            attemptId: ATTEMPT_ID,
            nonce: 4n,
            oldLowerBlock: 100n,
            oldLowerBlockHash: OLD_HASH,
            oldLowerNonce: 3n,
            observedLowerBlock: 100n,
            observedLowerBlockHash: OBSERVED_HASH,
            replacementBlock: 140n,
            replacementBlockHash: REPLACEMENT_HASH,
            replacementNonce: 4n,
            durableBlock: 200n,
            durableBlockHash: DURABLE_HASH,
            durableNonce: 5n,
            probeCount: 3n,
            invalidatedFact: expectedInvalidatedFact,
          },
        },
      });
      expect(pending).toEqual(before);
    },
  );
});
