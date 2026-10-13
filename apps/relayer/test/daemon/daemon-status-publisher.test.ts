import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createDaemonStatusPublisher,
} from '../../src/daemon/daemon-status-publisher.js';

import type {
  writeDaemonStatusFile,
} from '../../src/state/file-daemon-status-store.js';

import type {
  SignerRuntimeObservation,
} from '../../src/state/read-signer-runtime-observation.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

const FIRST_HASH = `0x${'aa'.repeat(32)}` as const;
const SECOND_HASH = `0x${'bb'.repeat(32)}` as const;

const START = Date.parse('2026-10-12T12:00:00.000Z');

function runtime(): SignerRuntimeObservation {
  return {
    journalInitialized: true,
    status: {
      open: false,
      primaryReason: 'unresolved-attempt',
      blockers: ['unresolved-attempt'],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: '2026-10-12T11:59:00.000Z',
    },
    attempts: [{
      attemptId: ATTEMPT_ID,
      nonce: 4n,
      phase: 'broadcast-may-have-occurred',
      transactionHashes: [FIRST_HASH, SECOND_HASH],
    }],
  };
}

function fixture() {
  let milliseconds = START;

  const write = vi.fn<typeof writeDaemonStatusFile>()
    .mockResolvedValue(undefined);

  const onFailure = vi.fn<(error: unknown) => void>();

  const readObservation = vi.fn<() => SignerRuntimeObservation>()
    .mockReturnValue(runtime());

  const env = {
    QUICKNET_STATE_DIR: '/verified-state',
  };

  const publisher = createDaemonStatusPublisher({
    identity: IDENTITY,
    runId: RUN_ID,
    env,
    now: () => milliseconds,
    write,
    onFailure,
  });

  return {
    publisher,
    write,
    onFailure,
    readObservation,
    env,
    setTime(value: number) {
      milliseconds = value;
    },
  };
}

describe('daemon status publisher', () => {
  it('does not write before receiving an initialized runtime reader', async () => {
    const t = fixture();

    // Startup recovery may finish before the reader is registered.
    t.publisher.onRecoveryCompleted({ retryDelayMs: null });

    await t.publisher.publish();

    expect(t.write).not.toHaveBeenCalled();
    expect(t.onFailure).not.toHaveBeenCalled();

    t.readObservation.mockReturnValueOnce({
      ...runtime(),
      journalInitialized: false,
      attempts: [],
    });

    t.publisher.onInitialized(t.readObservation);

    await t.publisher.publish();

    expect(t.readObservation).toHaveBeenCalledOnce();
    expect(t.write).not.toHaveBeenCalled();
  });

  it('publishes JSON-safe attempts with all candidate hashes', async () => {
    const t = fixture();
    t.publisher.onInitialized(t.readObservation);

    await t.publisher.publish();

    expect(t.write).toHaveBeenCalledOnce();

    const written = t.write.mock.calls[0]![0];

    expect(written.identity).toEqual(IDENTITY);
    expect(written.env).toEqual({
      QUICKNET_STATE_DIR: '/verified-state',
    });

    expect(written.snapshot).toMatchObject({
      version: 1,
      runId: RUN_ID,
      observedAt: new Date(START).toISOString(),
      lastCompletedCycle: null,
      lastRetryObservation: null,
      attempts: [{
        attemptId: ATTEMPT_ID,
        nonce: '4',
        phase: 'broadcast-may-have-occurred',
        transactionHashes: [FIRST_HASH, SECOND_HASH],
      }],
    });

    expect(Object.isFrozen(written.snapshot)).toBe(true);
    expect(() => JSON.stringify(written.snapshot)).not.toThrow();
  });

  it('keeps event timestamps unchanged when another snapshot is published', async () => {
    const t = fixture();

    // Retain an observation made during startup.
    t.publisher.onRecoveryCompleted({ retryDelayMs: 5_000 });

    t.setTime(START + 1_000);
    t.publisher.onInitialized(t.readObservation);
    t.publisher.onCycleCompleted(1);

    t.setTime(START + 2_000);
    await t.publisher.publish();

    t.setTime(START + 10_000);
    await t.publisher.publish();

    const first = t.write.mock.calls[0]![0].snapshot;
    const second = t.write.mock.calls[1]![0].snapshot;

    expect(first.observedAt)
      .toBe(new Date(START + 2_000).toISOString());
    expect(second.observedAt)
      .toBe(new Date(START + 10_000).toISOString());

    expect(second.lastCompletedCycle).toEqual({
      cycle: 1,
      completedAt: new Date(START + 1_000).toISOString(),
    });

    expect(second.lastRetryObservation).toEqual({
      observedAt: new Date(START).toISOString(),
      retryDelayMs: 5_000,
    });

    expect(second.lastCompletedCycle).toEqual(first.lastCompletedCycle);
    expect(second.lastRetryObservation)
      .toEqual(first.lastRetryObservation);
  });

  it('serializes overlapping publication requests', async () => {
    const t = fixture();
    t.publisher.onInitialized(t.readObservation);

    let release!: () => void;

    const blockedWrite = new Promise<void>((resolve) => {
      release = resolve;
    });

    t.write.mockReturnValueOnce(blockedWrite);

    const first = t.publisher.publish();
    const second = t.publisher.publish();

    try {
      await vi.waitFor(() => {
        expect(t.write).toHaveBeenCalledOnce();
      });

      t.setTime(START + 1_000);
      t.publisher.onCycleCompleted(1);

      expect(t.readObservation).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all([first, second]);
    }

    expect(t.write).toHaveBeenCalledTimes(2);
    expect(t.readObservation).toHaveBeenCalledTimes(2);

    expect(t.write.mock.calls[0]![0].snapshot.lastCompletedCycle)
      .toBeNull();

    expect(t.write.mock.calls[1]![0].snapshot.lastCompletedCycle)
      .toEqual({
        cycle: 1,
        completedAt: new Date(START + 1_000).toISOString(),
      });
  });

  it('reports a failed write and permits later publication', async () => {
    const t = fixture();
    const failure = new Error('Publication outcome uncertain');

    t.publisher.onInitialized(t.readObservation);
    t.write.mockRejectedValueOnce(failure);

    await expect(t.publisher.publish()).resolves.toBeUndefined();

    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(failure);

    await expect(t.publisher.publish()).resolves.toBeUndefined();

    expect(t.write).toHaveBeenCalledTimes(2);
  });

  it('preserves publication isolation when failure reporting throws', async () => {
    const t = fixture();

    t.publisher.onInitialized(t.readObservation);
    t.write.mockRejectedValueOnce(new Error('Write failed'));

    t.onFailure.mockImplementation(() => {
      throw new Error('Diagnostic delivery failed');
    });

    await expect(t.publisher.publish()).resolves.toBeUndefined();
    await expect(t.publisher.publish()).resolves.toBeUndefined();

    expect(t.write).toHaveBeenCalledTimes(2);
  });

  it('reports reader failure without writing or poisoning the queue', async () => {
    const t = fixture();
    const failure = new Error('Observation failed');

    t.publisher.onInitialized(t.readObservation);

    t.readObservation.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(t.publisher.publish()).resolves.toBeUndefined();

    expect(t.write).not.toHaveBeenCalled();
    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(failure);

    await t.publisher.publish();

    expect(t.write).toHaveBeenCalledOnce();
  });

  it('preserves earlier observations when new bookkeeping input is invalid', async () => {
    const t = fixture();

    t.publisher.onInitialized(t.readObservation);
    t.publisher.onCycleCompleted(1);
    t.publisher.onRecoveryCompleted({ retryDelayMs: 5_000 });

    t.publisher.onCycleCompleted(0);
    t.publisher.onRecoveryCompleted({ retryDelayMs: -1 });

    await t.publisher.publish();

    const written = t.write.mock.calls[0]![0].snapshot;

    expect(written.lastCompletedCycle?.cycle).toBe(1);
    expect(written.lastRetryObservation?.retryDelayMs).toBe(5_000);
    expect(t.onFailure).toHaveBeenCalledTimes(2);
  });

  it('copies the configured environment before later mutation', async () => {
    const t = fixture();

    t.publisher.onInitialized(t.readObservation);
    t.env.QUICKNET_STATE_DIR = '/different-state';

    await t.publisher.publish();

    expect(t.write.mock.calls[0]![0].env?.QUICKNET_STATE_DIR)
      .toBe('/verified-state');
  });
});