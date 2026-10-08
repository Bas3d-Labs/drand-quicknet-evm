import {
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { PublicClient } from 'viem';

import {
  openSignerRuntime,
} from '../../src/cli/open-signer-runtime.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  assertServiceLockHeld,
} from '../../src/state/service-lock.js';

vi.mock('../../src/state/service-lock.js', () => ({
  assertServiceLockHeld: vi.fn(),
}));

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

describe('command signer runtime', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'signer-runtime-'),
    );

    vi.mocked(assertServiceLockHeld).mockReset();
    vi.mocked(assertServiceLockHeld).mockReturnValue(directory);
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  function options() {
    return {
      identity: { ...IDENTITY },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        destination: {
          write() {},
        },
      }),
      createErrorSummary: () => ({
        scrubText: (text: string) => ({
          text,
          removed: false,
        }),
      }),
      retry: {
        initialDelayMs: 100,
        maxDelayMs: 400,
      },
      env: {
        QUICKNET_STATE_DIR: directory,
      },
    };
  }

  function recovery() {
    const getBlock = vi.fn().mockResolvedValue({
      number: 100n,
      hash: HASH,
    });

    const getTransactionCount = vi.fn()
      .mockResolvedValue(4);

    return {
      publicClient: {
        getBlock,
        getTransactionCount,
      } as unknown as PublicClient,
      anchor: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      maxBlockRange: 10n,
    };
  }

  it('leaves a missing journal blocked without creating a baseline', async () => {
    const runtime = await openSignerRuntime(options());

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.coordinator.attempts).toEqual([]);
    expect(runtime.coordinator.status.open).toBe(false);

    await expect(
      runtime.recovery.run(recovery()),
    ).rejects.toThrow();

    expect(await readdir(directory)).toEqual([]);
  });

  it('uses the same persisted journal across signer casing and requires recovery on reopen', async () => {
    const first = await openSignerRuntime(options());

    await first.recovery.run({
      ...recovery(),
      bootstrap: {
        expectedNonce: 4n,
        confirmNoUntrackedTransactions: true,
      },
    });

    expect(first.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(await readdir(directory)).toEqual([
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ]);

    // Simulate a later command; the first runtime is no longer used.
    const next = options();
    next.identity.signer = `0x${'AB'.repeat(20)}`;

    const reopened = await openSignerRuntime(next);

    expect(reopened.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    await reopened.recovery.run(recovery());

    expect(reopened.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(await readdir(directory)).toHaveLength(1);
  });

  it('does not touch journal files without verified service ownership', async () => {
    vi.mocked(assertServiceLockHeld).mockImplementation(() => {
      throw new Error('Lock not held');
    });

    await expect(
      openSignerRuntime(options()),
    ).rejects.toThrow('Lock not held');

    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects invalid retry configuration before checking ownership or opening storage', async () => {
    const input = options();
    input.retry.initialDelayMs = 0;

    await expect(
      openSignerRuntime(input),
    ).rejects.toThrow('Invalid broadcast retry delays');

    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('does not replace a corrupt journal with a new baseline', async () => {
    await writeFile(
      join(
        directory,
        `transaction-journal-4663-${IDENTITY.signer}.json`,
      ),
      'invalid JSON',
    );

    await expect(
      openSignerRuntime(options()),
    ).rejects.toThrow('could not be decoded');
  });
});