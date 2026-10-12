import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir
} from 'node:os';

import {
  join
} from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient
} from 'viem';

import {
  openSignerRuntime,
} from '../../src/cli/open-signer-runtime.js';

import {
  syncNonce,
} from '../../src/cli/sync-nonce.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  isPriorSignerStateError,
} from '../../src/diagnostics/signer-journal-errors.js';

import {
  assertServiceLockHeld,
  serviceLockReason,
} from '../../src/state/service-lock.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

vi.mock('../../src/state/service-lock.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/service-lock.js')
  >();

  return {
    ...actual,
    assertServiceLockHeld: vi.fn(),
  };
});

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

    const lockFile = join(directory, 'relayer.flock');
    await writeFile(lockFile, '');

    const lock = await lstat(lockFile, { bigint: true });

    vi.mocked(assertServiceLockHeld)
      .mockReset()
      .mockReturnValue({
        stateDirectory: directory,
        dev: lock.dev,
        ino: lock.ino,
      });
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

  async function stateEntries(): Promise<string[]> {
    return (await readdir(directory))
      .filter((name) => name !== 'relayer.flock')
      .sort();
  }

  it('leaves a missing journal untouched until automatic recovery', async () => {
    const runtime = await openSignerRuntime(options());

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.coordinator.attempts).toEqual([]);

    expect(runtime.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(await stateEntries()).toEqual([]);

    expect(await runtime.recovery.run(recovery())).toMatchObject({
      inspection: { status: 'no-attempt' },
      inclusions: { status: 'inspected' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(runtime.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(await stateEntries()).toEqual([
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ]);
  });

  it('uses the same persisted journal across signer casing and requires recovery on reopen', async () => {
    const first = await openSignerRuntime(options());

    await first.recovery.run(recovery());

    expect(first.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(await stateEntries()).toEqual([
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

    expect(await stateEntries()).toHaveLength(1);
  });

  it('accepts an applied nonce repair after reopening and recovery', async () => {
    const filePath = join(
      directory,
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    );

    const snapshot: TransactionJournalSnapshot = {
      version: 1,
      identity: { ...IDENTITY },
      baseline: {
        anchor: {
          blockNumber: 90n,
          blockHash: HASH,
        },
        nonce: 4n,
      },
      lastObservation: {
        anchor: {
          blockNumber: 100n,
          blockHash: HASH,
        },
        nonce: 8n,
      },
      nextNonce: 4n,
      durableNextNonce: 4n,
      repairs: [],
      attempts: [],
    };

    await writeFile(
      filePath,
      await encodeJournalSnapshot(snapshot, IDENTITY),
    );

    const blocked = await openSignerRuntime(options());

    expect(blocked.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    const anchor = {
      blockNumber: 110n,
      blockHash: HASH,
    };

    const getChainId = vi.fn().mockResolvedValue(IDENTITY.chainId);
    const getBlockNumber = vi.fn().mockResolvedValue(anchor.blockNumber);
    const getBlock = vi.fn().mockResolvedValue({
      number: anchor.blockNumber,
      hash: anchor.blockHash,
    });
    const getTransactionCount = vi.fn().mockResolvedValue(8);

    const request = vi.fn().mockRejectedValue(
      new Error('Unexpected raw RPC request.'),
    );
    const sendRawTransaction = vi.fn().mockRejectedValue(
      new Error('Unexpected transaction broadcast.'),
    );

    const publicClient = {
      getChainId,
      getBlockNumber,
      getBlock,
      getTransactionCount,
      request,
      sendRawTransaction,
    } as unknown as PublicClient;

    // Simulate a later command under the same service ownership.
    // The blocked runtime is no longer used.
    const result = await syncNonce({
      publicClient,
      identity: { ...IDENTITY },
      finality: { type: 'safe' },
      apply: true,
      env: options().env,
    });

    expect(result.status).toBe('applied');

    if (result.status !== 'applied') {
      throw new Error('Expected nonce repair to be applied.');
    }

    expect(result.repair).toMatchObject({
      kind: 'sync-nonce',
      previousNextNonce: 4n,
      nextNonce: 8n,
      observation: {
        anchor,
        nonce: 8n,
      },
    });

    const repaired = await decodeJournalSnapshot(
      await readFile(filePath, 'utf8'),
      IDENTITY,
    );

    expect(repaired.baseline).toEqual(snapshot.baseline);
    expect(repaired.nextNonce).toBe(8n);
    expect(repaired.durableNextNonce).toBe(8n);
    expect(repaired.lastObservation).toEqual({
      anchor,
      nonce: 8n,
    });
    expect(repaired.repairs).toEqual([result.repair]);
    expect(repaired.attempts).toEqual([]);

    const reopened = await openSignerRuntime(options());

    // Repair persistence alone must not bypass runtime recovery.
    expect(reopened.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(await reopened.recovery.run({
      publicClient,
      anchor,
      maxBlockRange: 10n,
    })).toMatchObject({
      inspection: { status: 'no-attempt' },
      inclusions: { status: 'inspected' },
      broadcast: null,
      retryDelayMs: null,
    });

    expect(reopened.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: null,
      blockers: [],
    });

    expect(reopened.coordinator.attempts).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();

    const recovered = await decodeJournalSnapshot(
      await readFile(filePath, 'utf8'),
      IDENTITY,
    );

    expect(recovered.baseline).toEqual(snapshot.baseline);
    expect(recovered.repairs).toEqual([result.repair]);
    expect(recovered.nextNonce).toBe(8n);
    expect(recovered.durableNextNonce).toBe(8n);
    expect(recovered.attempts).toEqual([]);
  });

  it('does not touch journal files without verified service ownership', async () => {
    vi.mocked(assertServiceLockHeld).mockImplementation(() => {
      throw new Error('Lock not held');
    });

    await expect(
      openSignerRuntime(options()),
    ).rejects.toThrow('Lock not held');

    expect(await stateEntries()).toEqual([]);
  });

  it('rejects invalid retry configuration before checking ownership or opening storage', async () => {
    const input = options();
    input.retry.initialDelayMs = 0;

    await expect(
      openSignerRuntime(input),
    ).rejects.toThrow('Invalid broadcast retry delays');

    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(await stateEntries()).toEqual([]);
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

  it('refuses a missing journal when checkpoint state exists', async () => {
    const checkpointFile = join(directory, 'checkpoint.json');

    await writeFile(checkpointFile, '{}');

    const opening = openSignerRuntime({
      ...options(),
      checkpointFile,
    });

    await expect(opening).rejects.toMatchObject({
      code: 'prior-state-present',
    });

    const error: unknown = await opening.catch((error: unknown) => error);
    expect(isPriorSignerStateError(error)).toBe(true);

    expect(await stateEntries()).toEqual([
      'checkpoint.json',
    ]);
  });

  it('allows automatic initialization when the configured checkpoint is absent', async () => {
    const checkpointFile = join(directory, 'checkpoint.json');

    const runtime = await openSignerRuntime({
      ...options(),
      checkpointFile,
    });

    expect(await stateEntries()).toEqual([]);

    expect(await runtime.recovery.run(recovery())).toMatchObject({
      inspection: { status: 'no-attempt' },
      inclusions: { status: 'inspected' },
      broadcast: null,
    });

    expect(runtime.coordinator.status.open).toBe(true);

    expect(await stateEntries()).toEqual([
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ]);
  });

  it('recovers an existing journal when checkpoint state exists', async () => {
    const first = await openSignerRuntime(options());

    await first.recovery.run(recovery());

    const checkpointFile = join(directory, 'checkpoint.json');
    await writeFile(checkpointFile, '{}');

    // Simulate a later command; the first runtime is no longer used.
    const reopened = await openSignerRuntime({
      ...options(),
      checkpointFile,
    });

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

    expect((await stateEntries()).sort()).toEqual([
      'checkpoint.json',
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ].sort());
  });

  it('checks the checkpoint configured through the environment', async () => {
    const checkpointFile = join(directory, 'checkpoint.json');
    await writeFile(checkpointFile, '{}');

    const input = options();

    await expect(openSignerRuntime({
      ...input,
      env: {
        ...input.env,
        QUICKNET_CHECKPOINT_FILE: checkpointFile,
      },
    })).rejects.toMatchObject({
      code: 'prior-state-present',
    });

    expect(assertServiceLockHeld).toHaveBeenCalledWith({
      env: {
        ...input.env,
        QUICKNET_CHECKPOINT_FILE: checkpointFile,
      },
      checkpointFile,
    });

    expect(await stateEntries()).toEqual([
      'checkpoint.json',
    ]);
  });

  it.each([
    'checkpoint.json',
    'operator-notes.txt',
    `transaction-journal-4663-0x${'cd'.repeat(20)}.json`,
  ])('refuses unconfigured prior-state entry: %s', async (name) => {
    await writeFile(join(directory, name), '{}');

    // Neither an explicit checkpoint nor its environment setting is supplied.
    await expect(
      openSignerRuntime(options()),
    ).rejects.toMatchObject({
      code: 'prior-state-present',
    });

    expect(await stateEntries()).toEqual([name]);
  });

  it.each([
    'directory',
    'dangling-symlink',
  ] as const)('refuses an unexplained %s', async (kind) => {
    const entry = join(directory, 'unexplained');

    if (kind === 'directory') {
      await mkdir(entry);
    } else {
      await symlink(join(directory, 'missing-target'), entry);
    }

    await expect(
      openSignerRuntime(options()),
    ).rejects.toMatchObject({
      code: 'prior-state-present',
    });

    expect(await stateEntries()).toEqual(['unexplained']);
  });

  it('preserves an owned journal temp file when the journal is missing', async () => {
    const journalName =
      `transaction-journal-4663-${IDENTITY.signer}.json`;

    // Matches the store's owned temporary-file naming convention.
    const tempName =
      `${journalName}.123.12345678-1234-4123-8123-123456789abc.tmp`;

    const tempFile = join(directory, tempName);
    await writeFile(tempFile, 'interrupted snapshot');

    await expect(
      openSignerRuntime(options()),
    ).rejects.toMatchObject({
      code: 'prior-state-present',
    });

    expect(await stateEntries()).toEqual([tempName]);
    expect(await readFile(tempFile, 'utf8'))
      .toBe('interrupted snapshot');
  });

  it('classifies a changed lock identity as an ownership failure', async () => {
    const lock = await lstat(
      join(directory, 'relayer.flock'),
      { bigint: true },
    );

    vi.mocked(assertServiceLockHeld).mockReturnValueOnce({
      stateDirectory: directory,
      dev: lock.dev,
      ino: lock.ino + 1n,
    });

    const error: unknown = await openSignerRuntime(options())
      .catch((error: unknown) => error);

    expect(serviceLockReason(error)).toBe('descriptor');
    expect(isPriorSignerStateError(error)).toBe(false);
    expect(await stateEntries()).toEqual([]);
  });

  it('classifies a lock replaced by a symlink as an ownership failure', async () => {
    const lockFile = join(directory, 'relayer.flock');
    const target = join(directory, 'other-lock');

    await writeFile(target, '');
    await rm(lockFile);
    await symlink(target, lockFile);

    const error: unknown = await openSignerRuntime(options())
      .catch((error: unknown) => error);

    expect(serviceLockReason(error)).toBe('lock-file');
    expect(isPriorSignerStateError(error)).toBe(false);
  });

  it('allows existing-journal recovery to clean owned temporary files', async () => {
    const first = await openSignerRuntime(options());
    await first.recovery.run(recovery());

    const journalName =
      `transaction-journal-4663-${IDENTITY.signer}.json`;

    const tempName =
      `${journalName}.123.12345678-1234-4123-8123-123456789abc.tmp`;

    await writeFile(join(directory, tempName), 'orphaned snapshot');

    const reopened = await openSignerRuntime(options());
    await reopened.recovery.run(recovery());

    expect(reopened.coordinator.status.open).toBe(true);
    expect(await stateEntries()).toEqual([journalName]);
  });
});