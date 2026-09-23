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
  parseCompressedSignature,
} from '@based-labs/drand-quicknet';

import type {
  RegistrySignature,
} from '../src/types.js';

import {
  drandQuicknetBeaconRegistryAbi,
} from '../src/abi.js';

import {
  simulateSubmitBeacon,
  simulateSubmitBeaconWithWitness,
  submitBeacon,
  submitBeaconWithWitness,
} from '../src/write.js';

import {
  ACCOUNT,
  DEPLOYMENT,
  RANDOMNESS,
  REGISTRY_ADDRESS,
  ROUND,
  TRANSACTION_HASH,
} from './fixtures.js';

const WITNESS_ROUND = 1000n;

const WITNESS_SIGNATURE = parseCompressedSignature(
  'b44679b9a59af2ec876b1a6b1ad52ea9' +
  'b1615fc3982b19576350f93447cb1125' +
  'e342b73a8dd2bacbe47e4b6b63ed5e39',
);

const WITNESS_Y_HI =
  0x11f92e4521ef54f047b64b85fa98db2dn;

const WITNESS_Y_LO =
  0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2n;

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
          WITNESS_SIGNATURE,
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
          signature: WITNESS_SIGNATURE,
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
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [
          ROUND,
          WITNESS_SIGNATURE,
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
          signature: WITNESS_SIGNATURE,
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
          WITNESS_SIGNATURE,
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
        signature: WITNESS_SIGNATURE,
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
          WITNESS_SIGNATURE,
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
        signature: WITNESS_SIGNATURE,
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
          WITNESS_SIGNATURE,
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
        signature: WITNESS_SIGNATURE,
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
          signature: WITNESS_SIGNATURE,
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
          WITNESS_SIGNATURE,
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
          signature: WITNESS_SIGNATURE,
        }),
      ).rejects.toBe(error);
    });
  });

  describe('witness submission', () => {
    function simulationOptions() {
      return {
        publicClient,
        deployment: DEPLOYMENT,
        account: ACCOUNT,
        round: WITNESS_ROUND,
        signature: WITNESS_SIGNATURE,
        yHi: WITNESS_Y_HI,
        yLo: WITNESS_Y_LO,
      } as const;
    }

    function simulatedRequest() {
      return {
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeaconWithWitness',
        args: [
          WITNESS_ROUND,
          WITNESS_SIGNATURE,
          WITNESS_Y_HI,
          WITNESS_Y_LO,
        ],
        // Ensure simulation-provided transaction fields survive forwarding.
        gas: 1_000_000n,
        nonce: 7,
      } as const;
    }

    it('simulates with the expected witness arguments', async () => {
      const simulation = {
        request: simulatedRequest(),
        result: RANDOMNESS,
      };

      simulateContract.mockResolvedValue(simulation);

      const result = await simulateSubmitBeaconWithWitness(
        simulationOptions(),
      );

      expect(result).toBe(simulation);
      expect(simulateContract).toHaveBeenCalledOnce();

      expect(simulateContract).toHaveBeenCalledWith({
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeaconWithWitness',
        args: [
          WITNESS_ROUND,
          WITNESS_SIGNATURE,
          WITNESS_Y_HI,
          WITNESS_Y_LO,
        ],
      });

      expect(writeContract).not.toHaveBeenCalled();
    });

    it('forwards empty signature and zero witness values', async () => {
      const request = {
        ...simulatedRequest(),
        args: [
          WITNESS_ROUND,
          '0x',
          0n,
          0n,
        ],
      } as const;

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      const result = await simulateSubmitBeaconWithWitness({
        ...simulationOptions(),
        signature: '0x' as RegistrySignature,
        yHi: 0n,
        yLo: 0n,
      });

      expect(result.result).toBe(RANDOMNESS);
      expect(simulateContract).toHaveBeenCalledOnce();

      expect(simulateContract).toHaveBeenCalledWith({
        account: ACCOUNT,
        address: REGISTRY_ADDRESS,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeaconWithWitness',
        args: [
          WITNESS_ROUND,
          '0x',
          0n,
          0n,
        ],
      });

      expect(writeContract).not.toHaveBeenCalled();
    });

    it('broadcasts the simulated request and returns its result', async () => {
      const request = simulatedRequest();

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      writeContract.mockResolvedValue(TRANSACTION_HASH);

      const result = await submitBeaconWithWitness({
        ...simulationOptions(),
        walletClient,
      });

      expect(simulateContract).toHaveBeenCalledOnce();
      expect(writeContract).toHaveBeenCalledOnce();

      expect(
        simulateContract.mock.invocationCallOrder[0],
      ).toBeLessThan(
        writeContract.mock.invocationCallOrder[0],
      );

      // Forward the exact request, including gas and nonce.
      expect(writeContract.mock.calls[0]?.[0]).toBe(request);

      expect(result).toEqual({
        hash: TRANSACTION_HASH,
        randomness: RANDOMNESS,
      });
    });

    it('does not broadcast or retry when simulation fails', async () => {
      const error = new Error('Witness simulation reverted');

      simulateContract.mockRejectedValue(error);

      await expect(
        submitBeaconWithWitness({
          ...simulationOptions(),
          walletClient,
        }),
      ).rejects.toBe(error);

      expect(simulateContract).toHaveBeenCalledOnce();
      expect(writeContract).not.toHaveBeenCalled();
    });

    it('propagates wallet failures without retrying', async () => {
      const request = simulatedRequest();
      const error = new Error('Transaction submission uncertain');

      simulateContract.mockResolvedValue({
        request,
        result: RANDOMNESS,
      });

      writeContract.mockRejectedValue(error);

      await expect(
        submitBeaconWithWitness({
          ...simulationOptions(),
          walletClient,
        }),
      ).rejects.toBe(error);

      expect(simulateContract).toHaveBeenCalledOnce();
      expect(writeContract).toHaveBeenCalledOnce();
      expect(writeContract.mock.calls[0]?.[0]).toBe(request);
    });
  });
});