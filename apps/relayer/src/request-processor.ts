import type {
  Account,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  ImportQuicknetRoundResult,
} from './import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from './import-round-when-available.js';

import type {
  QuicknetRandomnessRequest,
} from './request-events.js';

export interface ProcessQuicknetRequestsOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  requests: readonly QuicknetRandomnessRequest[];
}

export interface ProcessedQuicknetRound {
  round: bigint;
  result: ImportQuicknetRoundResult;
}

export interface ProcessQuicknetRequestsResult {
  rounds: readonly ProcessedQuicknetRound[];
}

export async function processQuicknetRequests(
  options: ProcessQuicknetRequestsOptions,
): Promise<ProcessQuicknetRequestsResult> {
  const uniqueRounds = getUniqueRounds(options.requests);

  const rounds: ProcessedQuicknetRound[] = [];
  for (const round of uniqueRounds) {
    const result = await importQuicknetRoundWhenAvailable({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      deployment: options.deployment,
      round,
    });

    rounds.push({
      round,
      result,
    });
  }

  return { 
    rounds,
  };
}

function getUniqueRounds(
  requests: readonly QuicknetRandomnessRequest[],
): readonly bigint[] {
  const seen = new Set<bigint>();
  const rounds: bigint[] = [];

  for (const request of requests) {
    if (seen.has(request.round)) {
      continue;
    }

    seen.add(request.round);
    rounds.push(request.round);
  }

  return rounds;
}