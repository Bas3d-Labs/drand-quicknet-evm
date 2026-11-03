import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  decodeFunctionData,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import type {
  BeaconSubmissionRequest,
} from '../../src/rounds/encode-beacon-submission.js';

import {
  submitBeaconTransaction,
  type SubmitBeaconTransactionOptions,
} from '../../src/rounds/submit-beacon-transaction.js';

import type {
  SubmitTransactionWorkResult,
  TransactionManagerStatus,
} from '../../src/state/transaction-manager-types.js';

const REGISTRY =
  '0x2222222222222222222222222222222222222222' as const;

const HASH = `0x${'aa'.repeat(32)}` as const;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;
const ROUND = 20_791_007n;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

const WORK_ID =
  'quicknet-round:v1:4663:' +
  '0x2222222222222222222222222222222222222222:20791007';

function setup() {
  const status: TransactionManagerStatus = {
    chainId: 4663,
    journalInitialized: true,
    busy: false,
    open: true,
    primaryReason: null,
    blockers: [],
    recoveryComplete: true,
    inclusionChecksComplete: true,
    persistenceState: 'idle',
    blockedSince: null,
    attempts: [],
  };

  const result = {
    status: 'submitted',
    broadcast: {
      status: 'acknowledged',
      workId: WORK_ID,
      attemptId: ATTEMPT_ID,
      transactionHash: HASH,
      nonce: 4n,
    },
  } as const satisfies SubmitTransactionWorkResult;

  const submit =
    vi.fn<SubmitBeaconTransactionOptions['manager']['submit']>()
      .mockResolvedValue(result);

  const manager = {
    status,
    submit,
  } satisfies SubmitBeaconTransactionOptions['manager'];

  const request = {
    address: REGISTRY,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'submitBeacon',
    args: [ROUND, SIGNATURE],
    gas: 150_000n,
  } as const;

  const options = {
    manager,
    request,
  } satisfies SubmitBeaconTransactionOptions;

  return {
    options,
    submit,
    result,
  };
}

describe('beacon transaction submission', () => {
  it('forwards encoded work, gas, signal, and cycle to the manager', async () => {
    const t = setup();
    const controller = new AbortController();

    const result = await submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    }, 7);

    expect(result).toBe(t.result);
    expect(t.submit).toHaveBeenCalledOnce();

    const submitted = t.submit.mock.calls[0]![0];

    expect(submitted).toEqual({
      work: {
        workId: WORK_ID,
        call: {
          to: REGISTRY,
          data: expect.any(String),
          value: 0n,
          gas: 150_000n,
        },
      },
      signal: controller.signal,
      cycle: 7,
    });

    expect(decodeFunctionData({
      abi: drandQuicknetBeaconRegistryAbi,
      data: submitted.work.call.data,
    })).toEqual({
      functionName: 'submitBeacon',
      args: [ROUND, SIGNATURE],
    });
  });

  it('uses the same work identity for compressed and witness calls', async () => {
    const t = setup();

    const compressed = {
      address: REGISTRY,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'submitBeacon',
      args: [ROUND, SIGNATURE],
    } as const satisfies BeaconSubmissionRequest;

    const witness = {
      address: REGISTRY,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'submitBeaconWithWitness',
      args: [ROUND, SIGNATURE, 123n, 456n],
    } as const satisfies BeaconSubmissionRequest;

    await submitBeaconTransaction({
      manager: t.options.manager,
      request: compressed,
    }, 7);

    await submitBeaconTransaction({
      manager: t.options.manager,
      request: witness,
    }, 8);

    expect(t.submit).toHaveBeenCalledTimes(2);

    const first = t.submit.mock.calls[0]![0];
    const second = t.submit.mock.calls[1]![0];

    expect(first.work.workId).toBe(WORK_ID);
    expect(second.work.workId).toBe(WORK_ID);
    expect(first.cycle).toBe(7);
    expect(second.cycle).toBe(8);

    for (const submitted of [first, second]) {
      expect(submitted.work.call.to).toBe(REGISTRY);
      expect(submitted.work.call.value).toBe(0n);
      expect(submitted.work.call.gas).toBeUndefined();
    }

    expect(first.work.call.data).not.toBe(second.work.call.data);

    expect(decodeFunctionData({
      abi: drandQuicknetBeaconRegistryAbi,
      data: first.work.call.data,
    })).toEqual({
      functionName: 'submitBeacon',
      args: [ROUND, SIGNATURE],
    });

    expect(decodeFunctionData({
      abi: drandQuicknetBeaconRegistryAbi,
      data: second.work.call.data,
    })).toEqual({
      functionName: 'submitBeaconWithWitness',
      args: [ROUND, SIGNATURE, 123n, 456n],
    });
  });

  it.each([
    {
      status: 'already-retained',
      retained: {
        workId: WORK_ID,
        attemptId: ATTEMPT_ID,
      },
    },
    {
      status: 'deferred',
      primaryReason: 'unresolved-attempt',
      reasons: ['unresolved-attempt'],
    },
    {
      status: 'submitted',
      broadcast: {
        status: 'not-acknowledged',
        workId: WORK_ID,
        attemptId: ATTEMPT_ID,
        transactionHash: HASH,
        nonce: 4n,
      },
    },
  ] as const satisfies readonly SubmitTransactionWorkResult[])(
    'preserves the manager’s $status result',
    async (result) => {
      const t = setup();
      t.submit.mockResolvedValueOnce(result);

      await expect(submitBeaconTransaction(t.options))
        .resolves.toBe(result);

      expect(t.submit).toHaveBeenCalledOnce();
    },
  );

  it('does not enter the manager when already cancelled', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    controller.abort(reason);

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.submit).not.toHaveBeenCalled();
  });

  it('preserves the exact manager error without retrying', async () => {
    const t = setup();
    const failure = new Error('Submission failed');

    t.submit.mockRejectedValueOnce(failure);

    await expect(submitBeaconTransaction(t.options))
      .rejects.toBe(failure);

    expect(t.submit).toHaveBeenCalledOnce();
  });

  it('preserves a completed manager result when cancellation arrives', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    t.submit.mockImplementationOnce(async () => {
      controller.abort(reason);
      return t.result;
    });

    await expect(submitBeaconTransaction({
      ...t.options,
      signal: controller.signal,
    })).resolves.toBe(t.result);

    expect(controller.signal.aborted).toBe(true);
    expect(t.submit).toHaveBeenCalledOnce();
  });
});