import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  DurableRecoverySchedule,
} from '../../src/state/durable-recovery-schedule.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

const ANCHOR = {
  blockNumber: 100n,
  blockHash: HASH,
};

function setup() {
  let now = 0;

  const schedule = new DurableRecoverySchedule({
    refreshIntervalMs: 1_000,
    now: () => now,
  });

  return {
    schedule,
    at(value: number) {
      now = value;
    },
  };
}

describe('durable recovery schedule', () => {
  it('requires recovery before the first completed pass', () => {
    const t = setup();

    expect(t.schedule.isDue(ANCHOR)).toBe(true);

    t.at(500);

    expect(t.schedule.isDue(ANCHOR)).toBe(true);
  });

  it('waits until the refresh boundary for an unchanged anchor', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);

    expect(t.schedule.isDue(ANCHOR)).toBe(false);

    t.at(999);
    expect(t.schedule.isDue(ANCHOR)).toBe(false);

    t.at(1_000);
    expect(t.schedule.isDue(ANCHOR)).toBe(true);
  });

  it.each([
    {
      name: 'higher block',
      anchor: { blockNumber: 101n, blockHash: OTHER },
    },
    {
      name: 'different hash at the same height',
      anchor: { blockNumber: 100n, blockHash: OTHER },
    },
    {
      name: 'lower block',
      anchor: { blockNumber: 99n, blockHash: OTHER },
    },
  ])('requires recovery for a $name', ({ anchor }) => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);

    expect(t.schedule.isDue(anchor)).toBe(true);
  });

  it('compares hashes without treating casing as an anchor change', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);

    expect(t.schedule.isDue({
      blockNumber: 100n,
      blockHash: `0x${'AA'.repeat(32)}`,
    })).toBe(false);
  });

  it('does not postpone recovery when a due check is repeated', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);

    t.at(1_000);
    expect(t.schedule.isDue(ANCHOR)).toBe(true);

    t.at(1_500);
    expect(t.schedule.isDue(ANCHOR)).toBe(true);

    // Only explicit successful completion starts another interval.
    t.schedule.recordCompleted(ANCHOR);

    t.at(2_499);
    expect(t.schedule.isDue(ANCHOR)).toBe(false);

    t.at(2_500);
    expect(t.schedule.isDue(ANCHOR)).toBe(true);
  });

  it('requires recovery after invalidation', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);
    expect(t.schedule.isDue(ANCHOR)).toBe(false);

    t.schedule.invalidate();
    expect(t.schedule.isDue(ANCHOR)).toBe(true);

    t.schedule.recordCompleted(ANCHOR);
    expect(t.schedule.isDue(ANCHOR)).toBe(false);
  });

  it('detaches the completed anchor from the caller', () => {
    const t = setup();
    const anchor = { ...ANCHOR };

    t.schedule.recordCompleted(anchor);
    anchor.blockNumber = 101n;

    expect(t.schedule.isDue(ANCHOR)).toBe(false);
    expect(t.schedule.isDue(anchor)).toBe(true);
    expect(Object.isFrozen(anchor)).toBe(false);
  });

  it('starts due after restart regardless of the previous schedule', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);
    expect(t.schedule.isDue(ANCHOR)).toBe(false);

    const restarted = setup();

    expect(restarted.schedule.isDue(ANCHOR)).toBe(true);
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('requires recovery when elapsed time is unusable: %s', (now) => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);
    t.at(now);

    expect(t.schedule.isDue(ANCHOR)).toBe(true);
  });

  it('invalidates completion when the clock cannot record it', () => {
    const t = setup();

    t.schedule.recordCompleted(ANCHOR);

    t.at(Number.NaN);
    t.schedule.recordCompleted(ANCHOR);

    t.at(0);
    expect(t.schedule.isDue(ANCHOR)).toBe(true);
  });

  it.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid refresh interval: %s', (refreshIntervalMs) => {
    expect(() => new DurableRecoverySchedule({
      refreshIntervalMs,
      now: () => 0,
    })).toThrow('Invalid durable recovery refresh interval.');
  });
});