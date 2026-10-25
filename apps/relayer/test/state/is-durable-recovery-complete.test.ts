import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  isDurableRecoveryComplete,
  type DurableRecoveryCompletionState,
} from '../../src/state/is-durable-recovery-complete.js';

import type {
  SignerRecoveryResult,
} from '../../src/state/signer-coordinator.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

function state(
  nonces: readonly bigint[] = [],
): DurableRecoveryCompletionState {
  return {
    recoveryComplete: true,
    persistenceState: 'idle',
    attempts: nonces.map((nonce) => ({ nonce })),
  };
}

function unresolved(nonce: bigint): SignerRecoveryResult {
  return {
    status: 'unresolved',
    observation: {
      anchor: ANCHOR,
      nonce,
    },
    receipt: { status: 'receipt-not-found' },
    search: null,
  };
}

describe('durable recovery completion', () => {
  it('completes an empty recovered journal', () => {
    expect(isDurableRecoveryComplete({
      status: 'no-attempt',
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
    }, state())).toBe(true);
  });

  it('rejects a no-attempt result paired with retained attempts', () => {
    expect(isDurableRecoveryComplete({
      status: 'no-attempt',
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
    }, state([4n]))).toBe(false);
  });

  it.each(['success', 'reverted', 'replaced'] as const)(
    'completes a persisted %s resolution only when nothing remains',
    (outcome) => {
      let evidence:
        Extract<
          SignerRecoveryResult,
          { status: 'resolution-available' }
        >['evidence'];

      if (outcome === 'replaced') {
        evidence = {
          outcome,
          replacementTransactionHash: OTHER,
          nonceAtAnchor: 5n,
          anchor: ANCHOR,
          inclusion: ANCHOR,
        };
      } else {
        evidence = {
          outcome,
          transactionHash: HASH,
          anchor: ANCHOR,
          inclusion: ANCHOR,
        };
      }

      const result: SignerRecoveryResult = {
        status: 'resolution-available',
        observation: {
          anchor: ANCHOR,
          nonce: 5n,
        },
        evidence,
      };

      expect(isDurableRecoveryComplete(result, state())).toBe(true);

      expect(isDurableRecoveryComplete(
        result,
        state([5n]),
      )).toBe(false);
    },
  );

  it.each([3n, 4n])(
    'allows an unresolved stopping point with unconsumed nonce %s',
    (nonce) => {
      expect(isDurableRecoveryComplete(
        unresolved(nonce),
        state([4n, 5n]),
      )).toBe(true);
    },
  );

  it('keeps consumed but unidentified nonce recovery due', () => {
    expect(isDurableRecoveryComplete(
      unresolved(5n),
      state([4n, 5n]),
    )).toBe(false);
  });

  it('rejects an unresolved result without a remaining attempt', () => {
    expect(isDurableRecoveryComplete(
      unresolved(4n),
      state(),
    )).toBe(false);
  });

  it('allows an inclusion above the durable anchor to wait', () => {
    expect(isDurableRecoveryComplete({
      status: 'unresolved',
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
      receipt: {
        status: 'included-not-durable',
        transactionHash: HASH,
        outcome: 'success',
        inclusion: {
          blockNumber: 105n,
          blockHash: OTHER,
        },
      },
      search: null,
    }, state([4n]))).toBe(true);
  });

  it('keeps contradictory receipt evidence due', () => {
    expect(isDurableRecoveryComplete({
      status: 'unresolved',
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
      receipt: {
        status: 'fork-served-receipt',
        inclusion: {
          blockNumber: 99n,
          blockHash: OTHER,
        },
        canonicalBlock: {
          blockNumber: 99n,
          blockHash: HASH,
        },
      },
      search: null,
    }, state([4n]))).toBe(false);
  });

  it.each([
    'nonce-behind-journal',
    'inconsistent-observations',
  ] as const)('keeps %s due', (status) => {
    expect(isDurableRecoveryComplete({
      status,
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
    }, state())).toBe(false);
  });

  it('keeps a changed anchor due', () => {
    expect(isDurableRecoveryComplete({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 100n,
        blockHash: OTHER,
      },
    }, state())).toBe(false);
  });

  it('keeps deferred bootstrap due', () => {
    expect(isDurableRecoveryComplete({
      status: 'bootstrap-deferred',
      reason: 'nonce-count-mismatch',
      observation: {
        anchor: ANCHOR,
        nonce: 4n,
      },
      latestNonce: 5n,
      pendingNonce: 5n,
    }, state())).toBe(false);
  });

  it('requires coordinator recovery completion', () => {
    expect(isDurableRecoveryComplete(
      unresolved(4n),
      {
        ...state([4n]),
        recoveryComplete: false,
      },
    )).toBe(false);
  });

  it('does not complete with failed persistence', () => {
    expect(isDurableRecoveryComplete(
      unresolved(4n),
      {
        ...state([4n]),
        persistenceState: 'failed',
      },
    )).toBe(false);
  });
});