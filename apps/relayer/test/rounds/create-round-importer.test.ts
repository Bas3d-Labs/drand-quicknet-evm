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

// Opaque dependencies: this factory only forwards them.
const DEPLOYMENT = {} as RegistryDeployment;

const STABLE_OPTIONS = {
  publicClient: PUBLIC_CLIENT,
  account: ACCOUNT,
  deployment: DEPLOYMENT,
};

const ROUND = 100n;

const RESULT: ImportQuicknetRoundResult = {
  status: 'already-stored',
  round: ROUND,
  randomness: `0x${'11'.repeat(32)}`,
};

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
});