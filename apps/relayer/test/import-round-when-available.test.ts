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

import {
  type CompressedSignature,
  type QuicknetBeacon,
} from '@based-labs/drand-quicknet';

import {
  type RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

const registryMocks = vi.hoisted(() => ({
  createRegistryReader: vi.fn(),
}));

const waitMocks = vi.hoisted(() => ({
  waitForQuicknetRound: vi.fn(),
}));

const fetchMocks = vi.hoisted(() => ({
  fetchQuicknetBeaconWithRetry:
    vi.fn(),
}));

const importMocks = vi.hoisted(() => ({
  importQuicknetRound: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet-registry',
  () => registryMocks,
);

vi.mock(
  '../src/wait-for-round.js',
  () => waitMocks,
);

vi.mock(
  '../src/fetch-beacon-with-retry.js',
  () => fetchMocks,
);

vi.mock(
  '../src/import-round.js',
  () => importMocks,
);

import {
  importQuicknetRoundWhenAvailable,
} from '../src/import-round-when-available.js';

const CHAIN_ID = 46_630;

const REGISTRY_ADDRESS: Address = '0x1111111111111111111111111111111111111111';

const ACCOUNT_ADDRESS: Address = '0x2222222222222222222222222222222222222222';

const RUNTIME_CODEHASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ROUND = 31_089_008n;

const COMPRESSED_SIGNATURE = `0x${'11'.repeat(48)}` as CompressedSignature;

const RANDOMNESS: Hex =
  '0x3333333333333333333333333333333333333333333333333333333333333333';

const TRANSACTION_HASH: Hex =
  '0x4444444444444444444444444444444444444444444444444444444444444444';

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
};

const BEACON: QuicknetBeacon = {
  round: ROUND,
  signature: COMPRESSED_SIGNATURE,
};

describe(
  'importQuicknetRoundWhenAvailable',
  () => {
    let verifyDeployment:ReturnType<typeof vi.fn>;
    let isStored:ReturnType<typeof vi.fn>;
    let getBeacon:ReturnType<typeof vi.fn>;
    let publicClient:PublicClient;
    let walletClient:WalletClient;
    let account:Account;

    beforeEach(() => {
      vi.clearAllMocks();

      verifyDeployment =
        vi.fn().mockResolvedValue(
          undefined,
        );

      isStored =
        vi.fn().mockResolvedValue(
          false,
        );

      getBeacon =
        vi.fn().mockResolvedValue(
          RANDOMNESS,
        );

      registryMocks
        .createRegistryReader
        .mockReturnValue({
          verifyDeployment,
          isStored,
          getBeacon,
        });

      waitMocks
        .waitForQuicknetRound
        .mockResolvedValue(
          undefined,
        );

      fetchMocks
        .fetchQuicknetBeaconWithRetry
        .mockResolvedValue(
          BEACON,
        );

      importMocks
        .importQuicknetRound
        .mockResolvedValue({
          status: 'imported',
          round: ROUND,
          randomness: RANDOMNESS,
          transactionHash:
            TRANSACTION_HASH,
        });

      publicClient =
        {} as unknown as PublicClient;

      walletClient =
        {} as unknown as WalletClient;

      account = {
        address: ACCOUNT_ADDRESS,
      } as unknown as Account;
    });

    function importRound(
      options: {
        round?: bigint;
        maxFetchAttempts?: number;
        fetchRetryDelayMs?: number;
      } = {},
    ) {
      const round =
        options.round ??
        ROUND;

      const importOptions = {
        publicClient,
        walletClient,
        account,
        deployment:
          DEPLOYMENT,
        round,
      };

      if (
        options.maxFetchAttempts !==
        undefined
      ) {
        return importQuicknetRoundWhenAvailable({
          ...importOptions,
          maxFetchAttempts:
            options.maxFetchAttempts,
          ...(options.fetchRetryDelayMs ===
          undefined
            ? {}
            : {
                fetchRetryDelayMs:
                  options.fetchRetryDelayMs,
              }),
        });
      }

      if (
        options.fetchRetryDelayMs !==
        undefined
      ) {
        return importQuicknetRoundWhenAvailable({
          ...importOptions,
          fetchRetryDelayMs:
            options.fetchRetryDelayMs,
        });
      }

      return importQuicknetRoundWhenAvailable(
        importOptions,
      );
    }

    it('rejects round zero before doing any work', async () => {
      await expect(
        importRound({
          round: 0n,
        }),
      ).rejects.toThrow(
        'Quicknet round must be greater than zero.',
      );

      expect(
        registryMocks
          .createRegistryReader,
      ).not.toHaveBeenCalled();

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).not.toHaveBeenCalled();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).not.toHaveBeenCalled();

      expect(
        importMocks
          .importQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('rejects a negative round before doing any work', async () => {
      await expect(
        importRound({
          round: -1n,
        }),
      ).rejects.toThrow(
        RangeError,
      );

      expect(
        registryMocks
          .createRegistryReader,
      ).not.toHaveBeenCalled();
    });

    it('creates a reader for the configured registry', async () => {
      await importRound();

      expect(
        registryMocks
          .createRegistryReader,
      ).toHaveBeenCalledOnce();

      expect(
        registryMocks
          .createRegistryReader,
      ).toHaveBeenCalledWith({
        client:
          publicClient,
        deployment:
          DEPLOYMENT,
      });
    });

    it('verifies the registry deployment before checking storage', async () => {
      await importRound();

      expect(
        verifyDeployment,
      ).toHaveBeenCalledOnce();

      expect(
        firstInvocationOrder(
          verifyDeployment,
        ),
      ).toBeLessThan(
        firstInvocationOrder(
          isStored,
        ),
      );
    });

    it('propagates deployment verification failures', async () => {
      const error =
        new Error(
          'Invalid registry deployment.',
        );

      verifyDeployment
        .mockRejectedValue(
          error,
        );

      await expect(
        importRound(),
      ).rejects.toBe(
        error,
      );

      expect(
        isStored,
      ).not.toHaveBeenCalled();

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).not.toHaveBeenCalled();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).not.toHaveBeenCalled();

      expect(
        importMocks
          .importQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('returns immediately when the round is already stored', async () => {
      isStored
        .mockResolvedValue(
          true,
        );

      const result =
        await importRound();

      expect(result).toEqual({
        status:
          'already-stored',
        round: ROUND,
        randomness:
          RANDOMNESS,
      });

      expect(
        isStored,
      ).toHaveBeenCalledWith(
        ROUND,
      );

      expect(
        getBeacon,
      ).toHaveBeenCalledWith(
        ROUND,
      );

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).not.toHaveBeenCalled();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).not.toHaveBeenCalled();

      expect(
        importMocks
          .importQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('propagates a failure reading an already-stored beacon', async () => {
      const error =
        new Error(
          'Beacon read failed.',
        );

      isStored
        .mockResolvedValue(
          true,
        );

      getBeacon
        .mockRejectedValue(
          error,
        );

      await expect(
        importRound(),
      ).rejects.toBe(
        error,
      );

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('waits for the exact requested round', async () => {
      await importRound();

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).toHaveBeenCalledOnce();

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).toHaveBeenCalledWith({
        round: ROUND,
      });
    });

    it('does not fetch before waiting completes', async () => {
      await importRound();

      expect(
        firstInvocationOrder(
          waitMocks
            .waitForQuicknetRound,
        ),
      ).toBeLessThan(
        firstInvocationOrder(
          fetchMocks
            .fetchQuicknetBeaconWithRetry,
        ),
      );
    });

    it('propagates wait failures without fetching', async () => {
      const error =
        new Error(
          'Wait interrupted.',
        );

      waitMocks
        .waitForQuicknetRound
        .mockRejectedValue(
          error,
        );

      await expect(
        importRound(),
      ).rejects.toBe(
        error,
      );

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).not.toHaveBeenCalled();

      expect(
        importMocks
          .importQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('fetches the exact requested round after waiting', async () => {
      await importRound();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledOnce();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledWith({
        round: ROUND,
      });
    });

    it('forwards maxFetchAttempts to the fetch retry layer', async () => {
      await importRound({
        maxFetchAttempts:
          12,
      });

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledWith({
        round: ROUND,
        maxAttempts: 12,
      });
    });

    it('forwards fetchRetryDelayMs to the fetch retry layer', async () => {
      await importRound({
        fetchRetryDelayMs:
          125,
      });

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledWith({
        round: ROUND,
        retryDelayMs: 125,
      });
    });

    it('forwards both fetch retry options', async () => {
      await importRound({
        maxFetchAttempts:
          12,
        fetchRetryDelayMs:
          125,
      });

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledWith({
        round: ROUND,
        maxAttempts: 12,
        retryDelayMs: 125,
      });
    });

    it('does not explicitly pass undefined fetch options', async () => {
      await importRound();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledWith({
        round: ROUND,
      });
    });

    it('propagates fetch exhaustion without importing', async () => {
      const error =
        new Error(
          `Failed to fetch Quicknet round ${ROUND} after 8 attempts.`,
        );

      fetchMocks
        .fetchQuicknetBeaconWithRetry
        .mockRejectedValue(
          error,
        );

      await expect(
        importRound(),
      ).rejects.toBe(
        error,
      );

      expect(
        importMocks
          .importQuicknetRound,
      ).not.toHaveBeenCalled();
    });

    it('passes the fetched beacon into importQuicknetRound', async () => {
      await importRound();

      expect(
        importMocks
          .importQuicknetRound,
      ).toHaveBeenCalledOnce();

      expect(
        importMocks
          .importQuicknetRound,
      ).toHaveBeenCalledWith({
        publicClient,
        walletClient,
        account,
        deployment:
          DEPLOYMENT,
        round: ROUND,
        beacon:
          BEACON,
      });
    });

    it('does not fetch the beacon a second time itself', async () => {
      await importRound();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledOnce();

      expect(
        importMocks
          .importQuicknetRound,
      ).toHaveBeenCalledOnce();
    });

    it('returns the imported result unchanged', async () => {
      const result =
        await importRound();

      expect(result).toEqual({
        status: 'imported',
        round: ROUND,
        randomness:
          RANDOMNESS,
        transactionHash:
          TRANSACTION_HASH,
      });
    });

    it('returns already-stored when another relayer wins the race during import', async () => {
      importMocks
        .importQuicknetRound
        .mockResolvedValue({
          status:
            'already-stored',
          round: ROUND,
          randomness:
            RANDOMNESS,
        });

      const result =
        await importRound();

      expect(result).toEqual({
        status:
          'already-stored',
        round: ROUND,
        randomness:
          RANDOMNESS,
      });

      expect(
        waitMocks
          .waitForQuicknetRound,
      ).toHaveBeenCalledOnce();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledOnce();

      expect(
        importMocks
          .importQuicknetRound,
      ).toHaveBeenCalledOnce();
    });

    it('propagates import failures without retrying them', async () => {
      const error =
        new Error(
          'Transaction submission failed.',
        );

      importMocks
        .importQuicknetRound
        .mockRejectedValue(
          error,
        );

      await expect(
        importRound(),
      ).rejects.toBe(
        error,
      );

      expect(
        importMocks
          .importQuicknetRound,
      ).toHaveBeenCalledOnce();

      expect(
        fetchMocks
          .fetchQuicknetBeaconWithRetry,
      ).toHaveBeenCalledOnce();
    });

    it('performs the operation in the expected order', async () => {
      await importRound();

      const verifyOrder =
        firstInvocationOrder(
          verifyDeployment,
        );

      const storedOrder =
        firstInvocationOrder(
          isStored,
        );

      const waitOrder =
        firstInvocationOrder(
          waitMocks
            .waitForQuicknetRound,
        );

      const fetchOrder =
        firstInvocationOrder(
          fetchMocks
            .fetchQuicknetBeaconWithRetry,
        );

      const importOrder =
        firstInvocationOrder(
          importMocks
            .importQuicknetRound,
        );

      expect(
        verifyOrder,
      ).toBeLessThan(
        storedOrder,
      );

      expect(
        storedOrder,
      ).toBeLessThan(
        waitOrder,
      );

      expect(
        waitOrder,
      ).toBeLessThan(
        fetchOrder,
      );

      expect(
        fetchOrder,
      ).toBeLessThan(
        importOrder,
      );
    });
  },
);

function firstInvocationOrder(
  mock: {
    mock: {
      invocationCallOrder: number[];
    };
  },
): number {
  const order =
    mock.mock
      .invocationCallOrder[0];

  if (order === undefined) {
    throw new Error(
      'Expected mock to have been called.',
    );
  }

  return order;
}