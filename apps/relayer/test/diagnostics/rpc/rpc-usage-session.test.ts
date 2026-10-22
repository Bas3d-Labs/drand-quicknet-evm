import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  RpcMetricsSnapshot,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import type {
  RpcUsageLogContext,
} from '../../../src/diagnostics/rpc/rpc-usage-log.js';

import {
  createRpcUsageSession,
} from '../../../src/diagnostics/rpc/rpc-usage-session.js';

const WALL_START = Date.parse('2026-10-22T12:00:00.000Z');

function snapshot(completed = false): RpcMetricsSnapshot {
  let succeeded = 0;
  let inFlight = 1;
  let durationMs = 0;

  if (completed) {
    succeeded = 1;
    inFlight = 0;
    durationMs = 75_000.25;
  }

  return {
    collectorId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-10-22T12:00:00.000Z',
    logical: [{
      client: 'public',
      method: 'eth_call',
      started: 1,
      succeeded,
      failed: 0,
      inFlight,
      durationMs,
    }],
    http: [],
  };
}

function fixture() {
  let monotonicMs = 0;
  let wallMs = WALL_START;

  const readSnapshot = vi.fn<() => RpcMetricsSnapshot>()
    .mockReturnValue(snapshot());

  const emit = vi.fn<(context: RpcUsageLogContext) => void>();
  const onFailure = vi.fn<(error: unknown) => void>();

  const session = createRpcUsageSession({
    readSnapshot,
    emit,
    onFailure,
    monotonicNow: () => monotonicMs,
    wallNow: () => wallMs,
  });

  return {
    session,
    readSnapshot,
    emit,
    onFailure,
    setTime(monotonic: number, wall = WALL_START + monotonic) {
      monotonicMs = monotonic;
      wallMs = wall;
    },
  };
}

describe('RPC usage reporting session', () => {
  it('waits for the threshold without capturing an implicit baseline', () => {
    const t = fixture();

    expect(t.readSnapshot).not.toHaveBeenCalled();

    t.session.onCycle();
    t.setTime(59_999);
    t.session.onCycle();

    expect(t.readSnapshot).not.toHaveBeenCalled();
    expect(t.emit).not.toHaveBeenCalled();

    t.setTime(60_000);
    t.session.onCycle();

    expect(t.readSnapshot).toHaveBeenCalledOnce();
    expect(t.emit).toHaveBeenCalledOnce();

    const first = t.emit.mock.calls[0]![0];

    expect(first.observedAt)
      .toBe(new Date(WALL_START + 60_000).toISOString());
    expect(first.report.interval).toEqual({
      available: false,
      reason: 'no-baseline',
    });
    expect(first.report.cumulative.logical[0]?.inFlight).toBe(1);
    expect(t.onFailure).not.toHaveBeenCalled();
  });

  it('uses actual elapsed time and attributes spanning work to completion', () => {
    const t = fixture();

    t.setTime(65_000);
    t.session.onCycle();

    t.readSnapshot.mockReturnValue(snapshot(true));

    // A backward wall-clock change does not affect interval length.
    t.setTime(140_000.5, WALL_START - 1_000);
    t.session.onCycle();

    expect(t.emit).toHaveBeenCalledTimes(2);

    const second = t.emit.mock.calls[1]![0];

    expect(second.observedAt)
      .toBe(new Date(WALL_START - 1_000).toISOString());
    expect(second.report.interval).toMatchObject({
      available: true,
      elapsedMs: 75_000.5,
      logical: [{
        client: 'public',
        method: 'eth_call',
        started: 0,
        completed: 1,
        failed: 0,
        inFlight: 0,
        durationMs: 75_000.25,
        averageDurationMs: 75_000.25,
      }],
    });

    expect(JSON.stringify(second)).not.toContain('observedAtMs');
    expect(t.onFailure).not.toHaveBeenCalled();
  });

  it('schedules from the last attempt without emitting catch-up reports', () => {
    const t = fixture();

    t.setTime(180_000);
    t.session.onCycle();
    t.session.onCycle();

    t.setTime(239_999);
    t.session.onCycle();

    expect(t.emit).toHaveBeenCalledOnce();

    t.setTime(240_000);
    t.session.onCycle();

    expect(t.emit).toHaveBeenCalledTimes(2);
    expect(t.emit.mock.calls[1]![0].report.interval).toMatchObject({
      available: true,
      elapsedMs: 60_000,
    });
  });

  it('reports once on finish even before the first threshold', () => {
    const t = fixture();

    t.setTime(1_000);
    t.session.finish();
    t.session.finish();

    t.setTime(120_000);
    t.session.onCycle();

    expect(t.readSnapshot).toHaveBeenCalledOnce();
    expect(t.emit).toHaveBeenCalledOnce();
    expect(t.emit.mock.calls[0]![0].report.interval).toEqual({
      available: false,
      reason: 'no-baseline',
    });
  });

  it('reports a short final interval after an earlier report', () => {
    const t = fixture();

    t.setTime(60_000);
    t.session.onCycle();

    t.setTime(60_250);
    t.session.finish();

    expect(t.emit).toHaveBeenCalledTimes(2);
    expect(t.emit.mock.calls[1]![0].report.interval).toMatchObject({
      available: true,
      elapsedMs: 250,
    });
  });

  it('retains cumulative usage when finish has the same observation time', () => {
    const t = fixture();

    t.setTime(60_000);
    t.session.onCycle();
    t.session.finish();

    expect(t.emit).toHaveBeenCalledTimes(2);

    const final = t.emit.mock.calls[1]![0];

    expect(final.report.interval).toEqual({
      available: false,
      reason: 'invalid-elapsed-time',
    });
    expect(final.report.cumulative.logical).toHaveLength(1);
  });

  it('preserves the baseline after capture failure and waits before retrying', () => {
    const t = fixture();
    const failure = new Error('Capture failed');

    t.setTime(60_000);
    t.session.onCycle();

    t.readSnapshot.mockImplementationOnce(() => {
      throw failure;
    });

    t.setTime(120_000);
    expect(() => t.session.onCycle()).not.toThrow();

    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(t.emit).toHaveBeenCalledOnce();

    t.setTime(179_999);
    t.session.onCycle();

    expect(t.readSnapshot).toHaveBeenCalledTimes(2);

    t.setTime(180_000);
    t.session.onCycle();

    expect(t.emit).toHaveBeenCalledTimes(2);
    expect(t.emit.mock.calls[1]![0].report.interval).toMatchObject({
      available: true,
      elapsedMs: 120_000,
    });
  });

  it('advances the attempted-report baseline when delivery throws', () => {
    const t = fixture();
    const failure = new Error('Delivery failed');

    t.emit.mockImplementationOnce(() => {
      throw failure;
    });

    t.setTime(60_000);
    expect(() => t.session.onCycle()).not.toThrow();

    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(failure);

    t.setTime(120_000);
    t.session.onCycle();

    expect(t.emit).toHaveBeenCalledTimes(2);
    expect(t.emit.mock.calls[1]![0].report.interval).toMatchObject({
      available: true,
      elapsedMs: 60_000,
    });
  });

  it('contains final capture and diagnostic failures', () => {
    const t = fixture();
    const failure = new Error('Final capture failed');

    t.readSnapshot.mockImplementation(() => {
      throw failure;
    });

    t.onFailure.mockImplementation(() => {
      throw new Error('Diagnostic delivery failed');
    });

    expect(() => t.session.finish()).not.toThrow();
    expect(() => t.session.finish()).not.toThrow();

    expect(t.readSnapshot).toHaveBeenCalledOnce();
    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(t.emit).not.toHaveBeenCalled();
  });
});