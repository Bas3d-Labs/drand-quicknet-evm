import {
  createPublicClient,
  createWalletClient,
  type PublicClient,
  type WalletClient,
} from 'viem';

import type {
  RelayerConfig,
} from '../config/config.js';

import {
  createRpcMetrics,
  type RpcMetrics,
  type RpcMetricsOptions,
} from '../diagnostics/rpc/rpc-metrics.js';

import {
  measuredHttp,
} from './measured-http.js';

export interface RelayerClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  rpcMetrics: RpcMetrics;
}

export function createRelayerClients(
  config: RelayerConfig,
  metricsOptions: RpcMetricsOptions = {},
): RelayerClients {
  const rpcMetrics = createRpcMetrics(metricsOptions);

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: measuredHttp(
      config.rpcUrl,
      rpcMetrics,
      'public',
    ),
  });

  const walletClient = createWalletClient({
    account: config.account,
    chain: config.chain,
    transport: measuredHttp(
      config.rpcUrl,
      rpcMetrics,
      'wallet',
    ),
  });

  return {
    publicClient,
    walletClient,
    rpcMetrics,
  };
}