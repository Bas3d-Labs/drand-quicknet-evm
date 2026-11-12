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
  performance,
} from 'node:perf_hooks';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
} from 'viem';

import type {
  PublicClient,
  WalletClient,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

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
  DEFAULT_JOURNAL_BOUNDS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from '../../src/state/journal-bounds.js';

import {
  JournalBoundsExceededError,
} from '../../src/state/journal-bounds-error.js';

import {
  journalFilename,
} from '../../src/state/journal-identity.js';

import {
  assertServiceLockHeld,
  serviceLockReason,
} from '../../src/state/service-lock.js';

import type {
  JournalAttempt,
  JournalSignedTransaction,
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

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address.toLowerCase() as `0x${string}`,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

async function runtimeBoundsFixture(
  transactionCounts: readonly number[],
): Promise<TransactionJournalSnapshot> {
  // Public test fixture only.
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

  const identity = {
    chainId: IDENTITY.chainId,
    signer: account.address,
  };

  const observation = {
    anchor: {
      blockNumber: 100n,
      blockHash: HASH,
    },
    nonce: 4n,
  };

  const attempts: JournalAttempt[] = [];

  for (const [index, count] of transactionCounts.entries()) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Fixture requires a positive transaction count.');
    }

    const nonce = 4 + index;

    async function sign(
      replacementIndex: number,
    ): Promise<JournalSignedTransaction> {
      const signedTransaction = await account.signTransaction({
        type: 'eip1559',
        chainId: identity.chainId,
        nonce,
        gas: 21_000n,
        to: account.address,
        value: 0n,
        maxFeePerGas: 2n + BigInt(replacementIndex),
        maxPriorityFeePerGas: 1n,
      });

      return {
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      };
    }

    const first = await sign(0);
    const remaining: JournalSignedTransaction[] = [];

    for (let replacement = 1; replacement < count; replacement += 1) {
      remaining.push(await sign(replacement));
    }

    attempts.push({
      attemptId:
        '00000000-0000-4000-8000-'
        + (index + 1).toString(16).padStart(12, '0'),
      workId: 'runtime-bounds:' + index,
      nonce: BigInt(nonce),
      createdAt: '2026-10-21T00:00:00.000Z',
      signedTransactions: [first, ...remaining],
      replacementSearch: null,
      phase: 'signed',
      inclusion: null,
    });
  }

  return {
    version: 1,
    identity,
    baseline: observation,
    lastObservation: observation,
    nextNonce: 4n + BigInt(attempts.length),
    durableNextNonce: 4n,
    repairs: [],
    ledger: {
      outcomes: [],
      obligations: [],
    },
    attempts,
  };
}

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

  function recoveryClient(): PublicClient {
    return {
      getBlock: vi.fn<PublicClient['getBlock']>()
        .mockImplementation(async ({ blockNumber } = {}) => ({
          number: blockNumber,
          hash: HASH,
        }) as never),
      getTransactionCount: vi.fn<PublicClient['getTransactionCount']>()
        .mockResolvedValue(4),
    } as unknown as PublicClient;
  }

  function options(
    publicClient: PublicClient = recoveryClient(),
  ) {
    return {
      identity: { ...IDENTITY },
      publicClient,
      walletClient: {
        prepareTransactionRequest: vi.fn().mockRejectedValue(
          new Error('Unexpected transaction preparation.'),
        ),
      } as unknown as WalletClient,
      account: ACCOUNT,
      readChainHeads: vi.fn(async () => ({
        durableBlock: 100n,
        latestBlock: 100n,
      })),
      maxBlockRange: 10n,
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
    return {
      durable: {
        blockNumber: 100n,
        blockHash: HASH,
      },
      head: {
        blockNumber: 100n,
        blockHash: HASH,
      },
    };
  }

  async function stateEntries(): Promise<string[]> {
    return (await readdir(directory))
      .filter((name) => name !== 'relayer.flock')
      .sort();
  }

  it('leaves a missing journal untouched until automatic recovery', async () => {
    const runtime = await openSignerRuntime(options());

    expect(Object.isFrozen(runtime.status)).toBe(true);
    expect(runtime.status.attempts).toEqual([]);

    expect(runtime.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(await stateEntries()).toEqual([]);

    expect(await runtime.reconcile(recovery())).toMatchObject({
      recoveryStatus: 'no-attempt',
      inclusionStatus: 'inspected',
      broadcast: null,
      retryDelayMs: null,
    });

    expect(runtime.status).toMatchObject({
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

    await first.reconcile(recovery());

    expect(first.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(await stateEntries()).toEqual([
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ]);

    // Simulate a later command; the first runtime is no longer used.
    const next = options();
    next.identity.signer =
      `0x${IDENTITY.signer.slice(2).toUpperCase()}`;

    const reopened = await openSignerRuntime(next);

    expect(reopened.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    await reopened.reconcile(recovery());

    expect(reopened.status).toMatchObject({
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
      ledger: {
        outcomes: [],
        obligations: [],
      },
      attempts: [],
    };

    await writeFile(
      filePath,
      await encodeJournalSnapshot(snapshot, IDENTITY),
    );

    const blocked = await openSignerRuntime(options());

    expect(blocked.status).toMatchObject({
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

    const reopened = await openSignerRuntime(options(publicClient));

    // Repair persistence alone must not bypass runtime recovery.
    expect(reopened.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(await reopened.reconcile({
      durable: anchor,
      head: anchor,
    })).toMatchObject({
      recoveryStatus: 'no-attempt',
      inclusionStatus: 'inspected',
      broadcast: null,
      retryDelayMs: null,
    });

    expect(reopened.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: null,
      blockers: [],
    });

    expect(reopened.status.attempts).toEqual([]);
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

    expect(await runtime.reconcile(recovery())).toMatchObject({
      recoveryStatus: 'no-attempt',
      inclusionStatus: 'inspected',
      broadcast: null,
    });

    expect(runtime.status.open).toBe(true);

    expect(await stateEntries()).toEqual([
      `transaction-journal-4663-${IDENTITY.signer}.json`,
    ]);
  });

  it('recovers an existing journal when checkpoint state exists', async () => {
    const first = await openSignerRuntime(options());

    await first.reconcile(recovery());

    const checkpointFile = join(directory, 'checkpoint.json');
    await writeFile(checkpointFile, '{}');

    // Simulate a later command; the first runtime is no longer used.
    const reopened = await openSignerRuntime({
      ...options(),
      checkpointFile,
    });

    expect(reopened.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    await reopened.reconcile(recovery());

    expect(reopened.status).toMatchObject({
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
    await first.reconcile(recovery());

    const journalName =
      `transaction-journal-4663-${IDENTITY.signer}.json`;

    const tempName =
      `${journalName}.123.12345678-1234-4123-8123-123456789abc.tmp`;

    await writeFile(join(directory, tempName), 'orphaned snapshot');

    const reopened = await openSignerRuntime(options());
    await reopened.reconcile(recovery());

    expect(reopened.status.open).toBe(true);
    expect(await stateEntries()).toEqual([journalName]);
  });

  it.each([
    {
      name: 'retained attempts',
      counts: Array.from(
        { length: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts + 1 },
        () => 1,
      ),
      bound: 'retained-attempts',
      maximum: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts,
      observed: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts + 1,
    },
    {
      name: 'signed transactions',
      counts: [MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1],
      bound: 'signed-transactions-per-attempt',
      maximum: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
      observed: MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT + 1,
    },
  ])(
    'refuses over-bound $name without changing retained state',
    async (testCase) => {
      const snapshot = await runtimeBoundsFixture(testCase.counts);
      const filePath = join(
        directory,
        journalFilename(snapshot.identity),
      );

      const contents = await encodeJournalSnapshot(
        snapshot,
        snapshot.identity,
      );

      const orphan =
        `${filePath}.123.11111111-1111-4111-8111-111111111111.tmp`;

      await writeFile(filePath, contents);
      await writeFile(orphan, 'retained recovery evidence');

      const entriesBefore = await stateEntries();
      const statBefore = await lstat(filePath, { bigint: true });
      const onPersistenceBoundary = vi.fn();

      const opening = openSignerRuntime({
        ...options(),
        identity: snapshot.identity,
        onPersistenceBoundary,
      });

      await expect(opening).rejects.toBeInstanceOf(
        JournalBoundsExceededError,
      );

      await expect(opening).rejects.toMatchObject({
        violations: [
          {
            bound: testCase.bound,
            maximum: testCase.maximum,
            observed: testCase.observed,
          },
        ],
      });

      expect(onPersistenceBoundary).not.toHaveBeenCalled();
      expect(await readFile(filePath, 'utf8')).toBe(contents);
      expect(await readFile(orphan, 'utf8'))
        .toBe('retained recovery evidence');
      expect(await stateEntries()).toEqual(entriesBefore);

      const statAfter = await lstat(filePath, { bigint: true });

      expect(statAfter.dev).toBe(statBefore.dev);
      expect(statAfter.ino).toBe(statBefore.ino);
      expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);
    },
  );

  it('opens a journal at the runtime bounds and retains every transaction hash', async () => {
    const snapshot = await runtimeBoundsFixture(
      Array.from(
        { length: DEFAULT_JOURNAL_BOUNDS.maxRetainedAttempts },
        () => DEFAULT_JOURNAL_BOUNDS.maxSignedTransactionsPerAttempt,
      ),
    );

    const filePath = join(
      directory,
      journalFilename(snapshot.identity),
    );

    await writeFile(
      filePath,
      await encodeJournalSnapshot(snapshot, snapshot.identity),
    );

    const runtime = await openSignerRuntime({
      ...options(),
      identity: snapshot.identity,
    });

    expect(runtime.status.attempts).toEqual(
      snapshot.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        workId: attempt.workId,
        nonce: attempt.nonce,
        phase: attempt.phase,
        transactionHashes: attempt.signedTransactions.map(
          (transaction) => transaction.transactionHash,
        ),
      })),
    );

    expect(runtime.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    const retained = await decodeJournalSnapshot(
      await readFile(filePath, 'utf8'),
      snapshot.identity,
    );

    expect(retained).toEqual(snapshot);
  });

  it('wires durable recovery reuse with a 60-second monotonic refresh', async () => {
    let now = 0;

    const clock = vi.spyOn(performance, 'now')
      .mockImplementation(() => now);

    try {
      const client = recoveryClient();
      const getTransactionCount = vi.mocked(client.getTransactionCount);
      const runtime = await openSignerRuntime(options(client));
      const input = recovery();

      expect(await runtime.reconcile(input)).toMatchObject({
        recoveryStatus: 'no-attempt',
        inclusionStatus: 'inspected',
        broadcast: null,
        state: {
          open: true,
          recoveryComplete: true,
          inclusionChecksComplete: true,
        },
      });

      getTransactionCount.mockClear();

      now = 59_999;

      expect(await runtime.reconcile(input)).toMatchObject({
        recoveryStatus: 'skipped',
        inclusionStatus: 'inspected',
        broadcast: null,
        state: {
          open: true,
          inclusionChecksComplete: true,
        },
      });

      // Reuse still performs the latest-head nonce inspection.
      expect(getTransactionCount).toHaveBeenCalledTimes(1);

      now = 60_000;

      expect(await runtime.reconcile(input)).toMatchObject({
        recoveryStatus: 'no-attempt',
        inclusionStatus: 'inspected',
        broadcast: null,
        state: {
          open: true,
          recoveryComplete: true,
          inclusionChecksComplete: true,
        },
      });

      // The refresh performs both durable and latest-head observations.
      expect(getTransactionCount).toHaveBeenCalledTimes(3);

      expect(await runtime.reconcile(input)).toMatchObject({
        recoveryStatus: 'skipped',
        inclusionStatus: 'inspected',
      });

      expect(getTransactionCount).toHaveBeenCalledTimes(4);
      expect(runtime.status.open).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('runs durable recovery when the durable anchor advances before refresh is due', async () => {
    const clock = vi.spyOn(performance, 'now')
      .mockReturnValue(0);

    try {
      const client = recoveryClient();
      const getTransactionCount = vi.mocked(client.getTransactionCount);
      const runtime = await openSignerRuntime(options(client));

      await runtime.reconcile(recovery());

      expect(await runtime.reconcile(recovery())).toMatchObject({
        recoveryStatus: 'skipped',
        inclusionStatus: 'inspected',
      });

      getTransactionCount.mockClear();

      const advanced = {
        blockNumber: 101n,
        blockHash: HASH,
      };

      expect(await runtime.reconcile({
        durable: advanced,
        head: advanced,
      })).toMatchObject({
        recoveryStatus: 'no-attempt',
        inclusionStatus: 'inspected',
        broadcast: null,
        state: {
          open: true,
          recoveryComplete: true,
          inclusionChecksComplete: true,
        },
      });

      expect(getTransactionCount).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});