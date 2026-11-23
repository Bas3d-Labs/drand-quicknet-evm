import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  DaemonLoopSchedule,
  type SchedulingState,
} from '../../src/daemon/daemon-loop-schedule.js';

import type {
  DispatchObservation,
  WaitingEntry,
} from '../../src/daemon/future-round-scheduler.js';

const CONSUMER = `0x${'11'.repeat(20)}` as const;

const OPEN: SchedulingState = { open: true, blockers: [], retainedCount: 0 };

function entry(workId: string, releaseTime = 0n): WaitingEntry {
  return {
    workId,
    releaseTime,
    enteredAt: 0,
    source: 'soft',
    registry: CONSUMER,
    request: {
      consumer: CONSUMER,
      round: 100n,
      blockNumber: 1n,
      transactionHash: `0x${'22'.repeat(32)}`,
      logIndex: 0,
    },
  };
}

const INSPECTED = {
  completedAt: 0,
  retainedCount: 0,
  recoveryComplete: true,
  inclusionChecksComplete: true,
  persistenceIdle: true,
};

function fixture(poll = 60_000) {
  const schedule = new DaemonLoopSchedule(poll, 0);

  const capture = schedule.captureFull(0, 0);

  schedule.inspectionCompleted(INSPECTED);
  schedule.fullFinished(capture, 0, OPEN, new Map(), false);
  schedule.discoveryFinished(CONSUMER, 0, false);
  schedule.discoveryPassFinished(0, 0);

  return schedule;
}

describe('daemon loop obligation projection', () => {
  it('credits pre-submit inspection without rearming at work completion', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(10_000, 10_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 10_100 });
    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 12_000, retainedCount: 1 });
    schedule.fullFinished(capture, 17_000, { ...OPEN, retainedCount: 1 }, new Map(), false);

    expect(schedule.deadlines(17_000, 17_000, OPEN).full).toBe(42_000);
  });

  it.each(['recoveryComplete', 'inclusionChecksComplete', 'persistenceIdle'] as const)(
    'requires %s for scheduling credit',
    (flag) => {
      const schedule = fixture();

      const capture = schedule.captureFull(1_000, 1_000);

      schedule.inspectionCompleted({ ...INSPECTED, completedAt: 2_000, [flag]: false });
      schedule.fullFinished(capture, 3_000, OPEN, new Map(), true);

      expect(schedule.deadlines(3_000, 3_000, OPEN).full).toBe(18_000);
    },
  );

  it('does not accept truthy non-boolean inspection flags', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(1_000, 1_000);

    schedule.inspectionCompleted({
      ...INSPECTED,
      completedAt: 2_000,
      recoveryComplete: 'true' as never,
    });
    schedule.fullFinished(capture, 3_000, OPEN, new Map(), true);

    expect(schedule.deadlines(3_000, 3_000, OPEN).full).toBe(18_000);
  });

  it('retries the single periodic obligation even when it was not due at failure', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(1_000, 1_000);

    expect(capture.obligations).toEqual([]);

    schedule.fullFinished(capture, 2_000, OPEN, new Map(), true);

    expect(schedule.deadlines(2_000, 2_000, OPEN).full).toBe(17_000);
    expect(schedule.captureFull(17_000, 17_000).obligations.map((item) => item.identity))
      .toEqual(['periodic']);
  });

  it('lets a qualifying inspection from other work clear an existing retry', () => {
    const schedule = fixture();

    schedule.fullFinished(schedule.captureFull(0, 0), 1_000, OPEN, new Map(), true);

    const unrelated = schedule.captureFull(5_000, 5_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 6_000 });
    schedule.fullFinished(unrelated, 7_000, OPEN, new Map(), false);

    expect(schedule.deadlines(7_000, 7_000, OPEN).full).toBe(96_000);
  });

  it('keeps successful inspection credit when later work fails', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(1_000, 1_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 2_000 });
    schedule.fullFinished(capture, 3_000, OPEN, new Map(), true);

    expect(schedule.deadlines(3_000, 3_000, OPEN).full).toBe(92_000);
  });

  it('tightens after a retained send without acknowledgement-triggered work', () => {
    // Acknowledgement is deliberately not an input. Both outcomes retain bytes.
    const schedule = fixture();

    const capture = schedule.captureFull(1_000, 1_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 2_000 });
    schedule.fullFinished(capture, 3_000, { ...OPEN, retainedCount: 1 }, new Map(), false);

    expect(schedule.deadlines(3_000, 3_000, OPEN).full).toBe(33_000);
    expect(schedule.captureFull(3_000, 3_000).obligations).toEqual([]);
  });

  it('does not postpone a nearer retained deadline at later full completion', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(1_000, 1_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 2_000, retainedCount: 1 });
    schedule.fullFinished(capture, 20_000, { ...OPEN, retainedCount: 1 }, new Map(), false);

    expect(schedule.deadlines(20_000, 20_000, OPEN).full).toBe(32_000);
  });

  it('retries a durable failure in 15 seconds after a qualifying empty inspection', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(90_000, 90_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 90_100 });
    schedule.durableTarget(CONSUMER, 1n, 2_000n, 90_200);
    schedule.durableFailed(CONSUMER, 91_000);
    schedule.fullFinished(capture, 91_000, OPEN, new Map(), false);

    expect(schedule.deadlines(91_000, 91_000, OPEN).full).toBe(106_000);

    const retry = schedule.captureFull(106_000, 106_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 106_100 });
    schedule.durableFinished(CONSUMER, 2_001n, 107_000);
    schedule.fullFinished(retry, 107_000, OPEN, new Map(), false);

    expect(schedule.deadlines(107_000, 107_000, OPEN).full).toBe(196_100);
  });

  it('retries a durable read failure before any range is known and clears it on success', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(90_000, 90_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 90_100 });
    schedule.durableFailed(CONSUMER, 91_000);
    schedule.fullFinished(capture, 91_000, OPEN, new Map(), false);

    expect(schedule.deadlines(91_000, 91_000, OPEN).full).toBe(106_000);

    const retry = schedule.captureFull(106_000, 106_000);

    schedule.inspectionCompleted({ ...INSPECTED, completedAt: 106_100 });

    expect(schedule.durableTarget(CONSUMER, 101n, 100n, 106_200)).toBe(100n);

    schedule.durableFinished(CONSUMER, 101n, 107_000);
    schedule.fullFinished(retry, 107_000, OPEN, new Map(), false);

    expect(schedule.deadlines(107_000, 107_000, OPEN).full).toBe(196_100);
  });

  it.each(['waiting', 'failed', 'unattempted'] as const)(
    'retries released %s work at the waiting cap',
    (disposition) => {
      const schedule = fixture();

      schedule.transition({ kind: 'started', entry: entry('a') });

      const facts = new Map<string, DispatchObservation>();

      if (disposition !== 'unattempted') {
        facts.set('a', { workId: 'a', disposition, handedOff: 0 });
      }

      schedule.fullFinished(schedule.captureFull(1, 1), 2, OPEN, facts, false);

      expect(schedule.deadlines(2, 2, OPEN).full).toBe(15_002);
    },
  );

  it('keeps an explicit waiting delay alongside an immediate cap remainder', () => {
    const schedule = fixture();

    schedule.transition({ kind: 'started', entry: entry('waiting') });
    schedule.transition({ kind: 'started', entry: entry('remainder') });

    schedule.fullFinished(schedule.captureFull(1, 1), 2, OPEN, new Map([
      ['waiting', { workId: 'waiting', disposition: 'waiting', handedOff: 1 }],
      ['remainder', { workId: 'remainder', disposition: 'remainder', handedOff: 1 }],
    ]), false);

    expect(schedule.captureFull(2, 2).obligations.map((item) => item.identity))
      .toEqual(['remainder']);

    schedule.transition({
      kind: 'released',
      entry: entry('remainder'),
      disposition: 'already-stored',
    });

    expect(schedule.deadlines(2, 2, OPEN).full).toBe(15_002);
  });

  it('does not extend A backoff when a cycle triggered by B fails', () => {
    const schedule = fixture();

    schedule.transition({ kind: 'started', entry: entry('a') });
    schedule.fullFinished(schedule.captureFull(0, 0), 1, OPEN, new Map(), true);
    schedule.transition({ kind: 'started', entry: entry('b') });
    schedule.fullFinished(schedule.captureFull(5_000, 5_000), 6_000, OPEN, new Map(), true);
    schedule.transition({ kind: 'evicted', entry: entry('b') });

    expect(schedule.deadlines(6_000, 6_000, OPEN).full).toBe(15_001);
    expect(schedule.captureFull(60_001, 60_001).obligations.map((item) => item.identity))
      .toContain('a');
  });

  it('does not defer a future release when an earlier inspection fails', () => {
    const schedule = new DaemonLoopSchedule(60_000, 0);

    schedule.transition({ kind: 'started', entry: entry('future', 5n) });
    schedule.fullFinished(schedule.captureFull(0, 0), 1_000, OPEN, new Map(), true);

    expect(schedule.deadlines(1_000, 1_000, OPEN).full).toBe(5_000);
  });

  it('preserves a release retry across duplicate observation and clock remapping', () => {
    const schedule = fixture();

    schedule.transition({ kind: 'started', entry: entry('a') });
    schedule.fullFinished(schedule.captureFull(0, 0), 1, OPEN, new Map(), false);
    schedule.transition({ kind: 'started', entry: entry('a') });

    expect(schedule.deadlines(5, 1_000_000, OPEN).full).toBe(15_001);
  });

  it('clears completed or evicted work without keeping a stale deadline', () => {
    const schedule = fixture();

    schedule.transition({ kind: 'started', entry: entry('a') });

    expect(schedule.deadlines(0, 0, OPEN).full).toBe(0);

    schedule.transition({ kind: 'evicted', entry: entry('a') });

    expect(schedule.deadlines(0, 0, OPEN).full).toBe(90_000);
  });

  it.each(['unattributed-signer-activity', 'conflict-search-exhausted', 'unknown'])(
    'suppresses release wakes for %s, including mixed blocker sets',
    (blocker) => {
      const schedule = fixture();

      schedule.transition({ kind: 'started', entry: entry('a') });

      const state = { ...OPEN, open: false, blockers: ['recovery-incomplete', blocker] };

      expect(schedule.deadlines(0, 0, state).full).toBe(90_000);
    },
  );

  it('uses 15 seconds only for exclusively recovery-clearable released work', () => {
    const schedule = fixture();

    const state = { ...OPEN, open: false, blockers: ['recovery-incomplete'] };

    schedule.transition({ kind: 'started', entry: entry('a') });
    schedule.fullFinished(schedule.captureFull(0, 0), 1, state, new Map(), true);

    expect(schedule.deadlines(1, 1, state).full).toBe(15_001);
  });

  it('does not turn clock-deferred work into a failed retry', () => {
    const schedule = fixture();

    schedule.transition({ kind: 'started', entry: entry('a', 10n) });
    schedule.fullFinished(schedule.captureFull(10_000, 10_000), 10_001, OPEN, new Map([
      ['a', { workId: 'a', disposition: 'clock-deferred', handedOff: 0 }],
    ]), false);

    expect(schedule.deadlines(10_001, 9_000, OPEN).full).toBe(11_001);
  });

  it('remembers a newer durable target only until the fixed target drains', () => {
    const schedule = fixture();

    schedule.captureFull(0, 0);

    expect(schedule.durableTarget(CONSUMER, 1n, 4_000n, 0)).toBe(4_000n);

    schedule.durableFinished(CONSUMER, 2_001n, 1);

    expect(schedule.durableTarget(CONSUMER, 2_001n, 5_000n, 2)).toBe(4_000n);

    schedule.durableFinished(CONSUMER, 4_001n, 3);

    expect(schedule.durableTarget(CONSUMER, 4_001n, 5_000n, 4)).toBe(5_000n);
  });

  it('requires progress before creating a first durable continuation', () => {
    const schedule = fixture();

    const capture = schedule.captureFull(0, 0);

    schedule.durableTarget(CONSUMER, 1n, 4_000n, 0);
    schedule.durableFailed(CONSUMER, 1);
    schedule.fullFinished(capture, 1, OPEN, new Map(), false);

    expect(schedule.deadlines(1, 1, OPEN).full).toBe(15_001);
  });

  it('preserves durable backoff through other work and checkpoint reload', () => {
    const schedule = fixture();

    schedule.captureFull(0, 0);
    schedule.durableTarget(CONSUMER, 1n, 4_000n, 0);
    schedule.durableFinished(CONSUMER, 1_001n, 1);

    const failed = schedule.captureFull(1, 1);

    schedule.durableFailed(CONSUMER, 2);
    schedule.fullFinished(failed, 2, OPEN, new Map(), false);

    const unrelated = schedule.captureFull(5_000, 5_000);

    schedule.durableFailed(CONSUMER, 6_000);
    schedule.fullFinished(unrelated, 6_000, OPEN, new Map(), true);
    schedule.durableFinished(CONSUMER, 2_001n, 7_000);
    schedule.durableTarget(CONSUMER, 2_100n, 4_000n, 8_000);

    expect(schedule.deadlines(8_000, 8_000, OPEN).full).toBe(15_002);
  });

  it('uses one ordinary deadline after all healthy consumers finish', () => {
    const other = `0x${'33'.repeat(20)}` as const;

    const schedule = new DaemonLoopSchedule(15_000, 0);

    schedule.discoveryFinished(CONSUMER, 300, false);
    schedule.discoveryFinished(other, 600, false);
    schedule.discoveryPassFinished(0, 600);

    expect(schedule.deadlines(600, 600, OPEN).discovery).toBe(15_600);
    expect(schedule.discoveryDue(CONSUMER, 15_599)).toBe(false);
    expect(schedule.discoveryDue(other, 15_599)).toBe(false);
    expect(schedule.discoveryDue(CONSUMER, 15_600)).toBe(true);
    expect(schedule.discoveryDue(other, 15_600)).toBe(true);
  });

  it('keeps failure backoff across an ordinary round without postponing healthy work', () => {
    const other = `0x${'33'.repeat(20)}` as const;

    const schedule = fixture(15_000);

    // A capped continuation can fail between ordinary rounds.
    schedule.discoveryFinished(CONSUMER, 1_000, true);
    schedule.discoveryFailed(CONSUMER, 1_000, 1_100);
    schedule.discoveryPassFinished(1_000, 1_100);

    expect(schedule.deadlines(1_100, 1_100, OPEN).discovery).toBe(15_000);
    expect(schedule.discoveryDue(CONSUMER, 15_000)).toBe(false);
    expect(schedule.discoveryDue(other, 15_000)).toBe(true);

    schedule.discoveryFinished(other, 15_300, false);
    schedule.discoveryPassFinished(15_000, 15_300);

    expect(schedule.deadlines(15_300, 15_300, OPEN).discovery).toBe(16_100);
    expect(schedule.discoveryDue(CONSUMER, 16_100)).toBe(true);
    expect(schedule.discoveryDue(other, 16_100)).toBe(false);

    schedule.discoveryFinished(CONSUMER, 16_400, false);
    schedule.discoveryPassFinished(16_100, 16_400);

    expect(schedule.deadlines(16_400, 16_400, OPEN).discovery).toBe(30_300);
  });

  it('keeps per-consumer discovery backoff independent of a successful continuation', () => {
    const other = `0x${'33'.repeat(20)}` as const;

    const schedule = new DaemonLoopSchedule(15_000, 0);

    schedule.discoveryFailed(CONSUMER, 0, 1);
    schedule.discoveryFinished(other, 1, true);
    schedule.discoveryPassFinished(0, 1);

    expect(schedule.discoveryDue(CONSUMER, 1)).toBe(false);
    expect(schedule.discoveryDue(other, 1)).toBe(true);

    schedule.discoveryFinished(other, 2, false);
    schedule.discoveryPassFinished(1, 2);

    expect(schedule.deadlines(2, 2, OPEN).discovery).toBe(15_001);
  });
});
