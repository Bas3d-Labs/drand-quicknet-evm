import {
  readFile,
  stat,
} from 'node:fs/promises';

import type {
  Address,
  Hex,
} from 'viem';

import {
  assertOnlyKeys,
  requireAddress,
  requireBytes32,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from './validation.js';

export interface ArtifactDeployment {
  transactionHash: Hex;
  blockNumber: number;
}

export interface DeploymentArtifact {
  address: Address;
  runtimeCodehash: Hex;
  deployment: ArtifactDeployment;
}

export interface DeploymentManifest {
  manifestVersion: 1;
  network: string;
  chainId: number;
  registry: DeploymentArtifact;
  verifier: DeploymentArtifact;
}

function validateArtifactDeployment(
  value: unknown,
  path: string,
): ArtifactDeployment {
  const deployment = requireRecord(value, path);

  assertOnlyKeys(
    deployment,
    [
      'transactionHash',
      'blockNumber',
    ],
    path,
  );

  return {
    transactionHash: requireBytes32(
      deployment.transactionHash,
      `${path}.transactionHash`,
    ),
    blockNumber: requirePositiveInteger(
      deployment.blockNumber,
      `${path}.blockNumber`,
    ),
  };
}

function validateDeploymentArtifact(
  value: unknown,
  path: string,
): DeploymentArtifact {
  const artifact = requireRecord(value, path);

  assertOnlyKeys(
    artifact,
    [
      'address',
      'runtimeCodehash',
      'deployment',
    ],
    path,
  );

  return {
    address: requireAddress(
      artifact.address,
      `${path}.address`,
    ),
    runtimeCodehash: requireBytes32(
      artifact.runtimeCodehash,
      `${path}.runtimeCodehash`,
    ),
    deployment:
      validateArtifactDeployment(
        artifact.deployment,
        `${path}.deployment`,
      ),
  };
}

export function validateDeploymentManifest(
  value: unknown,
): DeploymentManifest {
  const root = requireRecord(
    value,
    'manifest',
  );

  assertOnlyKeys(
    root,
    [
      'manifestVersion',
      'network',
      'chainId',
      'registry',
      'verifier',
    ],
    'manifest',
  );

  if (root.manifestVersion !== 1) {
    throw new Error(
      'manifestVersion must be 1.',
    );
  }

  return {
    manifestVersion: 1,

    network: requireString(
      root.network,
      'manifest.network',
    ),

    chainId: requirePositiveInteger(
      root.chainId,
      'manifest.chainId',
    ),

    registry: validateDeploymentArtifact(
      root.registry,
      'manifest.registry',
    ),

    verifier: validateDeploymentArtifact(
      root.verifier,
      'manifest.verifier',
    ),
  };
}

export async function loadDeploymentManifest(
  manifestPath: string,
): Promise<DeploymentManifest> {
  let fileStat;
  try {
    fileStat = await stat(manifestPath);
  } catch {
    throw new Error(
      `deploymentManifest does not exist: ${manifestPath}`,
    );
  }

  if (!fileStat.isFile()) {
    throw new Error(
      `deploymentManifest is not a file: ${manifestPath}`,
    );
  }

  let contents: string;
  try {
    contents = await readFile(
      manifestPath,
      'utf8',
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        'failed to read deploymentManifest '
        + `${manifestPath}: ${error.message}`,
      );
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(
      `deploymentManifest contains invalid JSON: ${manifestPath}`,
    );
  }

  return validateDeploymentManifest(parsed);
}