import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRpcMetrics,
  type RpcMetricsSnapshot,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  projectRpcUsageLogContext,
} from '../../../src/diagnostics/rpc/rpc-usage-log.js';

import {
  createRpcUsageReport,
} from '../../../src/diagnostics/rpc/rpc-usage-report.js';

import {
  createRpcUsageSnapshot,
} from '../../../src/diagnostics/rpc/rpc-usage-snapshot.js';

const OBSERVED_AT = '2026-10-23T12:00:00.000Z';

function expectValidUsage(snapshot: RpcMetricsSnapshot): void {
  expect(() => createRpcUsageSnapshot(
    snapshot,
    OBSERVED_AT,
  )).not.toThrow();

  expect(() => projectRpcUsageLogContext({
    observedAt: OBSERVED_AT,
    report: createRpcUsageReport({
      snapshot,
      observedAtMs: 1_000,
    }),
  })).not.toThrow();
}

describe('RPC metrics HTTP completion', () => {
  it('keeps snapshots consistent during response completion', async () => {
    const metrics = createRpcMetrics();
    const response = new Response(null, { status: 200 });

    let resolveFetch!: (response: Response) => void;

    const fetched = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    const pending = metrics.http('public', () => fetched);

    // Resolving fetch queues its existing continuation first.
    // The old async wrapper updated the status bucket there,
    // but deferred the remaining completion counters until later.
    const observed = new Promise<RpcMetricsSnapshot>((resolve) => {
      resolveFetch(response);

      queueMicrotask(() => {
        resolve(metrics.snapshot());
      });
    });

    const snapshot = await observed;
    const returned = await pending;

    expect(returned).toBe(response);
    expect(snapshot.http).toHaveLength(1);

    const row = snapshot.http[0]!;

    expect(row).toMatchObject({
      client: 'public',
      started: 1,
      succeeded: 1,
      failed: 0,
      inFlight: 0,
      statuses: {
        '2xx': 1,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    });

    expect(Number.isFinite(row.durationMs)).toBe(true);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);

    expectValidUsage(snapshot);
  });

  it('preserves a resolved response when its status getter throws', async () => {
    const metrics = createRpcMetrics();

    await metrics.http(
      'public',
      async () => new Response(null, { status: 200 }),
    );

    const before = metrics.snapshot().http[0]!;

    const response = new Response(null, { status: 503 });
    const getter = vi.fn(() => {
      throw new Error('Status inspection failed');
    });

    Object.defineProperty(response, 'status', {
      get: getter,
    });

    await expect(metrics.http(
      'public',
      async () => response,
    )).resolves.toBe(response);

    const snapshot = metrics.snapshot();
    const after = snapshot.http[0]!;

    expect(getter).toHaveBeenCalledOnce();
    expect(after.started).toBe(before.started + 1);
    expect(after.succeeded).toBe(before.succeeded + 1);
    expect(after.failed).toBe(before.failed);
    expect(after.inFlight).toBe(before.inFlight);
    expect(after.statuses).toEqual(before.statuses);
    expect(after.durationMs).toBeGreaterThanOrEqual(before.durationMs);

    expectValidUsage(snapshot);
  });
});