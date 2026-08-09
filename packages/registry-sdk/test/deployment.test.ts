import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Hex,
  PublicClient,
} from 'viem';

import {
  verifyRegistryDeployment,
} from '../src/deployment.js';

import {
  CHAIN_ID,
  DEPLOYMENT,
  REGISTRY_ADDRESS,
  RUNTIME_CODE,
} from './fixtures.js';

function createPublicClientMock(
  options: {
    chainId?: number;
    code?: Hex | undefined;
  } = {},
) {
  const chainId =
    options.chainId ?? CHAIN_ID;

  const code =
    'code' in options
      ? options.code
      : RUNTIME_CODE;

  const getChainId =
    vi.fn().mockResolvedValue(chainId);

  const getCode =
    vi.fn().mockResolvedValue(code);

  const client = {
    getChainId,
    getCode,
  } as unknown as PublicClient;

  return {
    client,
    getChainId,
    getCode,
  };
}

describe('verifyRegistryDeployment', () => {
  it('accepts the expected chain, address code, and runtime codehash', async () => {
    const {
      client,
      getChainId,
      getCode,
    } = createPublicClientMock();

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).resolves.toBeUndefined();

    expect(
      getChainId,
    ).toHaveBeenCalledOnce();

    expect(
      getCode,
    ).toHaveBeenCalledOnce();

    expect(
      getCode,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
    });
  });

  it('rejects a chain ID mismatch', async () => {
    const {
      client,
      getCode,
    } = createPublicClientMock({
      chainId: CHAIN_ID + 1,
    });

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry chain mismatch: expected ${CHAIN_ID}, received ${CHAIN_ID + 1}`,
    );

    expect(
      getCode,
    ).not.toHaveBeenCalled();
  });

  it('rejects an address with no code', async () => {
    const {
      client,
    } = createPublicClientMock({
      code: undefined,
    });

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at registry address ${REGISTRY_ADDRESS}`,
    );
  });

  it('rejects an address with empty code', async () => {
    const {
      client,
    } = createPublicClientMock({
      code: '0x',
    });

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at registry address ${REGISTRY_ADDRESS}`,
    );
  });

  it('rejects a runtime codehash mismatch', async () => {
    const {
      client,
    } = createPublicClientMock({
      code: '0x6002600055',
    });

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      'Registry runtime codehash mismatch',
    );
  });
});