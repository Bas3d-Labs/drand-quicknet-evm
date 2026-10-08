import {
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import type {
  simulateBeaconSubmission,
} from './simulate-beacon-submission.js';

type SimulationRequest =
  Awaited<ReturnType<typeof simulateBeaconSubmission>>['request'];

type CompressedSubmissionCall = Pick<
  Extract<SimulationRequest, { functionName: 'submitBeacon' }>,
  'address' | 'functionName' | 'args'
>;

type WitnessSubmissionCall = Pick<
  Extract<
    SimulationRequest,
    { functionName: 'submitBeaconWithWitness' }
  >,
  'address' | 'functionName' | 'args'
>;

export type BeaconSubmissionRequest = (
  | CompressedSubmissionCall
  | WitnessSubmissionCall
) & {
  readonly abi: Abi;
}

export interface EncodedBeaconSubmission {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * Encodes the selected simulation request without signing or sending.
 */
export function encodeBeaconSubmission(
  request: BeaconSubmissionRequest,
): EncodedBeaconSubmission {
  let data: Hex;

  // Narrow the request so each function retains its corresponding args.
  if (request.functionName === 'submitBeaconWithWitness') {
    data = encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    });
  } else {
    data = encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    });
  }

  return Object.freeze({
    to: request.address,
    data,
    value: 0n,
  });
}