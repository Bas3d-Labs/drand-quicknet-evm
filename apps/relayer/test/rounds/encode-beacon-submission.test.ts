import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  decodeFunctionData,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import {
  encodeBeaconSubmission,
  type BeaconSubmissionRequest,
} from '../../src/rounds/encode-beacon-submission.js';

const REGISTRY =
  '0x1111111111111111111111111111111111111111' as const;

const ROUND = 20_791_007n;
const SIGNATURE = `0x${'11'.repeat(48)}` as const;

describe('beacon submission encoding', () => {
  it('preserves the compressed submission and its arguments', () => {
    const request = {
      address: REGISTRY,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'submitBeacon',
      args: [ROUND, SIGNATURE],
    } as const satisfies BeaconSubmissionRequest;

    const result = encodeBeaconSubmission(request);

    expect(result.to).toBe(REGISTRY);
    expect(result.value).toBe(0n);

    expect(decodeFunctionData({
      abi: drandQuicknetBeaconRegistryAbi,
      data: result.data,
    })).toEqual({
      functionName: 'submitBeacon',
      args: [ROUND, SIGNATURE],
    });

    expect(Object.isFrozen(result)).toBe(true);
  });

  it('preserves the witness submission and both witness coordinates', () => {
    const yHi = 123n;
    const yLo = 456n;

    const request = {
      address: REGISTRY,
      abi: drandQuicknetBeaconRegistryAbi,
      functionName: 'submitBeaconWithWitness',
      args: [ROUND, SIGNATURE, yHi, yLo],
    } as const satisfies BeaconSubmissionRequest;

    const result = encodeBeaconSubmission(request);

    expect(result.to).toBe(REGISTRY);
    expect(result.value).toBe(0n);

    expect(decodeFunctionData({
      abi: drandQuicknetBeaconRegistryAbi,
      data: result.data,
    })).toEqual({
      functionName: 'submitBeaconWithWitness',
      args: [ROUND, SIGNATURE, yHi, yLo],
    });

    expect(Object.isFrozen(result)).toBe(true);
  });
});