import { PublicClient } from "viem";
import { RegistryDeployment } from "./types.js";
import { drandQuicknetBeaconRegistryAbi } from "./abi.js";
import { verifyRegistryDeployment } from "./deployment.js";
import { roundScheduledTime } from "../../drand-quicknet/dist/rounds.js";

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

    oracle() {
      return client.readContract({
        ...contract,
        functionName: 'oracle',
      });
    },

    isStored(round: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'isStored',
        args: [round],
      });
    },

    getBeacon(round: bigint) {
      return client.readContract({
        ...contract,
        functionName: 'getBeacon',
        args: [round],
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