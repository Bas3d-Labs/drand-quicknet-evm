import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Account,
  Address,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  CompressedSignature,
  UncompressedSignature,
} from '@based-labs/drand-quicknet';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const quicknetMocks = vi.hoisted(() => ({
  fetchBeacon: vi.fn(),
  decompressSignature: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  createRegistryReader: vi.fn(),
  submitBeacon: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet',
  () => quicknetMocks,
);

vi.mock(
  '@based-labs/drand-quicknet-registry',
  () => registryMocks,
);

import {
  importQuicknetRound,
} from '../src/import-round.js';

const CHAIN_ID = 46630;

const REGISTRY_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const ACCOUNT_ADDRESS: Address = '0x2222222222222222222222222222222222222222';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ROUND = 20_791_007n;

const COMPRESSED_SIGNATURE =
  `0x${'11'.repeat(48)}` as CompressedSignature;

const UNCOMPRESSED_SIGNATURE =
  `0x${'22'.repeat(96)}` as UncompressedSignature;

const RANDOMNESS: Hex =
  '0x3333333333333333333333333333333333333333333333333333333333333333';

const OTHER_RANDOMNESS: Hex =
  '0x4444444444444444444444444444444444444444444444444444444444444444';

const SUBMITTED_TRANSACTION_HASH: Hex =
  '0x5555555555555555555555555555555555555555555555555555555555555555';

const RECEIPT_TRANSACTION_HASH: Hex =
  '0x6666666666666666666666666666666666666666666666666666666666666666';

const RECEIPT_BLOCK_NUMBER = 123_456n;

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
};

describe('importQuicknetRound', () => {
  let verifyDeployment: ReturnType<typeof vi.fn>;
  let isStored: ReturnType<typeof vi.fn>;
  let getBeacon: ReturnType<typeof vi.fn>;
  let waitForTransactionReceipt:
    ReturnType<typeof vi.fn>;

  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let account: Account;

  beforeEach(() => {
    vi.clearAllMocks();

    verifyDeployment =
      vi.fn().mockResolvedValue(undefined);

    isStored =
      vi.fn().mockResolvedValue(false);

    getBeacon =
      vi.fn().mockResolvedValue(RANDOMNESS);

    registryMocks.createRegistryReader.mockReturnValue({
      deployment: DEPLOYMENT,
      verifyDeployment,
      isStored,
      getBeacon,
    });

    quicknetMocks.fetchBeacon.mockResolvedValue({
      round: ROUND,
      signature: COMPRESSED_SIGNATURE,
    });

    quicknetMocks.decompressSignature.mockReturnValue(
      UNCOMPRESSED_SIGNATURE,
    );

    registryMocks.submitBeacon.mockResolvedValue({
      hash: SUBMITTED_TRANSACTION_HASH,
      randomness: RANDOMNESS,
    });

    waitForTransactionReceipt =
      vi.fn().mockResolvedValue({
        status: 'success',
        transactionHash: RECEIPT_TRANSACTION_HASH,
        blockNumber: RECEIPT_BLOCK_NUMBER,
      });

    publicClient = {
      waitForTransactionReceipt,
    } as unknown as PublicClient;

    walletClient = {} as WalletClient;

    account = {
      address: ACCOUNT_ADDRESS,
    } as unknown as Account;
  });

  function importRound(
    round = ROUND,
  ) {
    return importQuicknetRound({
      publicClient,
      walletClient,
      account,
      deployment: DEPLOYMENT,
      round,
    });
  }

  it('rejects round zero', async () => {
    await expect(
      importRound(0n),
    ).rejects.toThrow(
      'Quicknet round must be greater than zero.',
    );

    expect(
      registryMocks.createRegistryReader,
    ).not.toHaveBeenCalled();

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('rejects a negative round', async () => {
    await expect(
      importRound(-1n),
    ).rejects.toThrow(RangeError);

    expect(
      registryMocks.createRegistryReader,
    ).not.toHaveBeenCalled();
  });

  it('creates a reader for the configured registry', async () => {
    await importRound();

    expect(
      registryMocks.createRegistryReader,
    ).toHaveBeenCalledWith({
      client: publicClient,
      deployment: DEPLOYMENT,
    });
  });

  it('verifies the registry deployment before reading it', async () => {
    await importRound();

    expect(
      verifyDeployment,
    ).toHaveBeenCalledOnce();

    expect(
      firstInvocationOrder(verifyDeployment),
    ).toBeLessThan(
      firstInvocationOrder(isStored),
    );
  });

  it('propagates deployment verification failures', async () => {
    const error = new Error('Invalid registry deployment');

    verifyDeployment.mockRejectedValue(error);

    await expect(
      importRound(),
    ).rejects.toBe(error);

    expect(
      isStored,
    ).not.toHaveBeenCalled();

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();
  });

  it('returns an already-stored beacon without fetching or submitting', async () => {
    isStored.mockResolvedValue(true);

    getBeacon.mockResolvedValue(RANDOMNESS);

    const result =
      await importRound();

    expect(result).toEqual({
      status: 'already-stored',
      round: ROUND,
      randomness: RANDOMNESS,
    });

    expect(
      isStored,
    ).toHaveBeenCalledWith(ROUND);

    expect(
      getBeacon,
    ).toHaveBeenCalledWith(ROUND);

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();

    expect(
      quicknetMocks.decompressSignature,
    ).not.toHaveBeenCalled();

    expect(
      registryMocks.submitBeacon,
    ).not.toHaveBeenCalled();

    expect(
      waitForTransactionReceipt,
    ).not.toHaveBeenCalled();
  });

  it('fetches exactly the requested Quicknet round', async () => {
    await importRound();

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledOnce();

    expect(
      quicknetMocks.fetchBeacon,
    ).toHaveBeenCalledWith(ROUND);
  });

  it('rejects a fetched beacon for a different round', async () => {
    quicknetMocks.fetchBeacon.mockResolvedValue({
      round: ROUND + 1n,
      signature: COMPRESSED_SIGNATURE,
    });

    await expect(
      importRound(),
    ).rejects.toThrow(
      `Quicknet round mismatch: requested ${ROUND}, received ${ROUND + 1n}`,
    );

    expect(
      quicknetMocks.decompressSignature,
    ).not.toHaveBeenCalled();

    expect(
      registryMocks.submitBeacon,
    ).not.toHaveBeenCalled();
  });

  it('propagates beacon fetch failures', async () => {
    const error = new Error('Quicknet unavailable');

    quicknetMocks.fetchBeacon.mockRejectedValue(
      error,
    );

    await expect(
      importRound(),
    ).rejects.toBe(error);

    expect(
      quicknetMocks.decompressSignature,
    ).not.toHaveBeenCalled();

    expect(
      registryMocks.submitBeacon,
    ).not.toHaveBeenCalled();
  });

  it('decompresses the fetched signature before submission', async () => {
    await importRound();

    expect(
      quicknetMocks.decompressSignature,
    ).toHaveBeenCalledOnce();

    expect(
      quicknetMocks.decompressSignature,
    ).toHaveBeenCalledWith(
      COMPRESSED_SIGNATURE,
    );

    expect(
      registryMocks.submitBeacon,
    ).toHaveBeenCalledWith({
      publicClient,
      walletClient,
      deployment: DEPLOYMENT,
      account,
      round: ROUND,
      signature: UNCOMPRESSED_SIGNATURE,
    });
  });

  it('does not submit when signature decompression fails', async () => {
    const error = new Error('Invalid compressed point');

    quicknetMocks.decompressSignature.mockImplementation(
      () => {
        throw error;
      },
    );

    await expect(
      importRound(),
    ).rejects.toBe(error);

    expect(
      registryMocks.submitBeacon,
    ).not.toHaveBeenCalled();

    expect(
      waitForTransactionReceipt,
    ).not.toHaveBeenCalled();
  });

  it('propagates registry submission failures', async () => {
    const error = new Error('Simulation reverted');

    registryMocks.submitBeacon.mockRejectedValue(
      error,
    );

    await expect(
      importRound(),
    ).rejects.toBe(error);

    expect(
      waitForTransactionReceipt,
    ).not.toHaveBeenCalled();
  });

  it('waits for the submitted transaction receipt', async () => {
    await importRound();

    expect(
      waitForTransactionReceipt,
    ).toHaveBeenCalledOnce();

    expect(
      waitForTransactionReceipt,
    ).toHaveBeenCalledWith({
      hash: SUBMITTED_TRANSACTION_HASH,
    });
  });

  it('rejects a reverted registry transaction', async () => {
    waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      transactionHash: RECEIPT_TRANSACTION_HASH,
      blockNumber: RECEIPT_BLOCK_NUMBER,
    });

    await expect(
      importRound(),
    ).rejects.toThrow(
      `Registry submission reverted: ${RECEIPT_TRANSACTION_HASH}`,
    );

    expect(
      getBeacon,
    ).not.toHaveBeenCalled();
  });

  it('reads the stored beacon at the receipt block after successful inclusion', async () => {
    await importRound();

    expect(
      getBeacon,
    ).toHaveBeenCalledOnce();

    expect(
      getBeacon,
    ).toHaveBeenCalledWith(
      ROUND,
      RECEIPT_BLOCK_NUMBER,
    );

    expect(
      firstInvocationOrder(waitForTransactionReceipt),
    ).toBeLessThan(
      firstInvocationOrder(getBeacon),
    );
  });

  it('retries a failed receipt-block beacon read and then succeeds', async () => {
    vi.useFakeTimers();

    try {
      const error = new Error('RPC backend is behind');

      getBeacon
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(RANDOMNESS);

      const resultPromise =
        importRound();

      await vi.runAllTimersAsync();

      await expect(
        resultPromise,
      ).resolves.toEqual({
        status: 'imported',
        round: ROUND,
        randomness: RANDOMNESS,
        transactionHash:
          RECEIPT_TRANSACTION_HASH,
      });

      expect(
        getBeacon,
      ).toHaveBeenCalledTimes(2);

      expect(
        getBeacon,
      ).toHaveBeenNthCalledWith(
        1,
        ROUND,
        RECEIPT_BLOCK_NUMBER,
      );

      expect(
        getBeacon,
      ).toHaveBeenNthCalledWith(
        2,
        ROUND,
        RECEIPT_BLOCK_NUMBER,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the last error after receipt-block beacon read retries are exhausted', async () => {
    vi.useFakeTimers();

    try {
      const firstError = new Error('RPC backend is behind');
      const lastError = new Error('RPC backend is still behind');

      getBeacon
        .mockRejectedValueOnce(firstError)
        .mockRejectedValueOnce(firstError)
        .mockRejectedValueOnce(firstError)
        .mockRejectedValueOnce(firstError)
        .mockRejectedValueOnce(lastError);

      const resultPromise = importRound();

      const rejection =
        expect(resultPromise).rejects.toBe(
          lastError,
        );

      await vi.runAllTimersAsync();

      await rejection;

      expect(
        getBeacon,
      ).toHaveBeenCalledTimes(5);

      for (const call of getBeacon.mock.calls) {
        expect(call).toEqual([
          ROUND,
          RECEIPT_BLOCK_NUMBER,
        ]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stored randomness value that differs from simulation', async () => {
    getBeacon.mockResolvedValue(
      OTHER_RANDOMNESS,
    );

    await expect(
      importRound(),
    ).rejects.toThrow(
      `Stored randomness mismatch for Quicknet round ${ROUND}: simulated ${RANDOMNESS}, stored ${OTHER_RANDOMNESS}`,
    );
  });

  it('accepts equivalent randomness with different hex casing', async () => {
    const lower: Hex =
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';

    const upper = `0x${lower.slice(2).toUpperCase()}` as Hex;

    registryMocks.submitBeacon.mockResolvedValue({
      hash: SUBMITTED_TRANSACTION_HASH,
      randomness: upper,
    });

    getBeacon.mockResolvedValue(lower);

    await expect(
      importRound(),
    ).resolves.toMatchObject({
      status: 'imported',
      randomness: lower,
    });
  });

  it('returns the imported beacon and included transaction hash', async () => {
    const result = await importRound();

    expect(result).toEqual({
      status: 'imported',
      round: ROUND,
      randomness: RANDOMNESS,
      transactionHash:
        RECEIPT_TRANSACTION_HASH,
    });
  });

  it('uses a provided beacon without fetching it again', async () => {
    const beacon = {
      round: ROUND,
      signature:
        COMPRESSED_SIGNATURE,
    };

    const result =
      await importQuicknetRound({
        publicClient,
        walletClient,
        account,
        deployment: DEPLOYMENT,
        round: ROUND,
        beacon,
      });

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();

    expect(
      quicknetMocks.decompressSignature,
    ).toHaveBeenCalledWith(
      COMPRESSED_SIGNATURE,
    );

    expect(result.status).toBe(
      'imported',
    );
  });

  it('rejects a provided beacon for a different round', async () => {
    const beacon = {
      round: ROUND + 1n,
      signature:
        COMPRESSED_SIGNATURE,
    };

    await expect(
      importQuicknetRound({
        publicClient,
        walletClient,
        account,
        deployment: DEPLOYMENT,
        round: ROUND,
        beacon,
      }),
    ).rejects.toThrow(
      `Quicknet round mismatch: requested ${ROUND}, received ${ROUND + 1n}.`,
    );

    expect(
      quicknetMocks.fetchBeacon,
    ).not.toHaveBeenCalled();

    expect(
      registryMocks.submitBeacon,
    ).not.toHaveBeenCalled();
  });

  it('performs the import steps in the expected order', async () => {
    await importRound();

    const verifyOrder = firstInvocationOrder(verifyDeployment);

    const storedOrder = firstInvocationOrder(isStored);

    const fetchOrder = firstInvocationOrder(
      quicknetMocks.fetchBeacon,
    );

    const decompressOrder = firstInvocationOrder(
      quicknetMocks.decompressSignature,
    );

    const submitOrder = firstInvocationOrder(
      registryMocks.submitBeacon,
    );

    const receiptOrder = firstInvocationOrder(
      waitForTransactionReceipt,
    );

    const readOrder = firstInvocationOrder(getBeacon);

    expect(verifyOrder).toBeLessThan(
      storedOrder,
    );

    expect(storedOrder).toBeLessThan(
      fetchOrder,
    );

    expect(fetchOrder).toBeLessThan(
      decompressOrder,
    );

    expect(decompressOrder).toBeLessThan(
      submitOrder,
    );

    expect(submitOrder).toBeLessThan(
      receiptOrder,
    );

    expect(receiptOrder).toBeLessThan(
      readOrder,
    );
  });
});

function firstInvocationOrder(
  mock: {
    mock: {
      invocationCallOrder: number[];
    };
  },
): number {
  const order =
    mock.mock.invocationCallOrder[0];

  if (order === undefined) {
    throw new Error(
      'Expected mock to have been called.',
    );
  }

  return order;
}