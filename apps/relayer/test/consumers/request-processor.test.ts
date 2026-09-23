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
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

vi.mock(
  '../../src/rounds/import-round-when-available.js',
  () => ({
    importQuicknetRoundWhenAvailable: vi.fn(),
  }),
);

import type {
  ImportQuicknetRoundResult,
} from '../../src/rounds/import-round.js';
import {
  importQuicknetRoundWhenAvailable,
} from '../../src/rounds/import-round-when-available.js';
import type {
  QuicknetRandomnessRequest,
} from '../../src/consumers/request-events.js';
import {
  processQuicknetRequests,
} from '../../src/consumers/request-processor.js';

const CONSUMER_A: Address = '0x1111111111111111111111111111111111111111';
const CONSUMER_B: Address = '0x2222222222222222222222222222222222222222';

const RANDOMNESS_A: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const RANDOMNESS_B: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const RANDOMNESS_C: Hex =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const TRANSACTION_HASH_A: Hex =
  '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const TRANSACTION_HASH_B: Hex =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const REQUEST_TRANSACTION_HASH: Hex =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const CHAIN_ID = 12345;

const REGISTRY_ADDRESS: Address =
  '0x3333333333333333333333333333333333333333';

const REGISTRY_RUNTIME_CODEHASH: Hex =
  '0x9999999999999999999999999999999999999999999999999999999999999999';
  
const VERIFIER_ADDRESS: Address =
  '0x5555555555555555555555555555555555555555';

const VERIFIER_RUNTIME_CODEHASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const PUBLIC_CLIENT =
  {} as PublicClient;

const WALLET_CLIENT =
  {} as WalletClient;

const ACCOUNT =
  {} as Account;

const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: REGISTRY_RUNTIME_CODEHASH,
  verifierAddress: VERIFIER_ADDRESS,
  verifierRuntimeCodehash: VERIFIER_RUNTIME_CODEHASH,
};

function createRequest(
  round: bigint,
  consumer: Address = CONSUMER_A,
  blockNumber: bigint = 1_000n,
  logIndex: number = 0,
): QuicknetRandomnessRequest {
  return {
    consumer,
    round,
    blockNumber,
    transactionHash: REQUEST_TRANSACTION_HASH,
    logIndex,
  };
}

function importedResult(
  round: bigint,
  randomness: Hex,
  transactionHash: Hex,
): ImportQuicknetRoundResult {
  return {
    status: 'imported',
    submission: 'witness',
    round,
    randomness,
    transactionHash,
  };
}

function alreadyStoredResult(
  round: bigint,
  randomness: Hex,
): ImportQuicknetRoundResult {
  return {
    status: 'already-stored',
    round,
    randomness,
  };
}

describe('processQuicknetRequests', () => {
  beforeEach(() => {
    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockReset();
  });

  it('returns no processed rounds for an empty request list', async () => {
    const result = await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [],
    });

    expect(result).toEqual({
      rounds: [],
    });

    expect(
      importQuicknetRoundWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it('processes one requested round', async () => {
    const importResult = importedResult(
      100n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(100n),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 100n,
          result: importResult,
        },
      ],
    });

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledOnce();

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      round: 100n,
    });
  });

  it('deduplicates repeated requests for the same round', async () => {
    const importResult = importedResult(
      200n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(200n, CONSUMER_A, 1_000n, 0),
        createRequest(200n, CONSUMER_A, 1_001n, 1),
        createRequest(200n, CONSUMER_A, 1_002n, 2),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 200n,
          result: importResult,
        },
      ],
    });

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledOnce();
  });

  it('deduplicates the same round requested by different consumers', async () => {
    const importResult = importedResult(
      300n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockResolvedValue(importResult);

    await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(300n, CONSUMER_A, 1_000n, 0),
        createRequest(300n, CONSUMER_B, 1_001n, 0),
      ],
    });

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledOnce();

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      round: 300n,
    });
  });

  it('processes multiple unique rounds in first-seen order', async () => {
    const result500 = importedResult(
      500n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const result502 = importedResult(
      502n,
      RANDOMNESS_B,
      TRANSACTION_HASH_B,
    );

    const result501 = alreadyStoredResult(
      501n,
      RANDOMNESS_C,
    );

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    )
      .mockResolvedValueOnce(result500)
      .mockResolvedValueOnce(result502)
      .mockResolvedValueOnce(result501);

    const result = await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(500n, CONSUMER_A, 1_000n, 0),
        createRequest(502n, CONSUMER_A, 1_001n, 0),
        createRequest(500n, CONSUMER_B, 1_002n, 0),
        createRequest(501n, CONSUMER_A, 1_003n, 0),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 500n,
          result: result500,
        },
        {
          round: 502n,
          result: result502,
        },
        {
          round: 501n,
          result: result501,
        },
      ],
    });

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        round: 500n,
      },
    );

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        round: 502n,
      },
    );

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenNthCalledWith(
      3,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        round: 501n,
      },
    );
  });

  it('treats an already-stored round as successful', async () => {
    const importResult = alreadyStoredResult(
      600n,
      RANDOMNESS_A,
    );

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockResolvedValue(importResult);

    const result = await processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(600n),
      ],
    });

    expect(result).toEqual({
      rounds: [
        {
          round: 600n,
          result: importResult,
        },
      ],
    });
  });

  it('processes unique rounds sequentially', async () => {
    let resolveFirst:
      | ((value: ImportQuicknetRoundResult) => void)
      | undefined;

    const firstResult = importedResult(
      700n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const secondResult = importedResult(
      701n,
      RANDOMNESS_B,
      TRANSACTION_HASH_B,
    );

    const firstPromise =
      new Promise<ImportQuicknetRoundResult>((resolve) => {
        resolveFirst = resolve;
      });

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    )
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(secondResult);

    const processing = processQuicknetRequests({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      requests: [
        createRequest(700n),
        createRequest(701n),
      ],
    });

    await Promise.resolve();

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledTimes(1);

    if (resolveFirst === undefined) {
      throw new Error('Expected first round resolver to be initialized.');
    }

    resolveFirst(firstResult);

    const result = await processing;

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      rounds: [
        {
          round: 700n,
          result: firstResult,
        },
        {
          round: 701n,
          result: secondResult,
        },
      ],
    });
  });

  it('propagates a round processing failure', async () => {
    const failure = new Error('Quicknet round import failed.');

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    ).mockRejectedValue(failure);

    await expect(
      processQuicknetRequests({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        requests: [
          createRequest(800n),
        ],
      }),
    ).rejects.toBe(failure);
  });

  it('stops processing after the first failed round', async () => {
    const firstResult = importedResult(
      900n,
      RANDOMNESS_A,
      TRANSACTION_HASH_A,
    );

    const failure = new Error('Failed to import round 901.');

    vi.mocked(
      importQuicknetRoundWhenAvailable,
    )
      .mockResolvedValueOnce(firstResult)
      .mockRejectedValueOnce(failure);

    await expect(
      processQuicknetRequests({
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        requests: [
          createRequest(900n),
          createRequest(901n),
          createRequest(902n),
        ],
      }),
    ).rejects.toBe(failure);

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenCalledTimes(2);

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenNthCalledWith(
      1,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        round: 900n,
      },
    );

    expect(
      importQuicknetRoundWhenAvailable,
    ).toHaveBeenNthCalledWith(
      2,
      {
        publicClient: PUBLIC_CLIENT,
        walletClient: WALLET_CLIENT,
        account: ACCOUNT,
        deployment: DEPLOYMENT,
        round: 901n,
      },
    );

    expect(
      importQuicknetRoundWhenAvailable,
    ).not.toHaveBeenCalledWith({
      publicClient: PUBLIC_CLIENT,
      walletClient: WALLET_CLIENT,
      account: ACCOUNT,
      deployment: DEPLOYMENT,
      round: 902n,
    });
  });
});
