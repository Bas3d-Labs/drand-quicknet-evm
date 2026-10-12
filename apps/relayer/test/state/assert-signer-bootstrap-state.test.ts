import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMocks);

import {
  lstat,
  readdir,
} from 'node:fs/promises';

import {
  priorSignerStateError,
} from '../../src/diagnostics/signer-journal-errors.js';

import {
  assertSignerBootstrapState,
} from '../../src/state/assert-signer-bootstrap-state.js';

import {
  LOCK_FILENAME,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

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

  it.each([
    'lock-only',
    'other-entry',
    'wrong-identity',
    'missing-lock',
  ] as const)('classifies first-use state: %s', async (scenario) => {
    fsMocks.lstat.mockRejectedValueOnce(
      Object.assign(new Error('Missing'), { code: 'ENOENT' }),
    );

    const names = scenario === 'missing-lock'
      ? ['checkpoint.json']
      : scenario === 'lock-only'
        ? [LOCK_FILENAME]
        : [LOCK_FILENAME, 'checkpoint.json'];

    fsMocks.readdir.mockResolvedValueOnce(names);

    fsMocks.lstat.mockResolvedValueOnce({
      isFile: () => true,
      nlink: 1n,
      dev: OWNERSHIP.dev,
      ino: scenario === 'wrong-identity'
        ? OWNERSHIP.ino + 1n
        : OWNERSHIP.ino,
    });

    const result = assertSignerBootstrapState(JOURNAL, OWNERSHIP);

    switch (scenario) {
      case 'lock-only':
        await expect(result).resolves.toBeUndefined();
        break;

      case 'other-entry':
        await expect(result).rejects.toEqual(
          priorSignerStateError(),
        );
        break;

      case 'wrong-identity':
        await expect(result).rejects.toEqual(
          new ServiceLockNotHeldError('descriptor'),
        );
        break;

      case 'missing-lock':
        await expect(result).rejects.toEqual(
          new ServiceLockNotHeldError('lock-file'),
        );
        break;
    }

    expect(readdir).toHaveBeenCalledExactlyOnceWith(
      OWNERSHIP.stateDirectory,
    );

    expect(lstat).toHaveBeenNthCalledWith(1, JOURNAL);

    if (scenario === 'missing-lock') {
      expect(lstat).toHaveBeenCalledOnce();
    } else {
      expect(lstat).toHaveBeenCalledTimes(2);
      expect(lstat).toHaveBeenNthCalledWith(
        2,
        `${OWNERSHIP.stateDirectory}/${LOCK_FILENAME}`,
        { bigint: true },
      );
    }
  });
});