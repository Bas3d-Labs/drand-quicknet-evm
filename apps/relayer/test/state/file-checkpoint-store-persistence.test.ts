import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import type {
  Address,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const faults = vi.hoisted(() => ({
  beforeReplace: undefined as Error | undefined,
  afterReplace: undefined as Error | undefined,
}));

vi.mock('../../src/state/durable-replace.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/state/durable-replace.js')
  >();

  return {
    async durableReplace(
      ...args: Parameters<typeof actual.durableReplace>
    ): Promise<void> {
      const before = faults.beforeReplace;
      faults.beforeReplace = undefined;

      if (before !== undefined) {
        throw before;
      }

      await actual.durableReplace(...args);

      const after = faults.afterReplace;
      faults.afterReplace = undefined;

      if (after !== undefined) {
        throw after;
      }
    },
  };
});

import {
  FileCheckpointStore,
} from '../../src/state/file-checkpoint-store.js';

const CONSUMER_A: Address =
  '0x1111111111111111111111111111111111111111';

const CONSUMER_B: Address =
  '0x2222222222222222222222222222222222222222';

const DEPLOYMENT: RegistryDeployment = {
  chainId: 12345,
  address: '0x3333333333333333333333333333333333333333',
  runtimeCodehash: '0x' + 'aa'.repeat(32) as `0x${string}`,
  verifierAddress: '0x4444444444444444444444444444444444444444',
  verifierRuntimeCodehash: '0x' + 'bb'.repeat(32) as `0x${string}`,
};

describe('FileCheckpointStore persistence', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    faults.beforeReplace = undefined;
    faults.afterReplace = undefined;

    directory = await mkdtemp(
      join(tmpdir(), 'quicknet-checkpoint-persistence-'),
    );

    filePath = join(directory, 'checkpoint.json');
  });

  afterEach(async () => {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  function openStore(): Promise<FileCheckpointStore> {
    return FileCheckpointStore.open({
      filePath,
      deployment: DEPLOYMENT,
    });
  }

  async function readConsumers(): Promise<unknown> {
    const contents = await readFile(filePath, 'utf8');

    return JSON.parse(contents).consumers;
  }

  it.each([
    'beforeReplace',
    'afterReplace',
  ] as const)(
    'reloads disk state after %s failure before saving another consumer',
    async (phase) => {
      const store = await openStore();

      await store.save(CONSUMER_A, 100n);

      const failure = new Error('Injected persistence failure.');
      faults[phase] = failure;

      await expect(
        store.save(CONSUMER_A, 200n),
      ).rejects.toBe(failure);

      let expectedNextBlock = '100';

      if (phase === 'afterReplace') {
        expectedNextBlock = '200';
      }

      expect(await readConsumers()).toEqual({
        [CONSUMER_A]: {
          nextBlock: expectedNextBlock,
        },
      });

      // Save directly after failure so this operation must recover
      // the disk snapshot before merging another consumer's progress.
      await store.save(CONSUMER_B, 50n);

      expect(await readConsumers()).toEqual({
        [CONSUMER_A]: {
          nextBlock: expectedNextBlock,
        },
        [CONSUMER_B]: {
          nextBlock: '50',
        },
      });

      expect(await store.load(CONSUMER_A)).toBe(
        BigInt(expectedNextBlock),
      );
      expect(await store.load(CONSUMER_B)).toBe(50n);

      // Retrying the failed update is safe for either disk outcome.
      await store.save(CONSUMER_A, 200n);

      expect(await readConsumers()).toEqual({
        [CONSUMER_A]: {
          nextBlock: '200',
        },
        [CONSUMER_B]: {
          nextBlock: '50',
        },
      });

      expect(await store.load(CONSUMER_A)).toBe(200n);
      expect(await store.load(CONSUMER_B)).toBe(50n);
  });

  it('preserves both consumers when saves are started concurrently', async () => {
    const store = await openStore();

    await Promise.all([
      store.save(CONSUMER_A, 100n),
      store.save(CONSUMER_B, 200n),
    ]);

    expect(await store.load(CONSUMER_A)).toBe(100n);
    expect(await store.load(CONSUMER_B)).toBe(200n);

    expect(await readConsumers()).toEqual({
      [CONSUMER_A]: {
        nextBlock: '100',
      },
      [CONSUMER_B]: {
        nextBlock: '200',
      },
    });
  });
});