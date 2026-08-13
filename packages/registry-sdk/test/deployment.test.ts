import {
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  verifyRegistryDeployment,
} from '../src/deployment.js';

import {
  CHAIN_ID,
  DEPLOYMENT,
  ORACLE_ADDRESS,
  ORACLE_RUNTIME_CODE,
  ORACLE_RUNTIME_CODEHASH,
  REGISTRY_ADDRESS,
  RUNTIME_CODE,
  RUNTIME_CODEHASH,
} from './fixtures.js';

const OTHER_CHAIN_ID = CHAIN_ID + 1;

const OTHER_ORACLE_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const WRONG_RUNTIME_CODE: Hex = '0x6003600055';
const WRONG_RUNTIME_CODEHASH = keccak256(WRONG_RUNTIME_CODE);

describe('verifyRegistryDeployment', () => {
  const getChainId =
    vi.fn();

  const getCode =
    vi.fn();

  const readContract =
    vi.fn();

  const client = {
    getChainId,
    getCode,
    readContract,
  } as unknown as PublicClient;

  beforeEach(() => {
    vi.clearAllMocks();

    getChainId.mockResolvedValue(
      CHAIN_ID,
    );

    getCode.mockImplementation(
      async ({
        address,
      }: {
        address: Address;
      }) => {
        if (address === REGISTRY_ADDRESS) {
          return RUNTIME_CODE;
        }

        if (address === ORACLE_ADDRESS) {
          return ORACLE_RUNTIME_CODE;
        }

        return undefined;
      },
    );

    readContract.mockImplementation(
      async ({
        functionName,
      }: {
        functionName: string;
      }) => {
        if (functionName === 'oracle') {
          return ORACLE_ADDRESS;
        }

        if (functionName === 'oracleCodehash') {
          return ORACLE_RUNTIME_CODEHASH;
        }

        throw new Error(`Unexpected function: ${functionName}`);
      },
    );
  });

  it('verifies a matching deployment', async () => {
    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).resolves.toBeUndefined();

    expect(getChainId).toHaveBeenCalledOnce();

    expect(getCode).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
    });

    expect(getCode).toHaveBeenCalledWith({
      address: ORACLE_ADDRESS,
    });

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY_ADDRESS,
        functionName: 'oracle',
      }),
    );

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY_ADDRESS,
        functionName: 'oracleCodehash',
      }),
    );
  });

  it('rejects a chain mismatch', async () => {
    getChainId.mockResolvedValue(
      OTHER_CHAIN_ID,
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry chain mismatch: expected ${CHAIN_ID}, received ${OTHER_CHAIN_ID}`
    );

    expect(getCode).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a registry address without code', async () => {
    getCode.mockResolvedValueOnce(
      undefined,
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at registry address ${REGISTRY_ADDRESS}`
    );

    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects empty registry code', async () => {
    getCode.mockResolvedValueOnce(
      '0x',
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at registry address ${REGISTRY_ADDRESS}`
    );

    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a registry runtime codehash mismatch', async () => {
    getCode.mockResolvedValueOnce(
      WRONG_RUNTIME_CODE,
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry runtime codehash mismatch: expected ${RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );

    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a registry oracle address mismatch', async () => {
    readContract.mockResolvedValueOnce(
      OTHER_ORACLE_ADDRESS,
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry oracle address mismatch: expected ${ORACLE_ADDRESS}, received ${OTHER_ORACLE_ADDRESS}`
    );
  });

  it('rejects a registry oracle codehash mismatch', async () => {
    readContract
      .mockResolvedValueOnce(
        ORACLE_ADDRESS,
      )
      .mockResolvedValueOnce(
        WRONG_RUNTIME_CODEHASH,
      );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry oracle codehash mismatch: expected ${ORACLE_RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );
  });

  it('rejects an oracle address without code', async () => {
    getCode
      .mockResolvedValueOnce(
        RUNTIME_CODE,
      )
      .mockResolvedValueOnce(
        undefined,
      );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at oracle address ${ORACLE_ADDRESS}`
    );
  });

  it('rejects empty oracle code', async () => {
    getCode
      .mockResolvedValueOnce(
        RUNTIME_CODE,
      )
      .mockResolvedValueOnce(
        '0x',
      );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `No contract deployed at oracle address ${ORACLE_ADDRESS}`
    );
  });

  it('rejects an oracle runtime codehash mismatch', async () => {
    getCode
      .mockResolvedValueOnce(
        RUNTIME_CODE,
      )
      .mockResolvedValueOnce(
        WRONG_RUNTIME_CODE,
      );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Oracle runtime codehash mismatch: expected ${ORACLE_RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );
  });
});