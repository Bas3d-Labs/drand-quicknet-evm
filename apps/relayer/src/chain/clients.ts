import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import type {
  PublicClient,
  WalletClient,
} from 'viem';
import type { RelayerConfig } from "../config/config.js";

export interface RelayerClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function createRelayerClients(
  config: RelayerConfig
): RelayerClients {
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  });

  const walletClient = createWalletClient({
    account: config.account,
    chain: config.chain,
    transport: http(config.rpcUrl),
  });

  return {
    publicClient,
    walletClient,
  };
}