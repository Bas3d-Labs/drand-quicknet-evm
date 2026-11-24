import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  LocalAccount,
  PublicClient,
} from 'viem';

import {
  createRelayerLog,
  type ScopedRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  SignerCoordinator,
  type RecoverSignerOptions,
} from '../../src/state/signer-coordinator.js';

import type {
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from '../../src/state/transaction-journal.js';

import * as verification
  from '../../src/state/transaction-journal-verification.js';
import * as completion from '../../src/state/write-completion.js';

import {
  acceptanceRequest,
} from '../helpers/operator-acceptance-fixture.js';

import {
  ACCOUNT,
  ATTEMPT_ID,
  DURABLE,
  HINT_HASH,
  IDENTITY,
  OTHER_HASH,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

const CREATED = '2026-11-12T00:00:00.000Z';

const ORIGINAL_CYCLE = 71;

const RETRY_CYCLE = 72;

const PERSISTENCE_ERROR = 'Journal persistence did not complete.';

const RESTART_ERROR =
  'Journal persistence was acknowledged, but coordinator completion failed. ' +
  'The committed journal is retained. ' +
  'Restart the relayer to reload it and run recovery; ' +
  'persistence retry is unavailable.';

const KINDS = [
  'bootstrap',
  'prepared',
  'broadcast',
  'observation',
  'search-progress',
  'resolution',
  'operator-acceptance',
  'operator-attribution',
  'search-reset',
  'search-unconsumed-bound-rebase',
  'search-lower-bound-replacement',
] as const;

type Kind = typeof KINDS[number];
type Scenario = Kind | 'inclusion';

const WRITE_SITES = [
  'prepared',
  'broadcast',
  'observation',
  'bootstrap',
  'inclusion',
] as const;

const EVENT_KINDS = [
  'resolution',
  'operator-acceptance',
  'operator-attribution',
  'search-reset',
  'search-unconsumed-bound-rebase',
  'search-lower-bound-replacement',
] as const;

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function transaction() {
  return {
    type: 'eip1559' as const,
    to: ACCOUNT.address,
    data: '0x123456' as const,
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
}

// RPC and journal fixtures drive the real inspectors and planners. Only the
// verification/completion fault tests below replace a production function.
async function setup(kind: Scenario) {
  let snapshot = await fixture();

  const first = snapshot.attempts[0]!;

  const baseRpc = client(200n);

  const broadcastRequest = vi.fn(
    async () => first.signedTransactions[0].transactionHash
  );

  const rpc = {
    ...baseRpc,
    request: broadcastRequest,
    publicClient: {
      ...baseRpc.publicClient,
      request: broadcastRequest,
    } as unknown as PublicClient,
  };

  if (['bootstrap', 'prepared', 'observation', 'inclusion'].includes(kind)) {
    snapshot = {
      ...snapshot,
      lastObservation: snapshot.baseline,
      nextNonce: 4n,
      attempts: [],
    };
  }

  if (['broadcast', 'resolution', 'search-progress'].includes(kind)) {
    snapshot = {
      ...snapshot,
      lastObservation: snapshot.baseline,
      attempts: [{
        ...first,
        phase: 'signed',
        inclusion: null,
        replacementSearch: {
          lowerBound: snapshot.baseline,
          searchedThrough: null,
          exhausted: null,
        },
      }],
    };
  }

  if ([
    'bootstrap',
    'prepared',
    'broadcast',
    'observation',
    'inclusion'
  ].includes(kind)) {
    rpc.getTransactionCount.mockResolvedValue(4);
  }

  if (kind === 'resolution') {
    rpc.getTransactionReceipt.mockResolvedValue({
      transactionHash: first.signedTransactions[0].transactionHash,
      blockNumber: 101n,
      blockHash: anchor(101n).blockHash,
      status: 'success',
    } as never);
  }

  if (kind === 'operator-attribution') {
    const hinted = client();

    rpc.getBlock.mockImplementation(hinted.getBlock.getMockImplementation()!);
    rpc.getTransaction.mockImplementation(
      hinted.getTransaction.getMockImplementation()!
    );
  }

  if (kind === 'search-reset') {
    const read = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      const block = await read(input);

      if (input?.blockNumber === 102n) {
        return { ...block, hash: OTHER_HASH };
      }

      return block;
    });
  }

  if (
    kind === 'search-unconsumed-bound-rebase' ||
    kind === 'search-lower-bound-replacement'
  ) {
    const read = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      const block = await read(input);

      if (input?.blockNumber === 98n || input?.blockNumber === 100n) {
        return { ...block, hash: OTHER_HASH };
      }

      return block;
    });

    rpc.getTransactionCount.mockImplementation(async (input) => {
      if (
        kind === 'search-unconsumed-bound-rebase' ||
        input.blockNumber === 98n
      ) {
        return 4;
      }

      return 5;
    });
  }

  let visible: TransactionJournalRead = { kind: 'present', snapshot };

  if (kind === 'bootstrap') {
    visible = { kind: 'missing' };
  }

  const timeline: string[] = [];

  const lines: string[] = [];

  let diagnosticProbe: string | undefined;

  const save = vi.fn<TransactionJournalStore['save']>(async (next) => {
    timeline.push('save');
    visible = { kind: 'present', snapshot: next };
    timeline.push('ack');
  });

  const load = vi.fn(async () => visible);

  const createErrorSummary = (secrets: readonly string[] = []) => ({
    scrubText: createScrubber({ rpcUrls: [], secrets }),
  });

  const wrap = (log: ScopedRelayerLog): ScopedRelayerLog => ({
    ...log,
    withContext: (context) => wrap(log.withContext(context)),
    withErrorSummary: (policy) => wrap(log.withErrorSummary(policy)),
    signerBlocked(fields) {
      if (diagnosticProbe !== undefined) {
        throw new Error(diagnosticProbe);
      }

      log.signerBlocked(fields);
    },
  });

  const log = wrap(createRelayerLog({
    chainId: IDENTITY.chainId,
    errorSummary: createErrorSummary(),
    destination: {
      write(line) {
        lines.push(line);
        timeline.push(JSON.parse(line).event);
      },
    },
  }));

  const coordinator = await SignerCoordinator.create({
    identity: IDENTITY,
    store: { load, save },
    maxRetainedAttempts: 3,
    log,
    createErrorSummary,
    now: () => Date.parse(CREATED),
  });

  const signTransaction = vi.fn(ACCOUNT.signTransaction);

  const account: LocalAccount = { ...ACCOUNT, signTransaction };

  let options: RecoverSignerOptions = {
    publicClient: rpc.publicClient,
    anchor: DURABLE,
    maxBlockRange: 2n,
  };

  if (kind === 'operator-acceptance') {
    options = { ...options, acceptance: acceptanceRequest() };
  }

  if (kind === 'operator-attribution') {
    options = { ...options, attribution: request() };
  }

  if (kind === 'prepared' || kind === 'broadcast' || kind === 'inclusion') {
    await coordinator.recover(options);
    await coordinator.checkInclusions({
      publicClient: rpc.publicClient,
      head: DURABLE
    });
  }

  const run = () => {
    switch (kind) {
      case 'prepared':
        return coordinator.prepareAttempt({
          account,
          transaction: transaction(),
          workId: 'failure-contract:new',
        }, ORIGINAL_CYCLE);

      case 'broadcast':
        return coordinator.broadcastAttempt({
          publicClient: rpc.publicClient,
          attemptId: ATTEMPT_ID,
        }, ORIGINAL_CYCLE);

      case 'inclusion':
        return coordinator.checkInclusions({
          publicClient: rpc.publicClient,
          head: DURABLE,
        }, ORIGINAL_CYCLE);

      default:
        return coordinator.recover(options, ORIGINAL_CYCLE);
    }
  };

  save.mockClear();
  load.mockClear();
  lines.length = 0;
  timeline.length = 0;

  return {
    coordinator,
    rpc,
    run,
    options,
    account,
    save,
    load,
    signTransaction,
    timeline,
    lines,
    records: (): Record<string, unknown>[] =>
      lines.map((line) => JSON.parse(line)),
    visible: () => visible,
    setVisible: (next: TransactionJournalSnapshot) => {
      visible = { kind: 'present', snapshot: next };
    },
    probe: (message: string) => {
      diagnosticProbe = message;
    },
    hash: first.signedTransactions[0].transactionHash,
  };
}

function rpcCounts(t: Awaited<ReturnType<typeof setup>>) {
  return [
    t.rpc.getBlock.mock.calls.length,
    t.rpc.getTransactionCount.mock.calls.length,
    t.rpc.getTransactionReceipt.mock.calls.length,
    t.rpc.getTransaction.mock.calls.length,
    t.rpc.sendRawTransaction.mock.calls.length,
    t.rpc.request.mock.calls.length,
  ];
}

function expectSavedWrite(kind: Kind, saved: TransactionJournalSnapshot) {
  switch (kind) {
    case 'bootstrap':
      expect(saved).toMatchObject({
        baseline: { anchor: DURABLE, nonce: 4n },
        nextNonce: 4n,
        durableNextNonce: 4n,
        attempts: [],
      });
      return;

    case 'prepared':
      expect(saved).toMatchObject({
        nextNonce: 5n,
        durableNextNonce: 4n,
        attempts: [{ workId: 'failure-contract:new', phase: 'signed' }],
      });
      return;

    case 'broadcast':
      expect(saved.attempts).toMatchObject([{
        attemptId: ATTEMPT_ID,
        phase: 'broadcast-may-have-occurred',
      }]);
      return;

    case 'observation':
      expect(saved).toMatchObject({
        baseline: { anchor: anchor(98n), nonce: 4n },
        lastObservation: { anchor: DURABLE, nonce: 4n },
        attempts: [],
      });
      return;

    case 'search-progress':
      expect(saved.attempts).toMatchObject([{
        replacementSearch: {
          lowerBound: { anchor: anchor(98n), nonce: 4n },
          searchedThrough: anchor(100n),
          exhausted: null,
        },
      }]);
      return;

    case 'resolution':
      expect(saved).toMatchObject({
        attempts: [],
        durableNextNonce: 5n,
        ledger: { outcomes: [] },
      });
      return;

    case 'operator-acceptance':
      expect(saved).toMatchObject({
        attempts: [],
        ledger: { outcomes: [{ kind: 'operator-accepted-unattributed' }] },
      });
      return;

    case 'operator-attribution':
      expect(saved).toMatchObject({
        attempts: [],
        ledger: { outcomes: [{ kind: 'operator-attributed' }] },
      });
      return;

    case 'search-reset':
      expect(saved.attempts).toMatchObject([{
        replacementSearch: {
          lowerBound: { anchor: anchor(98n), nonce: 4n },
          searchedThrough: null,
          exhausted: null,
        },
      }]);
      return;

    case 'search-unconsumed-bound-rebase':
      expect(saved.attempts).toMatchObject([{
        replacementSearch: {
          lowerBound: { anchor: DURABLE, nonce: 4n },
          searchedThrough: null,
          exhausted: null,
        },
      }]);
      return;

    case 'search-lower-bound-replacement':
      expect(saved.attempts).toMatchObject([{
        replacementSearch: {
          lowerBound: {
            anchor: { blockNumber: 98n, blockHash: OTHER_HASH },
            nonce: 4n,
          },
          searchedThrough: null,
          exhausted: null,
        },
      }]);
      return;

    default:
      kind satisfies never;
  }
}

function expectedEvent(kind: Scenario, hash: string) {
  const common = {
    signer: ACCOUNT.address,
    attemptId: ATTEMPT_ID,
    nonce: '4',
    durableBlock: '104',
    durableBlockHash: DURABLE.blockHash,
  };

  switch (kind) {
    case 'resolution':
      return {
        signer: ACCOUNT.address,
        attemptId: ATTEMPT_ID,
        nonce: '4',
        event: 'attempt_resolved',
        transactionHash: hash,
        resolution: {
          outcome: 'success',
          transactionHash: hash,
          anchor: { blockNumber: '104', blockHash: DURABLE.blockHash },
          inclusion: { blockNumber: '101', blockHash: anchor(101n).blockHash },
        },
      };

    case 'operator-acceptance':
      return {
        ...common,
        event: 'signer_attempt_operator_accepted_unattributed',
        requestId: '22222222-2222-4222-8222-222222222222',
      };

    case 'operator-attribution':
      return {
        ...common,
        event: 'signer_attempt_operator_attributed',
        requestId: '22222222-2222-4222-8222-222222222222',
        transactionHash: HINT_HASH,
        supersededNoMatch: true,
        contradictsExhaustionNonce: true,
      };

    case 'search-reset':
      return {
        ...common,
        event: 'signer_search_reset',
        reason: 'searched-through-changed',
        expectedBlock: '102',
        expectedBlockHash: anchor(102n).blockHash,
        observedBlock: '102',
        observedBlockHash: OTHER_HASH,
      };

    case 'search-unconsumed-bound-rebase':
      return {
        ...common,
        event: 'signer_search_unconsumed_bound_rebased',
        oldLowerBlock: '98',
        oldLowerBlockHash: anchor(98n).blockHash,
        oldLowerNonce: '4',
        observedLowerBlockHash: OTHER_HASH,
        durableNonce: '4',
        invalidatedFact: {
          expectedBlock: '100',
          expectedBlockHash: anchor(100n).blockHash,
          observedBlock: '100',
          observedBlockHash: OTHER_HASH,
        },
      };

    case 'search-lower-bound-replacement':
      return {
        ...common,
        event: 'signer_search_lower_bound_replaced',
        oldLowerBlock: '98',
        oldLowerBlockHash: anchor(98n).blockHash,
        oldLowerNonce: '4',
        observedLowerBlock: '98',
        observedLowerBlockHash: OTHER_HASH,
        replacementBlock: '98',
        replacementBlockHash: OTHER_HASH,
        replacementNonce: '4',
        durableNonce: '5',
        probeCount: '1',
        invalidatedFact: {
          expectedBlock: '100',
          expectedBlockHash: anchor(100n).blockHash,
          observedBlock: '100',
          observedBlockHash: OTHER_HASH,
        },
      };

    default:
      return null;
  }
}

function operationName(kind: Scenario) {
  if (kind === 'prepared') {
    return 'prepare-attempt';
  }

  if (kind === 'broadcast') {
    return 'broadcast-attempt';
  }

  return 'reconcile-attempt';
}

afterEach(() => vi.restoreAllMocks());

describe('coordinator write failure boundaries', () => {
  it.each(WRITE_SITES)('discards %s rejected before storage', async (kind) => {
    const t = await setup(kind);

    const before = t.visible();

    const revision = t.coordinator.durableRecoveryRevision;

    const attempts = t.coordinator.attempts;

    vi.spyOn(verification, 'verifyJournalSnapshot').mockRejectedValueOnce(
      new TypeError('Injected verification failure'),
    );

    await expect(t.run()).rejects
      .toThrow('Invalid journal persistence snapshot.');

    expect(t.save).not.toHaveBeenCalled();
    expect(t.visible()).toBe(before);
    expect(t.coordinator.attempts).toEqual(attempts);
    expect(t.coordinator.durableRecoveryRevision).toBe(revision);
    expect(t.coordinator.status).toMatchObject({
      open: kind === 'prepared',
      recoveryComplete: kind === 'prepared' || kind === 'inclusion',
      inclusionChecksComplete: kind === 'prepared',
      persistenceState: 'idle',
    });

    const blockers = [];

    if (kind === 'broadcast') {
      blockers.push('unresolved-attempt');
    }

    if (kind !== 'prepared') {
      blockers.push('recovery-incomplete');
    }

    expect(t.coordinator.status.blockers).toEqual(blockers);
    expect(t.coordinator.status.primaryReason).toBe(blockers[0] ?? null);
    expect(t.coordinator.canBroadcast).toBe(false);
    expect(t.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(t.rpc.request).not.toHaveBeenCalled();

    await expect(t.coordinator.retryPersistence()).rejects.toThrow(
      'No failed journal write is available to retry.',
    );

    // A second operation proves the staged completion was discarded.
    if (kind === 'broadcast') {
      await expect(t.run()).rejects.toThrow(
        'Fresh reconciliation is required before broadcasting.',
      );
      await t.coordinator.recover(t.options);
    }

    const result = await t.run();

    if (kind === 'broadcast') {
      expect(result.status).toBe('acknowledged');
      expect(t.rpc.request).toHaveBeenCalledOnce();
    }

    expect(t.save).toHaveBeenCalled();
  });

  it.each(WRITE_SITES)(
    'retains %s when storage does not acknowledge',
    async (kind) => {
      const t = await setup(kind);

      const before = t.visible();

      const attempts = t.coordinator.attempts;

      const revision = t.coordinator.durableRecoveryRevision;

      t.save.mockRejectedValueOnce(new Error('Uncertain storage'));

      await expect(t.run()).rejects.toThrow(PERSISTENCE_ERROR);

      expect(t.visible()).toBe(before);
      expect(t.coordinator.attempts).toEqual(attempts);
      expect(t.coordinator.durableRecoveryRevision).toBe(revision);
      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: kind === 'inclusion',
        inclusionChecksComplete: false,
        persistenceState: 'failed',
        primaryReason: 'persistence-failure',
      });
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.rpc.sendRawTransaction).not.toHaveBeenCalled();
      expect(t.rpc.request).not.toHaveBeenCalled();

      const blockers = ['persistence-failure'];

      if (kind === 'broadcast') {
        blockers.push('unresolved-attempt');
      }

      blockers.push('recovery-incomplete');

      expect(t.coordinator.status.blockers).toEqual(blockers);

      await expect(t.run()).rejects.toMatchObject({
        message: 'A pending journal write must be retried first.',
      });

      expect(t.save).toHaveBeenCalledTimes(1);

      await t.coordinator.retryPersistence(RETRY_CYCLE);

      expect(t.save.mock.calls[1]![0]).toBe(t.save.mock.calls[0]![0]);
      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: kind === 'inclusion',
        inclusionChecksComplete: false,
        persistenceState: 'idle',
      });
      expect(t.coordinator.canBroadcast).toBe(false);
    }
  );

  it.each(KINDS)(
    'retries %s with its event and operation but no grants or RPC',
    async (kind) => {
      const t = await setup(kind);

      const expected = expectedEvent(kind, t.hash);

      // Model bytes becoming visible while durability remains uncertain.
      t.save.mockImplementationOnce(async (next) => {
        t.setVisible(next);
        throw new Error('Visible but unacknowledged');
      });

      await expect(t.run()).rejects.toThrow(PERSISTENCE_ERROR);

      const pending = t.save.mock.calls[0]![0];

      expectSavedWrite(kind, pending);

      const counts = rpcCounts(t);

      const signatures = t.signTransaction.mock.calls.length;

      expect(t.coordinator.status.persistenceState).toBe('failed');
      expect(t.records().filter(
        (record) => record.event !== 'signer_blocked'
      )).toEqual([]);

      const failedStatus = t.coordinator.status;

      const failedRecords = t.records();

      t.save.mockRejectedValueOnce(new Error('Retry also unacknowledged'));

      await expect(t.coordinator.retryPersistence(RETRY_CYCLE))
        .rejects.toThrow(PERSISTENCE_ERROR);

      expect(t.save.mock.calls[1]![0]).toBe(pending);
      expect(t.coordinator.status).toEqual(failedStatus);
      expect(t.records()).toEqual(failedRecords);
      expect(t.coordinator.canBroadcast).toBe(false);

      t.lines.length = 0;
      t.timeline.length = 0;

      await t.coordinator.retryPersistence(RETRY_CYCLE);

      expect(t.save.mock.calls[2]![0]).toBe(pending);
      expect(t.visible()).toEqual({ kind: 'present', snapshot: pending });
      expect(rpcCounts(t)).toEqual(counts);
      expect(t.signTransaction).toHaveBeenCalledTimes(signatures);
      expect(t.load).not.toHaveBeenCalled();
      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: false,
        inclusionChecksComplete: false,
        persistenceState: 'idle',
      });
      expect(t.coordinator.canBroadcast).toBe(false);

      const blockers = [];

      if ([
        'prepared',
        'broadcast',
        'search-progress',
        'search-reset',
        'search-unconsumed-bound-rebase',
        'search-lower-bound-replacement',
      ].includes(kind)) {
        blockers.push('unresolved-attempt');
      }

      blockers.push('recovery-incomplete');

      expect(t.coordinator.status.blockers).toEqual(blockers);
      expect(t.coordinator.status.primaryReason).toBe(blockers[0]);

      const expectedTimeline = ['save', 'ack'];

      if (expected !== null) {
        expectedTimeline.push(expected.event);
        expect(t.records()[0]).toMatchObject({
          ...expected,
          cycle: RETRY_CYCLE,
          operation: { name: 'reconcile-attempt' },
        });
      }

      expectedTimeline.push('signer_blocked');

      expect(t.timeline).toEqual(expectedTimeline);
      expect(t.records().at(-1)).toMatchObject({
        event: 'signer_blocked',
        cycle: RETRY_CYCLE,
        operation: { name: operationName(kind) },
      });

      await expect(t.coordinator.retryPersistence()).rejects.toThrow(
        'No failed journal write is available to retry.',
      );

      expect(t.save).toHaveBeenCalledTimes(3);
      expect(t.timeline).toEqual(expectedTimeline);
    }
  );

  it.each(EVENT_KINDS)(
    'emits %s after acknowledgement and before gate changes',
    async (kind) => {
      const t = await setup(kind);

      const started = deferred();

      const finish = deferred();

      const before = t.coordinator.attempts;

      const revision = t.coordinator.durableRecoveryRevision;

      t.save.mockImplementationOnce(async (next) => {
        t.timeline.push('save');
        started.resolve();
        await finish.promise;
        t.setVisible(next);
        t.timeline.push('ack');
      });

      const running = t.run();

      try {
        await Promise.race([started.promise, running]);
        expect(t.save).toHaveBeenCalledOnce();
        expect(t.timeline).toEqual(['save']);
        expect(t.coordinator.attempts).toEqual(before);
        expect(t.coordinator.durableRecoveryRevision).toBe(revision);
        expect(t.coordinator.canBroadcast).toBe(false);
      } finally {
        finish.resolve();
        await running;
      }

      const expected = expectedEvent(kind, t.hash)!;

      expect(t.timeline).toEqual([
        'save',
        'ack',
        expected.event,
        'signer_blocked'
      ]);
      expect(t.records()[0]).toMatchObject({
        ...expected,
        cycle: ORIGINAL_CYCLE,
        operation: { name: 'reconcile-attempt' },
      });
      expect(t.records().filter(
        (record) => record.event === expected.event
      )).toHaveLength(1);

      if (kind !== 'resolution') {
        expect(t.coordinator.status.recoveryComplete).toBe(false);
      }
    }
  );

  it.each([...WRITE_SITES, 'retry'] as const)(
    'retains the acknowledged journal when %s completion throws',
    async (kind) => {
      let scenario: Scenario = 'prepared';

      if (kind !== 'retry') {
        scenario = kind;
      }

      const t = await setup(scenario);

      if (kind === 'retry') {
        t.save.mockRejectedValueOnce(new Error('First write failed'));
        await expect(t.run()).rejects.toThrow(PERSISTENCE_ERROR);
      }

      const revision = t.coordinator.durableRecoveryRevision;

      // Planner output does not naturally throw here. Fault the pure completion
      // boundary after a real save, without accessing coordinator private
      // state.
      const describe = completion.describeWriteCompletion;

      const fault = vi.spyOn(completion, 'describeWriteCompletion');

      if (kind === 'observation') {
        // Recovery first describes terminality immediately after
        // acknowledgement.
        // Let that succeed, then fault the dispatch/completion invocation.
        fault.mockImplementationOnce(describe);
      }

      fault.mockImplementationOnce(() => {
        throw new Error('Injected completion failure');
      });

      let running: Promise<unknown>;

      if (kind === 'retry') {
        running = t.coordinator.retryPersistence(RETRY_CYCLE);
      } else {
        running = t.run();
      }

      await expect(running).rejects.toMatchObject({ message: RESTART_ERROR });

      const saved = t.save.mock.lastCall![0];

      expect(t.visible()).toEqual({ kind: 'present', snapshot: saved });
      expect(t.coordinator.journalInitialized).toBe(true);
      expect(t.coordinator.attempts).toEqual(saved.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        workId: attempt.workId,
        nonce: attempt.nonce,
        phase: attempt.phase,
        transactionHashes: attempt.signedTransactions.map(
          (signed) => signed.transactionHash
        ),
      })));
      expect(t.coordinator.durableRecoveryRevision).toBe(revision);
      expect(t.coordinator.status).toMatchObject({
        open: false,
        persistenceState: 'idle',
        recoveryComplete: kind === 'inclusion',
        inclusionChecksComplete: false,
      });
      expect(t.coordinator.canBroadcast).toBe(false);
      expect(t.rpc.sendRawTransaction).not.toHaveBeenCalled();
      expect(t.rpc.request).not.toHaveBeenCalled();

      await expect(t.coordinator.retryPersistence()).rejects.toThrow(
        'No failed journal write is available to retry.',
      );
      await expect(t.coordinator.recover(t.options)).rejects.toMatchObject({
        message: 'A pending journal write must be retried first.',
      });

      let expectedSaves = 1;

      if (kind === 'retry') {
        expectedSaves = 2;
      }

      expect(t.save).toHaveBeenCalledTimes(expectedSaves);
      expect(t.save.mock.lastCall![0]).toBe(saved);
    },
  );

  it(
    'keeps newly signed bytes protected after acknowledged preparation fails completion',
    async () => {
      const t = await setup('prepared');

      let bytes = '';

      t.save.mockImplementationOnce(async (next) => {
        bytes = next.attempts[0]!.signedTransactions[0].signedTransaction;
        t.setVisible(next);
        t.probe(`completion diagnostic ${bytes}`);
      });
      vi.spyOn(completion, 'describeWriteCompletion').mockImplementationOnce(
        () => {
          throw new Error('Injected completion failure');
        }
      );

      await expect(t.run()).rejects.toMatchObject({ message: RESTART_ERROR });

      expect(bytes).not.toBe('');
      expect(t.records().some(
        (record) => record.event === 'logging_failed'
      )).toBe(true);
      expect(t.lines.join('')).not.toContain(bytes);
      expect(t.coordinator.status.persistenceState).toBe('idle');
      expect(t.coordinator.attempts).toHaveLength(1);
    }
  );

  it(
    'waits for an unacknowledged inclusion save before completing abandonment',
    async () => {
      const t = await setup('inclusion');

      const owner = t.coordinator.beginInspection();

      const started = deferred();

      const finish = deferred();

      t.save.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        throw new Error('Held write unacknowledged');
      });

      const operation = owner.checkInclusions({
        publicClient: t.rpc.publicClient,
        head: DURABLE,
      });

      const rejected = expect(operation).rejects.toThrow(PERSISTENCE_ERROR);

      await started.promise;

      let abandoned = false;

      const abandonment = owner.abandon().then(() => {
        abandoned = true;
      });

      try {
        await Promise.resolve();
        expect(abandoned).toBe(false);
        expect(t.coordinator.status.persistenceState).toBe('writing');
        expect(t.coordinator.canBroadcast).toBe(false);
        expect(() => t.coordinator.beginInspection())
          .toThrow('already in progress');
        await expect(t.coordinator.retryPersistence())
          .rejects.toThrow('already in progress');
      } finally {
        finish.resolve();
        await Promise.all([rejected, abandonment]);
      }

      expect(abandoned).toBe(true);
      expect(t.coordinator.status).toMatchObject({
        open: false,
        recoveryComplete: true,
        inclusionChecksComplete: false,
        persistenceState: 'failed',
      });

      await t.coordinator.retryPersistence(RETRY_CYCLE);

      expect(t.save.mock.calls[1]![0]).toBe(t.save.mock.calls[0]![0]);
      expect(t.coordinator.status.open).toBe(false);
      expect(t.coordinator.canBroadcast).toBe(false);

      await t.coordinator.checkInclusions({
        publicClient: t.rpc.publicClient,
        head: DURABLE
      });

      expect(t.coordinator.status.open).toBe(true);
    }
  );
});
