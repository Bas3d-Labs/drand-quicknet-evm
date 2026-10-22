import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  projectRpcUsageLogContext,
} from '../../../src/diagnostics/rpc/rpc-usage-log.js';

const INVALID = 'Invalid RPC usage log context.';
const AT = '2026-10-22T12:00:00.000Z';

function context() {
  return {
    observedAt: AT,
    report: {
      collectorId: '11111111-1111-4111-8111-111111111111',
      startedAt: AT,
      cumulative: {
        logical: [{
          client: 'public',
          method: 'eth_call',
          started: 3,
          completed: 2,
          failed: 1,
          inFlight: 1,
          durationMs: 12.5,
          averageDurationMs: 6.25,
        }],
        http: [{
          client: 'public',
          started: 3,
          responses: 2,
          transportFailures: 1,
          inFlight: 0,
          statuses: {
            '2xx': 1,
            '3xx': 0,
            '4xx': 0,
            '5xx': 1,
          },
          durationMs: 9.75,
          averageDurationMs: 3.25,
        }],
      },
      interval: {
        available: true,
        elapsedMs: 0.25,
        logical: [{
          client: 'public',
          method: 'eth_call',
          started: 0,
          completed: 2,
          failed: 1,
          inFlight: 1,
          durationMs: 12.5,
          averageDurationMs: 6.25,
        }],
        http: [{
          client: 'public',
          started: 0,
          responses: 2,
          transportFailures: 1,
          inFlight: 0,
          statuses: {
            '2xx': 1,
            '3xx': 0,
            '4xx': 0,
            '5xx': 1,
          },
          durationMs: 9.75,
          averageDurationMs: 3.25,
        }],
      },
    },
  };
}

describe('RPC usage log context projection', () => {
  it('preserves both views and fractional elapsed time', () => {
    const input = context();

    expect(projectRpcUsageLogContext(input)).toEqual(input);
  });

  it.each([
    'no-baseline',
    'collector-changed',
    'invalid-elapsed-time',
    'counters-regressed',
  ] as const)(
    'preserves cumulative usage when the interval is unavailable: %s',
    (reason) => {
      const input = context();

      const result = projectRpcUsageLogContext({
        ...input,
        report: {
          ...input.report,
          interval: {
            available: false,
            reason,
          },
        },
      });

      expect(result.report.cumulative).toEqual(input.report.cumulative);
      expect(result.report.interval).toEqual({
        available: false,
        reason,
      });
      expect(Object.isFrozen(result.report.interval)).toBe(true);
    },
  );

  it('allows wall-clock observation time before collector creation', () => {
    const input = context();
    input.observedAt = '2026-10-22T11:59:00.000Z';

    expect(projectRpcUsageLogContext(input)).toEqual(input);
  });

  it.each([
    { field: 'observedAt', value: 'invalid' },
    { field: 'observedAt', value: '2026-10-22T12:00:00Z' },
    { field: 'startedAt', value: 'invalid' },
    { field: 'collectorId', value: 'not-a-uuid' },
  ])('rejects malformed $field: $value', ({ field, value }) => {
    const input = context();

    if (field === 'observedAt') {
      input.observedAt = value;
    } else {
      Object.assign(input.report, { [field]: value });
    }

    expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '1',
    undefined,
  ])('rejects invalid elapsed time: %s', (elapsedMs) => {
    const input = context();

    Object.assign(input.report.interval, { elapsedMs });

    expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
  });

  it.each([
    { available: 'true' },
    { available: null },
    { available: false, reason: 'unknown' },
    { available: false },
  ])('rejects an invalid interval discriminator or reason: %j', (interval) => {
    const input = context();

    expect(() => projectRpcUsageLogContext({
      ...input,
      report: {
        ...input.report,
        interval,
      },
    })).toThrow(INVALID);
  });

  it.each(['logical', 'http'] as const)(
    'rejects a missing interval %s row',
    (kind) => {
      const input = context();
      input.report.interval[kind] = [];

      expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
    },
  );

  it.each(['logical', 'http'] as const)(
    'rejects an interval %s client mismatch',
    (kind) => {
      const input = context();
      input.report.interval[kind][0]!.client = 'wallet';

      expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
    },
  );

  it('rejects an interval method mismatch', () => {
    const input = context();
    input.report.interval.logical[0]!.method = 'eth_getLogs';

    expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
  });

  it.each(['logical', 'http'] as const)(
    'rejects an interval %s gauge mismatch',
    (kind) => {
      const input = context();
      input.report.interval[kind][0]!.inFlight += 1;

      expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
    },
  );

  it('returns detached frozen objects without changing the input', () => {
    const input = context();
    const before = structuredClone(input);

    const result = projectRpcUsageLogContext(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input.report)).toBe(false);
    expect(result).not.toBe(input);
    expect(result.report).not.toBe(input.report);
    expect(result.report.cumulative).not.toBe(input.report.cumulative);
    expect(result.report.interval).not.toBe(input.report.interval);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.report)).toBe(true);
    expect(Object.isFrozen(result.report.cumulative)).toBe(true);
    expect(Object.isFrozen(result.report.interval)).toBe(true);
  });

  it.each([
    'observedAt',
    'report',
    'collectorId',
    'startedAt',
    'cumulative',
    'interval',
    'available',
    'elapsedMs',
  ])('rejects a getter for %s without invoking it', (field) => {
    const input = context();
    const getter = vi.fn(() => {
      throw new Error('getter-canary');
    });

    let target: object = input.report;

    if (field === 'observedAt' || field === 'report') {
      target = input;
    } else if (field === 'available' || field === 'elapsedMs') {
      target = input.report.interval;
    }

    Object.defineProperty(target, field, { get: getter });

    expect(() => projectRpcUsageLogContext(input)).toThrow(INVALID);
    expect(getter).not.toHaveBeenCalled();
  });

  it('omits undeclared fields and serialization hooks', () => {
    const input = context();
    const secret = 'rpc-event-canary';
    const toJSON = vi.fn(() => secret);
    const getter = vi.fn(() => secret);

    for (const target of [
      input,
      input.report,
      input.report.interval,
    ]) {
      Object.assign(target, {
        secret,
        observedAtMs: 123,
        toJSON,
      });

      Object.defineProperty(target, 'extra', { get: getter });
    }

    const serialized = JSON.stringify(projectRpcUsageLogContext(input));

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('observedAtMs');
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});