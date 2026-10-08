import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  keccak256,
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
    t.coordinator.completeRecovery(1);
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

    const pending = t.coordinator.resolveAttempt(t.evidence, 2);

    try {
      await started;

      expect(t.records()).toEqual([]);
      expect(t.coordinator.status.open).toBe(false);

      await expect(t.coordinator.resolveAttempt(t.evidence))
        .rejects.toThrow('already in progress');
    } finally {
      finish();
      await pending;
    }

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
    t.coordinator.completeRecovery();
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

    await expect(t.coordinator.resolveAttempt(t.evidence))
      .rejects.toThrow();

    expect(visible).toMatchObject({
      snapshot: {
        attempts: [],
        nextNonce: 5n,
        durableNextNonce: 5n,
      },
    });

    t.evidence.anchor.blockNumber = 999n;

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
      recoveryComplete: true,
      inclusionChecksComplete: false,
    });

    expect(t.save.mock.calls[2]![0]).toBe(t.save.mock.calls[0]![0]);
    expect(t.load).toHaveBeenCalledTimes(1);

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('No failed journal');

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
    const t = await setup();
    t.coordinator.completeRecovery();
    t.coordinator.block('unattributed-signer-activity');
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence);

    expect(t.records().map((record) => record.event))
      .toEqual(['attempt_resolved']);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockedSince: CREATED,
      primaryReason: 'unattributed-signer-activity',
    });

    t.coordinator.completeRecovery();
    expect(t.coordinator.status.open).toBe(false);
  });

  it('defers release until recovery and inclusion checks complete and preserves the episode', async () => {
    const t = await setup();
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_blocked',
    ]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
    });

    t.coordinator.completeRecovery(7);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      blockedSince: CREATED,
    });

    expect(t.records()).toHaveLength(2);

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

    t.coordinator.completeRecovery();
    expect(t.records()).toHaveLength(3);
  });

  it('preserves blockedSince and emits only primary-reason changes', async () => {
    const t = await setup();

    const observation = {
      anchor: t.evidence.anchor,
      nonce: 5n,
    };

    await t.coordinator.recordObservation(observation);
    t.lines.length = 0;

    t.coordinator.block('conflict-search-exhausted');
    t.coordinator.block('conflict-search-exhausted');

    const progress = {
      attemptId: t.attempt.attemptId,
      observation,
      result: {
        status: 'not-found' as const,
        searchedThrough: {
          blockNumber: 105n,
          blockHash: OTHER,
        },
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    };

    await t.coordinator.recordSearchProgress(progress);

    await t.coordinator.recordSearchProgress({
      ...progress,
      result: {
        ...progress.result,
        scannedBlocks: 0n,
      },
    });

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
    'rejects mismatched %s evidence before persistence',
    async (outcome) => {
      const t = await setup();
      t.lines.length = 0;

      await expect(t.coordinator.resolveAttempt({
        ...t.evidence,
        outcome,
        transactionHash: OTHER,
      })).rejects.toThrow('Invalid attempt resolution');

      expect(t.save).not.toHaveBeenCalled();
      expect(t.records()).toEqual([]);
    },
  );

  it.each(['reverted', 'replaced'] as const)(
    'accepts %s evidence without treating it as application completion',
    async (outcome) => {
      const t = await setup();
      t.coordinator.completeRecovery();
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

      await t.coordinator.resolveAttempt(evidence);

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
    t.coordinator.completeRecovery();

    await t.coordinator.resolveAttempt({
      outcome: 'replaced',
      anchor: t.evidence.anchor,
      inclusion: t.evidence.inclusion,
      replacementTransactionHash: OTHER,
      nonceAtAnchor: 8n,
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(
      t.records().some((record) => record.event === 'signer_gate_released'),
    ).toBe(false);
  });

  it('contains logger failures using the attempt policy through release', async () => {
    const t = await setup({ brokenLog: true });
    t.coordinator.completeRecovery();
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence, 9);

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

    t.coordinator.completeRecovery();

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

    t.coordinator.completeRecovery();
    expect(t.records()).toHaveLength(2);
  });

  it('latches already recorded unattributed activity during recovery', async () => {
    const t = await setup({ empty: true, extraNonce: true });

    t.coordinator.completeRecovery();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('clears the attempt search blocker after durable resolution', async () => {
    const t = await setup();

    t.coordinator.completeRecovery();
    t.coordinator.block('conflict-search-exhausted');
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence, 2);

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

  it('does not initialize missing journals or complete their recovery', async () => {
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

    expect(() => coordinator.completeRecovery())
      .toThrow('initialized journal');

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

    await t.coordinator.recordObservation(observation(4n), 2);

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

    await t.coordinator.recordObservation(observation(5n));

    expect(
      t.save.mock.calls[0]![0].attempts[0]?.replacementSearch
    ).toEqual({
      lowerBound: t.snapshot.lastObservation,
      searchedThrough: null,
    });
  });

  it('keeps an established lower bound across later observations', async () => {
    const t = await setup();

    await t.coordinator.recordObservation(observation(4n));
    await t.coordinator.recordObservation(observation(5n, 120n));

    expect(
      t.save.mock.calls[1]![0].attempts[0]?.replacementSearch,
    ).toEqual({
      lowerBound: observation(4n),
      searchedThrough: null,
    });
  });

  it('closes an otherwise open gate while saving and rejects overlapping operations', async () => {
    const t = await setup({ empty: true });
    t.coordinator.completeRecovery();
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

    const pending = t.coordinator.recordObservation(
      observation(4n),
    );

    try {
      await started;

      expect(t.coordinator.status.open).toBe(false);

      await expect(
        t.coordinator.recordObservation(observation(4n)),
      ).rejects.toThrow('already in progress');

      await expect(
        t.coordinator.retryPersistence(),
      ).rejects.toThrow('already in progress');
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
    t.coordinator.completeRecovery();
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    let visible = t.snapshot;

    t.save.mockImplementationOnce(async (snapshot) => {
      visible = snapshot;
      throw new Error('Durability uncertain');
    });

    const input = observation(8n);

    await expect(
      t.coordinator.recordObservation(input),
    ).rejects.toThrow('Journal persistence');

    expect(visible.lastObservation.nonce).toBe(8n);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'persistence-failure',
    });

    input.nonce = 4n;

    await expect(
      t.coordinator.recordObservation(input),
    ).rejects.toThrow('must be retried');

    await expect(
      t.coordinator.resolveAttempt(t.evidence),
    ).rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('Retry failed'));

    await expect(
      t.coordinator.retryPersistence(),
    ).rejects.toThrow('Journal persistence');

    await t.coordinator.retryPersistence(3);

    expect(t.save.mock.calls[2]![0])
      .toBe(t.save.mock.calls[0]![0]);

    expect(t.load).toHaveBeenCalledTimes(1);

    expect(t.coordinator.status).toMatchObject({
      open: false,
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

    restarted.completeRecovery();

    expect(restarted.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    await expect(
      restarted.recordObservation(observation(4n)),
    ).rejects.toThrow('Cannot overwrite');

    expect(t.save).toHaveBeenCalledTimes(3);
  });

  it('retries an ordinary observation without emitting an attempt resolution', async () => {
    const t = await setup({ empty: true });
    t.coordinator.completeRecovery();
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    t.save.mockRejectedValueOnce(new Error('Failed'));

    await expect(
      t.coordinator.recordObservation(observation(4n)),
    ).rejects.toThrow();

    await t.coordinator.retryPersistence();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
      inclusionChecksComplete: false,
      primaryReason: 'recovery-incomplete',
    });

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);

    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().filter(
      (record) => record.event === 'signer_gate_released',
    )).toHaveLength(1);

    expect(t.records().some(
      (record) => record.event === 'attempt_resolved',
    )).toBe(false);
  });

  it('does not complete startup recovery merely by saving an observation', async () => {
    const t = await setup({ empty: true });

    await t.coordinator.recordObservation(observation(4n));

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });
  });

  it('requires fresh recovery when the observed nonce is behind the journal', async () => {
    const t = await setup({ empty: true });
    t.coordinator.completeRecovery();
    await checkEmptyInclusions(t.coordinator, 4);

    expect(t.coordinator.status.open).toBe(true);

    t.save.mockClear();
    t.lines.length = 0;

    await expect(
      t.coordinator.recordObservation(observation(3n)),
    ).rejects.toThrow('Observed nonce is behind the journal. Recovery is required.');

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: false,
    });

    expect(t.save).not.toHaveBeenCalled();

    await t.coordinator.recordObservation(observation(4n));

    expect(t.coordinator.status.open).toBe(false);
  });

  it('rejects invalid observation fields before saving without invoking accessors', async () => {
    const t = await setup();
    const input = observation(4n);
    const getter = vi.fn(() => 4n);

    Object.defineProperty(input, 'nonce', {
      get: getter,
    });

    await expect(
      t.coordinator.recordObservation(input),
    ).rejects.toThrow('Invalid transaction journal snapshot');

    expect(getter).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
    expect(t.coordinator.status.persistenceState).toBe('idle');
  });

  it('persists excess nonce evidence with a replacement clear for restart recovery', async () => {
    const t = await setup();

    await t.coordinator.resolveAttempt({
      outcome: 'replaced',
      anchor: t.evidence.anchor,
      inclusion: t.evidence.inclusion,
      replacementTransactionHash: OTHER,
      nonceAtAnchor: 8n,
    });

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

    restarted.completeRecovery();

    expect(restarted.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('does not erase an existing higher nonce observation during replacement clear', async () => {
    const t = await setup({ extraNonce: true });

    await t.coordinator.resolveAttempt({
      outcome: 'replaced',
      anchor: t.evidence.anchor,
      inclusion: t.evidence.inclusion,
      replacementTransactionHash: OTHER,
      nonceAtAnchor: 5n,
    });

    expect(t.save.mock.calls[0]![0].lastObservation)
      .toEqual(t.snapshot.lastObservation);

    expect(t.coordinator.status.open).toBe(false);
  });

  it('does not initialize a missing journal from an ordinary observation', async () => {
    const save = vi.fn<TransactionJournalStore['save']>();

    const coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 3,
      store: {
        load: async () => ({
          kind: 'missing',
        }),
        save,
      },
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
      }),
      createErrorSummary: () => ({
        scrubText: createScrubber({
          privateKey: KEY,
          rpcUrls: [],
        }),
      }),
    });

    await expect(
      coordinator.recordObservation(observation(4n)),
    ).rejects.toThrow('initialized journal');

    expect(save).not.toHaveBeenCalled();
    expect(coordinator.status.open).toBe(false);
  });
});

describe('durable replacement search progress', () => {
  async function prepare() {
    const t = await setup();

    const observation = {
      anchor: t.evidence.anchor,
      nonce: 5n,
    };

    await t.coordinator.recordObservation(observation);

    t.save.mockClear();
    t.lines.length = 0;

    const progress = {
      attemptId: t.attempt.attemptId,
      observation,
      result: {
        status: 'not-found' as const,
        searchedThrough: {
          blockNumber: 105n,
          blockHash: OTHER,
        },
        scannedBlocks: 5n,
        remainingBlocks: 5n,
      },
    };

    return {
      ...t,
      progress,
    };
  }

  it('persists the boundary before clearing the search blocker', async () => {
    const t = await prepare();

    t.coordinator.block('conflict-search-exhausted');
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

    const pending = t.coordinator.recordSearchProgress(
      t.progress,
      7,
    );

    try {
      await started;

      expect(t.coordinator.status.primaryReason)
        .toBe('conflict-search-exhausted');

      expect(t.records()).toEqual([]);

      await expect(
        t.coordinator.recordSearchProgress(t.progress),
      ).rejects.toThrow('already in progress');
    } finally {
      finish();
      await pending;
    }

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      nextNonce: 5n,
      durableNextNonce: 4n,
      attempts: [{
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: t.snapshot.lastObservation,
          searchedThrough: t.progress.result.searchedThrough,
        },
      }],
    });

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
    ]);

    expect(t.records()[0]).toMatchObject({
      cycle: 7,
      blockedSince: CREATED,
    });
  });

  it('retains the exact failed progress write and its blocker effect through retries', async () => {
    const t = await prepare();
    t.coordinator.block('conflict-search-exhausted');

    let visible = t.snapshot;

    t.save.mockImplementationOnce(async (snapshot) => {
      visible = snapshot;
      throw new Error('uncertain');
    });

    await expect(
      t.coordinator.recordSearchProgress(t.progress),
    ).rejects.toThrow('Journal persistence');

    expect(
      visible.attempts[0]?.replacementSearch?.searchedThrough?.blockNumber,
    ).toBe(105n);

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    Object.assign(t.progress.result, {
      remainingBlocks: 0n,
      scannedBlocks: 10n,
      searchedThrough: t.evidence.anchor,
    });

    await expect(
      t.coordinator.recordSearchProgress(t.progress),
    ).rejects.toThrow('must be retried');

    t.save.mockRejectedValueOnce(new Error('again'));

    await expect(
      t.coordinator.retryPersistence(),
    ).rejects.toThrow();

    await t.coordinator.retryPersistence();

    expect(t.save.mock.calls[2]![0])
      .toBe(t.save.mock.calls[0]![0]);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unresolved-attempt',
    });

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it('reconstructs an exhausted search after restart and keeps zero progress inert', async () => {
    const t = await prepare();

    const exhausted = {
      ...t.progress,
      result: {
        ...t.progress.result,
        searchedThrough: t.evidence.anchor,
        scannedBlocks: 10n,
        remainingBlocks: 0n,
      },
    };

    await t.coordinator.recordSearchProgress(exhausted);

    expect(t.coordinator.status.primaryReason)
      .toBe('conflict-search-exhausted');

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

    restarted.completeRecovery();

    await restarted.recordSearchProgress({
      ...exhausted,
      result: {
        ...exhausted.result,
        scannedBlocks: 0n,
      },
    });

    expect(restarted.status).toMatchObject({
      open: false,
      primaryReason: 'conflict-search-exhausted',
    });

    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it('resumes from the persisted boundary after restart', async () => {
    const t = await prepare();

    await t.coordinator.recordSearchProgress(t.progress);

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

    await expect(
      restarted.recordSearchProgress(t.progress),
    ).rejects.toThrow('Invalid replacement search progress');

    await restarted.recordSearchProgress({
      ...t.progress,
      result: {
        ...t.progress.result,
        searchedThrough: {
          blockNumber: 106n,
          blockHash: OTHER,
        },
        scannedBlocks: 1n,
        remainingBlocks: 4n,
      },
    });

    expect(
      t.save.mock.calls[1]![0]
        .attempts[0]?.replacementSearch?.searchedThrough?.blockNumber,
    ).toBe(106n);
  });

  it.each([
    'attempt',
    'anchor',
    'nonce',
    'scanned',
    'remaining',
    'beyond-anchor',
    'anchor-hash',
    'backward',
  ])(
    'rejects inconsistent %s progress before persistence',
    async (kind) => {
      const t = await prepare();

      switch (kind) {
        case 'attempt':
          t.progress.attemptId =
            '22222222-2222-4222-8222-222222222222';
          break;

        case 'anchor':
          Object.assign(t.progress.observation.anchor, {
            blockHash: OTHER,
          });
          break;

        case 'nonce':
          t.progress.observation.nonce = 6n;
          break;

        case 'scanned':
          t.progress.result.scannedBlocks = 4n;
          break;

        case 'remaining':
          t.progress.result.remainingBlocks = 4n;
          break;

        case 'beyond-anchor':
          t.progress.result.searchedThrough.blockNumber = 111n;
          break;

        case 'anchor-hash':
          Object.assign(t.progress.result, {
            searchedThrough: {
              blockNumber: 110n,
              blockHash: OTHER,
            },
            scannedBlocks: 10n,
            remainingBlocks: 0n,
          });
          break;

        case 'backward':
          t.progress.result.searchedThrough.blockNumber = 99n;
          break;
      }

      await expect(
        t.coordinator.recordSearchProgress(t.progress),
      ).rejects.toThrow(TypeError);

      expect(t.save).not.toHaveBeenCalled();
      expect(t.coordinator.status.persistenceState).toBe('idle');
    },
  );

  it('rejects a changed hash at an unchanged search boundary', async () => {
    const t = await prepare();

    await t.coordinator.recordSearchProgress(t.progress);

    await expect(t.coordinator.recordSearchProgress({
      ...t.progress,
      result: {
        ...t.progress.result,
        searchedThrough: {
          blockNumber: 105n,
          blockHash: HASH,
        },
        scannedBlocks: 0n,
      },
    })).rejects.toThrow('Invalid replacement search progress');

    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it('keeps unrelated blockers after saving partial progress', async () => {
    const t = await prepare();

    t.coordinator.block('conflict-search-exhausted');
    t.coordinator.block('unattributed-signer-activity');

    await t.coordinator.recordSearchProgress(t.progress);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });

    expect(t.coordinator.status.blockers)
      .not.toContain('conflict-search-exhausted');
  });

  it.each([true, false])(
    'rejects progress without a usable attempt and lower bound: %s',
    async (empty) => {
      const t = await setup({ empty });

      await expect(t.coordinator.recordSearchProgress({
        attemptId: t.attempt.attemptId,
        observation: {
          anchor: t.evidence.anchor,
          nonce: 5n,
        },
        result: {
          status: 'not-found',
          searchedThrough: {
            blockNumber: 105n,
            blockHash: OTHER,
          },
          scannedBlocks: 5n,
          remainingBlocks: 5n,
        },
      })).rejects.toThrow();

      expect(t.save).not.toHaveBeenCalled();
    },
  );

  it('retains the search blocker through a failed clear and removes it after retry', async () => {
    const t = await prepare();

    t.coordinator.completeRecovery();
    t.coordinator.block('conflict-search-exhausted');
    t.lines.length = 0;

    t.save.mockRejectedValueOnce(new Error('Failed clear'));

    await expect(
      t.coordinator.resolveAttempt(t.evidence),
    ).rejects.toThrow();

    expect(t.coordinator.status.blockers)
      .toContain('conflict-search-exhausted');

    expect(t.records().some((record) =>
      record.event === 'attempt_resolved' ||
      record.event === 'signer_gate_released',
    )).toBe(false);

    await t.coordinator.retryPersistence();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      recoveryComplete: true,
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

    expect(t.records().some(
      (record) => record.event === 'signer_gate_released',
    )).toBe(false);
  });
});