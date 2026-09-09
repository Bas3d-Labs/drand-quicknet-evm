import {
  isAddressEqual,
  parseAbi,
  type Address,
} from 'viem';

import {
  type ArbitrumNitroConfig,
  type MaxTimeVariation,
} from './profile.js';

import {
  type ChainSnapshot,
  type SecurityPublicClient,
  createSecurityPublicClient,
  pinChainSnapshot,
  verifyRpcChainId,
} from '../../core/client.js';

import {
  aggregateCheckStatuses,
  type AggregateStatus,
  type CheckResult,
} from '../../core/check.js';

export type TimestampEnvelopeStatus = AggregateStatus;

export type TimestampEnvelopeCheck<
  TExpected,
  TObserved = TExpected,
> = CheckResult<TExpected, TObserved>;

export interface ObservedMaxTimeVariation {
  delayBlocks: bigint;
  futureBlocks: bigint;
  delaySeconds: bigint;
  futureSeconds: bigint;
}

export interface TimestampEnvelopeChecks {
  sequencerInbox: TimestampEnvelopeCheck<Address>;
  maxTimeVariation: TimestampEnvelopeCheck<ObservedMaxTimeVariation>;
}

export interface TimestampEnvelopeCheckResult {
  status: TimestampEnvelopeStatus;
  observedChainId: number;
  snapshot: ChainSnapshot;
  checks: TimestampEnvelopeChecks;
}

export interface CheckTimestampEnvelopeInput {
  parentRpcUrl: string;
  config: ArbitrumNitroConfig;
}

export interface CheckTimestampEnvelopeAtSnapshotInput {
  client: SecurityPublicClient;
  observedChainId: number;
  snapshot: ChainSnapshot;
  config: ArbitrumNitroConfig;
}

const ROLLUP_ABI = parseAbi([
  'function sequencerInbox() view returns (address)',
]);

const SEQUENCER_INBOX_ABI = parseAbi([
  'function maxTimeVariation() view returns '
  + '(uint256 delayBlocks, uint256 futureBlocks, '
  + 'uint256 delaySeconds, uint256 futureSeconds)',
]);

function errorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toObservedMaxTimeVariation(
  value: MaxTimeVariation,
): ObservedMaxTimeVariation {
  return {
    delayBlocks: BigInt(value.delayBlocks),
    futureBlocks: BigInt(value.futureBlocks),
    delaySeconds: BigInt(value.delaySeconds),
    futureSeconds: BigInt(value.futureSeconds),
  };
}

async function checkSequencerInbox(
  client: SecurityPublicClient,
  rollup: Address,
  expected: Address,
  blockNumber: bigint,
): Promise<TimestampEnvelopeCheck<Address>> {
  let observed: Address;

  try {
    observed = await client.readContract({
      address: rollup,
      abi: ROLLUP_ABI,
      functionName: 'sequencerInbox',
      blockNumber,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      expected,
      error: errorMessage(error),
    };
  }

  if (!isAddressEqual(observed, expected)) {
    return {
      status: 'DRIFT',
      expected,
      observed,
      reason: 'Rollup sequencerInbox does not match.',
    };
  }

  return {
    status: 'MATCH',
    expected,
    observed,
  };
}

function maxTimeVariationMatches(
  expected: ObservedMaxTimeVariation,
  observed: ObservedMaxTimeVariation,
): boolean {
  return (
    observed.delayBlocks === expected.delayBlocks &&
    observed.futureBlocks === expected.futureBlocks &&
    observed.delaySeconds === expected.delaySeconds &&
    observed.futureSeconds === expected.futureSeconds
  );
}

async function checkMaxTimeVariation(
  client: SecurityPublicClient,
  sequencerInbox: Address,
  expected: ObservedMaxTimeVariation,
  blockNumber: bigint,
): Promise<TimestampEnvelopeCheck<ObservedMaxTimeVariation>> {
  let observedTuple: readonly [
    bigint,
    bigint,
    bigint,
    bigint,
  ];

  try {
    observedTuple = await client.readContract({
      address: sequencerInbox,
      abi: SEQUENCER_INBOX_ABI,
      functionName: 'maxTimeVariation',
      blockNumber,
    });
  } catch (error) {
    return {
      status: 'ERROR',
      expected,
      error: errorMessage(error),
    };
  }

  const observed: ObservedMaxTimeVariation = {
    delayBlocks: observedTuple[0],
    futureBlocks: observedTuple[1],
    delaySeconds: observedTuple[2],
    futureSeconds: observedTuple[3],
  };

  if (!maxTimeVariationMatches(expected, observed)) {
    return {
      status: 'DRIFT',
      expected,
      observed,
      reason: 'maxTimeVariation does not match.',
    };
  }

  return {
    status: 'MATCH',
    expected,
    observed,
  };
}

function skippedMaxTimeVariation(
  expected: ObservedMaxTimeVariation,
): TimestampEnvelopeCheck<ObservedMaxTimeVariation> {
  return {
    status: 'SKIPPED',
    expected,
    reason: 'SequencerInbox identity was not established.',
  };
}

export async function checkTimestampEnvelopeAtSnapshot(
  input: CheckTimestampEnvelopeAtSnapshotInput,
): Promise<TimestampEnvelopeCheckResult> {
  const sequencerInbox = await checkSequencerInbox(
    input.client,
    input.config.rollup,
    input.config.expectedSequencerInbox,
    input.snapshot.blockNumber,
  );

  const expectedMaxTimeVariation = toObservedMaxTimeVariation(
    input.config.expectedMaxTimeVariation,
  );

  let maxTimeVariation: TimestampEnvelopeCheck<ObservedMaxTimeVariation>;

  if (sequencerInbox.status === 'MATCH') {
    maxTimeVariation = await checkMaxTimeVariation(
      input.client,
      sequencerInbox.observed,
      expectedMaxTimeVariation,
      input.snapshot.blockNumber,
    );
  } else {
    maxTimeVariation = skippedMaxTimeVariation(
      expectedMaxTimeVariation,
    );
  }

  const checks: TimestampEnvelopeChecks = {
    sequencerInbox,
    maxTimeVariation,
  };

  return {
    status: aggregateCheckStatuses([
      checks.sequencerInbox.status,
      checks.maxTimeVariation.status,
    ]),
    observedChainId: input.observedChainId,
    snapshot: input.snapshot,
    checks,
  };
}

export async function checkTimestampEnvelope(
  input: CheckTimestampEnvelopeInput,
): Promise<TimestampEnvelopeCheckResult> {
  const client = createSecurityPublicClient(
    input.parentRpcUrl,
  );

  const observedChainId = await verifyRpcChainId(
    client,
    input.config.parentChain.chainId,
  );

  const snapshot = await pinChainSnapshot(client);

  return checkTimestampEnvelopeAtSnapshot({
    client,
    observedChainId,
    snapshot,
    config: input.config,
  });
}