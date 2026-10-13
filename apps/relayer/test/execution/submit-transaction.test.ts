import {
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
  privateKeyToAccount,
} from 'viem/accounts';

import {
  submitTransaction,
} from '../../src/execution/submit-transaction.js';

import type {
  PrepareAttemptResult,
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const HASH = `0x${'aa'.repeat(32)}` as const;

// Preserve spaces, case, and NFD representation through the executor.
const WORK_ID = ' Work:Example:e\u0301 ';

function setup(status: PrepareAttemptResult['status'] = 'prepared') {
  const events: string[] = [];

  const call = {
    to: ACCOUNT.address,
    data: '0x12345678',
    value: 123n,
    gas: 50_000n,
  } as const;

  const fees = {
    type: 'eip1559',
    gas: call.gas,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 2n,
  } as const;

  const prepareTransactionRequest = vi.fn(async () => {
    events.push('prepare-fees');
    return fees;
  });

  const preparation: PrepareAttemptResult = status === 'prepared'
    ? Object.freeze({
        status: 'prepared',
        attemptId: ATTEMPT_ID,
        transactionHash: HASH,
        nonce: 4n,
      })
    : Object.freeze({
        status: 'already-retained',
        attemptId: ATTEMPT_ID,
        workId: WORK_ID,
      });

  const prepareAttempt = vi.fn<SignerCoordinator['prepareAttempt']>(
    async () => {
      events.push('prepare-attempt');
      return preparation;
    },
  );

  const broadcast = Object.freeze({
    status: 'acknowledged' as const,
    attemptId: ATTEMPT_ID,
    transactionHash: HASH,
    nonce: 4n,
  });

  const broadcastAttempt = vi.fn<SignerCoordinator['broadcastAttempt']>(
    async () => {
      events.push('broadcast');
      return broadcast;
    },
  );

  const options = {
    publicClient: {} as PublicClient,
    walletClient: {
      prepareTransactionRequest,
    } as unknown as WalletClient,
    account: ACCOUNT,
    coordinator: {
      status: { open: true },
      prepareAttempt,
      broadcastAttempt,
    } as unknown as SignerCoordinator,
    call,
    workId: WORK_ID,
  };

  return {
    options,
    events,
    fees,
    preparation,
    broadcast,
    prepareTransactionRequest,
    prepareAttempt,
    broadcastAttempt,
  };
}

describe('generic transaction submission', () => {
  it('forwards exact work identity and call, then broadcasts the prepared attempt', async () => {
    const t = setup();

    const result = await submitTransaction(t.options, 7);

    expect(result).toBe(t.broadcast);
    expect(t.events).toEqual([
      'prepare-fees',
      'prepare-attempt',
      'broadcast',
    ]);

    expect(t.prepareTransactionRequest).toHaveBeenCalledExactlyOnceWith({
      chain: undefined,
      account: ACCOUNT.address,
      ...t.options.call,
      parameters: ['gas', 'fees', 'type'],
    });

    expect(t.prepareAttempt).toHaveBeenCalledExactlyOnceWith({
      account: ACCOUNT,
      transaction: {
        ...t.options.call,
        ...t.fees,
      },
      workId: WORK_ID,
    }, 7);

    expect(t.broadcastAttempt).toHaveBeenCalledExactlyOnceWith({
      publicClient: t.options.publicClient,
      attemptId: ATTEMPT_ID,
    }, 7);
  });

  it('returns already-retained without broadcasting the retained attempt', async () => {
    const t = setup('already-retained');

    const result = await submitTransaction(t.options, 7);

    expect(result).toBe(t.preparation);
    expect(result).toEqual({
      status: 'already-retained',
      attemptId: ATTEMPT_ID,
      workId: WORK_ID,
    });
    expect(t.events).toEqual([
      'prepare-fees',
      'prepare-attempt',
    ]);
    expect(t.prepareAttempt).toHaveBeenCalledTimes(1);
    expect(t.broadcastAttempt).not.toHaveBeenCalled();
  });

  it.each(['prepared', 'already-retained'] as const)(
    'honors cancellation after preparation returns %s',
    async (status) => {
      const t = setup(status);
      const controller = new AbortController();
      const reason = new Error('Stopped after preparation.');

      t.prepareAttempt.mockImplementationOnce(async () => {
        controller.abort(reason);
        return t.preparation;
      });

      await expect(submitTransaction({
        ...t.options,
        signal: controller.signal,
      }, 7)).rejects.toBe(reason);

      expect(t.prepareAttempt).toHaveBeenCalledTimes(1);
      expect(t.broadcastAttempt).not.toHaveBeenCalled();
    },
  );
});