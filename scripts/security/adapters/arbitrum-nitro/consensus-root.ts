import {
  parseAbi,
  type Hex,
} from 'viem';

import {
  type ApprovedWasmModuleRoot,
  type ArbitrumNitroConfig,
} from './profile.js';

import {
  type ChainSnapshot,
  type SecurityPublicClient,
  createSecurityPublicClient,
  pinChainSnapshot,
  verifyRpcChainId,
} from '../../core/client.js';

import type {
  AggregateStatus,
  DriftCheckResult,
  ErrorCheckResult,
  MatchCheckResult,
} from '../../core/check.js';

export type ConsensusRootStatus = AggregateStatus;

export type ConsensusRootCheck =
  | (
      MatchCheckResult<
        ApprovedWasmModuleRoot[],
        Hex
      > & {
        matched: ApprovedWasmModuleRoot;
      }
    )
  | DriftCheckResult<ApprovedWasmModuleRoot[], Hex>
  | ErrorCheckResult<ApprovedWasmModuleRoot[]>;

export interface ConsensusRootCheckResult {
  status: ConsensusRootStatus;
  observedChainId: number;
  snapshot: ChainSnapshot;
  check: ConsensusRootCheck;
}

export interface CheckConsensusRootInput {
  parentRpcUrl: string;
  config: ArbitrumNitroConfig;
}

export interface CheckConsensusRootAtSnapshotInput {
  client: SecurityPublicClient;
  observedChainId: number;
  snapshot: ChainSnapshot;
  config: ArbitrumNitroConfig;
}

const ROLLUP_ABI = parseAbi([
  'function wasmModuleRoot() view returns (bytes32)',
]);

function errorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function findApprovedRoot(
  approvedRoots: ApprovedWasmModuleRoot[],
  observed: Hex,
): ApprovedWasmModuleRoot | undefined {
  const normalizedObserved = observed.toLowerCase();

  return approvedRoots.find(
    approved => approved.root === normalizedObserved
  );
}

async function checkWasmModuleRoot(
  client: SecurityPublicClient,
  config: ArbitrumNitroConfig,
  blockNumber: bigint,
): Promise<ConsensusRootCheck> {
  const expected = config.approvedWasmModuleRoots;

  let observed: Hex;

  try {
    observed = await client.readContract({
      address: config.rollup,
      abi: ROLLUP_ABI,
      functionName: 'wasmModuleRoot',
      blockNumber,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      expected,
      error: errorMessage(error),
    };
  }

  const matched = findApprovedRoot(expected, observed);
  if (matched === undefined) {
    return {
      status: 'DRIFT',
      expected,
      observed,
      reason: 'wasmModuleRoot is not in the approved root set.',
    };
  }

  return {
    status: 'MATCH',
    expected,
    observed,
    matched,
  };
}

export async function checkConsensusRootAtSnapshot(
  input: CheckConsensusRootAtSnapshotInput,
): Promise<ConsensusRootCheckResult> {
  const check = await checkWasmModuleRoot(
    input.client,
    input.config,
    input.snapshot.blockNumber,
  );

  return {
    status: check.status,
    observedChainId: input.observedChainId,
    snapshot: input.snapshot,
    check,
  };
}

export async function checkConsensusRoot(
  input: CheckConsensusRootInput,
): Promise<ConsensusRootCheckResult> {
  const client = createSecurityPublicClient(input.parentRpcUrl);

  const observedChainId = await verifyRpcChainId(
    client,
    input.config.parentChain.chainId,
  );

  const snapshot = await pinChainSnapshot(client);

  return checkConsensusRootAtSnapshot({
    client,
    observedChainId,
    snapshot,
    config: input.config,
  });
}