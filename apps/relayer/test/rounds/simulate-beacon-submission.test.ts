import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  parseCompressedSignature,
} from '@based-labs/drand-quicknet';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

const mocks = vi.hoisted(() => ({
  witness: vi.fn(),
  compressed: vi.fn(),
  decode: vi.fn(),
}));

vi.mock(
  '@based-labs/drand-quicknet-registry',
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import('@based-labs/drand-quicknet-registry')
    >(),
    simulateSubmitBeaconWithWitness: mocks.witness,
    simulateSubmitBeacon: mocks.compressed,
  }),
);

vi.mock(
  '@based-labs/drand-quicknet',
  async (importOriginal) => ({
    ...await importOriginal<
      typeof import('@based-labs/drand-quicknet')
    >(),
    createSignatureWitness: mocks.decode,
  }),
);

import {
  simulateBeaconSubmission,
} from '../../src/rounds/simulate-beacon-submission.js';

const ADDRESS =
  '0x1111111111111111111111111111111111111111';

const HASH: Hex = `0x${'11'.repeat(32)}`;

const SIGNATURE = parseCompressedSignature(
  'b44679b9a59af2ec876b1a6b1ad52ea9' +
  'b1615fc3982b19576350f93447cb1125' +
  'e342b73a8dd2bacbe47e4b6b63ed5e39',
);

const OPTIONS = {
  publicClient: {} as PublicClient,
  account: ADDRESS,
  deployment: {
    chainId: 46630,
    address: ADDRESS,
    runtimeCodehash: HASH,
    verifierAddress: ADDRESS,
    verifierRuntimeCodehash: HASH,
  },
  round: 1000n,
  signature: SIGNATURE,
} as const;

const Y_HI =
  0x11f92e4521ef54f047b64b85fa98db2dn;

const Y_LO =
  0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2n;

const WITNESS_RESULT = {
  request: {
    functionName: 'submitBeaconWithWitness',
    gas: 1_000_000n,
  },
  result: HASH,
};

const COMPRESSED_RESULT = {
  request: {
    functionName: 'submitBeacon',
    gas: 1_000_000n,
  },
  result: HASH,
};

const ABI = [
  ...drandQuicknetBeaconRegistryAbi,
  {
    type: 'error',
    name: 'InsufficientVerifierGas',
    inputs: [],
  },
] as const;

function revert(
  data: Hex,
  address: Hex = ADDRESS,
  functionName = 'submitBeaconWithWitness',
  message?: string,
) {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: ABI,
      data,
      functionName,
      message,
    }),
    {
      abi: ABI,
      functionName,
      contractAddress: address,
      args: [
        OPTIONS.round,
        SIGNATURE,
        Y_HI,
        Y_LO,
      ],
    },
  );
}

function invalidBeacon() {
  return revert(
    encodeErrorResult({
      abi: ABI,
      errorName: 'InvalidBeacon',
    }),
  );
}

describe('simulateBeaconSubmission', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    mocks.witness.mockResolvedValue(WITNESS_RESULT);
    mocks.compressed.mockResolvedValue(COMPRESSED_RESULT);

    const quicknet = await vi.importActual<
      typeof import('@based-labs/drand-quicknet')
    >('@based-labs/drand-quicknet');

    mocks.decode.mockImplementation(
      quicknet.createSignatureWitness,
    );
  });

  it('handles a real viem simulation revert and encodes the fallback calldata', async () => {
    const sdk = await vi.importActual<
      typeof import('@based-labs/drand-quicknet-registry')
    >('@based-labs/drand-quicknet-registry');

    mocks.witness.mockImplementation(
      sdk.simulateSubmitBeaconWithWitness,
    );

    mocks.compressed.mockImplementation(
      sdk.simulateSubmitBeacon,
    );

    const calls: unknown[] = [];

    const publicClient = createPublicClient({
      transport: custom({
        async request({ method, params }) {
          expect(method).toBe('eth_call');

          const [transaction] = params as [{ data: Hex }];

          const call = decodeFunctionData({
            abi: ABI,
            data: transaction.data,
          });

          calls.push(call);

          if (call.functionName === 'submitBeaconWithWitness') {
            throw {
              code: 3,
              message: 'execution reverted',
              data: encodeErrorResult({
                abi: ABI,
                errorName: 'InvalidBeacon',
              }),
            };
          }

          return encodeFunctionResult({
            abi: ABI,
            functionName: 'submitBeacon',
            result: HASH,
          });
        },
      }, {
        retryCount: 0,
      }),
    });

    const result = await simulateBeaconSubmission({
      ...OPTIONS,
      publicClient,
    });

    expect(calls).toEqual([
      {
        functionName: 'submitBeaconWithWitness',
        args: [
          1000n,
          SIGNATURE,
          Y_HI,
          Y_LO,
        ],
      },
      {
        functionName: 'submitBeacon',
        args: [
          1000n,
          SIGNATURE,
        ],
      },
    ]);

    expect(result.request.functionName).toBe('submitBeacon');
    expect(result.result).toBe(HASH);
  });

  it('derives the real KAT witness and reports witness submission', async () => {
    await expect(
      simulateBeaconSubmission(OPTIONS),
    ).resolves.toEqual({
      ...WITNESS_RESULT,
      submission: 'witness',
    });

    expect(mocks.witness).toHaveBeenCalledExactlyOnceWith({
      ...OPTIONS,
      yHi: Y_HI,
      yLo: Y_LO,
    });

    expect(mocks.compressed).not.toHaveBeenCalled();
  });

  it('simulates compressed once after a decoded witness InvalidBeacon', async () => {
    mocks.witness.mockRejectedValue(invalidBeacon());

    await expect(
      simulateBeaconSubmission(OPTIONS),
    ).resolves.toEqual({
      ...COMPRESSED_RESULT,
      submission: 'compressed',
      fallbackReason: 'witness-rejected',
    });

    expect(mocks.witness).toHaveBeenCalledOnce();

    expect(mocks.compressed).toHaveBeenCalledExactlyOnceWith(
      OPTIONS,
    );
  });

  it('propagates the fallback failure without another attempt', async () => {
    const error = invalidBeacon();

    mocks.witness.mockRejectedValue(invalidBeacon());
    mocks.compressed.mockRejectedValue(error);

    await expect(
      simulateBeaconSubmission(OPTIONS),
    ).rejects.toBe(error);

    expect(mocks.witness).toHaveBeenCalledOnce();
    expect(mocks.compressed).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'provider text',
      new Error('execution reverted: InvalidBeacon'),
    ],
    [
      'HTTP failure',
      new HttpRequestError({
        url: 'https://secret.example/token',
        status: 429,
      }),
    ],
    [
      'round rejection',
      revert(
        encodeErrorResult({
          abi: ABI,
          errorName: 'InvalidRound',
        }),
      ),
    ],
    [
      'gas guard',
      revert(
        encodeErrorResult({
          abi: ABI,
          errorName: 'InsufficientVerifierGas',
        }),
      ),
    ],
    [
      'empty revert',
      revert('0x'),
    ],
    [
      'unknown selector',
      revert('0xdeadbeef'),
    ],
    [
      'reason without decoded error',
      revert(
        '0x',
        ADDRESS,
        'submitBeaconWithWitness',
        'InvalidBeacon',
      ),
    ],
    [
      'wrong contract',
      revert(
        encodeErrorResult({
          abi: ABI,
          errorName: 'InvalidBeacon',
        }),
        '0x2222222222222222222222222222222222222222',
      ),
    ],
    [
      'wrong method',
      revert(
        encodeErrorResult({
          abi: ABI,
          errorName: 'InvalidBeacon',
        }),
        ADDRESS,
        'submitBeacon',
      ),
    ],
    [
      'lookalike object',
      {
        cause: {
          data: {
            errorName: 'InvalidBeacon',
          },
        },
      },
    ],
  ])('does not fall back for %s', async (_label, error) => {
    mocks.witness.mockRejectedValue(error);

    await expect(
      simulateBeaconSubmission(OPTIONS),
    ).rejects.toBe(error);

    expect(mocks.witness).toHaveBeenCalledOnce();
    expect(mocks.compressed).not.toHaveBeenCalled();
  });

  it('falls back once when local witness generation rejects the input', async () => {
    const signature = parseCompressedSignature(
      '00'.repeat(48),
    );

    const options = {
      ...OPTIONS,
      signature,
    };

    await expect(
      simulateBeaconSubmission(options),
    ).resolves.toEqual({
      ...COMPRESSED_RESULT,
      submission: 'compressed',
      fallbackReason: 'witness-decode-failed',
    });

    expect(mocks.witness).not.toHaveBeenCalled();

    expect(mocks.compressed).toHaveBeenCalledExactlyOnceWith(
      options,
    );
  });

  it('can use compressed verification if local decoding fails for a valid KAT', async () => {
    mocks.decode.mockImplementation(() => {
      throw new Error('Decoder failure');
    });

    const result = await simulateBeaconSubmission(OPTIONS);

    expect(result.request).toBe(COMPRESSED_RESULT.request);
    expect(result.submission).toBe('compressed');

    expect(result).toHaveProperty(
      'fallbackReason',
      'witness-decode-failed',
    );

    expect(mocks.witness).not.toHaveBeenCalled();

    expect(mocks.compressed).toHaveBeenCalledExactlyOnceWith(
      OPTIONS,
    );
  });

  it('propagates compressed rejection after a local decoding failure', async () => {
    const signature = parseCompressedSignature(
      '00'.repeat(48),
    );

    const error = invalidBeacon();

    mocks.compressed.mockRejectedValue(error);

    await expect(
      simulateBeaconSubmission({
        ...OPTIONS,
        signature,
      }),
    ).rejects.toBe(error);

    expect(mocks.witness).not.toHaveBeenCalled();
    expect(mocks.compressed).toHaveBeenCalledOnce();
  });

  it('waits for witness simulation before choosing fallback', async () => {
    const pending = Promise.withResolvers<
      typeof WITNESS_RESULT
    >();

    mocks.witness.mockReturnValue(pending.promise);

    const result = simulateBeaconSubmission(OPTIONS);

    expect(mocks.compressed).not.toHaveBeenCalled();

    pending.reject(invalidBeacon());

    await expect(result).resolves.toEqual({
      ...COMPRESSED_RESULT,
      submission: 'compressed',
      fallbackReason: 'witness-rejected',
    });

    expect(mocks.compressed).toHaveBeenCalledOnce();
  });
});