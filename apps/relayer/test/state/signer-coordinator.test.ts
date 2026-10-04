import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
    transactionHash: keccak256(bytes),
    signedTransaction: bytes,
    createdAt: CREATED,
    phase: 'broadcast-may-have-occurred' as const,
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
    nextNonce: 4n,
    attempt: options.empty ? null : attempt,
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
    store: { load, save },
    log,
    createErrorSummary: factory,
    now: () => Date.parse('2026-10-04T01:00:00.000Z'),
  });

  const evidence = {
    outcome: 'success' as const,
    transactionHash: attempt.transactionHash,
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
      'signer_gate_released',
    ]);

    for (const record of t.records()) {
      expect(record).toMatchObject({
        cycle: 2,
        attemptId: t.attempt.attemptId,
        signer: ACCOUNT.address,
      });
    }

    expect(t.coordinator.status.open).toBe(true);
    expect(t.coordinator.status.blockedSince).toBeNull();

    expect(t.save.mock.calls[0]![0]).toMatchObject({
      attempt: null,
      nextNonce: 5n,
    });

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
      snapshot: { attempt: null },
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
      'signer_gate_released',
    ]);

    expect(t.records()[1].resolution.anchor.blockNumber).toBe('110');

    expect(t.records()[2].cleared).toEqual([
      'persistence-failure',
      'unresolved-attempt',
    ]);

    expect(t.save.mock.calls[2]![0]).toBe(t.save.mock.calls[0]![0]);
    expect(t.load).toHaveBeenCalledTimes(1);

    await expect(t.coordinator.retryPersistence())
      .rejects.toThrow('No failed journal');
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

  it('defers release until recovery completes and preserves the episode', async () => {
    const t = await setup();
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence);

    expect(t.records().map((record) => record.event))
      .toEqual(['attempt_resolved']);

    expect(t.coordinator.status).toMatchObject({
      open: false,
      blockedSince: CREATED,
    });

    t.coordinator.completeRecovery(7);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_gate_released',
    ]);

    expect(t.records()[1]).toMatchObject({
      attemptId: t.attempt.attemptId,
      cycle: 7,
      blockedSince: CREATED,
    });

    t.coordinator.completeRecovery();
    expect(t.records()).toHaveLength(2);
  });

  it('preserves blockedSince and emits only primary-reason changes', async () => {
    const t = await setup();
    t.lines.length = 0;

    t.coordinator.block('conflict-search-exhausted');
    t.coordinator.block('conflict-search-exhausted');
    t.coordinator.recordSearchProgress();
    t.coordinator.recordSearchProgress();

    expect(t.records().map((record) => record.reason)).toEqual([
      'conflict-search-exhausted',
      'unresolved-attempt',
    ]);

    expect(t.records().every((record) => record.blockedSince === CREATED))
      .toBe(true);

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

    expect(t.coordinator.status.open).toBe(true);

    expect(t.records().map((record) => record.event)).toEqual([
      'logging_failed',
      'logging_failed',
    ]);

    expect(t.records().every((record) => record.cycle === 9)).toBe(true);
    expect(t.lines.join('')).not.toContain(t.bytes);
    expect(t.lines.join('')).not.toContain(KEY);
  });

  it('does not fabricate a release event on clean startup', async () => {
    const t = await setup({ empty: true });

    expect(t.coordinator.status.open).toBe(false);

    t.coordinator.completeRecovery();

    expect(t.coordinator.status.open).toBe(true);
    expect(t.records()).toEqual([]);
  });

  it('latches already recorded unattributed activity during recovery', async () => {
    const t = await setup({ empty: true, extraNonce: true });

    t.coordinator.completeRecovery();

    expect(t.coordinator.status).toMatchObject({
      open: false,
      primaryReason: 'unattributed-signer-activity',
    });
  });

  it('releases after a remaining search blocker clears, using the retained policy', async () => {
    const t = await setup();
    t.coordinator.completeRecovery();
    t.coordinator.block('conflict-search-exhausted');
    t.lines.length = 0;

    await t.coordinator.resolveAttempt(t.evidence, 2);

    expect(t.records().map((record) => record.event))
      .toEqual(['attempt_resolved']);

    t.coordinator.recordSearchProgress(3);

    expect(t.records().map((record) => record.event)).toEqual([
      'attempt_resolved',
      'signer_gate_released',
    ]);

    expect(t.records()[1]).toMatchObject({
      attemptId: t.attempt.attemptId,
      cycle: 3,
      cleared: ['conflict-search-exhausted', 'unresolved-attempt'],
      blockedSince: CREATED,
    });
  });

  it('does not initialize missing journals or complete their recovery', async () => {
    const save = vi.fn<TransactionJournalStore['save']>();

    const load = vi.fn<TransactionJournalStore['load']>()
      .mockResolvedValue({ kind: 'missing' });

    const log = createRelayerLog({ chainId: 4663 });

    const coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
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
      primaryReason: 'unattributed-signer-activity',
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
      nextNonce: 4n,
      lastObservation: observation(4n),
      attempt: {
        attemptId: t.attempt.attemptId,
        replacementSearch: {
          lowerBound: observation(4n),
          searchedThrough: null,
        },
      },
    });

    expect(t.records()).toEqual([]);
    expect(t.coordinator.status.open).toBe(false);
  });

  it('preserves the earlier observation when the nonce has already advanced', async () => {
    const t = await setup();

    await t.coordinator.recordObservation(observation(5n));

    expect(
      t.save.mock.calls[0]![0].attempt?.replacementSearch,
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
      t.save.mock.calls[1]![0].attempt?.replacementSearch,
    ).toEqual({
      lowerBound: observation(4n),
      searchedThrough: null,
    });
  });

  it('closes an otherwise open gate while saving and rejects overlapping operations', async () => {
    const t = await setup({ empty: true });
    t.coordinator.completeRecovery();

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

    expect(t.coordinator.status.open).toBe(true);
    expect(t.records()).toEqual([]);
  });

  it('retries the exact failed observation and preserves unexpected activity across restart', async () => {
    const t = await setup({ empty: true });
    t.coordinator.completeRecovery();

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

    t.save.mockRejectedValueOnce(new Error('Failed'));

    await expect(
      t.coordinator.recordObservation(observation(4n)),
    ).rejects.toThrow();

    await t.coordinator.retryPersistence();

    expect(t.records().map((record) => record.event)).toEqual([
      'signer_blocked',
      'signer_gate_released',
    ]);

    expect(t.coordinator.status.open).toBe(true);
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
      attempt: null,
      nextNonce: 5n,
      lastObservation: observation(8n),
    });

    const restarted = await SignerCoordinator.create({
      identity: IDENTITY,
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