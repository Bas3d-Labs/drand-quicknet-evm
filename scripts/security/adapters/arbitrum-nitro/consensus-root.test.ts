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
  encodeAbiParameters,
  type Hex,
} from 'viem';

import {
  createSecurityPublicClient,
} from '../../core/client.js';

import {
  checkConsensusRoot,
  checkConsensusRootAtSnapshot,
} from './consensus-root.js';

import type {
  ArbitrumNitroConfig,
} from './profile.js';

const PARENT_CHAIN_ID = 12345;
const OTHER_CHAIN_ID = 54321;

const BLOCK_NUMBER = 123456n;
const BLOCK_TIMESTAMP = 1700000000n;

const ROLLUP =
  '0x1111111111111111111111111111111111111111';

const SEQUENCER_INBOX =
  '0x2222222222222222222222222222222222222222';

const WASM_ROOT =
  '0x3333333333333333333333333333333333333333333333333333333333333333';

const SECOND_WASM_ROOT =
  '0x4444444444444444444444444444444444444444444444444444444444444444';

const OTHER_WASM_ROOT =
  '0x5555555555555555555555555555555555555555555555555555555555555555';

const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000';

const BLOCK_HASH =
  `0x${'11'.repeat(32)}`;

const PARENT_HASH =
  `0x${'22'.repeat(32)}`;

const STATE_ROOT =
  `0x${'33'.repeat(32)}`;

const TRANSACTIONS_ROOT =
  `0x${'44'.repeat(32)}`;

const RECEIPTS_ROOT =
  `0x${'55'.repeat(32)}`;

const UNCLES_HASH =
  `0x${'66'.repeat(32)}`;

const MIX_HASH =
  `0x${'77'.repeat(32)}`;

const LOGS_BLOOM =
  `0x${'00'.repeat(256)}`;

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

interface ConsensusRootRpcOptions {
  chainId?: number;
  blockNumber?: bigint;
  blockTimestamp?: bigint;
  wasmModuleRoot?: Hex;
  failBlock?: boolean;
  failWasmModuleRoot?: boolean;
  malformedWasmModuleRoot?: boolean;
}

type RpcResponder =
  (
    request: JsonRpcRequest,
  ) => unknown | Promise<unknown>;

const rpcServers: TestRpcServer[] = [];

function configFixture(): ArbitrumNitroConfig {
  return {
    parentChain: {
      name: 'example-parent',
      chainId: PARENT_CHAIN_ID,
      slotSeconds: 12,
      requireTimeVariationSlotParity: true,
    },

    rollup: ROLLUP,
    expectedSequencerInbox: SEQUENCER_INBOX,

    expectedMaxTimeVariation: {
      delayBlocks: 100,
      futureBlocks: 10,
      delaySeconds: 1200,
      futureSeconds: 120,
    },

    approvedWasmModuleRoots: [
      {
        consensusRelease: 'example-release',
        root: WASM_ROOT,
      },
      {
        consensusRelease: 'example-release-2',
        root: SECOND_WASM_ROOT,
      },
    ],
  };
}

function blockFixture(
  blockNumber: bigint,
  timestamp: bigint,
) {
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
    number: `0x${blockNumber.toString(16)}`,
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

      response.writeHead(
        200,
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

  const address = server.address();
  if (
    address === null ||
    typeof address === 'string'
  ) {
    throw new Error(
      'test RPC server did not expose a TCP address.'
    );
  }

  const rpcServer: TestRpcServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,

    async close(): Promise<void> {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      });
    },
  };

  rpcServers.push(rpcServer);

  return rpcServer;
}

function requireCallAddress(
  request: JsonRpcRequest,
): string {
  const call = request.params?.[0];
  if (
    typeof call !== 'object' ||
    call === null
  ) {
    throw new Error('eth_call parameter must be an object.');
  }

  if (
    !('to' in call) ||
    typeof call.to !== 'string'
  ) {
    throw new Error('eth_call target must be a string.');
  }

  return call.to;
}

function consensusRootRpcResponder(
  options: ConsensusRootRpcOptions = {},
): RpcResponder {
  const chainId = options.chainId ?? PARENT_CHAIN_ID;

  const blockNumber = options.blockNumber ?? BLOCK_NUMBER;
  const blockTimestamp = options.blockTimestamp ?? BLOCK_TIMESTAMP;

  const wasmModuleRoot = options.wasmModuleRoot ?? WASM_ROOT;

  return request => {
    if (request.method === 'eth_chainId') {
      return `0x${chainId.toString(16)}`;
    }

    if (
      request.method === 'eth_getBlockByNumber'
    ) {
      if (options.failBlock === true) {
        throw new Error('block unavailable');
      }

      return blockFixture(
        blockNumber,
        blockTimestamp,
      );
    }

    if (request.method === 'eth_call') {
      const address = requireCallAddress(request);
      if (address.toLowerCase() !== ROLLUP.toLowerCase()) {
        throw new Error(`unexpected eth_call address: ${address}`);
      }

      if (options.failWasmModuleRoot === true) {
        throw new Error('wasmModuleRoot unavailable');
      }

      if (options.malformedWasmModuleRoot === true) {
        return '0x1234';
      }

      return encodeAbiParameters(
        [
          {
            type: 'bytes32',
          },
        ],
        [
          wasmModuleRoot,
        ],
      );
    }

    throw new Error(`unsupported RPC method: ${request.method}`);
  };
}

async function startConsensusRootRpcServer(
  options: ConsensusRootRpcOptions = {},
): Promise<TestRpcServer> {
  return startRpcServer(
    consensusRootRpcResponder(options),
  );
}

async function runConsensusRootCheck(
  parentRpcUrl: string,
) {
  return checkConsensusRoot({
    parentRpcUrl,
    config: configFixture(),
  });
}

afterEach(async () => {
  for (const rpcServer of rpcServers) {
    await rpcServer.close();
  }

  rpcServers.length = 0;
});

describe('checkConsensusRoot', () => {
  it('returns MATCH when the consensus root is approved', async () => {
    const rpcServer = await startConsensusRootRpcServer();

    const result = await runConsensusRootCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'MATCH',
    );

    expect(
      result.observedChainId,
    ).toBe(
      PARENT_CHAIN_ID,
    );

    expect(result.snapshot).toEqual({
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
    });

    expect(
      result.check,
    ).toEqual({
      status: 'MATCH',

      expected: [
        {
          consensusRelease: 'example-release',
          root: WASM_ROOT,
        },
        {
          consensusRelease: 'example-release-2',
          root: SECOND_WASM_ROOT,
        },
      ],

      observed: WASM_ROOT,

      matched: {
        consensusRelease: 'example-release',
        root: WASM_ROOT,
      },
    });
  });

  it('matches any approved consensus root and preserves its release', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      wasmModuleRoot: SECOND_WASM_ROOT,
    });

    const result = await runConsensusRootCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'MATCH',
    );

    expect(
      result.check,
    ).toEqual({
      status: 'MATCH',

      expected: [
        {
          consensusRelease: 'example-release',
          root: WASM_ROOT,
        },
        {
          consensusRelease: 'example-release-2',
          root: SECOND_WASM_ROOT,
        },
      ],

      observed: SECOND_WASM_ROOT,

      matched: {
        consensusRelease: 'example-release-2',
        root: SECOND_WASM_ROOT,
      },
    });
  });

  it('establishes parent chain identity before any other observation', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      chainId: OTHER_CHAIN_ID,
    });

    await expect(
      runConsensusRootCheck(
        rpcServer.url,
      ),
    ).rejects.toThrow(
      'RPC chainId mismatch: '
      + `expected=${PARENT_CHAIN_ID} `
      + `observed=${OTHER_CHAIN_ID}.`
    );

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
    ]);
  });

  it('does not perform contract reads when the parent snapshot cannot be pinned', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      failBlock: true,
    });

    await expect(
      runConsensusRootCheck(
        rpcServer.url,
      ),
    ).rejects.toThrow();

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
    ]);
  });

  it('reads the Rollup consensus root at the pinned parent block', async () => {
    const rpcServer = await startConsensusRootRpcServer();

    await runConsensusRootCheck(rpcServer.url);

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_call',
    ]);

    expect(
      rpcServer.requests[1]?.params,
    ).toEqual([
      'latest',
      false,
    ]);

    expect(
      requireCallAddress(
        rpcServer.requests[2]!,
      ).toLowerCase(),
    ).toBe(
      ROLLUP.toLowerCase(),
    );

    const blockTag = `0x${BLOCK_NUMBER.toString(16)}`;

    expect(
      rpcServer.requests[2]?.params?.[1],
    ).toBe(
      blockTag,
    );
  });

  it('returns DRIFT when the consensus root is not approved', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      wasmModuleRoot: OTHER_WASM_ROOT,
    });

    const result = await runConsensusRootCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.check,
    ).toEqual({
      status: 'DRIFT',

      expected: [
        {
          consensusRelease: 'example-release',
          root: WASM_ROOT,
        },
        {
          consensusRelease: 'example-release-2',
          root: SECOND_WASM_ROOT,
        },
      ],

      observed: OTHER_WASM_ROOT,
      reason: 'wasmModuleRoot is not in the approved root set.',
    });
  });

  it('returns ERROR when wasmModuleRoot cannot be observed', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      failWasmModuleRoot: true,
    });

    const result = await runConsensusRootCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.check.status,
    ).toBe(
      'ERROR',
    );

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_call',
    ]);
  });

  it('returns ERROR when wasmModuleRoot cannot be decoded', async () => {
    const rpcServer = await startConsensusRootRpcServer({
      malformedWasmModuleRoot: true,
    });

    const result = await runConsensusRootCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.check.status,
    ).toBe(
      'ERROR',
    );

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_call',
    ]);
  });
});

describe('checkConsensusRootAtSnapshot', () => {
  it('uses the supplied parent snapshot without rechecking chain identity or repinning', async () => {
    const rpcServer = await startConsensusRootRpcServer();

    const client = createSecurityPublicClient(rpcServer.url);

    const result = await checkConsensusRootAtSnapshot({
      client,
      observedChainId: PARENT_CHAIN_ID,
      snapshot: {
        blockNumber: BLOCK_NUMBER,
        blockTimestamp: BLOCK_TIMESTAMP,
      },
      config: configFixture(),
    });

    expect(result.status).toBe(
      'MATCH',
    );

    expect(
      result.observedChainId,
    ).toBe(
      PARENT_CHAIN_ID,
    );

    expect(result.snapshot).toEqual({
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
    });

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_call',
    ]);

    const blockTag = `0x${BLOCK_NUMBER.toString(16)}`;

    expect(
      rpcServer.requests[0]?.params?.[1],
    ).toBe(
      blockTag,
    );
  });
});