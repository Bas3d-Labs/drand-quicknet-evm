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
  type Address,
} from 'viem';

import type {
  ArbitrumNitroConfig,
} from './profile.js';

import {
  checkTimestampEnvelope,
  checkTimestampEnvelopeAtSnapshot,
} from './timestamp-envelope.js';
import { createSecurityPublicClient } from '../../core/client.js';

const PARENT_CHAIN_ID = 12345;
const OTHER_CHAIN_ID = 54321;

const BLOCK_NUMBER = 123456n;
const BLOCK_TIMESTAMP = 1700000000n;

const ROLLUP =
  '0x1111111111111111111111111111111111111111';

const SEQUENCER_INBOX =
  '0x2222222222222222222222222222222222222222';

const OTHER_SEQUENCER_INBOX =
  '0x3333333333333333333333333333333333333333';

const WASM_ROOT =
  '0x4444444444444444444444444444444444444444444444444444444444444444';

const DELAY_BLOCKS = 100n;
const FUTURE_BLOCKS = 10n;
const DELAY_SECONDS = 1200n;
const FUTURE_SECONDS = 120n;

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

interface TimestampEnvelopeRpcOptions {
  chainId?: number;
  blockNumber?: bigint;
  blockTimestamp?: bigint;
  sequencerInbox?: Address;
  delayBlocks?: bigint;
  futureBlocks?: bigint;
  delaySeconds?: bigint;
  futureSeconds?: bigint;
  failBlock?: boolean;
  failSequencerInbox?: boolean;
  failMaxTimeVariation?: boolean;
  malformedSequencerInbox?: boolean;
  malformedMaxTimeVariation?: boolean;
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
      delayBlocks: Number(DELAY_BLOCKS),
      futureBlocks: Number(FUTURE_BLOCKS),
      delaySeconds: Number(DELAY_SECONDS),
      futureSeconds: Number(FUTURE_SECONDS),
    },

    approvedWasmModuleRoots: [
      {
        consensusRelease: 'example-release',
        root: WASM_ROOT,
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

function timestampEnvelopeRpcResponder(
  options: TimestampEnvelopeRpcOptions = {},
): RpcResponder {
  const chainId = options.chainId ?? PARENT_CHAIN_ID;

  const blockNumber = options.blockNumber ?? BLOCK_NUMBER;
  const blockTimestamp = options.blockTimestamp ?? BLOCK_TIMESTAMP;
  const sequencerInbox = options.sequencerInbox ?? SEQUENCER_INBOX;

  const delayBlocks = options.delayBlocks ?? DELAY_BLOCKS;
  const futureBlocks = options.futureBlocks ?? FUTURE_BLOCKS;

  const delaySeconds = options.delaySeconds ?? DELAY_SECONDS;
  const futureSeconds = options.futureSeconds ?? FUTURE_SECONDS;

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
      if (address.toLowerCase() === ROLLUP.toLowerCase()) {
        if (options.failSequencerInbox === true) {
          throw new Error('sequencerInbox unavailable');
        }

        if (options.malformedSequencerInbox === true) {
          return '0x1234';
        }

        return encodeAbiParameters(
          [
            {
              type: 'address',
            },
          ],
          [
            sequencerInbox,
          ],
        );
      }

      if (
        address.toLowerCase() === sequencerInbox.toLowerCase()
      ) {
        if (options.failMaxTimeVariation === true) {
          throw new Error('maxTimeVariation unavailable');
        }

        if (options.malformedMaxTimeVariation === true) {
          return '0x1234';
        }

        return encodeAbiParameters(
          [
            {
              type: 'uint256',
            },
            {
              type: 'uint256',
            },
            {
              type: 'uint256',
            },
            {
              type: 'uint256',
            },
          ],
          [
            delayBlocks,
            futureBlocks,
            delaySeconds,
            futureSeconds,
          ],
        );
      }

      throw new Error(`unexpected eth_call address: ${address}`);
    }

    throw new Error(`unsupported RPC method: ${request.method}`);
  };
}

async function startTimestampEnvelopeRpcServer(
  options: TimestampEnvelopeRpcOptions = {},
): Promise<TestRpcServer> {
  return startRpcServer(
    timestampEnvelopeRpcResponder(options),
  );
}

async function runTimestampEnvelopeCheck(
  parentRpcUrl: string,
) {
  return checkTimestampEnvelope({
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

describe('checkTimestampEnvelope', () => {
  it('returns MATCH when the timestamp envelope matches', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer();

    const result = await runTimestampEnvelopeCheck(
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
      result.checks.sequencerInbox,
    ).toEqual({
      status: 'MATCH',
      expected: SEQUENCER_INBOX,
      observed: SEQUENCER_INBOX,
    });

    expect(
      result.checks.maxTimeVariation,
    ).toEqual({
      status: 'MATCH',

      expected: {
        delayBlocks: DELAY_BLOCKS,
        futureBlocks: FUTURE_BLOCKS,
        delaySeconds: DELAY_SECONDS,
        futureSeconds: FUTURE_SECONDS,
      },

      observed: {
        delayBlocks: DELAY_BLOCKS,
        futureBlocks: FUTURE_BLOCKS,
        delaySeconds: DELAY_SECONDS,
        futureSeconds: FUTURE_SECONDS,
      },
    });
  });

  it('establishes parent chain identity before any other observation', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      chainId: OTHER_CHAIN_ID,
    });

    await expect(
      runTimestampEnvelopeCheck(
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
    const rpcServer =
      await startTimestampEnvelopeRpcServer({
        failBlock: true,
      });

    await expect(
      runTimestampEnvelopeCheck(
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

  it('uses one pinned parent block for both contract reads', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer();

    await runTimestampEnvelopeCheck(rpcServer.url);

    expect(
      rpcServer.requests.map(
        request => request.method,
      ),
    ).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_call',
      'eth_call',
    ]);

    expect(
      rpcServer.requests[1]?.params,
    ).toEqual([
      'latest',
      false,
    ]);

    const blockTag = `0x${BLOCK_NUMBER.toString(16)}`;

    expect(
      rpcServer.requests[2]?.params?.[1],
    ).toBe(
      blockTag,
    );

    expect(
      rpcServer.requests[3]?.params?.[1],
    ).toBe(
      blockTag,
    );
  });

  it('derives the SequencerInbox from the Rollup before reading maxTimeVariation', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer();

    await runTimestampEnvelopeCheck(rpcServer.url);

    expect(
      requireCallAddress(
        rpcServer.requests[2]!,
      ).toLowerCase(),
    ).toBe(
      ROLLUP.toLowerCase(),
    );

    expect(
      requireCallAddress(
        rpcServer.requests[3]!,
      ).toLowerCase(),
    ).toBe(
      SEQUENCER_INBOX.toLowerCase(),
    );
  });

  it('returns DRIFT and skips maxTimeVariation when the SequencerInbox mismatches', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      sequencerInbox: OTHER_SEQUENCER_INBOX,
    });

    const result = await runTimestampEnvelopeCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.sequencerInbox,
    ).toEqual({
      status: 'DRIFT',
      expected: SEQUENCER_INBOX,
      observed: OTHER_SEQUENCER_INBOX,
      reason: 'Rollup sequencerInbox does not match.',
    });

    expect(
      result.checks.maxTimeVariation,
    ).toEqual({
      status: 'SKIPPED',

      expected: {
        delayBlocks: DELAY_BLOCKS,
        futureBlocks: FUTURE_BLOCKS,
        delaySeconds: DELAY_SECONDS,
        futureSeconds: FUTURE_SECONDS,
      },

      reason:
        'SequencerInbox identity was not established.',
    });

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

  it('returns ERROR and skips maxTimeVariation when the SequencerInbox cannot be observed', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      failSequencerInbox: true,
    });

    const result = await runTimestampEnvelopeCheck(rpcServer.url);

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.sequencerInbox.status,
    ).toBe(
      'ERROR',
    );

    expect(
      result.checks.maxTimeVariation.status,
    ).toBe(
      'SKIPPED',
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

  it('returns DRIFT when maxTimeVariation mismatches', async () => {
    const observedDelaySeconds = DELAY_SECONDS + 1n;

    const rpcServer = await startTimestampEnvelopeRpcServer({
      delaySeconds: observedDelaySeconds,
    });

    const result = await runTimestampEnvelopeCheck(rpcServer.url);

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.sequencerInbox.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.maxTimeVariation,
    ).toEqual({
      status: 'DRIFT',

      expected: {
        delayBlocks: DELAY_BLOCKS,
        futureBlocks: FUTURE_BLOCKS,
        delaySeconds: DELAY_SECONDS,
        futureSeconds: FUTURE_SECONDS,
      },

      observed: {
        delayBlocks: DELAY_BLOCKS,
        futureBlocks: FUTURE_BLOCKS,
        delaySeconds: observedDelaySeconds,
        futureSeconds: FUTURE_SECONDS,
      },

      reason: 'maxTimeVariation does not match.',
    });
  });

  it('returns ERROR when maxTimeVariation cannot be observed', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      failMaxTimeVariation: true,
    });

    const result = await runTimestampEnvelopeCheck(rpcServer.url);

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.sequencerInbox.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.maxTimeVariation.status,
    ).toBe(
      'ERROR',
    );
  });

  it('returns ERROR and skips maxTimeVariation when sequencerInbox cannot be decoded', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      malformedSequencerInbox: true,
    });

    const result = await runTimestampEnvelopeCheck(rpcServer.url);

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.sequencerInbox.status,
    ).toBe(
      'ERROR',
    );

    expect(
      result.checks.maxTimeVariation.status,
    ).toBe(
      'SKIPPED',
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

  it('returns ERROR when maxTimeVariation cannot be decoded', async () => {
    const rpcServer = await startTimestampEnvelopeRpcServer({
      malformedMaxTimeVariation: true,
    });

    const result = await runTimestampEnvelopeCheck(rpcServer.url);

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.sequencerInbox.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.maxTimeVariation.status,
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
      'eth_call',
    ]);
  });

  describe('checkTimestampEnvelopeAtSnapshot', () => {
    it('uses the supplied parent snapshot without rechecking chain identity or repinning', async () => {
      const rpcServer = await startTimestampEnvelopeRpcServer();

      const client = createSecurityPublicClient(rpcServer.url);

      const result = await checkTimestampEnvelopeAtSnapshot({
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
        'eth_call',
      ]);

      const blockTag = `0x${BLOCK_NUMBER.toString(16)}`;

      expect(
        rpcServer.requests[0]?.params?.[1],
      ).toBe(
        blockTag,
      );

      expect(
        rpcServer.requests[1]?.params?.[1],
      ).toBe(
        blockTag,
      );
    });
  });
});