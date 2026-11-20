import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createRpcMetrics,
  type RpcTraceEvent,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  createRpcUsageSnapshot,
} from '../../../src/diagnostics/rpc/rpc-usage-snapshot.js';

import {
  measuredHttp,
} from '../../../src/chain/measured-http.js';

import {
  AT,
} from './trace-fixtures.js';

function fold(
  events: readonly RpcTraceEvent[],
) {
  const result = new Map<string, Record<string, number>>();

  for (const event of events) {
    const key = [event.layer, event.client, event.method].join(':');

    let row = result.get(key);

    if (row === undefined) {
      row = { started: 0, completed: 0, failed: 0, responses: 0, inFlight: 0 };

      result.set(key, row);
    }

    if (event.phase === 'start') {
      row.started! += 1;
      row.inFlight! += 1;
    } else {
      row.completed! += 1;
      row.inFlight! -= 1;

      if (event.outcome === 'failure') {
        row.failed! += 1;
      } else {
        row.responses! += 1;
      }

      if (event.status !== null) {
        row[event.status] = (row[event.status] ?? 0) + 1;
      }
    }
  }

  return result;
}

function assertReconciled(
  events: readonly RpcTraceEvent[],
  metrics: ReturnType<typeof createRpcMetrics>,
) {
  const actual = fold(events);

  const snapshot = createRpcUsageSnapshot(metrics.snapshot(), AT);

  for (const row of snapshot.logical) {
    expect(actual.get(`logical:${row.client}:${row.method}`)).toMatchObject({
      started: row.started,
      completed: row.completed,
      failed: row.failed,
      inFlight: row.inFlight,
    });
  }

  for (const row of snapshot.http) {
    const found = actual.get(`http:${row.client}:`)!;

    expect(found).toMatchObject({
      started: row.started,
      responses: row.responses,
      failed: row.transportFailures,
      inFlight: row.inFlight,
    });

    for (const [key, value] of Object.entries(row.statuses)) {
      expect(found[key] ?? 0).toBe(value);
    }
  }
}

describe('RPC event accounting', () => {
  it('reconciles calls across cuts, failures, response classes and clients', async () => {
    const events: RpcTraceEvent[] = [];

    const metrics = createRpcMetrics({
      onTrace: (event) => events.push(event),
    });

    let release!: (response: Response) => void;

    const pending = metrics.logical('public', 'eth_getLogs', () =>
      metrics.http(
        'public',
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );

    assertReconciled(events, metrics);

    const cut = events.length;

    const baseline = metrics.snapshot();

    await metrics.logical('wallet', 'unknown secret URL', async () => 1);

    release(new Response(null, { status: 503 }));

    await pending;

    await expect(
      metrics.logical('public', 'eth_call', () =>
        metrics.http('public', async () => {
          throw new Error('provider credential');
        }),
      ),
    ).rejects.toThrow();

    await metrics.http(
      'public',
      async () => new Response(null, { status: 200 }),
    );

    await metrics.http(
      'public',
      async () => new Response(null, { status: 302 }),
    );

    await metrics.http(
      'public',
      async () => new Response(null, { status: 429 }),
    );

    assertReconciled(events, metrics);

    const interval = fold(events.slice(cut));

    expect(interval.get('logical:public:eth_getLogs')).toMatchObject({
      started: 0,
      completed: 1,
      inFlight: -1,
    });

    expect(baseline.logical[0]!.inFlight).toBe(1);

    expect(metrics.snapshot().logical[0]!.inFlight).toBe(0);

    const starts = events.filter((event) => event.phase === 'start');

    expect(new Set(starts.map((event) => event.callId)).size).toBe(
      starts.length,
    );

    expect(
      events
        .filter((event) => event.layer === 'http')
        .every((event) => event.parentLogicalId === null),
    ).toBe(true);

    expect(JSON.stringify(events)).not.toContain('provider credential');

    expect(JSON.stringify(events)).not.toContain('unknown secret URL');
  });

  it('keeps logical and physical layers distinct for real transport retries', async () => {
    const events: RpcTraceEvent[] = [];

    const metrics = createRpcMetrics({
      onTrace: (event) => events.push(event),
    });

    let attempts = 0;

    const transport = measuredHttp(
      'https://provider.invalid/secret',
      metrics,
      'public',
      {
        retryCount: 1,
        retryDelay: 0,
        fetchFn: async () => {
          attempts += 1;

          if (attempts === 1) {
            throw new Error('https://provider.invalid/secret');
          }

          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
            { status: 200 },
          );
        },
      },
    )({ retryCount: 1 });

    await expect(
      transport.request({ method: 'eth_blockNumber' }),
    ).resolves.toBe('0x1');

    expect(attempts).toBe(2);

    expect(metrics.snapshot().logical[0]!.started).toBe(1);

    expect(metrics.snapshot().http[0]!.started).toBe(2);

    assertReconciled(events, metrics);

    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('reconciles a batched HTTP envelope without inventing its logical parent', async () => {
    const events: RpcTraceEvent[] = [];

    const metrics = createRpcMetrics({
      onTrace: (event) => events.push(event),
    });

    const transport = measuredHttp(
      'https://provider.invalid/secret',
      metrics,
      'public',
      {
        batch: { wait: 1 },
        retryCount: 0,
        fetchFn: async (_input, init) => {
          const batch = JSON.parse(String(init?.body)) as { id: number }[];

          return new Response(
            JSON.stringify(
              batch.map((request) => ({
                id: request.id,
                jsonrpc: '2.0',
                result: '0x1',
              })),
            ),
            { status: 200 },
          );
        },
      },
    )({ retryCount: 0 });

    await Promise.all([
      transport.request({ method: 'eth_blockNumber' }),
      transport.request({ method: 'eth_chainId' }),
    ]);

    expect(metrics.snapshot().logical).toHaveLength(2);

    expect(metrics.snapshot().http[0]!.started).toBe(1);

    assertReconciled(events, metrics);

    expect(
      events
        .filter((event) => event.layer === 'http')
        .every((event) => event.parentLogicalId === null),
    ).toBe(true);
  });

  it('observer exceptions do not alter response identity or original rejection', async () => {
    const metrics = createRpcMetrics({
      onTrace() {
        throw new Error('observer');
      },
    });

    const response = new Response(null, { status: 201 });

    expect(await metrics.http('public', async () => response)).toBe(response);

    const failure = new Error('original');

    await expect(
      metrics.logical('public', 'eth_call', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const snapshot = createRpcUsageSnapshot(metrics.snapshot(), AT);

    expect(snapshot.http[0]!.responses).toBe(1);

    expect(snapshot.logical[0]!.failed).toBe(1);
  });

  it('end events observe the same complete counter update and duration', async () => {
    const events: RpcTraceEvent[] = [];

    const cuts: ReturnType<ReturnType<typeof createRpcMetrics>['snapshot']>[] =
      [];

    const metrics = createRpcMetrics({
      onTrace(event) {
        events.push(event);

        if (event.phase === 'end') {
          cuts.push(metrics.snapshot());
        }
      },
    });

    await metrics.http(
      'public',
      async () => new Response(null, { status: 500 }),
    );

    expect(events).toHaveLength(2);

    expect(cuts).toHaveLength(1);

    expect(cuts[0]!.http[0]).toMatchObject({
      succeeded: 1,
      inFlight: 0,
      statuses: { '5xx': 1 },
    });

    expect(cuts[0]!.http[0]!.durationMs).toBe(events[1]!.durationMs);

    assertReconciled(events, metrics);
  });
});
