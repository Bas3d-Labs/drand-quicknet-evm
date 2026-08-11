import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  getAddress,
  type Address,
  type Hex,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  FileCheckpointStore,
} from '../src/file-checkpoint-store.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const REGISTRY_ADDRESS: Address = '0x3333333333333333333333333333333333333333';
const OTHER_REGISTRY_ADDRESS: Address =
  '0x4444444444444444444444444444444444444444';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const DEPLOYMENT: RegistryDeployment = {
  chainId: 46630,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
};

const LOWERCASE_CONSUMER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const CHECKSUMMED_CONSUMER = getAddress(LOWERCASE_CONSUMER);

describe('FileCheckpointStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(
        tmpdir(),
        'drand-quicknet-checkpoint-'
      )
    );

    filePath = join(
      directory,
      'checkpoint.json'
    );
  });

  afterEach(async () => {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      }
    );
  });

  function createStore(): FileCheckpointStore {
    return new FileCheckpointStore({
      filePath,
      deployment: DEPLOYMENT,
    });
  }

  async function writeCheckpointFile(
    value: unknown,
  ): Promise<void> {
    await writeFile(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    );
  }

  it('returns undefined when the checkpoint file does not exist', async () => {
    const store = createStore();
    const result = await store.load(CONSUMER_A);

    expect(result).toBeUndefined();
  });

  it('returns undefined when the file exists but the consumer has no checkpoint', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();
    const result = await store.load(CONSUMER_A);

    expect(result).toBeUndefined();
  });

  it('saves and loads a checkpoint', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 12_345n);

    const result = await store.load(CONSUMER_A);
    expect(result).toBe(12_345n);
  });

  it('supports block zero as a checkpoint', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 0n);

    const result = await store.load(CONSUMER_A);
    expect(result).toBe(0n);
  });

  it('rejects a negative checkpoint', async () => {
    const store = createStore();

    await expect(
      store.save(CONSUMER_A, -1n)
    ).rejects.toThrow(
      'Checkpoint nextBlock must not be negative.'
    );
  });

  it('does not create a checkpoint file when a negative checkpoint is rejected', async () => {
    const store = createStore();

    await expect(
      store.save(CONSUMER_A, -1n)
    ).rejects.toThrow(
      'Checkpoint nextBlock must not be negative.'
    );

    await expect(
      readFile(filePath, 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stores independent checkpoints for multiple consumers', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 12_345n);
    await store.save(CONSUMER_B, 67_890n);

    expect(
      await store.load(CONSUMER_A)
    ).toBe(
      12_345n
    );

    expect(
      await store.load(CONSUMER_B)
    ).toBe(
      67_890n
    );
  });

  it('updates one consumer without losing another consumer checkpoint', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 100n);
    await store.save(CONSUMER_B, 200n);
    await store.save(CONSUMER_A, 300n);

    expect(
      await store.load(CONSUMER_A)
    ).toBe(
      300n
    );

    expect(
      await store.load(CONSUMER_B)
    ).toBe(
      200n
    );
  });

  it('normalizes consumer addresses', async () => {
    const store = createStore();
    await store.save(LOWERCASE_CONSUMER, 500n);

    const result = await store.load(CHECKSUMMED_CONSUMER);
    expect(result).toBe(500n);
  });

  it('serializes nextBlock as a decimal string', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 18_446_744_073_709_551_615n);

    const contents = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents) as {
      consumers: Record<string, { nextBlock: unknown }>;
    };

    expect(
      parsed.consumers[CONSUMER_A]?.nextBlock
    ).toBe(
      '18446744073709551615'
    );
  });

  it('writes the checkpoint file version, chainId, and registry', async () => {
    const store = createStore();
    await store.save(CONSUMER_A, 100n);

    const contents = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents);

    expect(parsed).toEqual({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: getAddress(REGISTRY_ADDRESS),
      consumers: {
        [getAddress(CONSUMER_A)]: {
          nextBlock: '100',
        },
      },
    });
  });

  it('creates missing parent directories when saving', async () => {
    filePath = join(
      directory,
      'nested',
      'state',
      'checkpoint.json'
    );

    const store = createStore();
    await store.save(CONSUMER_A, 100n);

    const contents = await readFile(filePath, 'utf8');

    expect(
      contents.length
    ).toBeGreaterThan(
      0
    );
  });

  it('does not leave temporary checkpoint files after a successful save', async () => {
    const store = createStore();

    await store.save(CONSUMER_A, 100n);
    await store.save(CONSUMER_A, 200n);

    const files = await readdir(directory);

    expect(files).toEqual([
      'checkpoint.json',
    ]);
  });

  it('rejects invalid JSON', async () => {
    await writeFile(
      filePath,
      '{ invalid json',
      'utf8'
    );

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint file ${filePath} contains invalid JSON.`
    );
  });

  it('rejects a non-object checkpoint root', async () => {
    await writeCheckpointFile([]);

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Checkpoint file root must be an object.'
    );
  });

  it('rejects an unsupported checkpoint version', async () => {
    await writeCheckpointFile({
      version: 2,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Unsupported checkpoint file version: 2.'
    );
  });

  it('rejects a missing checkpoint version', async () => {
    await writeCheckpointFile({
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Unsupported checkpoint file version: undefined.'
    );
  });

  it('rejects an invalid chainId', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: '46630',
      registry: REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Checkpoint file contains an invalid chainId.'
    );
  });

  it('rejects a checkpoint for a different chain', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: 1,
      registry: REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint file chainId 1 does not match configured chainId ${DEPLOYMENT.chainId}.`
    );
  });

  it('rejects an invalid registry address', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: 'not-an-address',
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Checkpoint file contains an invalid registry address.'
    );
  });

  it('rejects a checkpoint for a different registry', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: OTHER_REGISTRY_ADDRESS,
      consumers: {},
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint file registry ${getAddress(OTHER_REGISTRY_ADDRESS)} does not match configured registry ${getAddress(REGISTRY_ADDRESS)}.`
    );
  });

  it('rejects a non-object consumers value', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: [],
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Checkpoint file consumers must be an object.'
    );
  });

  it('rejects an invalid consumer address', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        'not-an-address': {
          nextBlock: '100',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      'Checkpoint file contains an invalid consumer address: not-an-address.'
    );
  });

  it('rejects duplicate consumer addresses after normalization', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [LOWERCASE_CONSUMER]: {
          nextBlock: '100',
        },
        [CHECKSUMMED_CONSUMER]: {
          nextBlock: '200',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint file contains duplicate consumer address ${CHECKSUMMED_CONSUMER}.`
    );
  });

  it('rejects a non-object consumer checkpoint', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: '100',
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} must be an object.`
    );
  });

  it('rejects a non-string nextBlock', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock: 100,
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} contains an invalid nextBlock.`
    );
  });

  it('rejects an empty nextBlock', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock: '',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} contains an invalid nextBlock.`
    );
  });

  it('rejects a negative nextBlock string', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock: '-1',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} contains an invalid nextBlock.`
    );
  });

  it('rejects a hexadecimal nextBlock string', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock: '0x64',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} contains an invalid nextBlock.`
    );
  });

  it('rejects a fractional nextBlock string', async () => {
    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock: '100.5',
        },
      },
    });

    const store = createStore();

    await expect(
      store.load(CONSUMER_A)
    ).rejects.toThrow(
      `Checkpoint for consumer ${getAddress(CONSUMER_A)} contains an invalid nextBlock.`
    );
  });

  it('accepts a very large decimal nextBlock without precision loss', async () => {
    const nextBlock =
      '1234567890123456789012345678901234567890';

    await writeCheckpointFile({
      version: 1,
      chainId: DEPLOYMENT.chainId,
      registry: REGISTRY_ADDRESS,
      consumers: {
        [CONSUMER_A]: {
          nextBlock,
        },
      },
    });

    const store = createStore();
    const result = await store.load(CONSUMER_A);

    expect(result).toBe(
      BigInt(nextBlock)
    );
  });

  it('replaces an existing checkpoint file while preserving valid state', async () => {
    const store = createStore();

    await store.save(CONSUMER_A, 100n);
    await store.save(CONSUMER_A, 200n);

    const result = await store.load(CONSUMER_A);
    expect(result).toBe(200n);

    const contents = await readFile(filePath, 'utf8');

    expect(() =>
      JSON.parse(contents)
    ).not.toThrow();
  });
});