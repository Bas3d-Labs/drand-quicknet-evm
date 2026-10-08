import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  WalletClient,
} from 'viem';

import {
  prepareRelayerTransaction,
} from '../../src/chain/prepare-relayer-transaction.js';

const SIGNER =
  '0x1111111111111111111111111111111111111111' as const;

const REGISTRY =
  '0x2222222222222222222222222222222222222222' as const;

function setup() {
  const prepareTransactionRequest = vi.fn().mockResolvedValue({
    type: 'eip1559',
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const walletClient = {
    chain: undefined,
    prepareTransactionRequest,
  } as unknown as WalletClient;

  const options = {
    walletClient,
    signer: SIGNER,
    to: REGISTRY,
    data: '0x1234' as const,
    value: 0n,
  };

  return {
    options,
    prepareTransactionRequest,
  };
}

describe('relayer transaction preparation', () => {
  it('requests gas, fees, and type without requesting a nonce', async () => {
    const t = setup();

    const result = await prepareRelayerTransaction(t.options);

    expect(t.prepareTransactionRequest)
      .toHaveBeenCalledExactlyOnceWith({
        chain: undefined,
        account: SIGNER,
        to: REGISTRY,
        data: '0x1234',
        value: 0n,
        gas: undefined,
        parameters: ['gas', 'fees', 'type'],
      });

    expect(result).toEqual({
      to: REGISTRY,
      data: '0x1234',
      value: 0n,
      gas: 100_000n,
      type: 'eip1559',
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    expect(Object.isFrozen(result)).toBe(true);
  });

  it('supports legacy fee preparation', async () => {
    const t = setup();

    t.prepareTransactionRequest.mockResolvedValue({
      type: 'legacy',
      gas: 100_000n,
      gasPrice: 3n,
    });

    const result = await prepareRelayerTransaction(t.options);

    expect(result).toEqual({
      to: REGISTRY,
      data: '0x1234',
      value: 0n,
      gas: 100_000n,
      type: 'legacy',
      gasPrice: 3n,
    });

    expect(Object.isFrozen(result)).toBe(true);
  });

  it('preserves an existing gas limit through preparation', async () => {
    const t = setup();

    t.prepareTransactionRequest.mockResolvedValue({
      type: 'eip1559',
      gas: 150_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    const result = await prepareRelayerTransaction({
      ...t.options,
      gas: 150_000n,
    });

    expect(t.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: 150_000n,
      }),
    );

    expect(result.gas).toBe(150_000n);
  });

  it('keeps the original call and excludes prepared nonce and chain fields', async () => {
    const t = setup();

    t.prepareTransactionRequest.mockResolvedValue({
      type: 'eip1559',
      gas: 100_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      nonce: 999,
      chainId: 999,
      to: SIGNER,
      data: '0xffff',
      value: 100n,
    });

    const result = await prepareRelayerTransaction(t.options);

    expect(result).not.toHaveProperty('nonce');
    expect(result).not.toHaveProperty('chainId');

    expect(result).toMatchObject({
      to: REGISTRY,
      data: '0x1234',
      value: 0n,
    });
  });

  it('rejects an unsupported transaction type', async () => {
    const t = setup();

    t.prepareTransactionRequest.mockResolvedValue({
      type: 'eip4844',
      gas: 100_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      maxFeePerBlobGas: 1n,
    });

    await expect(
      prepareRelayerTransaction(t.options),
    ).rejects.toThrow('Unsupported prepared transaction type.');
  });

  it('propagates preparation failures', async () => {
    const t = setup();
    const error = new Error('Gas estimation failed');

    t.prepareTransactionRequest.mockRejectedValue(error);

    await expect(
      prepareRelayerTransaction(t.options),
    ).rejects.toBe(error);
  });
});