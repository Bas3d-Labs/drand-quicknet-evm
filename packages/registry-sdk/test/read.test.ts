import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Address,
  PublicClient,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from '../src/abi.js';

import {
  createRegistryReader,
} from '../src/read.js';

import {
  CHAIN_ID,
  DEPLOYMENT,
  MINIMUM_LEAD_ROUNDS,
  RANDOMNESS,
  REGISTRY_ADDRESS,
  REGISTRY_RUNTIME_CODE,
  ROUND,
  VERIFIER_ADDRESS,
  VERIFIER_RUNTIME_CODE,
  VERIFIER_RUNTIME_CODEHASH,
} from './fixtures.js';

describe('createRegistryReader', () => {
  let readContract: ReturnType<typeof vi.fn>;
  let getChainId: ReturnType<typeof vi.fn>;
  let getCode: ReturnType<typeof vi.fn>;

  let client: PublicClient;

  beforeEach(() => {
    readContract =
      vi.fn().mockImplementation(
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

    getChainId =
      vi.fn().mockResolvedValue(CHAIN_ID);

    getCode =
      vi.fn().mockImplementation(
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

    client = {
      readContract,
      getChainId,
      getCode,
    } as unknown as PublicClient;
  });

  it('exposes the deployment', () => {
    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    expect(registry.deployment).toBe(
      DEPLOYMENT,
    );
  });

  it('verifies the configured deployment identity', async () => {
    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.verifyDeployment(),
    ).resolves.toBeUndefined();

    expect(
      getChainId,
    ).toHaveBeenCalledOnce();

    expect(
      getCode,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
    });

    expect(
      readContract,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'verifier',
    });

    expect(
      readContract,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'verifierCodehash',
    });

    expect(
      readContract,
    ).not.toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'minimumLeadRounds',
    });

    expect(
      readContract,
    ).toHaveBeenCalledTimes(2);

    expect(
      getCode,
    ).toHaveBeenCalledWith({
      address: VERIFIER_ADDRESS,
    });
  });

  it('reads the verifier address', async () => {
    readContract.mockResolvedValue(
      VERIFIER_ADDRESS,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.verifier(),
    ).resolves.toBe(VERIFIER_ADDRESS);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'verifier',
    });
  });

  it('reads the verifier codehash', async () => {
    readContract.mockResolvedValue(
      VERIFIER_RUNTIME_CODEHASH,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.verifierCodehash(),
    ).resolves.toBe(
      VERIFIER_RUNTIME_CODEHASH,
    );

    expect(
      readContract,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'verifierCodehash',
    });
  });

  it('reads the minimum lead rounds', async () => {
    readContract.mockResolvedValue(
      MINIMUM_LEAD_ROUNDS,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.minimumLeadRounds(),
    ).resolves.toBe(
      MINIMUM_LEAD_ROUNDS,
    );

    expect(
      readContract,
    ).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'minimumLeadRounds',
    });
  });

  it('checks whether a round is stored', async () => {
    readContract.mockResolvedValue(true);

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.isStored(ROUND),
    ).resolves.toBe(true);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'isStored',
      args: [ROUND],
    });
  });

  it('returns a stored beacon', async () => {
    readContract.mockResolvedValue(
      RANDOMNESS,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.getBeacon(ROUND),
    ).resolves.toBe(RANDOMNESS);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'getBeacon',
      args: [ROUND],
    });
  });

  it('returns a stored beacon at a specific block', async () => {
    const blockNumber = 123_456n;

    readContract.mockResolvedValue(
      RANDOMNESS,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.getBeacon(
        ROUND,
        blockNumber,
      ),
    ).resolves.toBe(RANDOMNESS);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'getBeacon',
      args: [ROUND],
      blockNumber,
    });
  });

  it('reads the scheduled time for a round', async () => {
    const scheduledTime = 1_700_000_000n;

    readContract.mockResolvedValue(
      scheduledTime,
    );

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.roundScheduledTime(ROUND),
    ).resolves.toBe(scheduledTime);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'roundScheduledTime',
      args: [ROUND],
    });
  });

  it('reads the round for a timestamp', async () => {
    const timestamp = 1_700_000_000n;

    readContract.mockResolvedValue(ROUND);

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.roundAt(timestamp),
    ).resolves.toBe(ROUND);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'roundAt',
      args: [timestamp],
    });
  });

  it('reads the latest scheduled round', async () => {
    readContract.mockResolvedValue(ROUND);

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.latestScheduledRound(),
    ).resolves.toBe(ROUND);

    expect(readContract).toHaveBeenCalledWith({
      address: REGISTRY_ADDRESS,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'latestScheduledRound',
    });
  });

  it('propagates contract read errors', async () => {
    const error =
      new Error('RPC read failed');

    readContract.mockRejectedValue(error);

    const registry = createRegistryReader({
      client,
      deployment: DEPLOYMENT,
    });

    await expect(
      registry.isStored(ROUND),
    ).rejects.toBe(error);
  });
});