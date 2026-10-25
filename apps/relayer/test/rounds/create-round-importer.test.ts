import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  BeaconSubmitter,
} from '../../src/rounds/create-beacon-submitter.js';

import type {
  ImportQuicknetRoundResult,
} from '../../src/rounds/import-round.js';

import {
  createRoundImporter,
} from '../../src/rounds/create-round-importer.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../../src/rounds/import-round-when-available.js';

vi.mock(
  '../../src/rounds/import-round-when-available.js',
  () => ({
    importQuicknetRoundWhenAvailable: vi.fn(),
  }),
);

const PUBLIC_CLIENT = {} as PublicClient;
const ACCOUNT = {} as Account;

// Other deployment fields remain opaque to this factory.
const DEPLOYMENT = {
  chainId: 4663,
  address: `0x${'22'.repeat(20)}`,
} as RegistryDeployment;

const STABLE_OPTIONS = {
  publicClient: PUBLIC_CLIENT,
  account: ACCOUNT,
  deployment: DEPLOYMENT,
};

const ROUND = 100n;

const WORK_ID =
  `quicknet-round:v1:4663:${DEPLOYMENT.address.toLowerCase()}:100`;

const RESULT: ImportQuicknetRoundResult = {
  status: 'already-stored',
  round: ROUND,
  randomness: `0x${'11'.repeat(32)}`,
};

type RetainedWork = NonNullable<
  ReturnType<BeaconSubmitter['findRetainedWork']>
>;

function retainedWork(
  phase: RetainedWork['phase'],
): RetainedWork {
  return {
    attemptId: '00000000-0000-4000-8000-000000000001',
    workId: WORK_ID,
    nonce: 4n,
    phase,
    transactionHashes: [`0x${'aa'.repeat(32)}`],
  };
}

function forwardedOptions(index = 0) {
  const call = vi.mocked(importQuicknetRoundWhenAvailable)
    .mock.calls[index];

  if (call === undefined) {
    throw new Error('Expected an import call.');
  }

  return call[0];
}

describe('createRoundImporter', () => {
  let submitter: BeaconSubmitter;

  beforeEach(() => {
    vi.mocked(importQuicknetRoundWhenAvailable)
      .mockReset()
      .mockResolvedValue(RESULT);

    submitter = {
      findRetainedWork: vi.fn<BeaconSubmitter['findRetainedWork']>()
        .mockReturnValue(null),
      recover: vi.fn<BeaconSubmitter['recover']>(),
      submit: vi.fn<BeaconSubmitter['submit']>(),
    };
  });

  it.each([0, 1.5])(
    'rejects timeout %s during construction without importing',
    (receiptTimeoutMs) => {
      expect(() => createRoundImporter({
        ...STABLE_OPTIONS,
        receiptTimeoutMs,
      })).toThrow('Invalid receipt timeout.');

      expect(importQuicknetRoundWhenAvailable)
        .not.toHaveBeenCalled();
    },
  );

  it('accepts an omitted timeout and imports only when invoked', async () => {
    const bind = createRoundImporter(STABLE_OPTIONS);

    expect(importQuicknetRoundWhenAvailable)
      .not.toHaveBeenCalled();

    const importRound = bind({ submitter });

    expect(importQuicknetRoundWhenAvailable)
      .not.toHaveBeenCalled();

    await importRound(ROUND);

    expect(importQuicknetRoundWhenAvailable)
      .toHaveBeenCalledExactlyOnceWith({
        publicClient: PUBLIC_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        submitter,
        round: ROUND,
        onProgress: undefined,
      });

    const options = forwardedOptions();

    expect(Object.hasOwn(options, 'receiptTimeoutMs')).toBe(false);
    expect(Object.hasOwn(options, 'fetchTimeoutMs')).toBe(false);
    expect(Object.hasOwn(options, 'signal')).toBe(false);
    expect(Object.hasOwn(options, 'onProgress')).toBe(true);
    expect(options.onProgress).toBeUndefined();
  });

  it('forwards explicit timeout and bound dependencies unchanged', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();

    const importRound = createRoundImporter({
      ...STABLE_OPTIONS,
      receiptTimeoutMs: 45_000,
      fetchTimeoutMs: 12_000,
    })({
      submitter,
      onProgress,
      signal: controller.signal,
    });

    await importRound(ROUND);

    expect(importQuicknetRoundWhenAvailable)
      .toHaveBeenCalledExactlyOnceWith({
        publicClient: PUBLIC_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        submitter,
        round: ROUND,
        onProgress,
        receiptTimeoutMs: 45_000,
        fetchTimeoutMs: 12_000,
        signal: controller.signal,
      });

    const options = forwardedOptions();

    expect(options.publicClient).toBe(PUBLIC_CLIENT);
    expect(options.account).toBe(ACCOUNT);
    expect(options.deployment).toBe(DEPLOYMENT);
    expect(options.submitter).toBe(submitter);
    expect(options.onProgress).toBe(onProgress);
    expect(options.signal).toBe(controller.signal);
    expect(options.round).toBe(ROUND);

    expect(Object.hasOwn(options, 'receiptTimeoutMs')).toBe(true);
    expect(options.receiptTimeoutMs).toBe(45_000);
    expect(Object.hasOwn(options, 'signal')).toBe(true);

    expect(submitter.recover).not.toHaveBeenCalled();
    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it('preserves an explicitly undefined progress callback as an own property', async () => {
    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
      onProgress: undefined,
    });

    await importRound(ROUND);

    const options = forwardedOptions();

    expect(Object.hasOwn(options, 'onProgress')).toBe(true);
    expect(options.onProgress).toBeUndefined();
  });

  it('creates independent options for successive rounds', async () => {
    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
    });

    await importRound(ROUND);

    const first = forwardedOptions();

    // Mutation by a downstream caller must not affect the next call.
    first.receiptTimeoutMs = 123;

    await importRound(ROUND + 1n);

    const second = forwardedOptions(1);

    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(first.round).toBe(ROUND);
    expect(second.round).toBe(ROUND + 1n);
    expect(Object.hasOwn(second, 'receiptTimeoutMs')).toBe(false);
    expect(second.submitter).toBe(submitter);
  });

  it('returns the import result unchanged', async () => {
    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
    });

    const result = await importRound(ROUND);

    expect(result).toBe(RESULT);
    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(1);
  });

  it('propagates rejection unchanged without retrying', async () => {
    const failure = new Error('Import failed.');

    vi.mocked(importQuicknetRoundWhenAvailable)
      .mockRejectedValueOnce(failure);

    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
    });

    await expect(importRound(ROUND)).rejects.toBe(failure);

    expect(importQuicknetRoundWhenAvailable).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1.5, 60_001])(
    'rejects fetch timeout %s during construction without importing',
    (fetchTimeoutMs) => {
      expect(() => createRoundImporter({
        ...STABLE_OPTIONS,
        fetchTimeoutMs,
      })).toThrow(RangeError);

      expect(importQuicknetRoundWhenAvailable)
        .not.toHaveBeenCalled();
    },
  );

  it.each([
    'signed',
    'broadcast-may-have-occurred',
    'included',
  ] as const)(
    'defers retained work in phase %s without invoking the importer',
    async (phase) => {
      const retained = retainedWork(phase);
      const onProgress = vi.fn();

      vi.mocked(submitter.findRetainedWork)
        .mockReturnValue(retained);

      const importRound = createRoundImporter(STABLE_OPTIONS)({
        submitter,
        onProgress,
      });

      expect(await importRound(ROUND)).toEqual({
        status: 'deferred',
        reason: 'already-retained',
        round: ROUND,
        attemptId: retained.attemptId,
        workId: retained.workId,
      });

      expect(submitter.findRetainedWork)
        .toHaveBeenCalledExactlyOnceWith(WORK_ID);

      expect(importQuicknetRoundWhenAvailable)
        .not.toHaveBeenCalled();
      expect(submitter.recover).not.toHaveBeenCalled();
      expect(submitter.submit).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    },
  );

  it('normalizes the registry address before looking up retained work', async () => {
    const deployment = {
      ...DEPLOYMENT,
      address: `0x${'AB'.repeat(20)}`,
    } as RegistryDeployment;

    const importRound = createRoundImporter({
      ...STABLE_OPTIONS,
      deployment,
    })({ submitter });

    expect(await importRound(ROUND)).toBe(RESULT);

    expect(submitter.findRetainedWork)
      .toHaveBeenCalledExactlyOnceWith(
        `quicknet-round:v1:4663:0x${'ab'.repeat(20)}:100`,
      );

    expect(importQuicknetRoundWhenAvailable)
      .toHaveBeenCalledOnce();
    expect(forwardedOptions().deployment).toBe(deployment);
  });

  it('imports nonmatching work and observes removal on the next invocation', async () => {
    let retained: RetainedWork | null = retainedWork('included');

    vi.mocked(submitter.findRetainedWork)
      .mockImplementation((workId) => {
        if (retained !== null && retained.workId === workId) {
          return retained;
        }

        return null;
      });

    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
    });

    expect(await importRound(ROUND)).toMatchObject({
      status: 'deferred',
      reason: 'already-retained',
    });

    expect(importQuicknetRoundWhenAvailable)
      .not.toHaveBeenCalled();

    // A different round must not be deferred by the retained record.
    await importRound(ROUND + 1n);

    expect(importQuicknetRoundWhenAvailable)
      .toHaveBeenCalledOnce();
    expect(forwardedOptions().round).toBe(ROUND + 1n);

    // Removing the record must be visible through the same bound importer.
    retained = null;

    expect(await importRound(ROUND)).toBe(RESULT);

    expect(importQuicknetRoundWhenAvailable)
      .toHaveBeenCalledTimes(2);
    expect(forwardedOptions(1).round).toBe(ROUND);

    expect(submitter.findRetainedWork)
      .toHaveBeenNthCalledWith(1, WORK_ID);
    expect(submitter.findRetainedWork)
      .toHaveBeenNthCalledWith(
        2,
        `quicknet-round:v1:4663:${DEPLOYMENT.address.toLowerCase()}:101`,
      );
    expect(submitter.findRetainedWork)
      .toHaveBeenNthCalledWith(3, WORK_ID);
  });

  it('honors cancellation before retained-work lookup or import', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop importing.');

    vi.mocked(submitter.findRetainedWork)
      .mockReturnValue(retainedWork('included'));

    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
      signal: controller.signal,
    });

    controller.abort(reason);

    await expect(importRound(ROUND)).rejects.toBe(reason);

    expect(submitter.findRetainedWork).not.toHaveBeenCalled();
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    expect(submitter.recover).not.toHaveBeenCalled();
    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it.each([0n, -1n])(
    'rejects nonpositive round %s before lookup or import',
    async (round) => {
      const importRound = createRoundImporter(STABLE_OPTIONS)({
        submitter,
      });

      const result = importRound(round);

      await expect(result).rejects.toBeInstanceOf(RangeError);
      await expect(result).rejects.toThrow(
        'Quicknet round must be greater than zero.',
      );

      expect(submitter.findRetainedWork).not.toHaveBeenCalled();
      expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
    },
  );

  it('rejects a round above uint64 before lookup or import', async () => {
    const importRound = createRoundImporter(STABLE_OPTIONS)({
      submitter,
    });

    const result = importRound(1n << 64n);

    await expect(result).rejects.toBeInstanceOf(TypeError);
    await expect(result).rejects.toThrow(
      'Invalid beacon work identity input.',
    );

    expect(submitter.findRetainedWork).not.toHaveBeenCalled();
    expect(importQuicknetRoundWhenAvailable).not.toHaveBeenCalled();
  });
});