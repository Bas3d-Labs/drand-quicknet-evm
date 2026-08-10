import {
  getAddress,
  isHex,
  size,
  type Hex,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';
import { readFile } from 'node:fs/promises';

interface DeploymentManifest {
  chainId?: unknown;
  registry?: unknown;
}

interface RegistryManifest {
  address?: unknown;
  runtimeCodehash?: unknown;
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
  const chainId = parseChainId(manifest.chainId);

  if (
    options.expectedChainId !== undefined &&
    chainId !== options.expectedChainId
  ) {
    throw new Error(
      `Deployment manifest chain mismatch: expected ${options.expectedChainId}, received ${chainId}.`
    );
  }

  const registry = parseRegistryManifest(manifest.registry);
  return {
    chainId,
    address: parseRegistryAddress(registry.address),
    runtimeCodehash: parseRuntimeCodehash(registry.runtimeCodehash),
  };
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

function parseRegistryManifest(
  value: unknown,
): RegistryManifest {
  if (!isObject(value)) {
    throw new Error('Invalid deployment manifest: registry must be an object.');
  }

  return value;
}

function parseChainId(
  value: unknown,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error('Invalid deployment manifest: chainId must be a positive safe integer.');
  }

  return value;
}

function parseRegistryAddress(
  value: unknown,
): RegistryDeployment['address'] {
  if (typeof value !== 'string') {
    throw new Error('Invalid deployment manifest: registry.address must be a valid address.');
  }

  try {
    return getAddress(value);
  } catch {
    throw new Error('Invalid deployment manifest: registry.address must be a valid address.');
  }
}

function parseRuntimeCodehash(
  value: unknown,
): Hex {
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new Error(
      'Invalid deployment manifest: registry.runtimeCodehash must be a 32-byte hex value.'
    );
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