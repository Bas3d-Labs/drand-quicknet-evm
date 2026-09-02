import {
  createServer,
} from 'node:http';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  RpcChainIdMismatchError,
  createSecurityPublicClient,
  pinChainSnapshot,
  verifyRpcChainId,
} from './client.js';

const CHAIN_ID = 12345;
const OTHER_CHAIN_ID = 54321;

const BLOCK_NUMBER = 123456n;
const BLOCK_TIMESTAMP = 1700000000n;

const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000';

const BLOCK_HASH = `0x${'11'.repeat(32)}`;
const PARENT_HASH = `0x${'22'.repeat(32)}`;

const STATE_ROOT = `0x${'33'.repeat(32)}`;
const TRANSACTIONS_ROOT = `0x${'44'.repeat(32)}`;
const RECEIPTS_ROOT = `0x${'55'.repeat(32)}`;

const UNCLES_HASH = `0x${'66'.repeat(32)}`;
const MIX_HASH = `0x${'77'.repeat(32)}`;
const LOGS_BLOOM = `0x${'00'.repeat(256)}`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown[];
}

interface TestRpcServer {
  url: string;
  requests: JsonRpcRequest[];
  close(): Promise<void>;
}

type RpcResponder =
  (
    request: JsonRpcRequest,
  ) => unknown | Promise<unknown>;

const rpcServers: TestRpcServer[] = [];

function blockFixture(
  blockNumber: bigint | null,
  timestamp: bigint,
) {
  let number: string | null = null;

  if (blockNumber !== null) {
    number = `0x${blockNumber.toString(16)}`;
  }

  return {
    baseFeePerGas: '0x0',
    difficulty: '0x0',
    extraData: '0x',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    hash: BLOCK_HASH,
    logsBloom: LOGS_BLOOM,
    miner: ZERO_ADDRESS,
    mixHash: MIX_HASH,
    nonce: '0x0000000000000000',
    number,
    parentHash: PARENT_HASH,
    receiptsRoot: RECEIPTS_ROOT,
    sha3Uncles: UNCLES_HASH,
    size: '0x0',
    stateRoot: STATE_ROOT,
    timestamp: `0x${timestamp.toString(16)}`,
    totalDifficulty: '0x0',
    transactions: [],
    transactionsRoot: TRANSACTIONS_ROOT,
    uncles: [],
  };
}

async function readRequestBody(
  request: AsyncIterable<unknown>,
): Promise<string> {
  let body = '';

  for await (const chunk of request) {
    body += String(chunk);
  }

  return body;
}

async function startRpcServer(
  responder: RpcResponder,
): Promise<TestRpcServer> {
  const requests: JsonRpcRequest[] = [];

  const server = createServer(async (request, response) => {
    try {
      request.setEncoding('utf8');

      const body = await readRequestBody(request);
      const rpcRequest = JSON.parse(body) as JsonRpcRequest;

      requests.push(rpcRequest);

      const result = await responder(rpcRequest);

      response.writeHead(
        200,
        {
          'content-type': 'application/json',
        },
      );

      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcRequest.id,
          result,
        }),
      );
    } catch (error) {
      let message = 'test RPC server error';
      if (error instanceof Error) {
        message = error.message;
      }

      response.writeHead(200,
        {
          'content-type': 'application/json',
        },
      );

      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message,
          },
        }),
      );
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);

    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  

  const address =  server.address();
  if (
    address === null ||
    typeof address === 'string'
  ) {
    throw new Error(
      'test RPC server did not expose a TCP address.'
    );
  }

  const port = address.port;

  const rpcServer: TestRpcServer = {
    url: `http://127.0.0.1:${port}`,
    requests,

    async close(): Promise<void> {
      await new Promise<void>(
        (resolveClose, rejectClose) => {
          server.close(
            error => {
              if (error !== undefined) {
                rejectClose(error);
                return;
              }

              resolveClose();
            },
          );
        },
      );
    },
  };

  rpcServers.push(rpcServer);

  return rpcServer;
}

afterEach(async () => {
  for (const rpcServer of rpcServers) {
    await rpcServer.close();
  }

  rpcServers.length = 0;
});

describe('createSecurityPublicClient', () => {
  it('rejects an empty RPC URL', () => {
    expect(
      () => createSecurityPublicClient(
        '   ',
      ),
    ).toThrow(
      'rpcUrl must not be empty.'
    );
  });
});

describe('verifyRpcChainId', () => {
  it('accepts the expected chain ID', async () => {
    const rpcServer =
      await startRpcServer(
        request => {
          expect(
            request.method,
          ).toBe(
            'eth_chainId',
          );

          return `0x${CHAIN_ID.toString(16)}`;
        },
      );

    const client =
      createSecurityPublicClient(
        rpcServer.url,
      );

    await expect(
      verifyRpcChainId(
        client,
        CHAIN_ID,
      ),
    ).resolves.toBe(
      CHAIN_ID,
    );

    expect(
      rpcServer.requests,
    ).toHaveLength(1);
  });

  it('rejects a mismatched chain ID with structured values', async () => {
    const rpcServer =
      await startRpcServer(
        request => {
          expect(
            request.method,
          ).toBe(
            'eth_chainId',
          );

          return `0x${OTHER_CHAIN_ID.toString(16)}`;
        },
      );

    const client = createSecurityPublicClient(rpcServer.url);

    await expect(
      verifyRpcChainId(
        client,
        CHAIN_ID,
      ),
    ).rejects.toMatchObject({
      name: 'RpcChainIdMismatchError',
      expectedChainId: CHAIN_ID,
      observedChainId: OTHER_CHAIN_ID,
      message:
        'RPC chainId mismatch: '
        + `expected=${CHAIN_ID} `
        + `observed=${OTHER_CHAIN_ID}.`,
    });
  });

  it('uses the dedicated mismatch error type', async () => {
    const rpcServer =
      await startRpcServer(
        () => {
          return `0x${OTHER_CHAIN_ID.toString(16)}`;
        },
      );

    const client =
      createSecurityPublicClient(
        rpcServer.url,
      );

    await expect(
      verifyRpcChainId(
        client,
        CHAIN_ID,
      ),
    ).rejects.toBeInstanceOf(
      RpcChainIdMismatchError,
    );
  });
});

describe('pinChainSnapshot', () => {
  it('pins the latest block number and timestamp', async () => {
    const rpcServer =
      await startRpcServer(
        request => {
          expect(
            request.method,
          ).toBe(
            'eth_getBlockByNumber',
          );

          return blockFixture(
            BLOCK_NUMBER,
            BLOCK_TIMESTAMP,
          );
        },
      );

    const client =
      createSecurityPublicClient(
        rpcServer.url,
      );

    await expect(
      pinChainSnapshot(
        client,
      ),
    ).resolves.toEqual({
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
    });
  });

  it('requests the latest block without full transactions', async () => {
    const rpcServer =
      await startRpcServer(
        () => {
          return blockFixture(
            BLOCK_NUMBER,
            BLOCK_TIMESTAMP,
          );
        },
      );

    const client =
      createSecurityPublicClient(
        rpcServer.url,
      );

    await pinChainSnapshot(
      client,
    );

    expect(
      rpcServer.requests,
    ).toHaveLength(1);

    expect(
      rpcServer.requests[0],
    ).toMatchObject({
      method: 'eth_getBlockByNumber',
      params: [
        'latest',
        false,
      ],
    });
  });

  it('rejects a latest block without a block number', async () => {
    const rpcServer =
      await startRpcServer(
        () => {
          return blockFixture(
            null,
            BLOCK_TIMESTAMP,
          );
        },
      );

    const client =
      createSecurityPublicClient(
        rpcServer.url,
      );

    await expect(
      pinChainSnapshot(
        client,
      ),
    ).rejects.toThrow(
      'latest block does not have a block number.'
    );
  });
});