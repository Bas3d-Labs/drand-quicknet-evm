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
  keccak256,
  type Hex,
} from 'viem';

import {
  checkDeployment,
} from './deployment.js';

import type {
  DeploymentManifest,
} from './manifest.js';

import type {
  ChainProfile,
} from './profile.js';

const NETWORK = 'example-network';
const CHAIN_ID = 12345;
const OTHER_CHAIN_ID = 54321;

const BLOCK_NUMBER = 123456n;
const BLOCK_TIMESTAMP = 1700000000n;

const MINIMUM_LEAD_ROUNDS = 5n;

const REGISTRY =
  '0x1111111111111111111111111111111111111111';

const VERIFIER =
  '0x2222222222222222222222222222222222222222';

const ROLLUP =
  '0x3333333333333333333333333333333333333333';

const SEQUENCER_INBOX =
  '0x4444444444444444444444444444444444444444';

const WASM_ROOT =
  '0x5555555555555555555555555555555555555555555555555555555555555555';

const REGISTRY_DEPLOYMENT_TX =
  '0x6666666666666666666666666666666666666666666666666666666666666666';

const VERIFIER_DEPLOYMENT_TX =
  '0x7777777777777777777777777777777777777777777777777777777777777777';

const REGISTRY_CODE =
  '0x6001600055';

const VERIFIER_CODE =
  '0x6002600055';

const OTHER_REGISTRY_CODE =
  '0x6003600055';

const REGISTRY_CODEHASH =
  keccak256(REGISTRY_CODE);

const VERIFIER_CODEHASH =
  keccak256(VERIFIER_CODE);

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

interface DeploymentRpcOptions {
  chainId?: number;
  blockNumber?: bigint;
  blockTimestamp?: bigint;
  registryCode?: Hex;
  verifierCode?: Hex;
  minimumLeadRounds?: bigint;
  failBlock?: boolean;
  failRegistryCode?: boolean;
  failVerifierCode?: boolean;
  failMinimumLeadRounds?: boolean;
}

type RpcResponder =
  (
    request: JsonRpcRequest,
  ) => unknown | Promise<unknown>;

const rpcServers: TestRpcServer[] = [];

function profileFixture(): ChainProfile {
  return {
    profileVersion: 1,
    network: NETWORK,
    chainId: CHAIN_ID,
    onboardingTier: 1,
    documentation: './example-network.md',

    randomness: {
      beacon: 'drand-quicknet',
      periodSeconds: 3,
    },

    timing: {
      minimumLeadRounds: Number(
        MINIMUM_LEAD_ROUNDS,
      ),

      timestampFreshnessReserveSeconds: 3,
    },

    securityModel: {
      timestampAuthority: 'sequencer',
      historyIntegrityAssumption: 'trusted-sequencer',
      assumptionsSection: 'security-assumptions',
    },

    monitoring: {
      timestampSkewSeconds: {
        warning: 5,
        critical: 8,
      },
    },

    chainAdapter: {
      type: 'arbitrum-nitro',

      config: {
        parentChain: {
          name: 'example-parent',
          chainId: 23456,
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
        ],
      },
    },

    deploymentManifest: '../../../deployments/example-network.json',
  };
}

function manifestFixture(): DeploymentManifest {
  return {
    manifestVersion: 1,
    network: NETWORK,
    chainId: CHAIN_ID,

    registry: {
      address: REGISTRY,
      runtimeCodehash: REGISTRY_CODEHASH,

      deployment: {
        transactionHash:
          REGISTRY_DEPLOYMENT_TX,
        blockNumber: 900,
      },
    },

    verifier: {
      address: VERIFIER,
      runtimeCodehash: VERIFIER_CODEHASH,

      deployment: {
        transactionHash:
          VERIFIER_DEPLOYMENT_TX,
        blockNumber: 800,
      },
    },
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
          'content-type':
            'application/json',
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
    server.once(
      'error',
      rejectListen,
    );

    server.listen(
      0,
      '127.0.0.1',
      () => {
        server.off(
          'error',
          rejectListen,
        );

        resolveListen();
      },
    );
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

function requireStringParameter(
  request: JsonRpcRequest,
  index: number,
): string {
  const value = request.params?.[index];
  if (typeof value !== 'string') {
    throw new Error(
      `RPC parameter ${index} must be a string.`
    );
  }

  return value;
}

function deploymentRpcResponder(
  options: DeploymentRpcOptions = {},
): RpcResponder {
  const chainId = options.chainId ?? CHAIN_ID;

  const blockNumber = options.blockNumber ?? BLOCK_NUMBER;

  const blockTimestamp = options.blockTimestamp ?? BLOCK_TIMESTAMP;

  const registryCode = options.registryCode ?? REGISTRY_CODE;

  const verifierCode = options.verifierCode ?? VERIFIER_CODE;

  const minimumLeadRounds =
    options.minimumLeadRounds
    ?? MINIMUM_LEAD_ROUNDS;

  return request => {
    if (request.method === 'eth_chainId') {
      return `0x${chainId.toString(16)}`;
    }

    if (
      request.method === 'eth_getBlockByNumber'
    ) {
      if (options.failBlock === true) {
        throw new Error(
          'block unavailable'
        );
      }

      return blockFixture(
        blockNumber,
        blockTimestamp,
      );
    }

    if (request.method === 'eth_getCode') {
      const address = requireStringParameter(request, 0);
      if (
        address.toLowerCase() === REGISTRY.toLowerCase()
      ) {
        if (
          options.failRegistryCode === true
        ) {
          throw new Error('registry code unavailable');
        }

        return registryCode;
      }

      if (
        address.toLowerCase() === VERIFIER.toLowerCase()
      ) {
        if (
          options.failVerifierCode === true
        ) {
          throw new Error('verifier code unavailable');
        }

        return verifierCode;
      }

      throw new Error(
        `unexpected eth_getCode address: ${address}`
      );
    }

    if (request.method === 'eth_call') {
      if (
        options.failMinimumLeadRounds === true
      ) {
        throw new Error('minimumLeadRounds unavailable');
      }

      return encodeAbiParameters(
        [
          {
            type: 'uint64',
          },
        ],
        [
          minimumLeadRounds,
        ],
      );
    }

    throw new Error(
      `unsupported RPC method: ${request.method}`
    );
  };
}

async function startDeploymentRpcServer(
  options: DeploymentRpcOptions = {},
): Promise<TestRpcServer> {
  return startRpcServer(
    deploymentRpcResponder(options),
  );
}

async function runDeploymentCheck(
  rpcUrl: string,
) {
  return checkDeployment({
    rpcUrl,
    profile: profileFixture(),
    manifest: manifestFixture(),
  });
}

afterEach(async () => {
  for (const rpcServer of rpcServers) {
    await rpcServer.close();
  }

  rpcServers.length = 0;
});

describe('checkDeployment', () => {
  it('returns MATCH when deployment state matches', async () => {
    const rpcServer = await startDeploymentRpcServer();

    const result = await runDeploymentCheck(
      rpcServer.url,
    );

    expect(result.status).toBe(
      'MATCH',
    );

    expect(
      result.observedChainId,
    ).toBe(
      CHAIN_ID,
    );

    expect(result.snapshot).toEqual({
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
    });

    expect(
      result.checks.registryRuntimeCodehash,
    ).toEqual({
      status: 'MATCH',
      expected: REGISTRY_CODEHASH,
      observed: REGISTRY_CODEHASH,
    });

    expect(
      result.checks.verifierRuntimeCodehash,
    ).toEqual({
      status: 'MATCH',
      expected: VERIFIER_CODEHASH,
      observed: VERIFIER_CODEHASH,
    });

    expect(
      result.checks.registryMinimumLeadRounds,
    ).toEqual({
      status: 'MATCH',
      expected: MINIMUM_LEAD_ROUNDS,
      observed: MINIMUM_LEAD_ROUNDS,
    });
  });

  it('establishes chain identity before any other observation', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        chainId: OTHER_CHAIN_ID,
      });

    await expect(
      runDeploymentCheck(
        rpcServer.url,
      ),
    ).rejects.toThrow(
      'RPC chainId mismatch: '
      + `expected=${CHAIN_ID} `
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

  it('does not perform substantive reads when the snapshot cannot be pinned', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        failBlock: true,
      });

    await expect(
      runDeploymentCheck(
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

  it('uses one pinned block for every substantive read', async () => {
    const rpcServer =
      await startDeploymentRpcServer();

    await runDeploymentCheck(
      rpcServer.url,
    );

    const methods =
      rpcServer.requests.map(
        request => request.method,
      );

    expect(methods).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getCode',
      'eth_call',
    ]);

    expect(
      rpcServer.requests[1]?.params,
    ).toEqual([
      'latest',
      false,
    ]);

    const blockTag =
      `0x${BLOCK_NUMBER.toString(16)}`;

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

    expect(
      rpcServer.requests[4]?.params?.[1],
    ).toBe(
      blockTag,
    );
  });

  it('returns DRIFT and skips the floor read when registry code is missing', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        registryCode: '0x',
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.registryRuntimeCodehash,
    ).toEqual({
      status: 'DRIFT',
      expected: REGISTRY_CODEHASH,
      observed: null,
      reason: 'address has no runtime code.',
    });

    expect(
      result.checks.registryMinimumLeadRounds,
    ).toEqual({
      status: 'SKIPPED',
      expected: MINIMUM_LEAD_ROUNDS,
      reason:
        'registry identity was not established.',
    });

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      rpcServer.requests.some(
        request =>
          request.method === 'eth_call',
      ),
    ).toBe(false);
  });

  it('returns DRIFT and skips the floor read when registry codehash mismatches', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        registryCode:
          OTHER_REGISTRY_CODE,
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.registryRuntimeCodehash,
    ).toEqual({
      status: 'DRIFT',
      expected: REGISTRY_CODEHASH,
      observed:
        keccak256(
          OTHER_REGISTRY_CODE,
        ),
      reason:
        'runtime codehash does not match.',
    });

    expect(
      result.checks.registryMinimumLeadRounds.status,
    ).toBe(
      'SKIPPED',
    );

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      rpcServer.requests.some(
        request =>
          request.method === 'eth_call',
      ),
    ).toBe(false);
  });

  it('returns ERROR for a registry code observation failure and still checks the verifier', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        failRegistryCode: true,
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.registryRuntimeCodehash.status,
    ).toBe(
      'ERROR',
    );

    expect(
      result.checks.registryMinimumLeadRounds.status,
    ).toBe(
      'SKIPPED',
    );

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      rpcServer.requests.some(
        request =>
          request.method === 'eth_call',
      ),
    ).toBe(false);
  });

  it('returns DRIFT for missing verifier code and still reads the verified registry floor', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        verifierCode: '0x',
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.registryRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.verifierRuntimeCodehash,
    ).toEqual({
      status: 'DRIFT',
      expected: VERIFIER_CODEHASH,
      observed: null,
      reason: 'address has no runtime code.',
    });

    expect(
      result.checks.registryMinimumLeadRounds.status,
    ).toBe(
      'MATCH',
    );

    expect(
      rpcServer.requests.some(
        request =>
          request.method === 'eth_call',
      ),
    ).toBe(true);
  });

  it('returns ERROR for a verifier code observation failure and still reads the verified registry floor', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        failVerifierCode: true,
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.registryRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'ERROR',
    );

    expect(
      result.checks.registryMinimumLeadRounds.status,
    ).toBe(
      'MATCH',
    );
  });

  it('returns DRIFT when minimumLeadRounds mismatches', async () => {
    const observed =
      MINIMUM_LEAD_ROUNDS + 1n;

    const rpcServer =
      await startDeploymentRpcServer({
        minimumLeadRounds: observed,
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'DRIFT',
    );

    expect(
      result.checks.registryMinimumLeadRounds,
    ).toEqual({
      status: 'DRIFT',
      expected: MINIMUM_LEAD_ROUNDS,
      observed,
      reason:
        'minimumLeadRounds does not match.',
    });

    expect(
      result.checks.registryRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );
  });

  it('returns ERROR when minimumLeadRounds cannot be observed', async () => {
    const rpcServer =
      await startDeploymentRpcServer({
        failMinimumLeadRounds: true,
      });

    const result =
      await runDeploymentCheck(
        rpcServer.url,
      );

    expect(result.status).toBe(
      'ERROR',
    );

    expect(
      result.checks.registryRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.verifierRuntimeCodehash.status,
    ).toBe(
      'MATCH',
    );

    expect(
      result.checks.registryMinimumLeadRounds.status,
    ).toBe(
      'ERROR',
    );
  });
});