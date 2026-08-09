import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
  WalletClient,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from '../src/abi.js';

import {
  simulateSubmitBeacon,
  submitBeacon,
} from '../src/write.js';

import {
  ACCOUNT,
  DEPLOYMENT,
  RANDOMNESS,
  REGISTRY_ADDRESS,
  ROUND,
  TRANSACTION_HASH,
  UNCOMPRESSED_SIGNATURE,
} from './fixtures.js';

describe('registry submission', () => {
  let simulateContract: ReturnType<typeof vi.fn>;
  let writeContract: ReturnType<typeof vi.fn>;

  let publicClient: PublicClient;
  let walletClient: WalletClient;

  beforeEach(() => {
    simulateContract = vi.fn();
    writeContract = vi.fn();

    publicClient = {
      simulateContract,
    } as unknown as PublicClient;

    walletClient = {
      writeContract,
    } as unknown as WalletClient;
  });

  describe('simulateSubmitBeacon', () => {
    it('simulates submitBeacon with the expected arguments', async () => {
      const request = {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      const result =
        await simulateSubmitBeacon({
          publicClient,
          deployment: DEPLOYMENT,
          account: ACCOUNT,
          round: ROUND,
          signature:
            UNCOMPRESSED_SIGNATURE,
        });

      expect(result).toEqual({
        request,
        result: RANDOMNESS,
      });

      expect(
        simulateContract,
      ).toHaveBeenCalledOnce();

      expect(
        simulateContract,
      ).toHaveBeenCalledWith({
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi:
          drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      });
    });

    it('propagates simulation failures', async () => {
      const error =
        new Error('Simulation reverted');

      simulateContract.mockRejectedValue(
        error,
      );

      await expect(
        simulateSubmitBeacon({
          publicClient,
          deployment: DEPLOYMENT,
          account: ACCOUNT,
          round: ROUND,
          signature:
            UNCOMPRESSED_SIGNATURE,
        }),
      ).rejects.toBe(error);
    });
  });

  describe('submitBeacon', () => {
    it('simulates before broadcasting', async () => {
      const request = {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      writeContract.mockResolvedValue(
        TRANSACTION_HASH,
      );

      await submitBeacon({
        publicClient,
        walletClient,
        deployment: DEPLOYMENT,
        account: ACCOUNT,
        round: ROUND,
        signature:
          UNCOMPRESSED_SIGNATURE,
      });

      expect(
        simulateContract,
      ).toHaveBeenCalledOnce();

      expect(
        writeContract,
      ).toHaveBeenCalledOnce();

      expect(
        simulateContract.mock.invocationCallOrder[0],
      ).toBeLessThan(
        writeContract.mock.invocationCallOrder[0],
      );
    });

    it('broadcasts the simulated request', async () => {
      const request = {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      writeContract.mockResolvedValue(
        TRANSACTION_HASH,
      );

      await submitBeacon({
        publicClient,
        walletClient,
        deployment: DEPLOYMENT,
        account: ACCOUNT,
        round: ROUND,
        signature:
          UNCOMPRESSED_SIGNATURE,
      });

      expect(
        writeContract,
      ).toHaveBeenCalledWith(request);
    });

    it('returns the transaction hash and simulated randomness', async () => {
      const request = {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      writeContract.mockResolvedValue(
        TRANSACTION_HASH,
      );

      const result = await submitBeacon({
        publicClient,
        walletClient,
        deployment: DEPLOYMENT,
        account: ACCOUNT,
        round: ROUND,
        signature:
          UNCOMPRESSED_SIGNATURE,
      });

      expect(result).toEqual({
        hash: TRANSACTION_HASH,
        randomness: RANDOMNESS,
      });
    });

    it('does not broadcast when simulation fails', async () => {
      const error =
        new Error('Simulation reverted');

      simulateContract.mockRejectedValue(
        error,
      );

      await expect(
        submitBeacon({
          publicClient,
          walletClient,
          deployment: DEPLOYMENT,
          account: ACCOUNT,
          round: ROUND,
          signature:
            UNCOMPRESSED_SIGNATURE,
        }),
      ).rejects.toBe(error);

      expect(
        writeContract,
      ).not.toHaveBeenCalled();
    });

    it('propagates wallet submission failures', async () => {
      const request = {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          UNCOMPRESSED_SIGNATURE,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      const error =
        new Error('Transaction rejected');

      writeContract.mockRejectedValue(error);

      await expect(
        submitBeacon({
          publicClient,
          walletClient,
          deployment: DEPLOYMENT,
          account: ACCOUNT,
          round: ROUND,
          signature:
            UNCOMPRESSED_SIGNATURE,
        }),
      ).rejects.toBe(error);
    });
  });
});