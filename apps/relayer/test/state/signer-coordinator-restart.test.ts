import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  BroadcastRetrySchedule,
} from '../../src/state/broadcast-retry-schedule.js';

import {
  DurableRecoverySchedule,
} from '../../src/state/durable-recovery-schedule.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  SignerRecoveryCycle,
} from '../../src/state/signer-recovery-cycle.js';

import {
  SignerRestartRequiredError,
} from '../../src/state/signer-restart-required-error.js';

import type {
  TransactionJournalRead,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import * as completion from '../../src/state/write-completion.js';
import * as revision from '../../src/state/durable-recovery-revision.js';

import {
  ACCOUNT,
  ATTEMPT_ID,
  DURABLE,
  IDENTITY,
  client,
  fixture,
} from '../helpers/operator-attribution-fixture.js';

async function setup() {
  const initial = await fixture();

  let current: TransactionJournalRead = {
    kind: 'present',
    snapshot: {
      ...initial,
      lastObservation: initial.baseline,
      nextNonce: 4n,
      attempts: [],
    },
  };

  const save = vi.fn<TransactionJournalStore['save']>(async (snapshot) => {
    current = { kind: 'present', snapshot };
  });

  const load = vi.fn(async () => current);

  const createErrorSummary = (secrets: readonly string[] = []) => ({
    scrubText: createScrubber({ rpcUrls: [], secrets }),
  });

  const create = () => SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    maxRetainedAttempts: 3,
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: { write() {} },
    }),
    createErrorSummary,
  });

  const coordinator = await create();

  const rpc = client(200n);

  rpc.getTransactionCount.mockResolvedValue(4);

  const options = {
    publicClient: rpc.publicClient,
    anchor: DURABLE,
    maxBlockRange: 2n,
  };

  const inclusion = { publicClient: rpc.publicClient, head: DURABLE };

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const prepare = {
    account: { ...ACCOUNT, signTransaction },
    transaction: {
      type: 'eip1559' as const,
      to: ACCOUNT.address,
      data: '0x' as const,
      value: 0n,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    },
    workId: 'restart:test',
  };

  const workCounts = () => [
    save.mock.calls.length,
    load.mock.calls.length,
    signTransaction.mock.calls.length,
    rpc.getBlock.mock.calls.length,
    rpc.getTransactionCount.mock.calls.length,
    rpc.getTransactionReceipt.mock.calls.length,
    rpc.getTransaction.mock.calls.length,
    rpc.sendRawTransaction.mock.calls.length,
  ];

  return {
    coordinator,
    create,
    save,
    options,
    inclusion,
    prepare,
    workCounts,
  };
}

function failCompletion() {
  return vi.spyOn(completion, 'describeWriteCompletion')
    .mockImplementationOnce(() => {
      throw new Error('Injected completion failure');
    });
}

afterEach(() => vi.restoreAllMocks());

describe('coordinator restart requirement', () => {
  it(
    'refuses every fresh action without more work after acknowledgement',
    async () => {
      const t = await setup();

      await t.coordinator.recover(t.options);

      failCompletion();

      await expect(t.coordinator.checkInclusions(t.inclusion))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);

      const counts = t.workCounts();

      expect(() => t.coordinator.beginInspection())
        .toThrow(SignerRestartRequiredError);
      await expect(t.coordinator.recover(t.options))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
      await expect(t.coordinator.checkInclusions(t.inclusion))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
      await expect(t.coordinator.prepareAttempt(t.prepare))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
      await expect(t.coordinator.broadcastAttempt({
        publicClient: t.options.publicClient,
        attemptId: ATTEMPT_ID,
      })).rejects.toBeInstanceOf(SignerRestartRequiredError);
      await expect(t.coordinator.retryPersistence())
        .rejects.toBeInstanceOf(SignerRestartRequiredError);

      expect(t.workCounts()).toEqual(counts);
      expect(t.coordinator.status).toMatchObject({
        open: false,
        persistenceState: 'idle',
        recoveryComplete: false,
        inclusionChecksComplete: false,
      });
      expect(t.coordinator.canBroadcast).toBe(false);
    },
  );

  it(
    'preserves ownership precedence and permits abandonment without repair',
    async () => {
      const t = await setup();

      await t.coordinator.recover(t.options);

      const owner = t.coordinator.beginInspection();

      failCompletion();

      await expect(owner.checkInclusions(t.inclusion))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
      expect(() => owner.finish())
        .toThrow('Signer inspection has pending persistence.');
      expect(() => t.coordinator.beginInspection())
        .toThrow('Signer inspection is already in progress.');
      await expect(t.coordinator.retryPersistence())
        .rejects.toThrow('Signer inspection is already in progress.');
      await expect(owner.recover(t.options))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);

      await owner.abandon();

      expect(() => t.coordinator.beginInspection())
        .toThrow(SignerRestartRequiredError);
      expect(t.coordinator.status.open).toBe(false);
    },
  );

  it(
    'reloads committed state into a new instance without replaying completion',
    async () => {
      const t = await setup();

      await t.coordinator.recover(t.options);

      failCompletion();

      await expect(t.coordinator.checkInclusions(t.inclusion))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);

      const saves = t.save.mock.calls.length;

      const describe = vi.mocked(completion.describeWriteCompletion);

      describe.mockClear();

      const fresh = await t.create();

      expect(t.save).toHaveBeenCalledTimes(saves);
      expect(describe).not.toHaveBeenCalled();
      expect(fresh.status.open).toBe(false);

      await fresh.recover(t.options);
      await fresh.checkInclusions(t.inclusion);

      expect(fresh.status.open).toBe(true);
      await expect(t.coordinator.recover(t.options))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
    },
  );

  it(
    'does not reuse a completed durable pass after inclusion completion fails',
    async () => {
      const t = await setup();

      const cycle = new SignerRecoveryCycle({
        coordinator: t.coordinator,
        schedule: new BroadcastRetrySchedule({
          initialDelayMs: 1_000,
          maxDelayMs: 10_000,
          now: () => 0,
        }),
        durableSchedule: new DurableRecoverySchedule({
          refreshIntervalMs: 10_000,
          now: () => 0,
        }),
      });

      const options = { ...t.options, head: DURABLE };

      const first = await cycle.run(options);

      expect(first.inspection.status).not.toBe('skipped');

      const reused = await cycle.run(options);

      expect(reused.inspection).toEqual({
        status: 'skipped',
        reason: 'unchanged-durable-state',
      });

      const token = t.coordinator.durableRecoveryRevision;

      failCompletion();

      await expect(t.coordinator.checkInclusions(t.inclusion))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);

      const counts = t.workCounts();

      await expect(cycle.run(options))
        .rejects.toBeInstanceOf(SignerRestartRequiredError);
      expect(t.workCounts()).toEqual(counts);
      expect(t.coordinator.durableRecoveryRevision).toBe(token);
    },
  );

  it(
    'preserves the original error after completion clears pending metadata',
    async () => {
      const t = await setup();

      await t.coordinator.recover(t.options);

      const error = new Error('Injected revision failure');

      vi.spyOn(revision, 'durableRecoveryRevision')
        .mockImplementationOnce(() => {
          throw error;
        });

      await expect(t.coordinator.checkInclusions(t.inclusion))
        .rejects.toBe(error);
      await expect(t.coordinator.retryPersistence()).rejects.toThrow(
        'No failed journal write is available to retry.',
      );

      await t.coordinator.recover(t.options);
      await t.coordinator.checkInclusions(t.inclusion);

      expect(t.coordinator.status.open).toBe(true);
    },
  );
});
