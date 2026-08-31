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
  MINIMUM_LEAD_ROUNDS,
  REGISTRY_ADDRESS,
  REGISTRY_RUNTIME_CODE,
  REGISTRY_RUNTIME_CODEHASH,
  VERIFIER_ADDRESS,
  VERIFIER_RUNTIME_CODE,
  VERIFIER_RUNTIME_CODEHASH,
} from './fixtures.js';

const OTHER_CHAIN_ID = CHAIN_ID + 1;

const OTHER_VERIFIER_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const WRONG_RUNTIME_CODE: Hex = '0x6003600055';
const WRONG_RUNTIME_CODEHASH = keccak256(WRONG_RUNTIME_CODE);

const OTHER_MINIMUM_LEAD_ROUNDS = MINIMUM_LEAD_ROUNDS + 1n;

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
          return REGISTRY_RUNTIME_CODE;
        }

        if (address === VERIFIER_ADDRESS) {
          return VERIFIER_RUNTIME_CODE;
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
        if (functionName === 'verifier') {
          return VERIFIER_ADDRESS;
        }

        if (functionName === 'verifierCodehash') {
          return VERIFIER_RUNTIME_CODEHASH;
        }

        if (functionName === 'minimumLeadRounds') {
          return MINIMUM_LEAD_ROUNDS;
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
      address: VERIFIER_ADDRESS,
    });

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY_ADDRESS,
        functionName: 'verifier',
      }),
    );

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY_ADDRESS,
        functionName: 'verifierCodehash',
      }),
    );

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY_ADDRESS,
        functionName: 'minimumLeadRounds',
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
      `Registry runtime codehash mismatch: expected ${REGISTRY_RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );

    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a registry verifier address mismatch', async () => {
    readContract.mockResolvedValueOnce(
      OTHER_VERIFIER_ADDRESS,
    );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry verifier address mismatch: expected ${VERIFIER_ADDRESS}, received ${OTHER_VERIFIER_ADDRESS}`
    );
  });

  it('rejects a registry verifier codehash mismatch', async () => {
    readContract
      .mockResolvedValueOnce(
        VERIFIER_ADDRESS,
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
      `Registry verifier codehash mismatch: expected ${VERIFIER_RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );
  });

  it('rejects a registry minimum lead rounds mismatch', async () => {
    readContract
      .mockResolvedValueOnce(
        VERIFIER_ADDRESS,
      )
      .mockResolvedValueOnce(
        VERIFIER_RUNTIME_CODEHASH,
      )
      .mockResolvedValueOnce(
        OTHER_MINIMUM_LEAD_ROUNDS,
      );

    await expect(
      verifyRegistryDeployment(
        client,
        DEPLOYMENT,
      ),
    ).rejects.toThrow(
      `Registry minimumLeadRounds mismatch: expected ${MINIMUM_LEAD_ROUNDS}, received ${OTHER_MINIMUM_LEAD_ROUNDS}`
    );
  });

  it('rejects a verifier address without code', async () => {
    getCode
      .mockResolvedValueOnce(
        REGISTRY_RUNTIME_CODE,
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
      `No contract deployed at verifier address ${VERIFIER_ADDRESS}`
    );
  });

  it('rejects empty verifier code', async () => {
    getCode
      .mockResolvedValueOnce(
        REGISTRY_RUNTIME_CODE,
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
      `No contract deployed at verifier address ${VERIFIER_ADDRESS}`
    );
  });

  it('rejects a verifier runtime codehash mismatch', async () => {
    getCode
      .mockResolvedValueOnce(
        REGISTRY_RUNTIME_CODE,
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
      `Verifier runtime codehash mismatch: expected ${VERIFIER_RUNTIME_CODEHASH}, received ${WRONG_RUNTIME_CODEHASH}`
    );
  });
});