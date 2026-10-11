import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
}));

import {
  lstat,
  readdir,
} from 'node:fs/promises';

import {
  assertSignerBootstrapState,
} from '../../src/state/assert-signer-bootstrap-state.js';

const OWNERSHIP = {
  stateDirectory: '/verified-state',
  dev: 1n,
  ino: 2n,
};

const JOURNAL = '/verified-state/transaction-journal.json';

describe('assertSignerBootstrapState', () => {
  beforeEach(() => {
    vi.mocked(lstat).mockReset();
    vi.mocked(readdir).mockReset();
  });

  it.each(['EACCES', 'EIO'])(
    'propagates journal inspection failure: %s',
    async (code) => {
      const failure = Object.assign(new Error('Inspection failed'), {
        code,
      });

      vi.mocked(lstat).mockRejectedValueOnce(failure);

      await expect(
        assertSignerBootstrapState(JOURNAL, OWNERSHIP),
      ).rejects.toBe(failure);

      expect(readdir).not.toHaveBeenCalled();
    },
  );

  it('propagates directory inspection failure', async () => {
    vi.mocked(lstat).mockRejectedValueOnce(
      Object.assign(new Error('Missing'), { code: 'ENOENT' }),
    );

    const failure = Object.assign(new Error('Directory unavailable'), {
      code: 'EACCES',
    });

    vi.mocked(readdir).mockRejectedValueOnce(failure);

    await expect(
      assertSignerBootstrapState(JOURNAL, OWNERSHIP),
    ).rejects.toBe(failure);

    // No attempt to inspect the lock after directory enumeration failed.
    expect(lstat).toHaveBeenCalledOnce();
  });
});