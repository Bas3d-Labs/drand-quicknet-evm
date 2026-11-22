import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  DaemonWorkExecutor,
} from '../../src/daemon/daemon-work-executor.js';

describe('daemon work executor', () => {
  it('only records triggers until the owner explicitly runs due work', async () => {
    const executor = new DaemonWorkExecutor();

    const action = vi.fn(async () => 42);

    executor.request('full', 10);
    executor.request('full', 30);
    executor.request('full', 5);

    await Promise.resolve();

    expect(action).not.toHaveBeenCalled();
    expect(executor.nextDeadline).toBe(5);
    expect(await executor.runNext(4.999, action)).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(await executor.runNext(5, action)).toEqual({ kind: 'full', value: 42 });
    expect(action).toHaveBeenCalledExactlyOnceWith('full');
    expect(executor.nextDeadline).toBeNull();
  });

  it('does not let a future deadline prevent another kind from running', async () => {
    const executor = new DaemonWorkExecutor();

    executor.request('discovery', 100);
    executor.request('full', 10);

    expect(await executor.runNext(10, async (kind) => kind)).toEqual({
      kind: 'full',
      value: 'full',
    });
    expect(executor.nextDeadline).toBe(100);
  });

  it('alternates overdue continuations without executing from a trigger', async () => {
    const executor = new DaemonWorkExecutor();

    const order: string[] = [];

    executor.request('full', 0);
    executor.request('discovery', 0);

    for (let index = 0; index < 6; index += 1) {
      await executor.runNext(100, async (kind) => {
        order.push(kind);
        executor.request(kind, 0);
      });
    }

    expect(order).toEqual([
      'discovery', 'full', 'discovery', 'full', 'discovery', 'full',
    ]);
  });

  it('rejects overlapping execution and retains triggers arriving during awaits', async () => {
    const executor = new DaemonWorkExecutor();

    const held = Promise.withResolvers<void>();

    const secondAction = vi.fn(async () => {});

    executor.request('full', 0);

    const first = executor.runNext(0, async () => held.promise);

    executor.request('full', 20);
    executor.request('discovery', 10);

    await expect(executor.runNext(100, secondAction)).rejects.toThrow(
      'Daemon work is already running.',
    );

    expect(secondAction).not.toHaveBeenCalled();

    held.resolve();

    await first;

    expect(executor.nextDeadline).toBe(10);
    expect(await executor.runNext(10, secondAction)).toMatchObject({ kind: 'discovery' });
    expect(executor.nextDeadline).toBe(20);
    expect(await executor.runNext(20, secondAction)).toMatchObject({ kind: 'full' });
    expect(executor.nextDeadline).toBeNull();
  });

  it.each(['throw', 'reject'] as const)(
    'preserves new triggers and the original error on %s',
    async (mode) => {
      const executor = new DaemonWorkExecutor();

      const error = new Error('original action error');

      executor.request('full', 20);

      await expect(executor.runNext(20, () => {
        executor.request('full', 10);

        if (mode === 'throw') {
          throw error;
        }

        return Promise.reject(error);
      })).rejects.toBe(error);

      expect(executor.nextDeadline).toBe(10);
      expect(await executor.runNext(20, async () => 'retry')).toEqual({
        kind: 'full',
        value: 'retry',
      });
    },
  );

  it('consumes failed work without scheduling its own retry', async () => {
    const executor = new DaemonWorkExecutor();

    const error = new Error('failed action');

    executor.request('full', 20);

    await expect(executor.runNext(20, async () => {
      throw error;
    })).rejects.toBe(error);

    expect(executor.nextDeadline).toBeNull();
    expect(await executor.runNext(100, async () => 'unexpected')).toBeUndefined();

    executor.request('full', 200);

    expect(await executor.runNext(200, async () => 'owner retry')).toEqual({
      kind: 'full',
      value: 'owner retry',
    });
  });

  it('does not equate discovery completion with full work completion', async () => {
    const executor = new DaemonWorkExecutor();

    const fullCompleted = vi.fn();

    executor.request('discovery', 0);
    executor.request('full', 0);

    await executor.runNext(0, async (kind) => {
      if (kind === 'full') {
        fullCompleted();
      }
    });

    expect(fullCompleted).not.toHaveBeenCalled();
    expect(executor.nextDeadline).toBe(0);

    await executor.runNext(0, async (kind) => {
      expect(kind).toBe('full');
      fullCompleted();
    });

    expect(fullCompleted).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    'rejects invalid deadline %s without changing pending work',
    async (time) => {
      const executor = new DaemonWorkExecutor();

      executor.request('full', 10);

      expect(() => executor.request('full', time)).toThrow('Invalid daemon work time.');
      await expect(executor.runNext(time, async () => {})).rejects.toThrow(
        'Invalid daemon work time.',
      );
      expect(executor.nextDeadline).toBe(10);
    },
  );
});

describe('daemon work deadline replacement', () => {
  it('removes obsolete work, postpones deadlines and does not execute', async () => {
    const executor = new DaemonWorkExecutor();

    const action = vi.fn(async () => {});

    executor.request('full', 0);
    executor.request('discovery', 0);
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
});
