import {
  createPublicClient,
  http,
} from 'viem';

export interface ChainSnapshot {
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export class RpcChainIdMismatchError
  extends Error {
  constructor(
    public readonly expectedChainId: number,
    public readonly observedChainId: number,
  ) {
    super(
      `RPC chainId mismatch: expected=${expectedChainId} observed=${observedChainId}.`
    );

    this.name = 'RpcChainIdMismatchError';
  }
}

export function createSecurityPublicClient(
  rpcUrl: string,
) {
  if (rpcUrl.trim().length === 0) {
    throw new Error('rpcUrl must not be empty.');
  }

  return createPublicClient({
    transport: http(rpcUrl, { retryCount: 0 }),
  });
}

export type SecurityPublicClient =
  ReturnType<typeof createSecurityPublicClient>;

export async function verifyRpcChainId(
  client: SecurityPublicClient,
  expectedChainId: number,
): Promise<number> {
  const observedChainId = await client.getChainId();
  if (observedChainId !== expectedChainId) {
    throw new RpcChainIdMismatchError(
      expectedChainId,
      observedChainId,
    );
  }

  return observedChainId;
}

export async function pinChainSnapshot(
  client: SecurityPublicClient,
): Promise<ChainSnapshot> {
  const block = await client.getBlock({
    blockTag: 'latest',
  });

  if (block.number === null) {
    throw new Error('latest block does not have a block number.');
  }

  return {
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
  };
}