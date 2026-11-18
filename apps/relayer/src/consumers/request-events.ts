import {
  type Address,
  type PublicClient,
} from 'viem';

import type {
  RequestDiscoveryObserver,
} from '../diagnostics/request-discovery.js';

import {
  QUICKNET_RANDOMNESS_REQUESTED_EVENT,
} from './consumer-abi.js';

export interface QuicknetRandomnessRequest {
  consumer: Address;
  round: bigint;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
}

export interface GetQuicknetRandomnessRequestOptions {
  publicClient: PublicClient;
  consumers: readonly Address[];
  fromBlock: bigint;
  toBlock: bigint;
  onRequestDiscovered?: RequestDiscoveryObserver | undefined;
}

export async function getQuicknetRandomnessRequests(
  options: GetQuicknetRandomnessRequestOptions,
): Promise<readonly QuicknetRandomnessRequest[]> {
  if (options.fromBlock > options.toBlock) {
    throw new Error('fromBlock must not be greater than toBlock.');
  }

  if (options.consumers.length === 0) {
    return [];
  }

  const event = QUICKNET_RANDOMNESS_REQUESTED_EVENT;
  const logs = await options.publicClient.getLogs({
    address: [...options.consumers],
    event,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    strict: true,
  });

  const requests = logs.map((log) => {
    if (
      log.blockNumber === null ||
      log.transactionHash === null ||
      log.logIndex === null
    ) {
      throw new Error('Quicknet randomness request log is missing canonical log metadata.');
    }

    return {
      consumer: log.address,
      round: log.args.round,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  });

  // Decode the entire response before emitting anything. Preserve scan errors.
  if (options.onRequestDiscovered !== undefined) {
    for (const [index, request] of requests.entries()) {
      try {
        const blockHash = logs[index]!.blockHash;

        options.onRequestDiscovered(Object.freeze({
          consumer: request.consumer,
          round: request.round,
          blockNumber: request.blockNumber,
          transactionHash: request.transactionHash,
          logIndex: request.logIndex,
          ...(blockHash == null ? {} : { blockHash }),
        }));
      } catch {
        // Diagnostic failures must not change requests or processing.
      }
    }
  }

  return requests;
}