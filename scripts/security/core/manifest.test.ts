import {
  mkdtemp,
  mkdir,
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
} from 'viem';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadDeploymentManifest,
  validateDeploymentManifest,
} from './manifest.js';

const NETWORK = 'example-network';
const CHAIN_ID = 12345;

const REGISTRY =
  '0x1234567890abcdef1234567890abcdef12345678';

const VERIFIER =
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const REGISTRY_CODEHASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_CODEHASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REGISTRY_DEPLOYMENT_TX =
  '0xcccccccccccccccccccccccccccccccc'
  + 'cccccccccccccccccccccccccccccccc';

const VERIFIER_DEPLOYMENT_TX =
  '0xdddddddddddddddddddddddddddddddd'
  + 'dddddddddddddddddddddddddddddddd';

const temporaryDirectories: string[] = [];

function manifestFixture() {
  return {
    manifestVersion: 1,
    network: NETWORK,
    chainId: CHAIN_ID,

    registry: {
      address: REGISTRY,
      runtimeCodehash: REGISTRY_CODEHASH,
      deployment: {
        transactionHash: REGISTRY_DEPLOYMENT_TX,
        blockNumber: 900,
      },
    },

    verifier: {
      address: VERIFIER,
      runtimeCodehash: VERIFIER_CODEHASH,
      deployment: {
        transactionHash: VERIFIER_DEPLOYMENT_TX,
        blockNumber: 800,
      },
    },
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'drand-quicknet-manifest-'),
  );

  temporaryDirectories.push(directory);

  return directory;
}

async function writeManifestFixture(
  manifest: unknown = manifestFixture(),
): Promise<string> {
  const directory = await createTemporaryDirectory();
  const manifestPath = join(
    directory,
    `${NETWORK}.json`,
  );

  await writeFile(
    manifestPath,
    JSON.stringify(
      manifest,
      null,
      2,
    ),
    'utf8',
  );

  return manifestPath;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }

  temporaryDirectories.length = 0;
});

describe('validateDeploymentManifest', () => {
  it('accepts a valid deployment manifest', () => {
    expect(
      () => validateDeploymentManifest(
        manifestFixture(),
      ),
    ).not.toThrow();
  });

  it('returns the validated deployment manifest', () => {
    const validated =
      validateDeploymentManifest(
        manifestFixture(),
      );

    expect(validated).toEqual({
      manifestVersion: 1,
      network: NETWORK,
      chainId: CHAIN_ID,

      registry: {
        address: getAddress(REGISTRY),
        runtimeCodehash: REGISTRY_CODEHASH,
        deployment: {
          transactionHash: REGISTRY_DEPLOYMENT_TX,
          blockNumber: 900,
        },
      },

      verifier: {
        address: getAddress(VERIFIER),
        runtimeCodehash: VERIFIER_CODEHASH,
        deployment: {
          transactionHash: VERIFIER_DEPLOYMENT_TX,
          blockNumber: 800,
        },
      },
    });
  });

  it('canonicalizes addresses', () => {
    const manifest = manifestFixture();

    manifest.registry.address =
      manifest.registry.address.toLowerCase();

    manifest.verifier.address =
      manifest.verifier.address.toLowerCase();

    const validated =
      validateDeploymentManifest(manifest);

    expect(validated.registry.address).toBe(
      getAddress(REGISTRY),
    );

    expect(validated.verifier.address).toBe(
      getAddress(VERIFIER),
    );
  });

  it('normalizes bytes32 values to lowercase', () => {
    const manifest = manifestFixture();

    manifest.registry.runtimeCodehash =
      `0x${REGISTRY_CODEHASH.slice(2).toUpperCase()}`;

    manifest.registry.deployment.transactionHash =
      `0x${REGISTRY_DEPLOYMENT_TX.slice(2).toUpperCase()}`;

    const validated =
      validateDeploymentManifest(manifest);

    expect(
      validated.registry.runtimeCodehash,
    ).toBe(REGISTRY_CODEHASH);

    expect(
      validated.registry.deployment.transactionHash,
    ).toBe(REGISTRY_DEPLOYMENT_TX);
  });

  it('rejects an unsupported manifest version', () => {
    const manifest = {
      ...manifestFixture(),
      manifestVersion: 2,
    };

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifestVersion must be 1.',
    );
  });

  it('rejects an unknown root key', () => {
    const manifest = {
      ...manifestFixture(),
      unexpected: true,
    };

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.unexpected is not supported.',
    );
  });

  it('rejects the retired attestations key', () => {
    const manifest = {
      ...manifestFixture(),
      attestations: {},
    };

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.attestations is not supported.',
    );
  });

  it('rejects an unknown artifact key', () => {
    const base = manifestFixture();

    const manifest = {
      ...base,
      registry: {
        ...base.registry,
        unexpected: true,
      },
    };

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.registry.unexpected is not supported.',
    );
  });

  it('rejects an unknown deployment key', () => {
    const base = manifestFixture();

    const manifest = {
      ...base,
      registry: {
        ...base.registry,
        deployment: {
          ...base.registry.deployment,
          unexpected: true,
        },
      },
    };

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.registry.deployment.unexpected '
      + 'is not supported.',
    );
  });

  it('rejects an invalid registry address', () => {
    const manifest = manifestFixture();

    manifest.registry.address = '0x1234';

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.registry.address must be an EVM address.',
    );
  });

  it('rejects an invalid verifier address', () => {
    const manifest = manifestFixture();

    manifest.verifier.address = 'not-an-address';

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.verifier.address must be an EVM address.',
    );
  });

  it('rejects an invalid runtime codehash', () => {
    const manifest = manifestFixture();

    manifest.registry.runtimeCodehash =
      '0x1234';

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.registry.runtimeCodehash must be bytes32.',
    );
  });

  it('rejects an invalid deployment transaction hash', () => {
    const manifest = manifestFixture();

    manifest.registry.deployment.transactionHash =
      '0x1234';

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.registry.deployment.transactionHash '
      + 'must be bytes32.',
    );
  });

  it('rejects a zero chain ID', () => {
    const manifest = manifestFixture();

    manifest.chainId = 0;

    expect(
      () => validateDeploymentManifest(manifest),
    ).toThrow(
      'manifest.chainId must be a positive safe integer.',
    );
  });
});

describe('loadDeploymentManifest', () => {
  it('loads and validates a manifest file', async () => {
    const manifestPath =
      await writeManifestFixture();

    const manifest =
      await loadDeploymentManifest(
        manifestPath,
      );

    expect(manifest.network).toBe(
      NETWORK,
    );

    expect(manifest.chainId).toBe(CHAIN_ID);

    expect(manifest.registry.address).toBe(
      getAddress(REGISTRY),
    );
  });

  it('rejects a missing manifest file', async () => {
    const directory =
      await createTemporaryDirectory();

    const manifestPath = join(
      directory,
      'missing.json',
    );

    await expect(
      loadDeploymentManifest(manifestPath),
    ).rejects.toThrow(
      `deploymentManifest does not exist: ${manifestPath}`,
    );
  });

  it('rejects a directory as the manifest path', async () => {
    const directory =
      await createTemporaryDirectory();

    const manifestDirectory = join(
      directory,
      'manifest.json',
    );

    await mkdir(
      manifestDirectory,
      {
        recursive: true,
      },
    );

    await expect(
      loadDeploymentManifest(
        manifestDirectory,
      ),
    ).rejects.toThrow(
      `deploymentManifest is not a file: ${manifestDirectory}`,
    );
  });

  it('rejects malformed JSON', async () => {
    const directory =
      await createTemporaryDirectory();

    const manifestPath = join(
      directory,
      `${NETWORK}.json`,
    );

    await writeFile(
      manifestPath,
      '{"manifestVersion":',
      'utf8',
    );

    await expect(
      loadDeploymentManifest(manifestPath),
    ).rejects.toThrow(
      'deploymentManifest contains invalid JSON: '
      + manifestPath,
    );
  });

  it('rejects a schema-invalid manifest file', async () => {
    const manifestPath =
      await writeManifestFixture({
        ...manifestFixture(),
        unexpected: true,
      });

    await expect(
      loadDeploymentManifest(manifestPath),
    ).rejects.toThrow(
      'manifest.unexpected is not supported.',
    );
  });
});