import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  DaemonWorkExecutor,
} from '../../src/daemon/daemon-work-executor.js';

describe('daemon work deadline replacement', () => {
  it('removes obsolete work, postpones deadlines and does not execute', async () => {
    const executor = new DaemonWorkExecutor();

    const action = vi.fn(async () => {});

    executor.replace({ full: 0, discovery: 0 });
    executor.replace({ full: null, discovery: 100 });

    expect(executor.nextDeadline).toBe(100);
    expect(await executor.runNext(99, action)).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(await executor.runNext(100, action)).toMatchObject({ kind: 'discovery' });
    expect(executor.nextDeadline).toBeNull();

    executor.replace({ full: 200, discovery: 300 });
    executor.replace({ full: null, discovery: null });

    expect(executor.nextDeadline).toBeNull();
    expect(await executor.runNext(1_000, action)).toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('preserves alternation across replacement and an empty projection', async () => {
    const executor = new DaemonWorkExecutor();

    const order: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      executor.replace({ full: null, discovery: null });
      executor.replace({ full: 0, discovery: 0 });

      await executor.runNext(100, async (kind) => {
        order.push(kind);
      });
    }

    expect(order).toEqual([
      'discovery', 'full', 'discovery', 'full', 'discovery', 'full',
    ]);
  });

  it.each(['resolve', 'reject'] as const)(
    'refuses replacement throughout an await that will %s',
    async (outcome) => {
      const executor = new DaemonWorkExecutor();

      const held = Promise.withResolvers<void>();

      const error = new Error('original failure');

      executor.replace({ full: 0, discovery: 50 });

      const running = executor.runNext(0, async () => held.promise);

      expect(() => executor.replace({ full: 100, discovery: null }))
        .toThrow('Daemon work is already running.');
      expect(executor.nextDeadline).toBe(50);

      if (outcome === 'reject') {
        const rejection = expect(running).rejects.toBe(error);

        held.reject(error);

        await rejection;
      } else {
        held.resolve();

        await running;
      }

      executor.replace({ full: 100, discovery: null });

      expect(executor.nextDeadline).toBe(100);
    },
  );

  it.each([NaN, Infinity, -Infinity, -1])(
    'validates the whole projection before changing pending work: %s',
    async (invalid) => {
      const executor = new DaemonWorkExecutor();

      executor.replace({ full: 10, discovery: 20 });

      expect(() => executor.replace({ full: null, discovery: invalid })).toThrow();
      expect(() => executor.replace({ full: invalid, discovery: null })).toThrow();
      expect(executor.nextDeadline).toBe(10);
      expect(await executor.runNext(10, async () => {})).toMatchObject({ kind: 'full' });
      expect(executor.nextDeadline).toBe(20);
    },
  );

  it('rejects overlapping execution and consumes a failed action', async () => {
    const executor = new DaemonWorkExecutor();

    const held = Promise.withResolvers<void>();

    const error = new Error('original failure');

    executor.replace({ full: 0, discovery: null });

    const running = executor.runNext(0, async () => held.promise);

    await expect(executor.runNext(0, async () => {})).rejects.toThrow('already running');

    const rejection = expect(running).rejects.toBe(error);

    held.reject(error);

    await rejection;

    expect(executor.nextDeadline).toBeNull();
    expect(await executor.runNext(100, async () => {})).toBeUndefined();
  });
});
