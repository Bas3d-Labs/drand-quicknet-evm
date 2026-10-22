import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  RpcMetricsSnapshot,
} from '../../src/diagnostics/rpc/rpc-metrics.js';

import type {
  RpcHttpUsageSnapshotRow,
  RpcLogicalUsageSnapshotRow,
  RpcUsageSnapshot,
} from '../../src/diagnostics/rpc/rpc-usage-snapshot.js';

import {
  MAX_WORK_ID_LENGTH,
} from '../../src/execution/work-identity.js';

import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import {
  readDaemonStatusSnapshot,
} from '../../src/state/daemon-status-snapshot.js';

import {
  MAX_DAEMON_STATUS_BYTES,
} from '../../src/state/file-daemon-status-store.js';

import {
  MAX_RETAINED_ATTEMPTS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from '../../src/state/journal-bounds.js';

import {
  BLOCKER_PRECEDENCE,
} from '../../src/state/signer-gate.js';

type RpcMethod = RpcMetricsSnapshot['logical'][number]['method'];

// Exhaustive: adding a collector method requires updating this fixture.
const METHODS: Record<RpcMethod, true> = {
  eth_blockNumber: true,
  eth_call: true,
  eth_chainId: true,
  eth_estimateGas: true,
  eth_feeHistory: true,
  eth_gasPrice: true,
  eth_getBalance: true,
  eth_getBlockByHash: true,
  eth_getBlockByNumber: true,
  eth_getCode: true,
  eth_getLogs: true,
  eth_getTransactionByHash: true,
  eth_getTransactionCount: true,
  eth_getTransactionReceipt: true,
  eth_maxPriorityFeePerGas: true,
  eth_sendRawTransaction: true,
  other: true,
};

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_COUNT_WIDTH = 16;
const MAX_DURATION_WIDTH = 24;
const REQUIRED_MARGIN_BYTES = 2_048;

// Canonical extended ISO timestamps occupy 27 characters.
const AT = '+275760-09-13T00:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const LONG_DURATION = 0.0000012345678901234567;

const IDENTITY = {
  chainId: MAX_COUNT,
  signer: `0x${'ab'.repeat(20)}` as const,
};

function recoverySnapshot() {
  let hashNumber = 1;

  const attempts = Array.from(
    { length: MAX_RETAINED_ATTEMPTS },
    (_, index) => {
      const suffix = index.toString(16);

      return {
        attemptId:
          '00000000-0000-4000-8000-'
          + (index + 1).toString(16).padStart(12, '0'),
        workId:
          '\u0800'.repeat(MAX_WORK_ID_LENGTH - suffix.length)
          + suffix,
        nonce: (
          MAX_UINT256
          - BigInt(MAX_RETAINED_ATTEMPTS - 1 - index)
        ).toString(),
        phase: 'broadcast-may-have-occurred',
        transactionHashes: Array.from(
          { length: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT },
          () => {
            const hash =
              '0x' + hashNumber.toString(16).padStart(64, '0');

            hashNumber += 1;
            return hash;
          },
        ),
      };
    },
  );

  // One attempt today: use the full 768-byte work-ID content fixture.
  if (attempts.length === 1) {
    attempts[0]!.workId = '\u0800'.repeat(MAX_WORK_ID_LENGTH);
  }

  return readDaemonStatusSnapshot({
    version: 1,
    identity: IDENTITY,
    runId: ID,
    observedAt: AT,
    journalInitialized: true,
    attempts,
    lastCompletedCycle: {
      cycle: MAX_COUNT,
      completedAt: AT,
    },
    lastRetryObservation: {
      observedAt: AT,
      retryDelayMs: MAX_COUNT,
    },
    lastObservedGate: {
      open: false,
      primaryReason: BLOCKER_PRECEDENCE[0],
      blockers: [...BLOCKER_PRECEDENCE],
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'writing',
      blockedSince: AT,
    },
  }, IDENTITY);
}

function metricsFixture(): RpcUsageSnapshot {
  const logical: RpcLogicalUsageSnapshotRow[] = [];
  const http: RpcHttpUsageSnapshotRow[] = [];

  // METHODS is an exhaustive object literal keyed by RpcMethod.
  const methods = Object.keys(METHODS) as RpcMethod[];

  for (const client of ['public', 'wallet'] as const) {
    for (const method of methods) {
      logical.push({
        client,
        method,
        started: MAX_COUNT,
        completed: MAX_COUNT,
        failed: 0,
        inFlight: 0,
        durationMs: LONG_DURATION,
      });
    }

    http.push({
      client,
      started: MAX_COUNT,
      responses: MAX_COUNT,
      transportFailures: 0,
      inFlight: 0,
      statuses: {
        '2xx': MAX_COUNT,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
      durationMs: LONG_DURATION,
    });
  }

  return {
    collectorId: ID,
    startedAt: AT,
    observedAt: AT,
    logical,
    http,
  };
}

/**
 * Conservative JSON byte budget.
 *
 * Every number receives its maximum permitted token width, even when
 * counter relationships prevent all fields reaching that width together.
 * Work IDs receive their maximum escaped-content budget plus quotes.
 * Other strings, property names, and punctuation use their actual bytes.
 */
function budgetBytes(value: unknown, field = ''): number {
  if (value === null) {
    return 4;
  }

  if (typeof value === 'number') {
    if (field === 'durationMs') {
      return MAX_DURATION_WIDTH;
    }

    return MAX_COUNT_WIDTH;
  }

  if (typeof value === 'string') {
    if (field === 'workId') {
      return MAX_WORK_ID_LENGTH * 3 + 2;
    }

    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }

  if (typeof value === 'boolean') {
    // Reserve five bytes even for fields currently set to true.
    return 5;
  }

  if (Array.isArray(value)) {
    let bytes = 2;

    for (const [index, item] of value.entries()) {
      if (index > 0) {
        bytes += 1;
      }

      bytes += budgetBytes(item);
    }

    return bytes;
  }

  if (typeof value === 'object') {
    let bytes = 2;

    for (const [index, [key, item]] of Object.entries(value).entries()) {
      if (index > 0) {
        bytes += 1;
      }

      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8');
      bytes += 1;
      bytes += budgetBytes(item, key);
    }

    return bytes;
  }

  throw new TypeError('Unsupported value in status budget fixture.');
}

describe('daemon status size budget', () => {
  it('pins count, duration, timestamp, and work-ID representation widths', () => {
    expect(JSON.stringify(MAX_COUNT)).toHaveLength(MAX_COUNT_WIDTH);
    expect(JSON.stringify(LONG_DURATION)).toHaveLength(
      MAX_DURATION_WIDTH,
    );
    expect(JSON.stringify(Number.MAX_VALUE).length)
      .toBeLessThanOrEqual(MAX_DURATION_WIDTH);
    expect(JSON.stringify(Number.MIN_VALUE).length)
      .toBeLessThanOrEqual(MAX_DURATION_WIDTH);

    expect(new Date(AT).toISOString()).toBe(AT);
    expect(AT).toHaveLength(27);

    const workId = '\u0800'.repeat(MAX_WORK_ID_LENGTH);

    expect(Buffer.byteLength(JSON.stringify(workId), 'utf8')).toBe(
      MAX_WORK_ID_LENGTH * 3 + 2,
    );
  });

  it('RPC19: budgets complete recovery data and every RPC row with margin', () => {
    const recovery = recoverySnapshot();
    const rpcUsage = metricsFixture();

    // Candidate publication shape; averages are reconstructed on read.
    const candidate = {
      ...recovery,
      rpcUsage,
    };

    const serialized = JSON.stringify(candidate) + '\n';
    const actualBytes = Buffer.byteLength(serialized, 'utf8');
    const conservativeBytes = budgetBytes(candidate) + 1;

    expect(rpcUsage.logical).toHaveLength(
      Object.keys(METHODS).length * 2,
    );
    expect(rpcUsage.http).toHaveLength(2);
    expect(serialized).not.toContain('averageDurationMs');

    expect(candidate.attempts).toHaveLength(MAX_RETAINED_ATTEMPTS);

    for (const attempt of candidate.attempts) {
      expect(attempt.transactionHashes).toHaveLength(
        MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      );
    }

    expect(candidate.lastObservedGate).toEqual(
      recovery.lastObservedGate,
    );

    expect(actualBytes).toBeLessThanOrEqual(conservativeBytes);

    expect(
      conservativeBytes + REQUIRED_MARGIN_BYTES,
      'Full status budget plus 2 KiB margin must fit the file limit.',
    ).toBeLessThanOrEqual(MAX_DAEMON_STATUS_BYTES);
  });
});