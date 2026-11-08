import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import {
  broadcastSignedTransaction,
} from '../../src/chain/broadcast-signed-transaction.js';

const HASH = `0x${'ab'.repeat(32)}` as const;
const OTHER_HASH = `0x${'cd'.repeat(32)}` as const;

// Opaque bytes for testing exact transport forwarding.
// This helper does not decode or validate signed transactions.
const SIGNED_TRANSACTION = '0x02abcd' as const;

function setup(response: unknown) {
  const request = vi.fn(async (): Promise<unknown> => response);

  const options = {
    publicClient: { request } as unknown as PublicClient,
    signedTransaction: SIGNED_TRANSACTION,
    transactionHash: HASH,
  };

  return {
    request,
    options,
  };
}

function expectSingleSend(
  request: ReturnType<typeof setup>['request'],
) {
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({
    method: 'eth_sendRawTransaction',
    params: [SIGNED_TRANSACTION],
  }, {
    retryCount: 0,
  });
}

describe('signed transaction broadcast', () => {
  it.each([
    { name: 'matching casing', response: HASH },
    {
      name: 'different hex casing',
      response: `0x${'AB'.repeat(32)}`,
    },
  ])('acknowledges the expected hash with $name', async ({ response }) => {
    const t = setup(response);

    const result = await broadcastSignedTransaction(t.options);

    expect(result).toEqual({
      status: 'acknowledged',
    });
    expectSingleSend(t.request);
  });

  it.each([
    { name: 'undefined', response: undefined },
    { name: 'null', response: null },
    { name: 'short hash', response: '0xab' },
    { name: 'non-hex hash', response: `0x${'zz'.repeat(32)}` },
  ])('reports an invalid response for $name', async ({ response }) => {
    const t = setup(response);

    const result = await broadcastSignedTransaction(t.options);

    expect(result).toEqual({
      status: 'not-acknowledged',
      failure: {
        observation: 'invalid-response',
      },
    });
    expectSingleSend(t.request);
  });

  it('reports a different valid hash without retrying', async () => {
    const t = setup(OTHER_HASH);

    const result = await broadcastSignedTransaction(t.options);

    expect(result).toEqual({
      status: 'not-acknowledged',
      failure: {
        observation: 'hash-mismatch',
        returnedTransactionHash: OTHER_HASH,
      },
    });
    expectSingleSend(t.request);
  });

  it('preserves the original request error as internal evidence without retrying', async () => {
    const t = setup(HASH);
    const failure = new Error('RPC request failed');

    t.request.mockRejectedValueOnce(failure);

    const result = await broadcastSignedTransaction(t.options);

    expect(result).toEqual({
      status: 'not-acknowledged',
      failure: {
        observation: 'request-error',
        error: failure,
      },
    });

    if (
      result.status !== 'not-acknowledged' ||
      result.failure.observation !== 'request-error'
    ) {
      throw new Error('Expected request-error evidence.');
    }

    expect(result.failure.error).toBe(failure);
    expectSingleSend(t.request);
  });
});