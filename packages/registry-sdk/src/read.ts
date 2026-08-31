import type {
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from './types.js';

import {
  drandQuicknetBeaconRegistryAbi,
} from './abi.js';

import {
  verifyRegistryDeployment,
} from './deployment.js';

export interface CreateRegistryReaderOptions {
  client: PublicClient;
  deployment: RegistryDeployment;
}

export function createRegistryReader(
  options: CreateRegistryReaderOptions,
) {
  const { client, deployment } = options;

  const contract = {
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
  };

  return {
    deployment,

    verifyDeployment() {
      return verifyRegistryDeployment(
        client,
        deployment,
      );
    },

    verifier() {
      return client.readContract({
        ...contract,
        functionName: 'verifier',
      });
    },

    verifierCodehash() {
      return client.readContract({
        ...contract,
        functionName: 'verifierCodehash',
      });
    },

    minimumLeadRounds() {
      return client.readContract({
        ...contract,
        functionName: 'minimumLeadRounds',
      });
    },

    isStored(round: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'isStored',
        args: [round],
      });
    },

    getBeacon(round: bigint, blockNumber?: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'getBeacon',
        args: [round],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
    },

    roundAt(timestamp: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'roundAt',
        args: [timestamp],
      });
    },

    roundScheduledTime(round: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'roundScheduledTime',
        args: [round],
      });
    },

    latestScheduledRound() {
      return client.readContract({
        ...contract,
        functionName: 'latestScheduledRound',
      });
    },
  } as const;
}