import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  keccak256,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';

import {
  privateKeyToAccount
} from 'viem/accounts';

import {
  createRelayerLog,
  type ScopedRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import type {
  AttemptResolutionEvidence,
} from '../../src/diagnostics/transaction-evidence.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalSnapshot,
  TransactionJournalStore,
  TransactionJournalRead,
} from '../../src/state/transaction-journal.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ACCOUNT = privateKeyToAccount(KEY);
const IDENTITY = { chainId: 4663, signer: ACCOUNT.address };
const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;
const CREATED = '2026-10-04T00:00:00.000Z';

async function setup(options: {
  extraNonce?: boolean;
  empty?: boolean;
  brokenLog?: boolean;
} = {}) {
  const bytes = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: 4663,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const observation = {
    anchor: { blockNumber: 100n, blockHash: HASH },
    nonce: 4n,
  };

  const attempt = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    workId: 'test-work:4',
    nonce: 4n,
    signedTransactions: [{
      transactionHash: keccak256(bytes),
      signedTransaction: bytes,
    }] as const,
    createdAt: CREATED,
    phase: 'broadcast-may-have-occurred' as const,
    inclusion: null,
    replacementSearch: null,
  };

  const snapshot: TransactionJournalSnapshot = {
    version: 1,
    identity: IDENTITY,
    baseline: observation,
    lastObservation: {
      ...observation,
      nonce: options.extraNonce ? 8n : 4n,
    },
    nextNonce: options.empty ? 4n : 5n,
    durableNextNonce: 4n,
    repairs: [],
    attempts: options.empty ? [] : [attempt],
  };

  const save = vi.fn<TransactionJournalStore['save']>()
    .mockResolvedValue(undefined);

  const load = vi.fn<TransactionJournalStore['load']>()
    .mockResolvedValue({ kind: 'present', snapshot });

  const lines: string[] = [];

  const factory = vi.fn((signedTransactions: readonly string[] = []) =>
    Object.freeze({
      scrubText: createScrubber({
        privateKey: KEY,
        rpcUrls: ['https://rpc.example/credential-canary'],
        secrets: signedTransactions,
      }),
    }),
  );

  const realLog = createRelayerLog({
    chainId: 4663,
    errorSummary: factory(),
    destination: {
      write(line) {
        lines.push(line);
      },
    },
  });

  factory.mockClear();

  let log = realLog;

  if (options.brokenLog) {
    function wrap(current: ScopedRelayerLog): ScopedRelayerLog {
      return {
        ...current,
        withContext: (context) => wrap(current.withContext(context)),
        withErrorSummary: (policy) => wrap(current.withErrorSummary(policy)),
        attemptResolved() {
          throw new Error(`failed ${bytes} ${KEY}`);
        },
        signerGateReleased() {
          throw new Error(`failed ${bytes} ${KEY}`);
        },
      };
    }

    log = wrap(realLog);
  }

  const coordinator = await SignerCoordinator.create({
    identity: IDENTITY,
    maxRetainedAttempts: 3,
    store: { load, save },
    log,
    createErrorSummary: factory,
    now: () => Date.parse('2026-10-04T01:00:00.000Z'),
  });

  const evidence = {
    outcome: 'success' as const,
    transactionHash: attempt.signedTransactions[0].transactionHash,
    anchor: { blockNumber: 110n, blockHash: HASH },
    inclusion: { blockNumber: 109n, blockHash: OTHER },
  };

  return {
    coordinator,
    save,
    load,
    lines,
    factory,
    bytes,
    snapshot,
    evidence,
    attempt,
    records: () => lines.map((line) => JSON.parse(line)),
  };
}

function receiptRecoveryOptions(
  t: Awaited<ReturnType<typeof setup>>,
  nonce = 5,
) {
  const publicClient = {
    getBlock: vi.fn<PublicClient['getBlock']>()
      .mockImplementation(async ({ blockNumber } = {}) => ({
        number: blockNumber,
        hash: blockNumber === t.evidence.inclusion.blockNumber
          ? t.evidence.inclusion.blockHash
          : t.evidence.anchor.blockHash,
      }) as never),
    getTransactionCount: vi.fn<PublicClient['getTransactionCount']>()
      .mockResolvedValue(nonce),
    getTransactionReceipt: vi.fn<PublicClient['getTransactionReceipt']>()
      .mockResolvedValue({
        transactionHash: t.evidence.transactionHash,
        blockNumber: t.evidence.inclusion.blockNumber,
        blockHash: t.evidence.inclusion.blockHash,
        status: t.evidence.outcome,
      } as never),
  } as unknown as PublicClient;

  return {
    publicClient,
    anchor: { ...t.evidence.anchor },
    maxBlockRange: 2n,
  };
}

function replacementRecoveryOptions(
  t: Awaited<ReturnType<typeof setup>>,
  nonce = 5,
) {
  const options = receiptRecoveryOptions(t, nonce);

  vi.mocked(options.publicClient.getTransactionReceipt)
    .mockImplementation(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    });

  vi.mocked(options.publicClient.getBlock)
    .mockImplementation(async ({ blockNumber } = {}) => ({
      number: blockNumber,
      hash: blockNumber === 109n ? OTHER : HASH,
      parentHash: blockNumber === 110n ? OTHER : HASH,
      transactions: blockNumber === 109n
        ? [{
            hash: OTHER,
            from: IDENTITY.signer,
            nonce: 4,
          }]
        : [],
    }) as never);

  return {
    ...options,
    maxBlockRange: 10n,
  };
}

function searchRecoveryOptions(
  t: Awaited<ReturnType<typeof setup>>,
  nonce = 5,
) {
  const options = replacementRecoveryOptions(t, nonce);
  const readBlock =
    vi.mocked(options.publicClient.getBlock).getMockImplementation()!;

  vi.mocked(options.publicClient.getBlock)
    .mockImplementation(async (args) => ({
      ...await readBlock(args),
      transactions: [],
    }));

  return options;
}

async function checkEmptyInclusions(
  coordinator: SignerCoordinator,
  nonce: number,
  cycle?: number,
) {
  const head = {
    blockNumber: 110n,
    blockHash: HASH,
  };

  return coordinator.checkInclusions({
    publicClient: {
      getBlock: vi.fn().mockResolvedValue({
        number: head.blockNumber,
        hash: head.blockHash,
      }),
      getTransactionCount: vi.fn().mockResolvedValue(nonce),
    } as unknown as PublicClient,
    head,
  }, cycle);
}

describe('signer coordinator transitions', () => {
  it('emits resolution then release only after durable clear, with correlation', async () => {
    const t = await setup();
    const options = receiptRecoveryOptions(t);
    t.lines.length = 0;

    let finish!: () => void;
    let entered!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    t.save.mockImplementationOnce(() => {
      entered();

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const pending = t.coordinator.recover(options, 2);

    try {
      await started;

      expect(t.records()).toEqual([]);
      expect(t.coordinator.status.open).toBe(false);

      await expect(t.coordinator.recover(options))
        .rejects.toThrow('already in progress');

      expect(t.save).toHaveBeenCalledOnce();
    } finally {
      finish();
      await pending;
    }

    expect(await pending).toMatchObject({
      status: 'resolution-available',
      evidence: t.evidence,
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.records()[0]).toMatchObject({
      cycle: 2,
      attemptId: t.attempt.attemptId,
      signer: ACCOUNT.address,
    });

    expect(t.records()[1]).toMatchObject({
      cycle: 2,
      reason: 'recovery-incomplete',
      blockedSince: CREATED,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
    });

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
    });

    await checkEmptyInclusions(t.coordinator, 5, 3);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.records()[2]).toMatchObject({
      cycle: 3,
      signer: ACCOUNT.address,
      blockedSince: CREATED,
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.coordinator.status.blockedSince).toBeNull();

    expect(t.factory).toHaveBeenCalledExactlyOnceWith([t.bytes]);
    expect(t.lines.join('')).not.toContain(t.bytes);
  });

  it('retains evidence and policy across visible failed clears and repeated retries', async () => {
    const t = await setup();
    const options = receiptRecoveryOptions(t);
    t.lines.length = 0;

    let visible: TransactionJournalRead = {
      kind: 'present',
      snapshot: t.snapshot,
    };

    t.save.mockImplementationOnce(async (snapshot) => {
      visible = { kind: 'present', snapshot };
      throw new Error('failed');
    });

    t.save.mockRejectedValueOnce(new Error('failed again'));

    await expect(t.coordinator.recover(options))
      .rejects.toThrow('Journal persistence');

    expect(visible).toMatchObject({
      snapshot: {
        attempts: [],
        nextNonce: 5n,
        durableNextNonce: 5n,
      },
    });

    t.evidence.anchor.blockNumber = 999n;

    vi.mocked(options.publicClient.getBlock).mockClear();
    vi.mocked(options.publicClient.getTransactionCount).mockClear();
    vi.mocked(options.publicClient.getTransactionReceipt).mockClear();

    await expect(t.coordinator.retryPersistence()).rejects.toThrow();

    expect(t.records().map((record) => record.event))
      .toEqual(['signer_blocked']);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockedSince: CREATED,
      primaryReason: 'persistence-failure',
    });

    await t.coordinator.retryPersistence(3);

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.records()[1].resolution.anchor.blockNumber).toBe('110');

    expect(t.records()[2]).toMatchObject({
      reason: 'recovery-incomplete',
      cycle: 3,
      blockedSince: CREATED,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.save.mock.calls[2]![0]).toBe(t.save.mock.calls[0]![0]);
    expect(t.save.mock.calls[1]![0]).toBe(t.save.mock.calls[0]![0]);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionReceipt).not.toHaveBeenCalled();

    expect(t.load).toHaveBeenCalledTimes(1);

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('No failed journal');

    // Inclusion checking alone cannot complete recovery after a failed write.
    await checkEmptyInclusions(t.coordinator, 5, 4);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    expect(await t.coordinator.recover(options, 4)).toEqual({
      status: 'no-attempt',
      observation: {
        anchor: {
          blockNumber: 110n,
          blockHash: HASH,
        },
        nonce: 5n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await checkEmptyInclusions(t.coordinator, 5, 4);

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.records()[3]).toMatchObject({
      cycle: 4,
      blockedSince: CREATED,
    });

    expect(t.records()[3].cleared).toEqual(
      expect.arrayContaining([
        'persistence-failure',
        'unresolved-attempt',
        'recovery-incomplete',
      ]),
    );

    expect(t.coordinator.status.open).toBe(true);
    expect(t.lines.join('')).not.toContain(t.bytes);
    expect(t.lines.join('')).not.toContain(KEY);
  });

  it('resolves without releasing while another blocker remains', async () => {
    const t = await setup({ extraNonce: true });
    t.lines.length = 0;

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t),
    )).toMatchObject({
      status: 'resolution-available',
      evidence: t.evidence,
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.records()[1]).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      reason: 'unattributed-signer-activity',
      blockers: [
        'unattributed-signer-activity',
        'recovery-incomplete',
      ],
      blockedSince: CREATED,
    });

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: t.snapshot.lastObservation,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
      primaryReason: 'unattributed-signer-activity',
    });

    await checkEmptyInclusions(t.coordinator, 8);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_blocked',
    ]);

    expect(t.records()[2]).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      reason: 'unattributed-signer-activity',
      blockers: ['unattributed-signer-activity'],
      blockedSince: CREATED,
    });

    expect(t.records().map((record) => record.event))
      .not.toContain('signer_gate_released');
  });

  it('defers release until recovery and inclusion checks complete and preserves the episode', async () => {
    const t = await setup();
    t.lines.length = 0;

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t),
      7,
    )).toMatchObject({
      status: 'resolution-available',
      evidence: t.evidence,
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
    });

    // Another durable recovery still cannot replace inclusion checking.
    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t),
      7,
    )).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.records()).toHaveLength(2);
    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
    });

    await checkEmptyInclusions(t.coordinator, 5, 8);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.records()[2]).toMatchObject({
      cycle: 8,
      blockedSince: CREATED,
    });

    expect(t.coordinator.status.open).toBe(true);
    expect(t.coordinator.status.blockedSince).toBeNull();

    await checkEmptyInclusions(t.coordinator, 5, 8);
    expect(t.records()).toHaveLength(3);
  });

  it('preserves blockedSince and suppresses unchanged blocker sets', async () => {
    const t = await setup();
    const options = searchRecoveryOptions(t);

    // Establish partial search progress before checking reason changes.
    expect(await t.coordinator.recover({
      ...options,
      maxBlockRange: 5n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    t.lines.length = 0;

    // Finish the range and establish exhaustion.
    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 0n,
      },
    });

    expect(t.coordinator.status.primaryReason)
      .toBe('conflict-search-exhausted');

    // Rechecking the exhausted range must not repeat the blocked event.
    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 0n,
        remainingBlocks: 0n,
      },
    });

    expect(t.records().map((record) => record.reason))
      .toEqual(['conflict-search-exhausted']);

    const advanced = {
      ...options,
      anchor: {
        blockNumber: 120n,
        blockHash: HASH,
      },
      maxBlockRange: 5n,
    };

    // An advanced anchor allows partial progress and clears exhaustion.
    expect(await t.coordinator.recover(advanced)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.coordinator.status.primaryReason).toBe('unresolved-attempt');

    // More partial progress leaves the entire blocker set unchanged.
    expect(await t.coordinator.recover({
      ...advanced,
      maxBlockRange: 1n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 1n,
        remainingBlocks: 4n,
      },
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'signer_blocked',
    ]);

    expect(t.records().map((record) => record.reason)).toEqual([
      'conflict-search-exhausted',
      'unresolved-attempt',
    ]);

    expect(
      t.records().every((record) => record.blockedSince === CREATED),
    ).toBe(true);

    expect(t.coordinator.status.open).toBe(false);
  });

  it.each(['success', 'reverted'] as const)(
    'rejects a mismatched %s receipt before persistence',
    async (outcome) => {
      const t = await setup();
      const options = receiptRecoveryOptions(t);
      t.lines.length = 0;

      vi.mocked(options.publicClient.getTransactionReceipt)
        .mockResolvedValue({
          transactionHash: OTHER,
          blockNumber: t.evidence.inclusion.blockNumber,
          blockHash: t.evidence.inclusion.blockHash,
          status: outcome,
        } as never);

      await expect(t.coordinator.recover(options))
        .rejects.toThrow('Invalid attempt receipt response');

      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.attempts.map((attempt) => attempt.attemptId))
        .toEqual([t.attempt.attemptId]);
      expect(t.coordinator.status.recoveryComplete).toBe(false);
      expect(t.records()).toEqual([]);
    },
  );

  it.each(['reverted', 'replaced'] as const)(
    'accepts %s evidence without treating it as application completion',
    async (outcome) => {
      const t = await setup();
      t.lines.length = 0;

      let evidence: AttemptResolutionEvidence = {
        ...t.evidence,
        outcome: 'reverted',
      };

      if (outcome === 'replaced') {
        evidence = {
          outcome,
          anchor: t.evidence.anchor,
          inclusion: t.evidence.inclusion,
          replacementTransactionHash: OTHER,
          nonceAtAnchor: 5n,
        };
      }

      const options = outcome === 'replaced'
        ? replacementRecoveryOptions(t)
        : receiptRecoveryOptions(t);

      if (outcome === 'reverted') {
        vi.mocked(options.publicClient.getTransactionReceipt)
          .mockResolvedValue({
            transactionHash: t.evidence.transactionHash,
            blockNumber: t.evidence.inclusion.blockNumber,
            blockHash: t.evidence.inclusion.blockHash,
            status: 'reverted',
          } as never);
      }

      expect(await t.coordinator.recover(options)).toMatchObject({
        status: 'resolution-available',
        evidence,
      });

      expect(t.save).toHaveBeenCalledOnce();

      expect(t.records()[0].resolution.outcome).toBe(outcome);

      expect(t.save.mock.calls[0]![0]).toMatchObject({
        attempts: [],
        nextNonce: 5n,
        durableNextNonce: 5n,
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: true,
        inclusionChecksComplete: false,
      });

      await checkEmptyInclusions(t.coordinator, 5);

      expect(t.coordinator.status.open).toBe(true);
    },
  );

  it('blocks additional unaccounted nonce consumption', async () => {
    const t = await setup();

    expect(await t.coordinator.recover(
      replacementRecoveryOptions(t, 8),
    )).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: 'replaced',
        replacementTransactionHash: OTHER,
        nonceAtAnchor: 8n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: {
        anchor: t.evidence.anchor,
        nonce: 8n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(
      t.records().some((record) => record.event === 'signer_gate_released'),
    ).toBe(false);
  });

  it('contains logger failures using the attempt policy through release', async () => {
    const t = await setup({ brokenLog: true });
    t.lines.length = 0;

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t),
      9,
    )).toMatchObject({
      status: 'resolution-available',
      evidence: t.evidence,
    });

    expect(t.coordinator.status.open).toBe(false);

    expect(t.records().map((record) => record.event)).toEqual([
      'logging_failed',
      'signer_blocked',
    ]);

    await checkEmptyInclusions(t.coordinator, 5, 9);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().map((record) => record.event)).toEqual([
      'logging_failed',
      'signer_blocked',
      'logging_failed',
    ]);

    expect(t.records().every((record) => record.cycle === 9)).toBe(true);
    expect(t.lines.join('')).not.toContain(t.bytes);
    expect(t.lines.join('')).not.toContain(KEY);
  });

  it('retains signed-byte protection through deferred release logging', async () => {
    const t = await setup({ brokenLog: true });
    const blockedSince = t.coordinator.status.blockedSince;

    expect(blockedSince).not.toBeNull();

    t.lines.length = 0;

    await t.coordinator.observeReconciliation(async () => {
      await t.coordinator.recover(
        receiptRecoveryOptions(t),
        11,
      );

      expect(t.coordinator.attempts).toEqual([]);
      expect(t.coordinator.status.open).toBe(false);

      // Resolution reporting happens at commit, even inside observation.
      expect(t.records()).toEqual([
        expect.objectContaining({
          event: 'logging_failed',
          cycle: 11,
          operation: { name: 'reconcile-attempt' },
        }),
      ]);

      await checkEmptyInclusions(t.coordinator, 5, 22);

      // The journal is empty and admission is open, but publication
      // and signed-byte policy cleanup remain deferred.
      expect(t.coordinator.status).toMatchObject({
        open: true,
        blockers: [],
        blockedSince,
      });
      expect(t.records()).toHaveLength(1);
    }, 33);

    expect(t.coordinator.status).toMatchObject({
      open: true,
      blockedSince: null,
    });

    // The fixture throws errors containing signed bytes from both
    // attemptResolved and signerGateReleased. Their logging_failed
    // summaries must use the protected policy, including at scope end.
    expect(t.records()).toEqual([
      expect.objectContaining({
        event: 'logging_failed',
        cycle: 11,
        operation: { name: 'reconcile-attempt' },
      }),
      expect.objectContaining({
        event: 'logging_failed',
        cycle: 33,
        operation: { name: 'reconcile-attempt' },
      }),
    ]);

    const output = t.lines.join('');

    expect(output).not.toContain(t.bytes);
    expect(output).not.toContain(KEY);
  });

  it('does not emit a release event before clean startup inclusion checks complete', async () => {
    const t = await setup({ empty: true });

    expect(t.coordinator.status.open).toBe(false);

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
    ]);

    expect(t.records()[0]).toMatchObject({
      reason: 'recovery-incomplete',
      blockedSince: '2026-10-04T01:00:00.000Z',
    });

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t, 4),
    )).toEqual({
      status: 'no-attempt',
      observation: {
        anchor: t.evidence.anchor,
        nonce: 4n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.records()).toHaveLength(1);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.records()[1]).toMatchObject({
      blockedSince: '2026-10-04T01:00:00.000Z',
      cleared: ['recovery-incomplete'],
    });

    // Repeating a successful inclusion check must not duplicate release.
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
    expect(t.records()).toHaveLength(2);
  });

  it('preserves already recorded unattributed activity during recovery', async () => {
    const t = await setup({ empty: true, extraNonce: true });

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t, 8),
    )).toEqual({
      status: 'no-attempt',
      observation: {
        anchor: t.evidence.anchor,
        nonce: 8n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 4n,
      durableNextNonce: 4n,
      lastObservation: {
        nonce: 8n,
      },
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('clears the attempt search blocker after durable resolution', async () => {
    const t = await setup();

    expect(await t.coordinator.recover(
      searchRecoveryOptions(t),
    )).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 10n,
        remainingBlocks: 0n,
      },
    });

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    t.save.mockClear();
    t.lines.length = 0;

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t),
      2,
    )).toMatchObject({
      status: 'resolution-available',
      evidence: t.evidence,
    });

    expect(t.save).toHaveBeenCalledOnce();

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
      blockedSince: CREATED,
    });

    await checkEmptyInclusions(t.coordinator, 5, 3);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.records()[2]).toMatchObject({
      cycle: 3,
      blockedSince: CREATED,
    });

    expect(t.records()[2].cleared).toEqual(
      expect.arrayContaining([
        'conflict-search-exhausted',
        'unresolved-attempt',
        'recovery-incomplete',
      ]),
    );

    expect(t.coordinator.status.open).toBe(true);
  });

  it('does not initialize a missing journal through inclusion checking', async () => {
    const save = vi.fn<TransactionJournalStore['save']>();

    const load = vi.fn<TransactionJournalStore['load']>()
      .mockResolvedValue({ kind: 'missing' });

    const log = createRelayerLog({ chainId: 4663 });

    const coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: { save, load },
      log,
      createErrorSummary: () => ({
        scrubText: (text) => ({ text, removed: false }),
      }),
    });

    const getBlock = vi.fn<PublicClient['getBlock']>();
    const getTransactionCount =
      vi.fn<PublicClient['getTransactionCount']>();

    await expect(coordinator.checkInclusions({
      publicClient: {
        getBlock,
        getTransactionCount,
      } as unknown as PublicClient,
      head: {
        blockNumber: 110n,
        blockHash: HASH,
      },
    })).rejects.toThrow('initialized journal');

    expect(getBlock).not.toHaveBeenCalled();
    expect(getTransactionCount).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();

    expect(coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(save).not.toHaveBeenCalled();
  });
});

describe('durable signer observations', () => {
  const observation = (
    nonce: bigint,
    blockNumber = 110n,
  ) => ({
    anchor: {
      blockNumber,
      blockHash: HASH,
    },
    nonce,
  });

  it('records observations without advancing the nonce or resolving the attempt', async () => {
    const t = await setup();
    t.lines.length = 0;

    expect(await t.coordinator.recover(
      searchRecoveryOptions(t, 4),
      2,
    )).toMatchObject({
      status: 'unresolved',
      observation: observation(4n),
      receipt: { status: 'receipt-not-found' },
      search: null,
    });

    expect(t.save).toHaveBeenCalledOnce();

    const saved = t.save.mock.calls[0]![0];

    expect(saved).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: observation(4n),
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: observation(4n),
          searchedThrough: null,
        },
      }],
    });

    expect(t.records()).toEqual([]);
    expect(t.coordinator.status.open).toBe(false);
  });

  it('preserves the earlier observation when the nonce has already advanced', async () => {
    const t = await setup();

    expect(await t.coordinator.recover({
      ...searchRecoveryOptions(t),
      maxBlockRange: 5n,
    })).toMatchObject({
      status: 'unresolved',
      observation: observation(5n),
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    const saved = t.save.mock.calls[0]![0];

    expect(saved.attempts[0]!.replacementSearch).toEqual({
      lowerBound: t.snapshot.lastObservation,
      searchedThrough: {
        blockNumber: 105n,
        blockHash: HASH,
      },
    });

    expect(saved.nextNonce).toBe(5n);
    expect(saved.durableNextNonce).toBe(4n);
    expect(saved.attempts).toHaveLength(1);
    expect(t.coordinator.status.open).toBe(false);
  });

  it('keeps an established lower bound across later observations', async () => {
    const t = await setup();

    expect(await t.coordinator.recover(
      searchRecoveryOptions(t, 4),
    )).toMatchObject({
      status: 'unresolved',
      observation: observation(4n),
      search: null,
    });

    expect(t.save.mock.calls[0]![0].attempts[0]!.replacementSearch)
      .toEqual({
        lowerBound: observation(4n),
        searchedThrough: null,
      });

    expect(await t.coordinator.recover({
      ...searchRecoveryOptions(t),
      anchor: observation(5n, 120n).anchor,
      maxBlockRange: 5n,
    })).toMatchObject({
      status: 'unresolved',
      observation: observation(5n, 120n),
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledTimes(2);
    const saved = t.save.mock.calls[1]![0];

    expect(saved.attempts[0]!.replacementSearch).toEqual({
      lowerBound: observation(4n),
      searchedThrough: {
        blockNumber: 115n,
        blockHash: HASH,
      },
    });

    expect(saved.nextNonce).toBe(5n);
    expect(saved.durableNextNonce).toBe(4n);
    expect(saved.attempts).toHaveLength(1);
    expect(t.coordinator.status.open).toBe(false);
  });

  it('closes an otherwise open gate while saving and rejects overlapping operations', async () => {
    const t = await setup({ empty: true });

    const options = receiptRecoveryOptions(t, 4);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    let finish!: () => void;
    let entered!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    t.save.mockImplementationOnce(() => {
      entered();

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const pending = t.coordinator.recover(options);

    try {
      await started;

      expect(t.coordinator.status.open).toBe(false);

      await expect(t.coordinator.recover(options))
        .rejects.toThrow('already in progress');

      await expect(checkEmptyInclusions(t.coordinator, 4))
        .rejects.toThrow('already in progress');

      expect(t.save).toHaveBeenCalledOnce();
    } finally {
      finish();
      await pending;
    }

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);
  });

  it('retries the exact failed observation and preserves unexpected activity across restart', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    await checkEmptyInclusions(t.coordinator, 4);
    expect(t.coordinator.status.open).toBe(true);

    const beforeFailure = t.coordinator.durableRecoveryRevision;

    expect(t.coordinator.status.blockers)
      .not.toContain('unattributed-signer-activity');

    t.save.mockClear();
    t.lines.length = 0;

    let visible = t.snapshot;

    t.save.mockImplementationOnce(async (snapshot) => {
      visible = snapshot;
      throw new Error('Durability uncertain');
    });

    vi.mocked(options.publicClient.getTransactionCount)
      .mockResolvedValue(8);

    await expect(t.coordinator.recover(options))
      .rejects.toThrow('Journal persistence');

    // The store may expose the attempted snapshot, but durability has
    // not been established. The committed revision must remain unchanged.
    expect(t.coordinator.durableRecoveryRevision).toBe(beforeFailure);

    const pending = t.save.mock.calls[0]![0];

    expect(visible).toBe(pending);
    expect(pending).toMatchObject({
      attempts: [],
      nextNonce: 4n,
      durableNextNonce: 4n,
      lastObservation: observation(8n),
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'persistence-failure',
    });

    // Changed RPC responses cannot replace the retained failed snapshot.
    vi.mocked(options.publicClient.getTransactionCount)
      .mockResolvedValue(4);

    vi.mocked(options.publicClient.getBlock).mockClear();
    vi.mocked(options.publicClient.getTransactionCount).mockClear();

    await expect(t.coordinator.recover(options))
      .rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('Retry failed'));

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('Journal persistence');

    expect(t.coordinator.durableRecoveryRevision).toBe(beforeFailure);

    await t.coordinator.retryPersistence(3);

    const committedRevision = t.coordinator.durableRecoveryRevision;

    expect(committedRevision).not.toBe(beforeFailure);

    expect(t.coordinator.status.blockers)
      .toContain('unattributed-signer-activity');

    expect(t.save).toHaveBeenCalledTimes(3);
    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(t.save.mock.calls[2]![0]).toBe(pending);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(t.load).toHaveBeenCalledOnce();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    const restarted = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: async () => ({
          kind: 'present',
          snapshot: visible,
        }),
        save: t.save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: t.factory,
    });

    expect(restarted.status.blockers)
      .toContain('unattributed-signer-activity');

    expect(restarted.durableRecoveryRevision).toBe(committedRevision);

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    // A lower observation cannot overwrite the recorded excess activity.
    expect(await restarted.recover(options)).toMatchObject({
      status: 'no-attempt',
      observation: observation(4n),
    });

    // A lower observation must neither erase the latched evidence nor
    // change the revision when no new committed recovery content exists.
    expect(restarted.durableRecoveryRevision).toBe(committedRevision);

    expect(t.save).toHaveBeenCalledTimes(3);

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    await checkEmptyInclusions(restarted, 4);

    expect(t.save).toHaveBeenCalledTimes(4);
    expect(t.save.mock.calls[3]![0]).toMatchObject({
      attempts: [],
      nextNonce: 4n,
      durableNextNonce: 4n,
      lastObservation: observation(8n),
    });

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('retries an ordinary observation without emitting an attempt resolution', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    await checkEmptyInclusions(t.coordinator, 4);
    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    t.save.mockRejectedValueOnce(new Error('Failed'));

    await expect(t.coordinator.recover(options))
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    vi.mocked(options.publicClient.getBlock).mockClear();
    vi.mocked(options.publicClient.getTransactionCount).mockClear();

    await t.coordinator.retryPersistence();

    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.save.mock.calls[1]![0]).toBe(pending);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    // Inclusion checking cannot complete recovery after a failed write.
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    // Fresh recovery invalidates the earlier inclusion authorization.
    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);

    expect(t.records().some(
      (record) => record.event === 'attempt_resolved',
    )).toBe(false);
  });

  it('does not complete startup recovery through inclusion checking alone', async () => {
    const t = await setup({ empty: true });
    t.lines.length = 0;

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 4n,
      durableNextNonce: 4n,
      lastObservation: observation(4n),
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    expect(await t.coordinator.recover(
      receiptRecoveryOptions(t, 4),
    )).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);
  });

  it('requires fresh recovery when the observed nonce is behind the journal', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    await checkEmptyInclusions(t.coordinator, 4);
    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    vi.mocked(options.publicClient.getTransactionCount)
      .mockResolvedValue(3);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'nonce-behind-journal',
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.save).not.toHaveBeenCalled();

    // A valid head observation cannot replace durable recovery.
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 4n,
      durableNextNonce: 4n,
      lastObservation: observation(4n),
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    vi.mocked(options.publicClient.getTransactionCount)
      .mockResolvedValue(4);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
      observation: observation(4n),
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status).toMatchObject({
      open: true,
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);

    expect(t.records().some(
      (record) => record.event === 'attempt_resolved',
    )).toBe(false);
  });

  it('rejects a stored observation getter without invoking it or saving', async () => {
    const t = await setup();
    const input = {
      ...t.snapshot,
      lastObservation: observation(4n),
    };

    const getter = vi.fn(() => 4n);

    Object.defineProperty(input.lastObservation, 'nonce', {
      get: getter,
    });

    t.load.mockResolvedValueOnce({
      kind: 'present',
      snapshot: input,
    });

    await expect(SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: t.load,
        save: t.save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: t.factory,
    })).rejects.toThrow('Invalid transaction journal snapshot');

    expect(getter).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
  });

  it('persists excess nonce evidence with a replacement clear for restart recovery', async () => {
    const t = await setup();
    const options = replacementRecoveryOptions(t, 8);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: 'replaced',
        replacementTransactionHash: OTHER,
        nonceAtAnchor: 8n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    const saved = t.save.mock.calls[0]![0];

    expect(saved).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: observation(8n),
    });

    const restarted = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: async () => ({
          kind: 'present',
          snapshot: saved,
        }),
        save: t.save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: t.factory,
    });

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    t.save.mockClear();
    vi.mocked(options.publicClient.getTransactionReceipt).mockClear();

    expect(await restarted.recover(options)).toEqual({
      status: 'no-attempt',
      observation: observation(8n),
    });

    expect(options.publicClient.getTransactionReceipt)
      .not.toHaveBeenCalled();

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: observation(8n),
    });

    await checkEmptyInclusions(restarted, 8);

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('does not erase an existing higher nonce observation during replacement clear', async () => {
    const t = await setup();

    // Establish excess activity and a usable replacement-search boundary.
    expect(await t.coordinator.recover({
      ...searchRecoveryOptions(t, 8),
      maxBlockRange: 5n,
    })).toMatchObject({
      status: 'unresolved',
      observation: observation(8n),
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();

    const recorded = t.save.mock.calls[0]![0];

    expect(recorded).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: observation(8n),
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: {
            blockNumber: 105n,
            blockHash: HASH,
          },
        },
      }],
    });

    expect(t.coordinator.status.primaryReason)
      .toBe('unattributed-signer-activity');

    t.save.mockClear();
    t.lines.length = 0;

    // Resolve the replacement despite a lower current nonce observation.
    expect(await t.coordinator.recover(
      replacementRecoveryOptions(t, 5),
    )).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: 'replaced',
        replacementTransactionHash: OTHER,
        nonceAtAnchor: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
      lastObservation: recorded.lastObservation,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.records()[1]).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      reason: 'unattributed-signer-activity',
      blockers: [
        'unattributed-signer-activity',
        'recovery-incomplete',
      ],
      blockedSince: CREATED,
    });

    await checkEmptyInclusions(t.coordinator, 5);

    expect(t.save.mock.calls[1]![0].lastObservation)
      .toEqual(recorded.lastObservation);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: true,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
      'signer_blocked',
    ]);

    expect(t.records()[2]).toMatchObject({
      event: 'signer_blocked',
      operation: { name: 'reconcile-attempt' },
      reason: 'unattributed-signer-activity',
      blockers: ['unattributed-signer-activity'],
      blockedSince: CREATED,
    });

    expect(t.records().map((record) => record.event))
      .not.toContain('signer_gate_released');
  });
});

describe('durable replacement search progress', () => {
  async function prepareExhaustedSearch() {
    const t = await setup();
    const options = searchRecoveryOptions(t);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 10n,
        remainingBlocks: 0n,
      },
    });

    expect(t.coordinator.status.primaryReason)
      .toBe('conflict-search-exhausted');

    const exhausted = t.save.mock.calls[0]![0];

    t.save.mockClear();
    t.lines.length = 0;

    return {
      ...t,
      exhausted,
      options: {
        ...options,
        anchor: {
          blockNumber: 120n,
          blockHash: HASH,
        },
        maxBlockRange: 5n,
      },
    };
  }

  it('persists the boundary before clearing the search blocker', async () => {
    const t = await prepareExhaustedSearch();

    let finish!: () => void;
    let entered!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    t.save.mockImplementationOnce(() => {
      entered();

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const pending = t.coordinator.recover(t.options, 7);

    try {
      await started;

      expect(t.coordinator.status.primaryReason)
        .toBe('conflict-search-exhausted');

      expect(t.records()).toEqual([]);

      await expect(t.coordinator.recover(t.options))
        .rejects.toThrow('already in progress');

      await expect(t.coordinator.retryPersistence())
        .rejects.toThrow('already in progress');
    } finally {
      finish();
      await pending;
    }

    expect(await pending).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
        searchedThrough: {
          blockNumber: 115n,
          blockHash: HASH,
        },
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: {
            blockNumber: 115n,
            blockHash: HASH,
          },
        },
      }],
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    expect(t.records().map((record) => record.event))
      .toEqual(['signer_blocked']);

    expect(t.records()[0]).toMatchObject({
      cycle: 7,
      blockedSince: CREATED,
      reason: 'unresolved-attempt',
    });
  });

  it('retains the exact failed progress write and its blocker effect through retries', async () => {
    const t = await prepareExhaustedSearch();
    let visible = t.exhausted;

    t.save.mockImplementationOnce(async (snapshot) => {
      visible = snapshot;
      throw new Error('uncertain');
    });

    await expect(t.coordinator.recover(t.options))
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    expect(visible).toBe(pending);
    expect(pending.attempts[0]!.replacementSearch).toEqual({
      lowerBound: t.snapshot.lastObservation,
      searchedThrough: {
        blockNumber: 115n,
        blockHash: HASH,
      },
    });

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    // A changed request cannot replace the retained progress snapshot.
    t.options.anchor.blockNumber = 130n;
    t.options.maxBlockRange = 10n;

    vi.mocked(t.options.publicClient.getBlock).mockClear();
    vi.mocked(t.options.publicClient.getTransactionCount).mockClear();
    vi.mocked(t.options.publicClient.getTransactionReceipt).mockClear();

    await expect(t.coordinator.recover(t.options))
      .rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('again'));

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('Journal persistence');

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    await t.coordinator.retryPersistence();

    expect(t.save).toHaveBeenCalledTimes(3);
    expect(t.save.mock.calls[1]![0]).toBe(pending);
    expect(t.save.mock.calls[2]![0]).toBe(pending);

    expect(t.options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(t.options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(t.options.publicClient.getTransactionReceipt).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    expect(t.load).toHaveBeenCalledOnce();
  });

  it('reconstructs an exhausted search after restart without rescanning the range', async () => {
    const t = await prepareExhaustedSearch();
    const committedRevision = t.coordinator.durableRecoveryRevision;

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    expect(t.coordinator.status.blockers)
      .not.toContain('unattributed-signer-activity');

    const restarted = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: async () => ({
          kind: 'present',
          snapshot: t.exhausted,
        }),
        save: t.save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: t.factory,
    });

    expect(restarted.status.blockers)
      .toContain('conflict-search-exhausted');

    expect(restarted.status.blockers)
      .not.toContain('unattributed-signer-activity');

    expect(restarted.durableRecoveryRevision).toBe(committedRevision);

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      primaryReason: 'conflict-search-exhausted',
    });

    const options = {
      ...t.options,
      anchor: { ...t.evidence.anchor },
    };

    vi.mocked(options.publicClient.getBlock).mockClear();

    expect(await restarted.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: t.evidence.anchor,
        scannedBlocks: 0n,
        remainingBlocks: 0n,
      },
    });

    const scannedBlocks = vi.mocked(options.publicClient.getBlock)
      .mock.calls
      .filter(([args]) => args?.includeTransactions === true);

    expect(scannedBlocks).toEqual([]);

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: t.exhausted.attempts[0]!.replacementSearch,
      }],
    });

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'conflict-search-exhausted',
    });

    // Repeating the exhausted search at the same anchor persists an
    // observation but changes neither search progress nor its blocker.
    expect(restarted.durableRecoveryRevision).toBe(committedRevision);
  });

  it('resumes from the persisted boundary after restart', async () => {
    const t = await setup();
    const options = {
      ...searchRecoveryOptions(t),
      maxBlockRange: 5n,
    };

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: {
          blockNumber: 105n,
          blockHash: HASH,
        },
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    const snapshot = t.save.mock.calls[0]![0];

    const restarted = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: async () => ({
          kind: 'present',
          snapshot,
        }),
        save: t.save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: t.factory,
    });

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    t.save.mockClear();
    vi.mocked(options.publicClient.getBlock).mockClear();

    expect(await restarted.recover({
      ...options,
      maxBlockRange: 1n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: {
          blockNumber: 106n,
          blockHash: HASH,
        },
        scannedBlocks: 1n,
        remainingBlocks: 4n,
      },
    });

    const scannedBlocks = vi.mocked(options.publicClient.getBlock)
      .mock.calls
      .filter(([args]) => args?.includeTransactions === true)
      .map(([args]) => args?.blockNumber);

    expect(scannedBlocks).toEqual([106n]);

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: snapshot.attempts[0]!.replacementSearch!.lowerBound,
          searchedThrough: {
            blockNumber: 106n,
            blockHash: HASH,
          },
        },
      }],
    });

    expect(restarted.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'unresolved-attempt',
    });
  });

  it('preserves saved progress when the searched-through boundary changes', async () => {
    const t = await setup();
    const options = {
      ...searchRecoveryOptions(t),
      maxBlockRange: 5n,
    };

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        searchedThrough: {
          blockNumber: 105n,
          blockHash: HASH,
        },
      },
    });

    const saved = t.save.mock.calls[0]![0];
    const getBlock = vi.mocked(options.publicClient.getBlock);
    const readBlock = getBlock.getMockImplementation()!;

    t.save.mockClear();
    t.lines.length = 0;
    getBlock.mockClear();

    getBlock.mockImplementation(async (args) => ({
      ...await readBlock(args),
      ...(args?.blockNumber === 105n ? { hash: OTHER } : {}),
    }));

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'boundary-changed',
        boundary: 'searched-through',
        observedAnchor: {
          blockNumber: 105n,
          blockHash: OTHER,
        },
      },
    });

    expect(t.save).not.toHaveBeenCalled();

    expect(getBlock.mock.calls.filter(
      ([args]) => args?.includeTransactions === true,
    )).toEqual([]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
    });

    expect(t.coordinator.attempts.map((attempt) => attempt.attemptId))
      .toEqual([t.attempt.attemptId]);

    getBlock.mockImplementation(readBlock);
    getBlock.mockClear();

    expect(await t.coordinator.recover({
      ...options,
      maxBlockRange: 1n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 1n,
        remainingBlocks: 4n,
        searchedThrough: {
          blockNumber: 106n,
          blockHash: HASH,
        },
      },
    });

    expect(getBlock.mock.calls
      .filter(([args]) => args?.includeTransactions === true)
      .map(([args]) => args?.blockNumber))
      .toEqual([106n]);

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: saved.attempts[0]!.replacementSearch!.lowerBound,
          searchedThrough: {
            blockNumber: 106n,
            blockHash: HASH,
          },
        },
      }],
    });

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);
  });

  it('keeps unrelated blockers after saving partial progress', async () => {
    const t = await setup();
    const options = searchRecoveryOptions(t, 8);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 10n,
        remainingBlocks: 0n,
      },
    });

    expect(t.coordinator.status.blockers).toEqual(
      expect.arrayContaining([
        'conflict-search-exhausted',
        'unattributed-signer-activity',
      ]),
    );

    t.save.mockClear();
    t.lines.length = 0;

    const anchor = {
      blockNumber: 120n,
      blockHash: HASH,
    };

    expect(await t.coordinator.recover({
      ...options,
      anchor,
      maxBlockRange: 5n,
    })).toMatchObject({
      status: 'unresolved',
      search: {
        status: 'not-found',
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    });

    expect(t.save).toHaveBeenCalledOnce();
    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      lastObservation: {
        anchor,
        nonce: 8n,
      },
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: {
            blockNumber: 115n,
            blockHash: HASH,
          },
        },
      }],
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);
  });

  it('retains the search blocker through a failed clear and removes it after retry', async () => {
    const t = await prepareExhaustedSearch();
    const options = receiptRecoveryOptions(t);

    t.save.mockRejectedValueOnce(new Error('Failed clear'));

    await expect(t.coordinator.recover(options))
      .rejects.toThrow('Journal persistence');

    const pending = t.save.mock.calls[0]![0];

    expect(pending).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
    });

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    expect(t.coordinator.attempts.map((attempt) => attempt.attemptId))
      .toEqual([t.attempt.attemptId]);

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    vi.mocked(options.publicClient.getBlock).mockClear();
    vi.mocked(options.publicClient.getTransactionCount).mockClear();
    vi.mocked(options.publicClient.getTransactionReceipt).mockClear();

    await t.coordinator.retryPersistence();

    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.save.mock.calls[1]![0]).toBe(pending);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionReceipt).not.toHaveBeenCalled();

    expect(t.coordinator.attempts).toEqual([]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.records()[2]).toMatchObject({
      reason: 'recovery-incomplete',
      blockedSince: CREATED,
    });

    // Retrying the clear does not authorize release.
    await checkEmptyInclusions(t.coordinator, 5);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: true,
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    expect(await t.coordinator.recover(options)).toMatchObject({
      status: 'no-attempt',
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    await checkEmptyInclusions(t.coordinator, 5);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().filter(
      (record) => record.event === 'attempt_resolved',
    )).toHaveLength(1);

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);
  });
});

describe('signer inspection ownership', () => {
  it('does not restore authorization when an empty inspection finishes', async () => {
    const t = await setup({ empty: true });

    await t.coordinator.recover(receiptRecoveryOptions(t, 4));
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status).toMatchObject({
      open: true,
      blockers: [],
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    const revision = t.coordinator.durableRecoveryRevision;
    t.save.mockClear();

    const inspection = t.coordinator.beginInspection();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockers: ['recovery-incomplete'],
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    inspection.finish();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockers: ['recovery-incomplete'],
      recoveryComplete: true,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.coordinator.durableRecoveryRevision).toBe(revision);
    expect(t.save).not.toHaveBeenCalled();

    // Finishing released ownership, but fresh inspection is still needed.
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('keeps admission closed between completed scoped operations', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();

    try {
      await inspection.recover(options);

      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: true,
        inclusionChecksComplete: false,
        persistenceState: 'idle',
      });

      await inspection.checkInclusions({
        publicClient: options.publicClient,
        head: options.anchor,
      });

      // Both operations and their writes have completed. Ownership alone
      // keeps admission closed despite the empty blocker list.
      expect(t.coordinator.status).toMatchObject({
        open: false,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
        persistenceState: 'idle',
      });
      expect(t.coordinator.canBroadcast).toBe(false);

      const writes = t.save.mock.calls.length;
      const reads = vi.mocked(options.publicClient.getBlock)
        .mock.calls.length;

      await expect(t.coordinator.recover(options))
        .rejects.toThrow('Signer inspection is already in progress.');

      await expect(t.coordinator.checkInclusions({
        publicClient: options.publicClient,
        head: options.anchor,
      })).rejects.toThrow('Signer inspection is already in progress.');

      expect(t.save).toHaveBeenCalledTimes(writes);
      expect(options.publicClient.getBlock).toHaveBeenCalledTimes(reads);
    } catch (error) {
      await inspection.abandon();
      throw error;
    }

    inspection.finish();

    expect(t.coordinator.status).toMatchObject({
      open: true,
      blockers: [],
    });
  });

  it('rejects an expired handle while a newer inspection owns the coordinator', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);

    const expired = t.coordinator.beginInspection();
    expired.finish();

    const current = t.coordinator.beginInspection();

    try {
      const before = t.coordinator.status;
      const revision = t.coordinator.durableRecoveryRevision;

      await expect(expired.recover(options))
        .rejects.toThrow('Signer inspection is no longer active.');

      await expect(expired.checkInclusions({
        publicClient: options.publicClient,
        head: options.anchor,
      })).rejects.toThrow('Signer inspection is no longer active.');

      expect(() => expired.finish())
        .toThrow('Signer inspection is no longer active.');

      await expect(expired.abandon())
        .rejects.toThrow('Signer inspection is no longer active.');

      expect(t.coordinator.status).toEqual(before);
      expect(t.coordinator.durableRecoveryRevision).toBe(revision);
      expect(t.save).not.toHaveBeenCalled();
      expect(options.publicClient.getBlock).not.toHaveBeenCalled();
      expect(options.publicClient.getTransactionCount)
        .not.toHaveBeenCalled();

      // Rejected stale operations must not release the current owner.
      await expect(t.coordinator.recover(options))
        .rejects.toThrow('Signer inspection is already in progress.');

      await current.recover(options);
      await current.checkInclusions({
        publicClient: options.publicClient,
        head: options.anchor,
      });
    } catch (error) {
      await current.abandon();
      throw error;
    }

    current.finish();

    expect(t.coordinator.status.open).toBe(true);
  });

  it('waits for an active inclusion write before completing abandonment', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();

    await inspection.recover(options);

    let entered!: () => void;
    let release!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    t.save.mockImplementationOnce(() => {
      entered();
      return held;
    });

    const operation = inspection.checkInclusions({
      publicClient: options.publicClient,
      head: options.anchor,
    });

    await started;

    expect(t.coordinator.status).toMatchObject({
      open: false,
      inclusionChecksComplete: false,
      persistenceState: 'writing',
    });

    expect(() => inspection.finish())
      .toThrow('Signer inspection operation is still running.');

    let abandoned = false;

    const abandonment = inspection.abandon().then(() => {
      abandoned = true;
    });

    try {
      await Promise.resolve();

      expect(abandoned).toBe(false);
      expect(t.coordinator.canBroadcast).toBe(false);

      expect(() => t.coordinator.beginInspection())
        .toThrow('Signer inspection is already in progress.');

      await expect(inspection.recover(options))
        .rejects.toThrow('Signer inspection is being abandoned.');

      expect(() => inspection.finish())
        .toThrow('Signer inspection is being abandoned.');
    } finally {
      release();
      await Promise.all([operation, abandonment]);
    }

    // Inclusion completion set its flag after abandonment began.
    // Abandonment must clear it again before releasing ownership.
    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockers: ['recovery-incomplete'],
      recoveryComplete: true,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('abandons a failed write and requires persistence retry before a new inspection', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();
    const failure = new Error('Uncertain journal write.');

    let entered!: () => void;
    let rejectWrite!: (error: Error) => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const held = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });

    t.save.mockImplementationOnce(() => {
      entered();
      return held;
    });

    const operation = inspection.recover(options);

    // Attach the rejection assertion before releasing the failed write.
    const rejected = expect(operation).rejects.toThrow(
      'Journal persistence did not complete.',
    );

    await started;
    rejectWrite(failure);
    await rejected;

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'failed',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    expect(() => inspection.finish())
      .toThrow('Signer inspection has pending persistence.');

    // Persistence retry is also excluded while inspection ownership remains.
    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('Signer inspection is already in progress.');

    const pendingSnapshot = t.save.mock.calls[0]![0];

    await inspection.abandon();

    expect(t.coordinator.status.persistenceState).toBe('failed');

    expect(() => t.coordinator.beginInspection())
      .toThrow('A pending journal write must be retried first.');

    // The one-shot failure is exhausted; retry uses the fixture's normal save.
    await t.coordinator.retryPersistence();

    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.save.mock.calls[1]![0]).toBe(pendingSnapshot);
    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    await t.coordinator.recover(options);
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('preserves acknowledged resolution when a later inspection operation throws', async () => {
    const t = await setup();
    const options = receiptRecoveryOptions(t);
    const inspection = t.coordinator.beginInspection();

    const result = await inspection.recover(options);

    expect(result.status).toBe('resolution-available');
    expect(t.coordinator.attempts).toEqual([]);
    expect(t.save).toHaveBeenCalledTimes(1);

    const committed = t.save.mock.calls[0]![0];
    const revision = t.coordinator.durableRecoveryRevision;

    expect(committed).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
    });

    const failure = new Error('Latest-head RPC failed.');

    vi.mocked(options.publicClient.getBlock)
      .mockRejectedValueOnce(failure);

    await expect(inspection.checkInclusions({
      publicClient: options.publicClient,
      head: options.anchor,
    })).rejects.toBe(failure);

    await inspection.abandon();

    expect(t.coordinator.attempts).toEqual([]);
    expect(t.coordinator.durableRecoveryRevision).toBe(revision);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.coordinator.status).toMatchObject({
      open: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });

    // Fresh recovery starts from the acknowledged, reduced population.
    const recovered = await t.coordinator.recover(options);

    expect(recovered.status).toBe('no-attempt');

    await checkEmptyInclusions(t.coordinator, 5);

    expect(t.coordinator.status.open).toBe(true);
    expect(t.coordinator.attempts).toEqual([]);
    expect(t.save.mock.calls.at(-1)![0]).toMatchObject({
      attempts: [],
      nextNonce: 5n,
      durableNextNonce: 5n,
    });
  });

  it('abandons before a deferred operation starts without performing work', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();

    const operation = inspection.recover(options);
    const rejected = expect(operation).rejects.toThrow(
      'Signer inspection is being abandoned.',
    );

    // No await: abandonment races the operation's deferred start.
    const abandonment = inspection.abandon();

    await Promise.all([rejected, abandonment]);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    // Abandonment released ownership.
    await t.coordinator.recover(options);
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('waits for a rejecting operation before releasing abandoned ownership', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();
    const failure = new Error('Held RPC failed.');

    let entered!: () => void;
    let rejectRead!: (error: Error) => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const held = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });

    vi.mocked(options.publicClient.getBlock)
      .mockImplementationOnce(() => {
        entered();
        return held;
      });

    const operation = inspection.recover(options);
    const rejected = expect(operation).rejects.toBe(failure);

    await started;

    let abandoned = false;

    const abandonment = inspection.abandon().then(() => {
      abandoned = true;
    });

    try {
      await Promise.resolve();

      expect(abandoned).toBe(false);
      expect(t.coordinator.status.open).toBe(false);
      expect(t.coordinator.canBroadcast).toBe(false);

      expect(() => t.coordinator.beginInspection())
        .toThrow('Signer inspection is already in progress.');

      await expect(inspection.recover(options))
        .rejects.toThrow('Signer inspection is being abandoned.');
    } finally {
      rejectRead(failure);
      await Promise.all([rejected, abandonment]);
    }

    expect(abandoned).toBe(true);
    expect(t.save).not.toHaveBeenCalled();
    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    await t.coordinator.recover(options);
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
  });

  it('captures recovery inputs before the deferred operation starts', async () => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const originalClient = options.publicClient;
    const originalAnchor = { ...options.anchor };
    const replacementClient = receiptRecoveryOptions(t, 8).publicClient;
    const inspection = t.coordinator.beginInspection();

    const operation = inspection.recover(options);

    // Mutate both the nested anchor and the outer options before any await.
    Object.assign(options.anchor, {
      blockNumber: 999n,
      blockHash: OTHER,
    });
    options.publicClient = replacementClient;
    options.maxBlockRange = 0n;

    try {
      expect(await operation).toMatchObject({
        status: 'no-attempt',
        observation: {
          anchor: originalAnchor,
          nonce: 4n,
        },
      });

      expect(originalClient.getBlock).toHaveBeenCalled();
      expect(originalClient.getTransactionCount).toHaveBeenCalled();

      for (const [request] of vi.mocked(originalClient.getBlock).mock.calls) {
        expect(request).toMatchObject({
          blockNumber: originalAnchor.blockNumber,
        });
      }

      expect(replacementClient.getBlock).not.toHaveBeenCalled();
      expect(replacementClient.getTransactionCount).not.toHaveBeenCalled();
      expect(replacementClient.getTransactionReceipt).not.toHaveBeenCalled();

      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.save.mock.calls[0]![0].lastObservation).toEqual({
        anchor: originalAnchor,
        nonce: 4n,
      });
    } catch (error) {
      await inspection.abandon();
      throw error;
    }

    inspection.finish();
  });

  it('captures inclusion inputs before the deferred operation starts', async () => {
    const t = await setup({ empty: true });
    const recovery = receiptRecoveryOptions(t, 4);

    await t.coordinator.recover(recovery);
    t.save.mockClear();

    const options = {
      publicClient: recovery.publicClient,
      head: { ...recovery.anchor },
      maxReplacementBlockRange: 2n,
    };

    const originalClient = options.publicClient;
    const originalHead = { ...options.head };
    const replacementClient = receiptRecoveryOptions(t, 8).publicClient;

    vi.mocked(originalClient.getBlock).mockClear();
    vi.mocked(originalClient.getTransactionCount).mockClear();

    const inspection = t.coordinator.beginInspection();
    const operation = inspection.checkInclusions(options);

    Object.assign(options.head, {
      blockNumber: 999n,
      blockHash: OTHER,
    });
    options.publicClient = replacementClient;
    options.maxReplacementBlockRange = 0n;

    try {
      expect(await operation).toMatchObject({
        status: 'inspected',
        inclusionChecksComplete: true,
        observation: {
          anchor: originalHead,
          nonce: 4n,
        },
      });

      expect(originalClient.getBlock).toHaveBeenCalled();
      expect(originalClient.getTransactionCount).toHaveBeenCalled();

      for (const [request] of vi.mocked(originalClient.getBlock).mock.calls) {
        expect(request).toMatchObject({
          blockNumber: originalHead.blockNumber,
        });
      }

      expect(replacementClient.getBlock).not.toHaveBeenCalled();
      expect(replacementClient.getTransactionCount).not.toHaveBeenCalled();
      expect(replacementClient.getTransactionReceipt).not.toHaveBeenCalled();

      expect(t.save).toHaveBeenCalledTimes(1);
      expect(t.save.mock.calls[0]![0].lastObservation).toEqual({
        anchor: originalHead,
        nonce: 4n,
      });

      expect(t.coordinator.status).toMatchObject({
        open: false,
        blockers: [],
        inclusionChecksComplete: true,
      });
    } catch (error) {
      await inspection.abandon();
      throw error;
    }

    inspection.finish();

    expect(t.coordinator.status.open).toBe(true);
  });

  it.each([
    22,
    undefined,
  ])('attributes inspection release to the last supplied cycle: %s', async (
    lastCycle,
  ) => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);

    t.lines.length = 0;

    const inspection = t.coordinator.beginInspection();

    await inspection.recover(options, 11);

    await inspection.checkInclusions({
      publicClient: options.publicClient,
      head: options.anchor,
    }, lastCycle);

    // Successful operations do not release the enclosing inspection.
    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockers: [],
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    expect(t.records().filter((record) =>
      record.event === 'signer_gate_released',
    )).toEqual([]);

    inspection.finish();

    expect(t.coordinator.status.open).toBe(true);

    const releases = t.records().filter((record) =>
      record.event === 'signer_gate_released',
    );

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      operation: { name: 'reconcile-attempt' },
    });

    if (lastCycle === undefined) {
      expect(releases[0]).not.toHaveProperty('cycle');
    } else {
      expect(releases[0].cycle).toBe(lastCycle);
    }
  });

  it.each([
    22,
    undefined,
  ])('attributes abandonment to queued work before execution: %s', async (
    queuedCycle,
  ) => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const inspection = t.coordinator.beginInspection();

    await inspection.recover(options, 11);

    await inspection.checkInclusions({
      publicClient: options.publicClient,
      head: options.anchor,
    }, 11);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockers: [],
      recoveryComplete: true,
      inclusionChecksComplete: true,
    });

    t.lines.length = 0;
    t.save.mockClear();

    vi.mocked(options.publicClient.getBlock).mockClear();
    vi.mocked(options.publicClient.getTransactionCount).mockClear();
    vi.mocked(options.publicClient.getTransactionReceipt).mockClear();

    const operation = inspection.recover(options, queuedCycle);
    const rejected = expect(operation).rejects.toThrow(
      'Signer inspection is being abandoned.',
    );

    // Do not await: abandonment must precede the deferred operation body.
    const abandonment = inspection.abandon();

    await Promise.all([rejected, abandonment]);

    expect(options.publicClient.getBlock).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(options.publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      persistenceState: 'idle',
    });
    expect(t.coordinator.canBroadcast).toBe(false);

    const blocked = t.records().filter((record) =>
      record.event === 'signer_blocked',
    );

    expect(blocked).toHaveLength(1);

    const blockedSince = t.coordinator.status.blockedSince;

    expect(blockedSince).not.toBeNull();
    expect(blocked[0].blockedSince).toBe(blockedSince);

    expect(blocked[0]).toMatchObject({
      reason: 'recovery-incomplete',
      blockers: ['recovery-incomplete'],
      operation: { name: 'reconcile-attempt' },
    });

    if (queuedCycle === undefined) {
      expect(blocked[0]).not.toHaveProperty('cycle');
    } else {
      expect(blocked[0].cycle).toBe(queuedCycle);
    }

    expect(t.records().filter((record) =>
      record.event === 'signer_gate_released',
    )).toEqual([]);
  });

  it.each([
    33,
    undefined,
  ])('defers inspection release to the enclosing reconciliation cycle: %s', async (
    observationCycle,
  ) => {
    const t = await setup({ empty: true });
    const options = receiptRecoveryOptions(t, 4);
    const blockedSince = t.coordinator.status.blockedSince;

    expect(blockedSince).not.toBeNull();

    t.lines.length = 0;

    await t.coordinator.observeReconciliation(async () => {
      const inspection = t.coordinator.beginInspection();

      await inspection.recover(options, 11);

      await inspection.checkInclusions({
        publicClient: options.publicClient,
        head: options.anchor,
      }, 22);

      // Ownership still prevents admission after both operations finish.
      expect(t.coordinator.status).toMatchObject({
        open: false,
        blockers: [],
        recoveryComplete: true,
        inclusionChecksComplete: true,
      });
      expect(t.records()).toEqual([]);

      inspection.finish();

      // Observation batches diagnostics; it does not retain ownership.
      // The gate is open, but its release has not been published.
      expect(t.coordinator.status).toMatchObject({
        open: true,
        blockers: [],
        blockedSince,
      });
      expect(t.records()).toEqual([]);
    }, observationCycle);

    expect(t.coordinator.status).toMatchObject({
      open: true,
      blockers: [],
      blockedSince: null,
    });

    const records = t.records();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'signer_gate_released',
      operation: { name: 'reconcile-attempt' },
      blockedSince,
    });

    if (observationCycle === undefined) {
      expect(records[0]).not.toHaveProperty('cycle');
    } else {
      expect(records[0].cycle).toBe(observationCycle);
    }
  });
});

describe('submission recording capture', () => {
  const workId = 'test-work:submission-recording';

  function preparationOptions() {
    return {
      account: ACCOUNT,
      workId,
      transaction: {
        type: 'eip1559' as const,
        to: ACCOUNT.address,
        data: '0x1234' as const,
        value: 0n,
        gas: 100_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      },
    };
  }

  async function ready() {
    const t = await setup({ empty: true });

    await t.coordinator.recover(receiptRecoveryOptions(t, 4));
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);
    t.save.mockClear();

    return t;
  }

  it('reports none when the work has no recorded attempt', async () => {
    const t = await ready();

    const recording =
      t.coordinator.captureSubmissionRecording(workId);

    expect(recording).toEqual({ status: 'none' });
    expect(Object.isFrozen(recording)).toBe(true);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('captures uncertain preparation from the failed pending snapshot', async () => {
    const t = await ready();

    let visibleSnapshot = t.snapshot;
    const visible = () => visibleSnapshot;

    t.save.mockImplementationOnce(async (snapshot) => {
      visibleSnapshot = snapshot;
      throw new Error('Injected failure after replacement.');
    });

    await expect(
      t.coordinator.prepareAttempt(preparationOptions()),
    ).rejects.toThrow('Journal persistence did not complete.');

    const visibleAttempt = visible().attempts[0]!;

    const recording =
      t.coordinator.captureSubmissionRecording(workId);

    expect(recording).toEqual({
      status: 'uncertain',
      attempt: {
        workId: visibleAttempt.workId,
        attemptId: visibleAttempt.attemptId,
      },
    });

    if (recording.status !== 'uncertain') {
      throw new Error('Expected uncertain preparation recording.');
    }

    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.attempt)).toBe(true);

    expect(t.coordinator.attempts).toEqual([]);
    expect(t.coordinator.status.persistenceState).toBe('failed');

    expect(
      t.coordinator.captureSubmissionRecording('unrelated-work'),
    ).toEqual({ status: 'none' });

    await t.coordinator.retryPersistence();

    expect(t.save).toHaveBeenCalledTimes(2);
    expect(t.save.mock.calls[1]![0]).toBe(t.save.mock.calls[0]![0]);

    expect(t.coordinator.captureSubmissionRecording(workId))
      .toEqual({
        status: 'retained',
        attempt: recording.attempt,
      });

    // Retry changes current state, not the failure-time capture.
    expect(recording.status).toBe('uncertain');
    expect(recording.attempt).toEqual({
      workId: visibleAttempt.workId,
      attemptId: visibleAttempt.attemptId,
    });
  });

  it('reports retained when the broadcast-marker write fails', async () => {
    const t = await ready();

    const prepared = await t.coordinator.prepareAttempt(
      preparationOptions(),
    );

    if (prepared.status !== 'prepared') {
      throw new Error('Expected a newly prepared attempt.');
    }

    const acknowledged = t.coordinator.attempts[0]!;

    const beforeMarker =
      t.coordinator.captureSubmissionRecording(workId);

    expect(beforeMarker).toEqual({
      status: 'retained',
      attempt: {
        workId: acknowledged.workId,
        attemptId: acknowledged.attemptId,
      },
    });

    t.save.mockClear();

    let visibleSnapshot = t.snapshot;
    const visible = () => visibleSnapshot;

    t.save.mockImplementationOnce(async (snapshot) => {
      visibleSnapshot = snapshot;
      throw new Error('Injected marker failure after replacement.');
    });

    const request = vi.fn();

    await expect(t.coordinator.broadcastAttempt({
      publicClient: { request } as unknown as PublicClient,
      attemptId: prepared.attemptId,
    })).rejects.toThrow('Journal persistence did not complete.');

    expect(request).not.toHaveBeenCalled();

    expect(visible().attempts[0]).toMatchObject({
      attemptId: prepared.attemptId,
      phase: 'broadcast-may-have-occurred',
    });

    expect(t.coordinator.attempts[0]).toMatchObject({
      attemptId: prepared.attemptId,
      phase: 'signed',
    });

    expect(t.coordinator.status.persistenceState).toBe('failed');

    const recording =
      t.coordinator.captureSubmissionRecording(workId);

    expect(recording).toEqual(beforeMarker);

    if (recording.status !== 'retained') {
      throw new Error('Expected acknowledged preparation recording.');
    }

    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.attempt)).toBe(true);

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[1]![0]).toBe(t.save.mock.calls[0]![0]);

    expect(t.coordinator.attempts[0]).toMatchObject({
      attemptId: prepared.attemptId,
      phase: 'broadcast-may-have-occurred',
    });

    expect(recording).toEqual(beforeMarker);
    expect(request).not.toHaveBeenCalled();
  });
});