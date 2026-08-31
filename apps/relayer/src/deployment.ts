import {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import { readFile } from 'node:fs/promises';

interface DeploymentManifest {
  chainId?: unknown;
  verifier?: unknown;
  registry?: unknown;
}

interface VerifierManifest {
  address?: unknown;
  runtimeCodehash?: unknown;
}

interface RegistryManifest {
  address?: unknown;
  runtimeCodehash?: unknown;
  minimumLeadRounds?: unknown;
}

export interface LoadRegistryDeploymentOptions {
  manifestUrl: URL;
  expectedChainId?: number;
}

export async function loadRegistryDeployment(
  options: LoadRegistryDeploymentOptions,
): Promise<RegistryDeployment> {
  const {
    manifestUrl,
    expectedChainId,
  } = options;

  let contents: string;
  try {
    contents = await readFile(manifestUrl, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read deployment manifest ${manifestUrl.href}.`,
      {
        cause: error,
      },
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Failed to parse deployment manifest ${manifestUrl.href} as JSON.`,
      {
        cause: error,
      },
    );
  }

  if (expectedChainId === undefined) {
    return parseRegistryDeployment(manifest);
  }
  
  return parseRegistryDeployment(
    manifest,
    {
      expectedChainId,
    },
  );
}

export interface ParseRegistryDeploymentOptions {
  expectedChainId?: number;
}

export function parseRegistryDeployment(
  value: unknown,
  options: ParseRegistryDeploymentOptions = {},
): RegistryDeployment {
  const manifest = parseDeploymentManifest(value);
  const verifier = parseVerifierManifest(manifest.verifier);
  const registry = parseRegistryManifest(manifest.registry);
  const deployment = RegistryDeployment.create({
    chainId: manifest.chainId,
    address: registry.address,
    minimumLeadRounds: registry.minimumLeadRounds,
    runtimeCodehash: registry.runtimeCodehash,
    verifierAddress: verifier.address,
    verifierRuntimeCodehash: verifier.runtimeCodehash,
  });

  if (
    options.expectedChainId !== undefined &&
    deployment.chainId !== options.expectedChainId
  ) {
    throw new Error(
      `Deployment manifest chain mismatch: expected ${options.expectedChainId}, received ${deployment.chainId}.`
    );
  }

  return deployment;
}

function parseDeploymentManifest(
  value: unknown,
): DeploymentManifest {
  if (!isObject(value)) {
    throw new Error(
      'Invalid deployment manifest: root value must be an object.'
    );
  }

  return value;
}

function parseVerifierManifest(
  value: unknown,
): VerifierManifest {
  if (!isObject(value)) {
    throw new Error(
      'Invalid deployment manifest: verifier must be an object.'
    );
  }

  return value;
}

function parseRegistryManifest(
  value: unknown,
): RegistryManifest {
  if (!isObject(value)) {
    throw new Error('Invalid deployment manifest: registry must be an object.');
  }

  return value;
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}