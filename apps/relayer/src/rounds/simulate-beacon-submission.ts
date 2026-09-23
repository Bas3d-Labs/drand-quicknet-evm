import {
  createSignatureWitness,
} from '@based-labs/drand-quicknet';

import {
  simulateSubmitBeacon,
  simulateSubmitBeaconWithWitness,
  type SimulateSubmitBeaconOptions,
} from '@based-labs/drand-quicknet-registry';

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
} from 'viem';

export type WitnessFallbackReason =
  | 'witness-rejected'
  | 'witness-decode-failed';

export type BeaconSubmissionDetails =
  | {
    submission: 'witness';
    fallbackReason?: never;
    }
  | {
      submission: 'compressed';
      fallbackReason: WitnessFallbackReason;
    };

// Select a submission path before any transaction is sent.
export async function simulateBeaconSubmission(
  options: SimulateSubmitBeaconOptions,
) {
  let witness: ReturnType<typeof createSignatureWitness>;

  try {
    witness = createSignatureWitness(options.signature);
  } catch {
    // The configured on-chain verifier remains the authentication authority.
    return simulateCompressed(options, 'witness-decode-failed');
  }

  try {
    const simulation = await simulateSubmitBeaconWithWitness({
      ...options,
      ...witness,
    });

    return {
      ...simulation,
      submission: 'witness' as const,
    };
  } catch (error) {
    // Match viem's decoded simulation error, never provider message text.
    if (
      !(error instanceof ContractFunctionExecutionError) ||
      error.contractAddress?.toLowerCase() !== options.deployment.address.toLowerCase() ||
      error.functionName !== 'submitBeaconWithWitness' ||
      !(error.cause instanceof ContractFunctionRevertedError) ||
      error.cause.data?.errorName !== 'InvalidBeacon'
    ) {
      throw error;
    }
  }

  return simulateCompressed(options, 'witness-rejected');
}

async function simulateCompressed(
  options: SimulateSubmitBeaconOptions,
  fallbackReason: WitnessFallbackReason,
) {
  const simulation = await simulateSubmitBeacon(options);

  return {
    ...simulation,
    submission: 'compressed' as const,
    fallbackReason,
  };
}