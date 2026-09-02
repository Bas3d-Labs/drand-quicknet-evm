import {
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

import {
  type ChainSnapshot,
  type SecurityPublicClient,
  createSecurityPublicClient,
  pinChainSnapshot,
  verifyRpcChainId,
} from './client.js';

import type {
  DeploymentManifest,
} from './manifest.js';

import type {
  ChainProfile,
} from './profile.js';

export type DeploymentCheckStatus =
  | 'MATCH'
  | 'DRIFT'
  | 'ERROR'
  | 'SKIPPED';

export type DeploymentStatus =
  | 'MATCH'
  | 'DRIFT'
  | 'ERROR';

export type DeploymentCheck<
  TExpected,
  TObserved = TExpected
> =
  | {
      status: 'MATCH';
      expected: TExpected;
      observed: TObserved;
    }
  | {
      status: 'DRIFT';
      expected: TExpected;
      observed: TObserved;
      reason: string;
    }
  | {
      status: 'ERROR';
      expected: TExpected;
      error: string;
    }
  | {
      status: 'SKIPPED';
      expected: TExpected;
      reason: string;
    };
  
export interface DeploymentChecks {
  registryRuntimeCodehash: DeploymentCheck<
    Hex,
    Hex | null
  >;

  verifierRuntimeCodehash: DeploymentCheck<
    Hex,
    Hex | null
  >;

  registryMinimumLeadRounds: DeploymentCheck<bigint>;
}

export interface DeploymentCheckResult {
  status: DeploymentStatus;
  observedChainId: number;
  snapshot: ChainSnapshot;
  checks: DeploymentChecks;
}

export interface CheckDeploymentInput {
  rpcUrl: string;
  profile: ChainProfile;
  manifest: DeploymentManifest;
}

const REGISTRY_ABI = parseAbi([
  'function minimumLeadRounds() view returns (uint64)',
]);

function errorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function checkRuntimeCodehash(
  client: SecurityPublicClient,
  address: Address,
  expected: Hex,
  blockNumber: bigint,
): Promise<DeploymentCheck<Hex, Hex | null>> {
  let code: Hex | undefined;

  try {
    code = await client.getCode({
      address,
      blockNumber,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      expected,
      error: errorMessage(error),
    };
  }

  if (code === undefined || code === '0x') {
    return {
      status: 'DRIFT',
      expected,
      observed: null,
      reason: 'address has no runtime code.',
    };
  }

  const observed = keccak256(code);
  if (observed !== expected) {
    return {
      status: 'DRIFT',
      expected,
      observed,
      reason: 'runtime codehash does not match.',
    };
  }

  return {
    status: 'MATCH',
    expected,
    observed,
  };
}

async function checkMinimumLeadRounds(
  client: SecurityPublicClient,
  registryAddress: Address,
  expected: bigint,
  blockNumber: bigint,
): Promise<DeploymentCheck<bigint>> {
  let observed: bigint;

  try {
    observed = await client.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: 'minimumLeadRounds',
      blockNumber,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      expected,
      error: errorMessage(error),
    };
  }

  if (observed !== expected) {
    return {
      status: 'DRIFT',
      expected,
      observed,
      reason: 'minimumLeadRounds does not match.',
    };
  }

  return {
    status: 'MATCH',
    expected,
    observed,
  };
}

function skippedMinimumLeadRounds(
  expected: bigint,
): DeploymentCheck<bigint> {
  return {
    status: 'SKIPPED',
    expected,
    reason:
      'registry identity was not established.',
  };
}

function aggregateDeploymentStatus(
  checks: DeploymentChecks,
): DeploymentStatus {
  const statuses = [
    checks.registryRuntimeCodehash.status,
    checks.verifierRuntimeCodehash.status,
    checks.registryMinimumLeadRounds.status,
  ];

  if (statuses.includes('ERROR')) {
    return 'ERROR';
  }

  if (statuses.includes('DRIFT')) {
    return 'DRIFT';
  }

  return 'MATCH';
}

export async function checkDeployment(
  input: CheckDeploymentInput,
): Promise<DeploymentCheckResult> {
  const client = createSecurityPublicClient(input.rpcUrl);

  const observedChainId = await verifyRpcChainId(
    client,
    input.profile.chainId
  );

  const snapshot = await pinChainSnapshot(client);

  const registryRuntimeCodehash = await checkRuntimeCodehash(
    client,
    input.manifest.registry.address,
    input.manifest.registry.runtimeCodehash,
    snapshot.blockNumber,
  );

  const verifierRuntimeCodehash = await checkRuntimeCodehash(
    client,
    input.manifest.verifier.address,
    input.manifest.verifier.runtimeCodehash,
    snapshot.blockNumber,
  );

  const expectedMinimumLeadRounds =
    BigInt(input.profile.timing.minimumLeadRounds);

  let registryMinimumLeadRounds: DeploymentCheck<bigint>;
  if (registryRuntimeCodehash.status === 'MATCH') {
    registryMinimumLeadRounds = await checkMinimumLeadRounds(
      client,
      input.manifest.registry.address,
      expectedMinimumLeadRounds,
      snapshot.blockNumber,
    );
  } else {
    registryMinimumLeadRounds = skippedMinimumLeadRounds(
      expectedMinimumLeadRounds
    );
  }

  const checks: DeploymentChecks = {
    registryRuntimeCodehash,
    verifierRuntimeCodehash,
    registryMinimumLeadRounds,
  };

  return {
    status: aggregateDeploymentStatus(checks),
    observedChainId,
    snapshot,
    checks,
  };
}