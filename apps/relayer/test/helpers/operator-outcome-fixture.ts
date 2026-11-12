import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import type {
  OperatorAttributedOutcome,
} from '../../src/state/transaction-journal.js';

import {
  HINT_HASH,
  OTHER_HASH,
} from './operator-attribution-fixture.js';

/** Largest numeric widths, candidate population and string byte bounds. */
export function maximumOutcome(
  index: number,
  nonce: bigint,
  escaped = false,
): OperatorAttributedOutcome {
  const id = index.toString(16).padStart(12, '0');

  const blockHash = OTHER_HASH;

  const operator = '"\\'.repeat(64);

  let workId = '\u0800'.repeat(256);

  if (escaped) {
    workId = '"\\'.repeat(128);
  }

  return {
    kind: 'operator-attributed',
    requestId: `22222222-2222-4222-8222-${id}`,
    snapshotDigest: OTHER_HASH,
    proposalDigest: OTHER_HASH,
    operator,
    at: '2026-11-12T00:00:00.000Z',
    attemptId: `33333333-3333-4333-8333-${id}`,
    workId,
    nonce,
    candidateHashes: Array.from({
      length: 16,
    }, (_, item) =>
      `0x${item.toString(16).padStart(64, '0')}` as const,
    ),
    durable: {
      anchor: {
        blockNumber: MAX_UINT256,
        blockHash,
      },
      nonce: MAX_UINT256,
    },
    finality: {
      type: 'confirmations',
      confirmations: MAX_UINT256,
    },
    lowerBound: {
      anchor: {
        blockNumber: MAX_UINT256 - 3n,
        blockHash,
      },
      nonce,
    },
    replacement: {
      transactionHash: HINT_HASH,
      inclusion: {
        blockNumber: MAX_UINT256 - 1n,
        blockHash,
      },
    },
    priorSearch: {
      searchedThrough: {
        blockNumber: MAX_UINT256 - 1n,
        blockHash,
      },
      exhausted: {
        anchor: {
          blockNumber: MAX_UINT256 - 1n,
          blockHash,
        },
        nonce: MAX_UINT256,
      },
    },
  };
}
