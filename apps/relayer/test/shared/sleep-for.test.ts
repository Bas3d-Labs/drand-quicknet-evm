import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  sleepFor,
} from '../../src/shared/sleep-for.js';

describe('sleepFor', () => {
  it('resolves without a signal', async () => {
    await expect(sleepFor(1)).resolves.toBeUndefined();
  });

  it('rejects an already-aborted signal with its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');

    controller.abort(reason);

    await expect(
      sleepFor(100, controller.signal),
    ).rejects.toBe(reason);
  });

  it('preserves the abort reason when cancelled during the wait', async () => {
    const controller = new AbortController();
    const reason = new Error('Shutdown requested.');

    const sleeping = sleepFor(100, controller.signal);
    const rejected = expect(sleeping).rejects.toBe(reason);

    controller.abort(reason);

    await rejected;
  });
});