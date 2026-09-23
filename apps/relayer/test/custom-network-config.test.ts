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
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  CustomNetworkDescriptor,
  loadCustomNetworkDescriptor,
} from '../src/config/custom-network-config.js';

const REGISTRY_ADDRESS =
  '0x1111111111111111111111111111111111111111';

const REGISTRY_RUNTIME_CODEHASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const VERIFIER_ADDRESS = '0x2222222222222222222222222222222222222222';

const VERIFIER_RUNTIME_CODEHASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) =>
        rm(
          directory,
          {
            recursive: true,
            force: true,
          },
        ),
    ),
  );
});

describe('CustomNetworkDescriptor.parseJson', () => {
  it('parses a valid custom network config', () => {
    expect(
      CustomNetworkDescriptor.parseJson(
        createValidConfig(),
      ),
    ).toEqual({
      version: 1,
      name: 'example-mainnet',
      chain: {
        id: 12_345,
        name: 'Example Chain',
        nativeCurrency: {
          name: 'Example',
          symbol: 'EX',
          decimals: 18,
        },
        testnet: false,
      },
      deployment: {
        chainId: 12_345,
        address: REGISTRY_ADDRESS,
        runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
        verifierAddress: VERIFIER_ADDRESS,
        verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
      },
      finality: {
        type: 'safe',
      },
    });
  });

  it('derives the deployment chain ID from the chain config', () => {
    const config =
      createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.id = 54_321;

    const descriptor =
      CustomNetworkDescriptor.parseJson(
        config,
      );

    expect(
      descriptor.deployment.chainId,
    ).toBe(
      54_321,
    );
  });

  it('trims network and chain metadata strings', () => {
    const config =
      createValidConfig();

    config.name =
      '  example-mainnet  ';

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.name =
      '  Example Chain  ';

    const nativeCurrency =
      chain.nativeCurrency as Record<
        string,
        unknown
      >;

    nativeCurrency.name =
      '  Example  ';

    nativeCurrency.symbol =
      '  EX  ';

    const descriptor =
      CustomNetworkDescriptor.parseJson(
        config,
      );

    expect(
      descriptor.name,
    ).toBe(
      'example-mainnet',
    );

    expect(
      descriptor.chain.name,
    ).toBe(
      'Example Chain',
    );

    expect(
      descriptor.chain.nativeCurrency,
    ).toEqual({
      name: 'Example',
      symbol: 'EX',
      decimals: 18,
    });
  });

  it('allows testnet to be omitted', () => {
    const config =
      createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    delete chain.testnet;

    expect(
      CustomNetworkDescriptor.parseJson(
        config,
      ).chain,
    ).toEqual({
      id: 12_345,
      name: 'Example Chain',
      nativeCurrency: {
        name: 'Example',
        symbol: 'EX',
        decimals: 18,
      },
    });
  });

  it('parses confirmation finality', () => {
    const config =
      createValidConfig();

    config.finality = {
      type: 'confirmations',
      confirmations: '20',
    };

    expect(
      CustomNetworkDescriptor.parseJson(
        config,
      ).finality,
    ).toEqual({
      type: 'confirmations',
      confirmations: 20n,
    });
  });

  it('rejects null as the root value', () => {
    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          null,
        ),
    ).toThrow(
      'Custom network config must be an object.'
    );
  });

  it('rejects an array as the root value', () => {
    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          [],
        ),
    ).toThrow(
      'Custom network config must be an object.'
    );
  });

  it('rejects a primitive as the root value', () => {
    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          'invalid',
        ),
    ).toThrow(
      'Custom network config must be an object.'
    );
  });

  it('rejects a missing root field', () => {
    const config = createValidConfig();

    delete config.registry;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: registry.'
    );
  });

  it('rejects an unexpected root field', () => {
    const config = createValidConfig();

    config.rpcUrl = 'https://rpc.example.com';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: rpcUrl.'
    );
  });

  it('rejects an unsupported version', () => {
    const config = createValidConfig();

    config.version = 2;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config version must be 1.'
    );
  });

  it('rejects a non-string network name', () => {
    const config = createValidConfig();

    config.name = 123;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config name must be a non-empty string.'
    );
  });

  it('rejects an empty network name', () => {
    const config = createValidConfig();

    config.name = '   ';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config name must be a non-empty string.'
    );
  });

  it('rejects a non-object chain config', () => {
    const config = createValidConfig();

    config.chain = 'invalid';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain must be an object.'
    );
  });

  it('rejects a missing chain field', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    delete chain.name;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: name.'
    );
  });

  it('rejects an unexpected chain field', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.rpcUrl =
      'https://rpc.example.com';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: rpcUrl.'
    );
  });

  it('rejects chain ID zero', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.id = 0;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.id must be a positive safe integer.'
    );
  });

  it('rejects a negative chain ID', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.id = -1;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.id must be a positive safe integer.'
    );
  });

  it('rejects a fractional chain ID', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.id = 12_345.5;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.id must be a positive safe integer.'
    );
  });

  it('rejects a chain ID larger than the safe integer range', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.id =
      Number.MAX_SAFE_INTEGER + 1;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.id must be a positive safe integer.'
    );
  });

  it('rejects an empty chain name', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.name = '   ';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.name must be a non-empty string.'
    );
  });

  it('rejects a non-boolean testnet value', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.testnet = 'false';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.testnet must be a boolean.'
    );
  });

  it('rejects a non-object native currency', () => {
    const config = createValidConfig();

    const chain =
      config.chain as Record<
        string,
        unknown
      >;

    chain.nativeCurrency =
      'invalid';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency must be an object.'
    );
  });

  it('rejects a missing native currency field', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    delete nativeCurrency.symbol;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: symbol.'
    );
  });

  it('rejects an unexpected native currency field', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.extra =
      'invalid';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: extra.'
    );
  });

  it('rejects an empty native currency name', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.name = '   ';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency.name must be a non-empty string.'
    );
  });

  it('rejects an empty native currency symbol', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.symbol = '   ';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency.symbol must be a non-empty string.'
    );
  });

  it('allows zero native currency decimals', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.decimals = 0;

    expect(
      CustomNetworkDescriptor.parseJson(
        config,
      ).chain.nativeCurrency.decimals,
    ).toBe(
      0,
    );
  });

  it('allows 255 native currency decimals', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.decimals = 255;

    expect(
      CustomNetworkDescriptor.parseJson(
        config,
      ).chain.nativeCurrency.decimals,
    ).toBe(
      255,
    );
  });

  it('rejects negative native currency decimals', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.decimals = -1;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency.decimals must be an integer from 0 to 255.'
    );
  });

  it('rejects native currency decimals above 255', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.decimals = 256;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency.decimals must be an integer from 0 to 255.'
    );
  });

  it('rejects fractional native currency decimals', () => {
    const config = createValidConfig();

    const nativeCurrency =
      getNativeCurrency(
        config,
      );

    nativeCurrency.decimals = 18.5;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config chain.nativeCurrency.decimals must be an integer from 0 to 255.'
    );
  });

  it('rejects a missing verifier root field', () => {
    const config = createValidConfig();

    delete config.verifier;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: verifier.'
    );
  });

  it('rejects a non-object verifier config', () => {
    const config = createValidConfig();
    config.verifier = 'invalid';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config verifier must be an object.'
    );
  });

  it('rejects a missing verifier field', () => {
    const config = createValidConfig();

    const verifier =
      config.verifier as Record<
        string,
        unknown
      >;

    delete verifier.address;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: address.'
    );
  });

  it('rejects an unexpected verifier field', () => {
    const config = createValidConfig();

    const verifier =
      config.verifier as Record<
        string,
        unknown
      >;

    verifier.chainId = 12_345;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: chainId.'
    );
  });

  it('propagates invalid verifier address failures', () => {
    const config = createValidConfig();

    const verifier =
      config.verifier as Record<
        string,
        unknown
      >;

    verifier.address =
      '0x1234';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Registry deployment verifierAddress must be a valid address.'
    );
  });

  it('propagates invalid verifier runtime codehash failures', () => {
    const config = createValidConfig();

    const verifier =
      config.verifier as Record<
        string,
        unknown
      >;

    verifier.runtimeCodehash =
      '0x1234';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Registry deployment verifierRuntimeCodehash must be a 32-byte hex value.'
    );
  });

  it('rejects a non-object registry config', () => {
    const config = createValidConfig();

    config.registry = 'invalid';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Custom network config registry must be an object.'
    );
  });

  it('rejects a missing registry field', () => {
    const config = createValidConfig();

    const registry =
      config.registry as Record<
        string,
        unknown
      >;

    delete registry.address;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Missing custom network config field: address.'
    );
  });

  it('rejects an unexpected registry field', () => {
    const config = createValidConfig();

    const registry =
      config.registry as Record<
        string,
        unknown
      >;

    registry.chainId = 12_345;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: chainId.'
    );
  });

  it('rejects minimumLeadRounds policy in the registry descriptor', () => {
    const config = createValidConfig();

    const registry =
      config.registry as Record<
        string,
        unknown
      >;

    registry.minimumLeadRounds = 5;

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Unexpected custom network config field: minimumLeadRounds.'
    );
  });

  it('propagates invalid registry address failures', () => {
    const config = createValidConfig();

    const registry =
      config.registry as Record<
        string,
        unknown
      >;

    registry.address =
      '0x1234';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Registry deployment address must be a valid address.'
    );
  });

  it('propagates invalid registry runtime codehash failures', () => {
    const config = createValidConfig();

    const registry =
      config.registry as Record<
        string,
        unknown
      >;

    registry.runtimeCodehash =
      '0x1234';

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Registry deployment runtimeCodehash must be a 32-byte hex value.'
    );
  });

  it('propagates invalid finality policy failures', () => {
    const config = createValidConfig();

    config.finality = {
      type: 'unknown',
    };

    expect(
      () =>
        CustomNetworkDescriptor.parseJson(
          config,
        ),
    ).toThrow(
      'Finality policy type must be safe, finalized, or confirmations.'
    );
  });
});

describe('loadCustomNetworkDescriptor', () => {
  it('loads and parses a valid custom network config file', async () => {
    const filePath =
      await createConfigFile(
        JSON.stringify(
          createValidConfig(),
          null,
          2,
        ),
      );

    await expect(
      loadCustomNetworkDescriptor(
        filePath,
      ),
    ).resolves.toEqual({
      version: 1,
      name: 'example-mainnet',
      chain: {
        id: 12_345,
        name: 'Example Chain',
        nativeCurrency: {
          name: 'Example',
          symbol: 'EX',
          decimals: 18,
        },
        testnet: false,
      },
      deployment: {
        chainId: 12_345,
        address: REGISTRY_ADDRESS,
        runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
        verifierAddress: VERIFIER_ADDRESS,
        verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
      },
      finality: {
        type: 'safe',
      },
    });
  });

  it('rejects a missing custom network config file', async () => {
    const directory = await createTemporaryDirectory();

    const filePath =
      join(
        directory,
        'does-not-exist.json',
      );

    await expect(
      loadCustomNetworkDescriptor(
        filePath,
      ),
    ).rejects.toThrow(
      `Failed to read custom network config: ${filePath}.`
    );
  });

  it('rejects invalid JSON', async () => {
    const filePath =
      await createConfigFile(
        '{ this is not valid json',
      );

    await expect(
      loadCustomNetworkDescriptor(
        filePath,
      ),
    ).rejects.toThrow(
      `Failed to parse custom network config ${filePath} as JSON.`
    );
  });

  it('propagates config validation failures after loading', async () => {
    const config = createValidConfig();

    config.version = 2;

    const filePath =
      await createConfigFile(
        JSON.stringify(
          config,
        ),
      );

    await expect(
      loadCustomNetworkDescriptor(
        filePath,
      ),
    ).rejects.toThrow(
      'Custom network config version must be 1.'
    );
  });
});

function createValidConfig(): Record<
  string,
  unknown
> {
  return {
    version: 1,
    name: 'example-mainnet',
    chain: {
      id: 12_345,
      name: 'Example Chain',
      nativeCurrency: {
        name: 'Example',
        symbol: 'EX',
        decimals: 18,
      },
      testnet: false,
    },
    verifier: {
      address: VERIFIER_ADDRESS,
      runtimeCodehash: VERIFIER_RUNTIME_CODEHASH,
    },
    registry: {
      address: REGISTRY_ADDRESS,
      runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
    },
    finality: {
      type: 'safe',
    },
  };
}

function getNativeCurrency(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const chain =
    config.chain as Record<
      string,
      unknown
    >;

  return chain.nativeCurrency as Record<
    string,
    unknown
  >;
}

async function createConfigFile(
  contents: string,
): Promise<string> {
  const directory =
    await createTemporaryDirectory();

  const filePath =
    join(
      directory,
      'network.json',
    );

  await writeFile(
    filePath,
    contents,
    'utf8',
  );

  return filePath;
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