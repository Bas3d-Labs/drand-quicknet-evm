import {
  readFile,
} from 'node:fs/promises';

import {
  type Chain
} from 'viem';

import {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  FinalityPolicy,
} from './finality-policy.js';
import { resolveNetworkConfigPath } from './config.js';

export interface CustomChainDescriptor {
  id: number;
  name: string;
  nativeCurrency: Chain['nativeCurrency'];
  testnet?: boolean;
}

export interface CustomNetworkDescriptor {
  version: 1;
  name: string;
  chain: CustomChainDescriptor;
  deployment: RegistryDeployment;
  finality: FinalityPolicy;
}

export const CustomNetworkDescriptor = {
  parseJson(
    value: unknown,
  ): CustomNetworkDescriptor {
    if (!isObject(value)) {
      throw new Error('Custom network config must be an object.');
    }

    assertExactKeys(
      value,
      ['version','name','chain','registry','finality'],
    );

    if (value.version !== 1) {
      throw new Error('Custom network config version must be 1.');
    }

    const name = parseNetworkName(value.name);
    const chain = parseChain(value.chain);
    const registry = parseRegistry(value.registry);
    const deployment = RegistryDeployment.create({
      chainId: chain.id,
      address: registry.address,
      runtimeCodehash: registry.runtimeCodehash,
    });
    const finality = FinalityPolicy.parseJson(value.finality);

    return {
      version: 1,
      name,
      chain,
      deployment,
      finality,
    };
  },
}

export async function loadCustomNetworkDescriptor(
  filePath: string,
): Promise<CustomNetworkDescriptor> {
  let contents: string;
  try {
    const configPath = resolveNetworkConfigPath(filePath);
    contents = await readFile(configPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Failed to read custom network config: ${filePath}.`,
      { cause }
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new Error(
      `Failed to parse custom network config ${filePath} as JSON.`,
      { cause }
    );
  }

  return CustomNetworkDescriptor.parseJson(value);
}

interface RegistryDescriptor {
  address: unknown;
  runtimeCodehash: unknown;
}

function parseNetworkName(
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Custom network config name must be a non-empty string.');
  }

  return value.trim();
}

function parseChain(
  value: unknown,
): CustomChainDescriptor {
  if (!isObject(value)) {
    throw new Error('Custom network config chain must be an object.');
  }

  assertExactKeys(
    value,
    ['id', 'name', 'nativeCurrency'],
    ['testnet'],
  );

  if (
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  ) {
    throw new Error('Custom network config chain.id must be a positive safe integer.');
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error('Custom network config chain.name must be a non-empty string.');
  }

  const nativeCurrency = parseNativeCurrency(value.nativeCurrency);
  
  if (value.testnet !== undefined && typeof value.testnet !== 'boolean') {
    throw new Error('Custom network config chain.testnet must be a boolean.');
  }

  return {
    id: value.id,
    name: value.name.trim(),
    nativeCurrency,
    ...(value.testnet === undefined
      ? {}
      : {
          testnet: value.testnet,
        }),
  }
}

function parseNativeCurrency(
  value: unknown,
): Chain['nativeCurrency'] {
  if (!isObject(value)) {
    throw new Error('Custom network config chain.nativeCurrency must be an object.');
  }

  assertExactKeys(
    value,
    ['name', 'symbol', 'decimals'],
  );

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error('Custom network config chain.nativeCurrency.name must be a non-empty string.');
  }

  if (typeof value.symbol !== 'string' || value.symbol.trim().length === 0) {
    throw new Error('Custom network config chain.nativeCurrency.symbol must be a non-empty string.');
  }

  if (
    typeof value.decimals !== 'number' ||
    !Number.isSafeInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255
  ) {
    throw new Error('Custom network config chain.nativeCurrency.decimals must be an integer from 0 to 255.');
  }

  return {
    name: value.name.trim(),
    symbol: value.symbol.trim(),
    decimals: value.decimals,
  };
}

function parseRegistry(
  value: unknown,
): RegistryDescriptor {
  if (!isObject(value)) {
    throw new Error('Custom network config registry must be an object.');
  }

  assertExactKeys(value, ['address', 'runtimeCodehash']);

  return {
    address: value.address,
    runtimeCodehash: value.runtimeCodehash,
  };
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

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const allowedKeys =
    new Set([
      ...requiredKeys,
      ...optionalKeys,
    ]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected custom network config field: ${key}.`);
    }
  }

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Missing custom network config field: ${key}.`);
    }
  }
}