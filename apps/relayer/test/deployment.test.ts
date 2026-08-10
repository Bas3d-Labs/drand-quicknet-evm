import {
  mkdtemp,
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
  pathToFileURL,
} from 'node:url';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import type {
  Address,
  Hex,
} from 'viem';

import {
  loadRegistryDeployment,
  parseRegistryDeployment,
} from '../src/deployment.js';

const CHAIN_ID = 46630;

const REGISTRY_ADDRESS: Address =
  '0x1111111111111111111111111111111111111111';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VALID_MANIFEST = {
  chainId: CHAIN_ID,
  registry: {
    address: REGISTRY_ADDRESS,
    runtimeCodehash: RUNTIME_CODEHASH,
  },
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
    ),
  );
});

describe('parseRegistryDeployment', () => {
  it('parses a valid deployment manifest', () => {
    expect(
      parseRegistryDeployment(
        VALID_MANIFEST,
      ),
    ).toEqual({
      chainId: CHAIN_ID,
      address: REGISTRY_ADDRESS,
      runtimeCodehash:
        RUNTIME_CODEHASH,
    });
  });

  it('accepts a matching expected chain ID', () => {
    expect(
      parseRegistryDeployment(
        VALID_MANIFEST,
        {
          expectedChainId:
            CHAIN_ID,
        },
      ),
    ).toEqual({
      chainId: CHAIN_ID,
      address: REGISTRY_ADDRESS,
      runtimeCodehash:
        RUNTIME_CODEHASH,
    });
  });

  it('rejects a mismatched expected chain ID', () => {
    expect(() =>
      parseRegistryDeployment(
        VALID_MANIFEST,
        {
          expectedChainId:
            CHAIN_ID + 1,
        },
      ),
    ).toThrow(
      `Deployment manifest chain mismatch: expected ${CHAIN_ID + 1}, received ${CHAIN_ID}.`
    );
  });

  it('rejects null as the root value', () => {
    expect(() =>
      parseRegistryDeployment(null),
    ).toThrow(
      'Invalid deployment manifest: root value must be an object.'
    );
  });

  it('rejects an array as the root value', () => {
    expect(() =>
      parseRegistryDeployment([]),
    ).toThrow(
      'Invalid deployment manifest: root value must be an object.'
    );
  });

  it('rejects a primitive as the root value', () => {
    expect(() =>
      parseRegistryDeployment(
        'not-an-object',
      ),
    ).toThrow(
      'Invalid deployment manifest: root value must be an object.'
    );
  });

  it('rejects a missing chainId', () => {
    expect(() =>
      parseRegistryDeployment({
        registry:
          VALID_MANIFEST.registry,
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a string chainId', () => {
    expect(() =>
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        chainId: '46630',
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects chainId zero', () => {
    expect(() =>
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        chainId: 0,
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a negative chainId', () => {
    expect(() =>
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        chainId: -1,
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a fractional chainId', () => {
    expect(() =>
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        chainId: 46_630.5,
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a chainId larger than the safe integer range', () => {
    expect(() =>
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        chainId:
          Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a missing registry object', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
      }),
    ).toThrow(
      'Invalid deployment manifest: registry must be an object.'
    );
  });

  it('rejects null registry', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: null,
      }),
    ).toThrow(
      'Invalid deployment manifest: registry must be an object.'
    );
  });

  it('rejects an array registry', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: [],
      }),
    ).toThrow(
      'Invalid deployment manifest: registry must be an object.'
    );
  });

  it('rejects a missing registry address', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          runtimeCodehash:
            RUNTIME_CODEHASH,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.address must be a valid address.'
    );
  });

  it('rejects a non-string registry address', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address: 123,
          runtimeCodehash:
            RUNTIME_CODEHASH,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.address must be a valid address.'
    );
  });

  it('rejects an invalid registry address', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address: '0x1234',
          runtimeCodehash:
            RUNTIME_CODEHASH,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.address must be a valid address.'
    );
  });

  it('normalizes the registry address with getAddress', () => {
    const lowercaseAddress =
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

    const deployment =
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            lowercaseAddress,
          runtimeCodehash:
            RUNTIME_CODEHASH,
        },
      });

    expect(
      deployment.address,
    ).toBe(
      '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD',
    );
  });

  it('rejects a missing runtime codehash', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects a non-string runtime codehash', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
          runtimeCodehash: 123,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects a runtime codehash without a 0x prefix', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
          runtimeCodehash:
            'aa'.repeat(32),
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects a runtime codehash shorter than 32 bytes', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
          runtimeCodehash:
            `0x${'aa'.repeat(31)}`,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects a runtime codehash longer than 32 bytes', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
          runtimeCodehash:
            `0x${'aa'.repeat(33)}`,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects non-hex characters in the runtime codehash', () => {
    expect(() =>
      parseRegistryDeployment({
        chainId: CHAIN_ID,
        registry: {
          address:
            REGISTRY_ADDRESS,
          runtimeCodehash:
            `0x${'gg'.repeat(32)}`,
        },
      }),
    ).toThrow(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('ignores unrelated manifest fields', () => {
    expect(
      parseRegistryDeployment({
        ...VALID_MANIFEST,
        deploymentBlock:
          123_456,
        sourceCommit:
          'abcdef',
        registry: {
          ...VALID_MANIFEST.registry,
          extraMetadata:
            'ignored',
        },
      }),
    ).toEqual({
      chainId: CHAIN_ID,
      address: REGISTRY_ADDRESS,
      runtimeCodehash:
        RUNTIME_CODEHASH,
    });
  });
});

describe('loadRegistryDeployment', () => {
  it('loads and parses a valid deployment manifest file', async () => {
    const manifestUrl =
      await createManifestFile(
        JSON.stringify(
          VALID_MANIFEST,
          null,
          2,
        ),
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
        expectedChainId:
          CHAIN_ID,
      }),
    ).resolves.toEqual({
      chainId: CHAIN_ID,
      address:
        REGISTRY_ADDRESS,
      runtimeCodehash:
        RUNTIME_CODEHASH,
    });
  });

  it('loads a manifest without an expected chain ID', async () => {
    const manifestUrl =
      await createManifestFile(
        JSON.stringify(
          VALID_MANIFEST,
        ),
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
      }),
    ).resolves.toEqual({
      chainId: CHAIN_ID,
      address:
        REGISTRY_ADDRESS,
      runtimeCodehash:
        RUNTIME_CODEHASH,
    });
  });

  it('rejects invalid JSON', async () => {
    const manifestUrl =
      await createManifestFile(
        '{ this is not valid json',
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
      }),
    ).rejects.toThrow(
      `Failed to parse deployment manifest ${manifestUrl.href} as JSON.`
    );
  });

  it('rejects a missing manifest file', async () => {
    const directory =
      await createTemporaryDirectory();

    const manifestUrl =
      pathToFileURL(
        join(
          directory,
          'does-not-exist.json',
        ),
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
      }),
    ).rejects.toThrow(
      `Failed to read deployment manifest ${manifestUrl.href}.`
    );
  });

  it('propagates manifest validation failures after loading', async () => {
    const manifestUrl =
      await createManifestFile(
        JSON.stringify({
          ...VALID_MANIFEST,
          chainId: 0,
        }),
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
      }),
    ).rejects.toThrow(
      'Invalid deployment manifest: chainId must be a positive safe integer.'
    );
  });

  it('rejects a loaded manifest whose chain ID does not match', async () => {
    const manifestUrl =
      await createManifestFile(
        JSON.stringify(
          VALID_MANIFEST,
        ),
      );

    await expect(
      loadRegistryDeployment({
        manifestUrl,
        expectedChainId:
          CHAIN_ID + 1,
      }),
    ).rejects.toThrow(
      `Deployment manifest chain mismatch: expected ${CHAIN_ID + 1}, received ${CHAIN_ID}.`
    );
  });
});

async function createManifestFile(
  contents: string,
): Promise<URL> {
  const directory =
    await createTemporaryDirectory();

  const path =
    join(
      directory,
      'deployment.json',
    );

  await writeFile(
    path,
    contents,
    'utf8',
  );

  return pathToFileURL(path);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        'drand-quicknet-relayer-',
      ),
    );

  temporaryDirectories.push(
    directory,
  );

  return directory;
}