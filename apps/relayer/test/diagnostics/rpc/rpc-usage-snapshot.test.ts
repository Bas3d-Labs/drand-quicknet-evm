import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  RPC_METHOD_LABELS,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import type {
  RpcMetricsSnapshot,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  createRpcUsageSnapshot,
  readRpcUsageSnapshot,
} from '../../../src/diagnostics/rpc/rpc-usage-snapshot.js';

const INVALID = 'Invalid RPC usage snapshot.';

function fixture() {
  return {
    collectorId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-10-21T00:00:00.000Z',
    observedAt: '2026-10-21T00:01:00.000Z',
    logical: [
      {
        client: 'public',
        method: 'eth_call',
        started: 4,
        completed: 3,
        failed: 1,
        inFlight: 1,
        durationMs: 12.75,
      },
    ],
    http: [
      {
        client: 'public',
        started: 5,
        responses: 3,
        transportFailures: 1,
        inFlight: 1,
        statuses: {
          '2xx': 1,
          '3xx': 0,
          '4xx': 0,
          '5xx': 1,
        },
        durationMs: 10.5,
      },
    ],
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);

  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}

describe('persisted RPC usage reader', () => {
  it('preserves cumulative measurements and unclassified HTTP responses', () => {
    const input = fixture();
    const result = readRpcUsageSnapshot(input);

    expect(result).toEqual(input);
    expect(JSON.stringify(result)).not.toContain('averageDurationMs');
  });

  it('accepts empty row arrays', () => {
    const input = {
      ...fixture(),
      logical: [],
      http: [],
    };

    expect(readRpcUsageSnapshot(input)).toEqual(input);
  });

  it('allows wall-clock observation time before collector creation', () => {
    const input = {
      ...fixture(),
      observedAt: '2026-10-20T23:59:00.000Z',
    };

    expect(readRpcUsageSnapshot(input)).toEqual(input);
  });

  it('projects known fields into detached, deeply frozen objects', () => {
    const base = fixture();
    const input = {
      ...base,
      privateField: 'discard-me',
      logical: base.logical.map((row) => ({
        ...row,
        averageDurationMs: 999,
        privateField: 'discard-me',
      })),
      http: base.http.map((row) => ({
        ...row,
        averageDurationMs: 999,
        statuses: {
          ...row.statuses,
          privateField: 'discard-me',
        },
      })),
    };
    const before = structuredClone(input);

    const result = readRpcUsageSnapshot(input);

    expect(result).toEqual(base);
    expect(input).toEqual(before);
    expectDeeplyFrozen(result);

    expect(result.logical).not.toBe(input.logical);
    expect(result.logical[0]).not.toBe(input.logical[0]);
    expect(result.http).not.toBe(input.http);
    expect(result.http[0]).not.toBe(input.http[0]);
    expect(result.http[0]!.statuses).not.toBe(input.http[0]!.statuses);

    input.logical[0]!.started = 999;
    input.http[0]!.statuses['2xx'] = 999;

    expect(result).toEqual(base);
  });

  it('accepts the complete row set and canonicalizes insertion order', () => {
    const base = fixture();
    const logical = [];
    const http = [];

    for (const client of ['wallet', 'public']) {
      for (const method of [...RPC_METHOD_LABELS].reverse()) {
        logical.push({
          ...base.logical[0]!,
          client,
          method,
        });
      }

      http.push({
        ...base.http[0]!,
        client,
        statuses: {
          '5xx': 1,
          '4xx': 0,
          '3xx': 0,
          '2xx': 1,
        },
      });
    }

    const input = { ...base, logical, http };
    const before = structuredClone(input);
    const result = readRpcUsageSnapshot(input);

    const reversed = readRpcUsageSnapshot({
      ...input,
      logical: [...logical].reverse(),
      http: [...http].reverse(),
    });

    expect(JSON.stringify(result)).toBe(JSON.stringify(reversed));
    expect(input).toEqual(before);
    expect(result.logical).toHaveLength(RPC_METHOD_LABELS.length * 2);
    expect(result.http.map((row) => row.client))
      .toEqual(['public', 'wallet']);

    const methods = [...RPC_METHOD_LABELS].sort();

    expect(result.logical.map((row) => row.client + ':' + row.method))
      .toEqual([
        ...methods.map((method) => 'public:' + method),
        ...methods.map((method) => 'wallet:' + method),
      ]);

    for (const row of result.http) {
      expect(Object.keys(row.statuses)).toEqual([
        '2xx',
        '3xx',
        '4xx',
        '5xx',
      ]);
    }
  });

  it.each([
    { name: 'null', input: null },
    { name: 'undefined', input: undefined },
    { name: 'array', input: [] },
    { name: 'string', input: 'snapshot' },
    { name: 'number', input: 1 },
  ])('rejects a non-object root: $name', ({ input }) => {
    expect(() => readRpcUsageSnapshot(input)).toThrow(INVALID);
  });

  it.each([
    { collectorId: 'not-a-uuid' },
    { collectorId: undefined },
    { startedAt: 'invalid' },
    { observedAt: '2026-10-21T00:01:00Z' },
    { logical: null },
    { http: {} },
  ])('rejects invalid metadata or arrays: %j', (patch) => {
    expect(() => readRpcUsageSnapshot({
      ...fixture(),
      ...patch,
    })).toThrow(INVALID);
  });

  it.each([
    { client: 'unknown' },
    { method: 'eth_unrecognized' },
  ])('rejects unsupported logical labels: %j', (patch) => {
    const input = fixture();

    expect(() => readRpcUsageSnapshot({
      ...input,
      logical: [{ ...input.logical[0]!, ...patch }],
    })).toThrow(INVALID);
  });

  it('rejects an unsupported HTTP client', () => {
    const input = fixture();

    expect(() => readRpcUsageSnapshot({
      ...input,
      http: [{ ...input.http[0]!, client: 'unknown' }],
    })).toThrow(INVALID);
  });

  it.each(['logical', 'http'] as const)(
    'rejects duplicate %s rows',
    (kind) => {
      const input = fixture();

      expect(() => readRpcUsageSnapshot({
        ...input,
        [kind]: [input[kind][0], input[kind][0]],
      })).toThrow(INVALID);
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects an oversized %s array',
    (kind) => {
      const input = fixture();
      let maximum = 2;

      if (kind === 'logical') {
        maximum = RPC_METHOD_LABELS.length * 2;
      }

      expect(() => readRpcUsageSnapshot({
        ...input,
        [kind]: Array.from(
          { length: maximum + 1 },
          () => input[kind][0],
        ),
      })).toThrow(INVALID);
    },
  );

  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    undefined,
  ])('rejects invalid counts throughout the snapshot: %s', (value) => {
    for (const field of [
      'started',
      'completed',
      'failed',
      'inFlight',
    ]) {
      const input = fixture();

      expect(() => readRpcUsageSnapshot({
        ...input,
        logical: [{ ...input.logical[0]!, [field]: value }],
      })).toThrow(INVALID);
    }

    for (const field of [
      'started',
      'responses',
      'transportFailures',
      'inFlight',
    ]) {
      const input = fixture();

      expect(() => readRpcUsageSnapshot({
        ...input,
        http: [{ ...input.http[0]!, [field]: value }],
      })).toThrow(INVALID);
    }

    for (const status of ['2xx', '3xx', '4xx', '5xx']) {
      const input = fixture();
      const row = input.http[0]!;

      expect(() => readRpcUsageSnapshot({
        ...input,
        http: [{
          ...row,
          statuses: {
            ...row.statuses,
            [status]: value,
          },
        }],
      })).toThrow(INVALID);
    }
  });

  it.each([
    -1,
    NaN,
    Infinity,
    -Infinity,
    '1',
    undefined,
  ])('rejects invalid durations in both row kinds: %s', (value) => {
    const input = fixture();

    expect(() => readRpcUsageSnapshot({
      ...input,
      logical: [{ ...input.logical[0]!, durationMs: value }],
    })).toThrow(INVALID);

    expect(() => readRpcUsageSnapshot({
      ...input,
      http: [{ ...input.http[0]!, durationMs: value }],
    })).toThrow(INVALID);
  });

  it.each([
    0,
    Number.MIN_VALUE,
    0.0000012345678901234567,
    Number.MAX_VALUE,
  ])('preserves finite non-negative duration precision: %s', (durationMs) => {
    const input = fixture();
    input.logical[0]!.durationMs = durationMs;
    input.http[0]!.durationMs = durationMs;

    // Exercise the actual JSON round trip.
    const result = readRpcUsageSnapshot(
      JSON.parse(JSON.stringify(input)),
    );

    expect(result.logical[0]!.durationMs).toBe(durationMs);
    expect(result.http[0]!.durationMs).toBe(durationMs);
  });

  it.each([
    { completed: 5 },
    { failed: 4 },
    { inFlight: 0 },
    { completed: 0, failed: 0, inFlight: 4 },
  ])('rejects inconsistent cumulative logical counters: %j', (patch) => {
    const input = fixture();

    expect(() => readRpcUsageSnapshot({
      ...input,
      logical: [{ ...input.logical[0]!, ...patch }],
    })).toThrow(INVALID);
  });

  it.each([
    { responses: 6 },
    { transportFailures: 3 },
    { inFlight: 0 },
    {
      responses: 0,
      transportFailures: 0,
      inFlight: 5,
      statuses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    },
    {
      statuses: { '2xx': 2, '3xx': 1, '4xx': 1, '5xx': 0 },
    },
  ])('rejects inconsistent cumulative HTTP counters: %j', (patch) => {
    const input = fixture();

    expect(() => readRpcUsageSnapshot({
      ...input,
      http: [{ ...input.http[0]!, ...patch }],
    })).toThrow(INVALID);
  });

  it('accepts pending-only rows with zero duration', () => {
    const input = fixture();

    input.logical[0] = {
      ...input.logical[0]!,
      completed: 0,
      failed: 0,
      inFlight: 4,
      durationMs: 0,
    };

    input.http[0] = {
      ...input.http[0]!,
      responses: 0,
      transportFailures: 0,
      inFlight: 5,
      durationMs: 0,
      statuses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    };

    expect(readRpcUsageSnapshot(input)).toEqual(input);
  });

  it('rejects completion and status totals that exceed safe bounds', () => {
    const input = fixture();
    const row = input.http[0]!;

    expect(() => readRpcUsageSnapshot({
      ...input,
      http: [{
        ...row,
        started: Number.MAX_SAFE_INTEGER,
        responses: Number.MAX_SAFE_INTEGER,
        transportFailures: 1,
        inFlight: 0,
      }],
    })).toThrow(INVALID);

    expect(() => readRpcUsageSnapshot({
      ...input,
      http: [{
        ...row,
        started: Number.MAX_SAFE_INTEGER,
        responses: Number.MAX_SAFE_INTEGER,
        transportFailures: 0,
        inFlight: 0,
        statuses: {
          '2xx': Number.MAX_SAFE_INTEGER,
          '3xx': 1,
          '4xx': 0,
          '5xx': 0,
        },
      }],
    })).toThrow(INVALID);
  });
});

describe('collector RPC usage projection', () => {
  const observedAt = '2026-10-12T12:00:00.000Z';

  function measurements(): RpcMetricsSnapshot {
    return {
      collectorId: '33333333-3333-4333-8333-333333333333',
      startedAt: '2026-10-12T11:00:00.000Z',
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 5,
        succeeded: 2,
        failed: 1,
        inFlight: 2,
        durationMs: 12.3456789,
      }],
      http: [{
        client: 'public',
        started: 6,
        succeeded: 3,
        failed: 1,
        inFlight: 2,
        statuses: {
          '2xx': 1,
          '3xx': 0,
          '4xx': 0,
          '5xx': 1,
        },
        durationMs: 8.7654321,
      }],
    };
  }

  it('maps collector counters into cumulative operator-facing fields', () => {
    const input = measurements();
    const result = createRpcUsageSnapshot(input, observedAt);

    expect(result).toEqual({
      collectorId: input.collectorId,
      startedAt: input.startedAt,
      observedAt,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 5,
        completed: 3,
        failed: 1,
        inFlight: 2,
        durationMs: 12.3456789,
      }],
      http: [{
        client: 'public',
        started: 6,
        responses: 3,
        transportFailures: 1,
        inFlight: 2,
        statuses: {
          '2xx': 1,
          '3xx': 0,
          '4xx': 0,
          '5xx': 1,
        },
        durationMs: 8.7654321,
      }],
    });

    expect(JSON.stringify(result)).not.toContain('averageDurationMs');
    expect(JSON.stringify(result)).not.toContain('succeeded');
  });

  it('preserves inputs and returns detached frozen measurements', () => {
    const input = measurements();
    const before = structuredClone(input);

    const result = createRpcUsageSnapshot(input, observedAt);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.logical[0])).toBe(false);
    expect(Object.isFrozen(input.http[0]!.statuses)).toBe(false);

    expect(result.logical).not.toBe(input.logical);
    expect(result.logical[0]).not.toBe(input.logical[0]);
    expect(result.http).not.toBe(input.http);
    expect(result.http[0]).not.toBe(input.http[0]);
    expect(result.http[0]!.statuses).not.toBe(input.http[0]!.statuses);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.logical)).toBe(true);
    expect(Object.isFrozen(result.logical[0])).toBe(true);
    expect(Object.isFrozen(result.http)).toBe(true);
    expect(Object.isFrozen(result.http[0])).toBe(true);
    expect(Object.isFrozen(result.http[0]!.statuses)).toBe(true);
  });

  it('preserves empty collectors without fabricating rows', () => {
    const input: RpcMetricsSnapshot = {
      ...measurements(),
      logical: [],
      http: [],
    };

    expect(createRpcUsageSnapshot(input, observedAt)).toEqual({
      collectorId: input.collectorId,
      startedAt: input.startedAt,
      observedAt,
      logical: [],
      http: [],
    });
  });

  it('rejects collector counts outside the persisted numeric range', () => {
    const input = measurements();

    const oversized: RpcMetricsSnapshot = {
      ...input,
      logical: [{
        ...input.logical[0]!,
        started: Number.MAX_SAFE_INTEGER + 1,
      }],
    };

    expect(() => createRpcUsageSnapshot(oversized, observedAt))
      .toThrow('Invalid RPC usage snapshot.');
  });
});