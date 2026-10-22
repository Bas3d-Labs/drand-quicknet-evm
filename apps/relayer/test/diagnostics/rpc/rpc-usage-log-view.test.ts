import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RPC_METHOD_LABELS,
  type RpcMetricsSnapshot,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  projectRpcUsageLogView,
} from '../../../src/diagnostics/rpc/rpc-usage-log-view.js';

import {
  createRpcUsageReport,
} from '../../../src/diagnostics/rpc/rpc-usage-report.js';

const INVALID = 'Invalid RPC usage log view.';

function observations() {
  const previous: RpcMetricsSnapshot = {
    collectorId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-10-22T12:00:00.000Z',
    logical: [{
      client: 'public',
      method: 'eth_call',
      started: 3,
      succeeded: 0,
      failed: 0,
      inFlight: 3,
      durationMs: 0,
    }],
    http: [{
      client: 'public',
      started: 3,
      succeeded: 0,
      failed: 0,
      inFlight: 3,
      durationMs: 0,
      statuses: {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    }],
  };

  const current: RpcMetricsSnapshot = {
    ...previous,
    logical: [{
      ...previous.logical[0]!,
      succeeded: 1,
      failed: 1,
      inFlight: 1,
      durationMs: 12.5,
    }],
    http: [{
      ...previous.http[0]!,
      succeeded: 2,
      failed: 1,
      inFlight: 0,
      durationMs: 9.75,
      statuses: {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 1,
      },
    }],
  };

  return { previous, current };
}

function report() {
  const { previous, current } = observations();

  return createRpcUsageReport(
    { snapshot: current, observedAtMs: 60_000 },
    { snapshot: previous, observedAtMs: 0 },
  );
}

describe('RPC usage log view projection', () => {
  it('preserves cumulative calculator output', () => {
    const input = report().cumulative;

    expect(projectRpcUsageLogView(input, 'cumulative'))
      .toEqual(input);
  });

  it('accepts interval completions exceeding starts and current gauges', () => {
    const input = report().interval;

    if (!input.available) {
      throw new Error('Expected an available interval.');
    }

    const result = projectRpcUsageLogView(input, 'interval');

    expect(result).toEqual({
      logical: input.logical,
      http: input.http,
    });

    expect(result.logical[0]).toMatchObject({
      started: 0,
      completed: 2,
      failed: 1,
      inFlight: 1,
      durationMs: 12.5,
      averageDurationMs: 6.25,
    });

    expect(result.http[0]).toMatchObject({
      started: 0,
      responses: 2,
      transportFailures: 1,
      inFlight: 0,
      durationMs: 9.75,
      averageDurationMs: 3.25,
    });

    expect(() => projectRpcUsageLogView(input, 'cumulative'))
      .toThrow(INVALID);
  });

  it('retains zero-delta rows and null averages', () => {
    const { current } = observations();

    const input = createRpcUsageReport(
      { snapshot: current, observedAtMs: 60_000 },
      { snapshot: current, observedAtMs: 0 },
    ).interval;

    if (!input.available) {
      throw new Error('Expected an available interval.');
    }

    const result = projectRpcUsageLogView(input, 'interval');

    expect(result.logical).toHaveLength(1);
    expect(result.http).toHaveLength(1);

    expect(result.logical[0]).toMatchObject({
      started: 0,
      completed: 0,
      failed: 0,
      inFlight: 1,
      durationMs: 0,
      averageDurationMs: null,
    });

    expect(result.http[0]).toMatchObject({
      started: 0,
      responses: 0,
      transportFailures: 0,
      inFlight: 0,
      durationMs: 0,
      averageDurationMs: null,
    });
  });

  it('returns detached frozen objects without modifying the input', () => {
    const input = structuredClone(report().cumulative);
    const before = structuredClone(input);

    const result = projectRpcUsageLogView(input, 'cumulative');

    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.http[0]!.statuses)).toBe(false);

    expect(result).not.toBe(input);
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

  it.each(['logical', 'http'] as const)(
    'rejects an incorrect %s average',
    (kind) => {
      const input = structuredClone(report().cumulative);

      Object.assign(input[kind][0]!, {
        averageDurationMs: 999,
      });

      expect(() => projectRpcUsageLogView(input, 'cumulative'))
        .toThrow(INVALID);
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects duplicate %s rows',
    (kind) => {
      const input = report().cumulative;
      const duplicate = {
        ...input,
        [kind]: [input[kind][0], input[kind][0]],
      };

      expect(() => projectRpcUsageLogView(duplicate, 'cumulative'))
        .toThrow(INVALID);
    },
  );

  it('rejects a status getter without invoking it', () => {
    const input = structuredClone(report().cumulative);
    const getter = vi.fn(() => 0);

    Object.defineProperty(input.http[0]!.statuses, '2xx', {
      get: getter,
    });

    expect(() => projectRpcUsageLogView(input, 'cumulative'))
      .toThrow(INVALID);

    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects an array element getter without invoking it', () => {
    const input = structuredClone(report().cumulative);
    const getter = vi.fn(() => input.logical[0]);

    Object.defineProperty(input.logical, '0', {
      get: getter,
    });

    expect(() => projectRpcUsageLogView(input, 'cumulative'))
      .toThrow(INVALID);

    expect(getter).not.toHaveBeenCalled();
  });

  it('ignores undeclared properties and serialization hooks', () => {
    const input = structuredClone(report().cumulative);
    const secret = 'rpc-log-canary';
    const toJSON = vi.fn(() => secret);
    const getter = vi.fn(() => secret);

    for (const target of [
      input,
      input.logical[0]!,
      input.http[0]!,
      input.http[0]!.statuses,
    ]) {
      Object.assign(target, { secret, toJSON });
      Object.defineProperty(target, 'extra', { get: getter });
    }

    const result = projectRpcUsageLogView(input, 'cumulative');

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'negative', value: -1 },
    { name: 'fractional', value: 1.5 },
    { name: 'NaN', value: Number.NaN },
    { name: 'infinite', value: Number.POSITIVE_INFINITY },
    { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'string', value: '1' },
    { name: 'missing', value: undefined },
  ])('rejects $name counts throughout both views', ({ value }) => {
    for (const kind of ['cumulative', 'interval'] as const) {
      const targets = [
        {
          row: 'logical',
          fields: ['started', 'completed', 'failed', 'inFlight'],
        },
        {
          row: 'http',
          fields: [
            'started',
            'responses',
            'transportFailures',
            'inFlight',
          ],
        },
      ] as const;

      for (const target of targets) {
        for (const field of target.fields) {
          const input = structuredClone(report().cumulative);

          Object.assign(input[target.row][0]!, {
            [field]: value,
          });

          expect(() => projectRpcUsageLogView(input, kind))
            .toThrow(INVALID);
        }
      }

      for (const bucket of ['2xx', '3xx', '4xx', '5xx'] as const) {
        const input = structuredClone(report().cumulative);

        Object.assign(input.http[0]!.statuses, {
          [bucket]: value,
        });

        expect(() => projectRpcUsageLogView(input, kind))
          .toThrow(INVALID);
      }
    }
  });

  it.each([
    { name: 'negative', value: -1 },
    { name: 'NaN', value: Number.NaN },
    { name: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { name: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { name: 'string', value: '1' },
    { name: 'missing', value: undefined },
  ])('rejects $name durations', ({ value }) => {
    for (const kind of ['cumulative', 'interval'] as const) {
      for (const row of ['logical', 'http'] as const) {
        const input = structuredClone(report().cumulative);

        Object.assign(input[row][0]!, {
          durationMs: value,
        });

        expect(() => projectRpcUsageLogView(input, kind))
          .toThrow(INVALID);
      }
    }
  });

  it('rejects unsafe HTTP completion totals in an interval', () => {
    const input = structuredClone(report().cumulative);

    Object.assign(input.http[0]!, {
      responses: Number.MAX_SAFE_INTEGER,
      transportFailures: 1,
      durationMs: 0,
      averageDurationMs: 0,
    });

    expect(() => projectRpcUsageLogView(input, 'interval'))
      .toThrow(INVALID);
  });

  it('rejects status totals exceeding responses', () => {
    const input = structuredClone(report().cumulative);

    Object.assign(input.http[0]!.statuses, {
      '2xx': 2,
      '5xx': 1,
    });

    for (const kind of ['cumulative', 'interval'] as const) {
      expect(() => projectRpcUsageLogView(input, kind))
        .toThrow(INVALID);
    }
  });

  it('accepts every supported row and canonicalizes their order', () => {
    const logical: RpcMetricsSnapshot['logical'][number][] = [];
    const http: RpcMetricsSnapshot['http'][number][] = [];

    for (const client of ['wallet', 'public'] as const) {
      for (const method of [...RPC_METHOD_LABELS].reverse()) {
        logical.push({
          client,
          method,
          started: 0,
          succeeded: 0,
          failed: 0,
          inFlight: 0,
          durationMs: 0,
        });
      }

      http.push({
        client,
        started: 0,
        succeeded: 0,
        failed: 0,
        inFlight: 0,
        durationMs: 0,
        statuses: {
          '2xx': 0,
          '3xx': 0,
          '4xx': 0,
          '5xx': 0,
        },
      });
    }

    const { current } = observations();

    const expected = createRpcUsageReport({
      snapshot: {
        ...current,
        logical,
        http,
      },
      observedAtMs: 0,
    }).cumulative;

    const input = {
      logical: [...expected.logical].reverse(),
      http: [...expected.http].reverse(),
    };
    const before = structuredClone(input);

    const result = projectRpcUsageLogView(input, 'cumulative');

    expect(result).toEqual(expected);
    expect(result.logical).toHaveLength(RPC_METHOD_LABELS.length * 2);
    expect(result.http).toHaveLength(2);
    expect(input).toEqual(before);
  });

  it.each([
    { kind: 'logical', maximum: RPC_METHOD_LABELS.length * 2 },
    { kind: 'http', maximum: 2 },
  ] as const)(
    'rejects oversized $kind arrays before reading their elements',
    ({ kind, maximum }) => {
      const input = report().cumulative;
      const oversized = new Array(maximum + 1);
      const getter = vi.fn(() => input[kind][0]);

      Object.defineProperty(oversized, '0', {
        get: getter,
      });

      expect(() => projectRpcUsageLogView({
        ...input,
        [kind]: oversized,
      }, 'cumulative')).toThrow(INVALID);

      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects sparse %s arrays',
    (kind) => {
      const input = report().cumulative;

      expect(() => projectRpcUsageLogView({
        ...input,
        [kind]: new Array(1),
      }, 'cumulative')).toThrow(INVALID);
    },
  );
});