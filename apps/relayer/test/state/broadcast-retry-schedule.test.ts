import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function setup() {
  let now = 0;

  const schedule = new BroadcastRetrySchedule({
    initialDelayMs: 100,
    maxDelayMs: 400,
    now: () => now,
  });

  return {
    schedule,
    at: (value: number) => {
      now = value;
    },
  };
}

describe('broadcast retry schedule', () => {
  it('has no due work until an attempt is tracked', () => {
    const { schedule } = setup();

    expect(schedule.delayMs).toBeNull();
    expect(schedule.claim(FIRST)).toBe(false);
  });

  it('allows the first send for a signed attempt immediately and only once', () => {
    const { schedule } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    expect(schedule.delayMs).toBe(0);
    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.claim(FIRST)).toBe(false);
    expect(schedule.delayMs).toBe(100);
  });

  it('doubles the interval up to the configured cap', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    expect(schedule.claim(FIRST)).toBe(true);

    at(99);
    expect(schedule.claim(FIRST)).toBe(false);

    at(100);
    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.delayMs).toBe(200);

    at(300);
    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.delayMs).toBe(400);

    at(700);
    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.delayMs).toBe(400);
  });

  it('preserves the schedule when journal phase or observations are refreshed', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);

    at(50);

    schedule.track({
      attemptId: FIRST,
      phase: 'broadcast-may-have-occurred',
    });

    expect(schedule.delayMs).toBe(50);

    at(100);

    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.delayMs).toBe(200);
  });

  it('delays an attempt restored after broadcast may have occurred', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'broadcast-may-have-occurred',
    });

    expect(schedule.delayMs).toBe(100);
    expect(schedule.claim(FIRST)).toBe(false);

    at(100);

    expect(schedule.claim(FIRST)).toBe(true);
  });

  it('does not accumulate missed sends while the daemon is delayed', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);

    at(10_000);

    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.claim(FIRST)).toBe(false);
    expect(schedule.delayMs).toBe(200);
  });

  it('ignores a claim for a different attempt without spending the due send', () => {
    const { schedule } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    expect(schedule.claim(SECOND)).toBe(false);
    expect(schedule.claim(FIRST)).toBe(true);
  });

  it('clears timing after resolution and gives a new signed attempt a fresh schedule', () => {
    const { schedule } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);
    schedule.track(null);

    expect(schedule.delayMs).toBeNull();
    expect(schedule.claim(FIRST)).toBe(false);

    schedule.track({
      attemptId: SECOND,
      phase: 'signed',
    });

    expect(schedule.claim(SECOND)).toBe(true);
    expect(schedule.delayMs).toBe(100);
  });

  it('switches to the current journal attempt without leaving the old attempt eligible', () => {
    const { schedule } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.track({
      attemptId: SECOND,
      phase: 'broadcast-may-have-occurred',
    });

    expect(schedule.claim(FIRST)).toBe(false);
    expect(schedule.delayMs).toBe(100);
  });

  it('supports a fixed retry interval', () => {
    let now = 0;

    const schedule = new BroadcastRetrySchedule({
      initialDelayMs: 100,
      maxDelayMs: 100,
      now: () => now,
    });

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);

    now = 100;

    expect(schedule.claim(FIRST)).toBe(true);
    expect(schedule.delayMs).toBe(100);
  });

  it('rounds fractional remaining time up and never claims early', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);

    at(99.5);

    expect(schedule.delayMs).toBe(1);
    expect(schedule.claim(FIRST)).toBe(false);
  });

  it('does not extend or bypass a deadline when the clock moves backwards', () => {
    const { schedule, at } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    schedule.claim(FIRST);

    at(50);
    expect(schedule.delayMs).toBe(50);

    at(10);
    expect(schedule.delayMs).toBe(50);
    expect(schedule.claim(FIRST)).toBe(false);

    at(100);
    expect(schedule.claim(FIRST)).toBe(true);
  });

  it.each([
    [0, 100],
    [-1, 100],
    [1.5, 100],
    [100, 99],
    [100, Number.NaN],
    [100, Number.POSITIVE_INFINITY],
    [100, 2_147_483_648],
  ])(
    'rejects invalid delays %#',
    (initialDelayMs, maxDelayMs) => {
      expect(() => new BroadcastRetrySchedule({
        initialDelayMs,
        maxDelayMs,
      })).toThrow('Invalid broadcast retry delays');
    },
  );

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])(
    'rejects an invalid clock without consuming a due send: %s',
    (value) => {
      const { schedule, at } = setup();

      schedule.track({
        attemptId: FIRST,
        phase: 'signed',
      });

      at(value);

      expect(() => schedule.claim(FIRST))
        .toThrow('Invalid broadcast retry clock');

      at(0);

      expect(schedule.claim(FIRST)).toBe(true);
    },
  );

  it('does not retain a thrown clock error as a cause', () => {
    const schedule = new BroadcastRetrySchedule({
      initialDelayMs: 100,
      maxDelayMs: 400,
      now() {
        throw new Error('secret-canary');
      },
    });

    let failure: unknown;

    try {
      schedule.track({
        attemptId: FIRST,
        phase: 'signed',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toHaveProperty(
      'message',
      'Could not read the broadcast retry clock.',
    );

    expect(failure).not.toHaveProperty('cause');
    expect(schedule.delayMs).toBeNull();
  });

  it('rejects invalid attempt metadata without replacing the tracked attempt', () => {
    const { schedule } = setup();

    schedule.track({
      attemptId: FIRST,
      phase: 'signed',
    });

    expect(() => schedule.track({
      attemptId: 'invalid',
      phase: 'signed',
    })).toThrow('Invalid broadcast retry attempt');

    expect(() => schedule.track({
      attemptId: SECOND,
      phase: 'invalid' as never,
    })).toThrow('Invalid broadcast retry attempt');

    expect(schedule.claim(FIRST)).toBe(true);
  });
});