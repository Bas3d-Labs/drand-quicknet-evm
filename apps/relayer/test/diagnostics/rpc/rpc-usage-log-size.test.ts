import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createRelayerLog,
} from '../../../src/diagnostics/relayer-log.js';

import {
  RPC_METHOD_LABELS,
  type RpcMetricsSnapshot,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  MAX_RPC_USAGE_LOG_BYTES,
  MAX_RPC_USAGE_LOG_RECORD_BYTES,
  RPC_USAGE_LOG_ENVELOPE_BYTES,
  projectRpcUsageLogContext,
  type RpcUsageLogContext,
} from '../../../src/diagnostics/rpc/rpc-usage-log.js';

import {
  createRpcUsageReport,
} from '../../../src/diagnostics/rpc/rpc-usage-report.js';

// Existing projected-record limit in relayer-log.ts.
// This measurement does not change that policy.
const CURRENT_RECORD_LIMIT = 16_384 - 1_024;

// Proposed logging ranges: safe-integer counts and finite,
// non-negative durations, averages, and elapsed time.
const COUNT_WIDTH = 16;
const DURATION_WIDTH = 24;

const REQUIRED_HEADROOM = 4 * 1_024;

const COLLECTOR_ID = '11111111-1111-4111-8111-111111111111';
const MAX_TIMESTAMP = '+275760-09-13T00:00:00.000Z';
const LONG_DURATION = 0.0000012345678901234567;

function measurements(
  started: number,
  succeeded: number,
  failed: number,
  durationMs: number,
): RpcMetricsSnapshot {
  const logical: RpcMetricsSnapshot['logical'][number][] = [];
  const http: RpcMetricsSnapshot['http'][number][] = [];

  for (const client of ['public', 'wallet'] as const) {
    for (const method of RPC_METHOD_LABELS) {
      logical.push({
        client,
        method,
        started,
        succeeded,
        failed,
        inFlight: started - succeeded - failed,
        durationMs,
      });
    }

    http.push({
      client,
      started,
      succeeded,
      failed,
      inFlight: started - succeeded - failed,
      durationMs,
      statuses: {
        '2xx': succeeded,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    });
  }

  return {
    collectorId: COLLECTOR_ID,
    startedAt: MAX_TIMESTAMP,
    logical,
    http,
  };
}

function record(snapshot: RpcMetricsSnapshot) {
  const previous = measurements(0, 0, 0, 0);

  const report = createRpcUsageReport(
    {
      snapshot,
      observedAtMs: 60_000,
    },
    {
      snapshot: previous,
      observedAtMs: 0,
    },
  );
  
  const context: RpcUsageLogContext = {
    observedAt: MAX_TIMESTAMP,
    report,
  };

  return {
    event: 'rpc_usage',
    ...projectRpcUsageLogContext(context),
    cycle: Number.MAX_SAFE_INTEGER,
    signer: `0x${'ab'.repeat(20)}`,
  };
}

/**
 * Conservative field-width budget.
 *
 * Counter relationships prevent every field from simultaneously
 * reaching its widest representation. Budget each independently
 * so the bound does not depend on a particular counter distribution.
 */
function budgetBytes(value: unknown, field = ''): number {
  if (typeof value === 'number') {
    if (
      field === 'durationMs' ||
      field === 'averageDurationMs' ||
      field === 'elapsedMs'
    ) {
      return DURATION_WIDTH;
    }

    return COUNT_WIDTH;
  }

  if (typeof value === 'boolean') {
    return 5;
  }

  if (Array.isArray(value)) {
    let bytes = 2;

    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        bytes += 1;
      }

      bytes += budgetBytes(value[index]);
    }

    return bytes;
  }

  if (typeof value === 'object' && value !== null) {
    let bytes = 2;
    let first = true;

    for (const [key, child] of Object.entries(value)) {
      if (!first) {
        bytes += 1;
      }

      first = false;
      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8');
      bytes += 1;
      bytes += budgetBytes(child, key);
    }

    return bytes;
  }

  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError('Unexpected size-fixture value.');
  }

  return Buffer.byteLength(serialized, 'utf8');
}

describe('RPC usage log size measurement', () => {
  it('measures both complete views against the existing record limit', () => {
    const completedPart = Math.floor(Number.MAX_SAFE_INTEGER / 3);

    const wide = record(measurements(
      Number.MAX_SAFE_INTEGER,
      completedPart,
      completedPart,
      LONG_DURATION,
    ));

    // Illustrative ordinary-width counts, not a measured workload.
    const ordinary = record(measurements(
      1_000,
      980,
      10,
      12_345.6789,
    ));

    expect(JSON.stringify(Number.MAX_SAFE_INTEGER).length)
      .toBe(COUNT_WIDTH);
    expect(JSON.stringify(LONG_DURATION).length)
      .toBe(DURATION_WIDTH);

    for (const candidate of [wide, ordinary]) {
      expect(candidate.report.cumulative.logical)
        .toHaveLength(RPC_METHOD_LABELS.length * 2);
      expect(candidate.report.cumulative.http).toHaveLength(2);

      const interval = candidate.report.interval;

      if (!interval.available) {
        throw new Error('Expected an available interval.');
      }

      expect(interval.logical)
        .toHaveLength(RPC_METHOD_LABELS.length * 2);
      expect(interval.http).toHaveLength(2);
      expect(interval.elapsedMs).toBe(60_000);
    }

    const ordinaryBytes = Buffer.byteLength(
      JSON.stringify(ordinary),
      'utf8',
    );
    const wideBytes = Buffer.byteLength(JSON.stringify(wide), 'utf8');
    const conservativeBytes = budgetBytes(wide);

    expect(wideBytes).toBeLessThanOrEqual(conservativeBytes);
    expect(ordinaryBytes).toBeLessThanOrEqual(conservativeBytes);
    expect(conservativeBytes + REQUIRED_HEADROOM)
      .toBeLessThanOrEqual(MAX_RPC_USAGE_LOG_RECORD_BYTES);

    console.table({
      ordinaryProjectedRecord: ordinaryBytes,
      wideProjectedRecord: wideBytes,
      conservativeProjectedBudget: conservativeBytes,
      currentProjectedRecordLimit: CURRENT_RECORD_LIMIT,
      conservativeBudgetWithEnvelope:
        conservativeBytes + RPC_USAGE_LOG_ENVELOPE_BYTES,
      proposedProjectedRecordLimit: MAX_RPC_USAGE_LOG_RECORD_BYTES,
      projectedHeadroom:
        MAX_RPC_USAGE_LOG_RECORD_BYTES - conservativeBytes,
    });
  });

  it('emits both complete views through the logger within the total budget', () => {
    const completedPart = Math.floor(Number.MAX_SAFE_INTEGER / 3);

    const candidate = record(measurements(
      Number.MAX_SAFE_INTEGER,
      completedPart,
      completedPart,
      LONG_DURATION,
    ));

    const lines: string[] = [];

    const logger = createRelayerLog({
      chainId: Number.MAX_SAFE_INTEGER,
      runId: '22222222-2222-4222-8222-222222222222',
      level: 'info',
      destination: {
        write(line) {
          lines.push(line);
        },
      },
    }).withContext({
      cycle: candidate.cycle,
      signer: candidate.signer as `0x${string}`,
    });

    logger.rpcUsage({
      observedAt: candidate.observedAt,
      report: candidate.report,
    });

    expect(lines).toHaveLength(1);

    const line = lines[0]!;
    const emitted = JSON.parse(line);

    expect(emitted).toMatchObject({
      level: 30,
      event: 'rpc_usage',
      msg: 'Relayer RPC usage',
      chainId: Number.MAX_SAFE_INTEGER,
      runId: '22222222-2222-4222-8222-222222222222',
      cycle: candidate.cycle,
      signer: candidate.signer,
      observedAt: candidate.observedAt,
    });

    expect(emitted.report).toEqual(candidate.report);
    expect(emitted.report.cumulative.logical)
      .toHaveLength(RPC_METHOD_LABELS.length * 2);
    expect(emitted.report.cumulative.http).toHaveLength(2);
    expect(emitted.report.interval.logical)
      .toHaveLength(RPC_METHOD_LABELS.length * 2);
    expect(emitted.report.interval.http).toHaveLength(2);

    expect(line.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(line, 'utf8'))
      .toBeLessThanOrEqual(MAX_RPC_USAGE_LOG_BYTES);
    expect(line).not.toContain('observedAtMs');
  });
});