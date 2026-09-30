import type {
  Address,
} from 'viem';

import {
  createRegistryReader,
} from '@based-labs/drand-quicknet-registry';

import {
  getBlockAnchor,
  blockAnchorsMatch,
  type BlockAnchor,
} from '../chain/block-anchor.js';

import {
  scanQuicknetRequests,
} from './request-scanner.js';

import {
  processQuicknetRequestsWithOutcomes,
  type ProcessQuicknetRequestsOptions,
  type QuicknetRoundOutcome,
} from './request-processor.js';

export type DurableFulfillment =
  | {
      status: 'stored';
    }
  | {
      status: 'not-stored';
    }
  | {
      status: 'unavailable';
      error: unknown;
    };

export interface DurableRoundOutcome {
  round: bigint;
  firstRequestBlock: bigint;
  fulfillment: DurableFulfillment;
}

export type DurableCheckpointDecision =
  | {
      status: 'verified';
      nextBlock: bigint;
    }
  | {
      status: 'anchor-changed';
      observedAnchor: BlockAnchor;
    }
  | {
      status: 'anchor-unavailable';
      error: unknown;
    };

export type DurableRequestResult = {
  imports: readonly QuicknetRoundOutcome[];
  fulfillment: readonly DurableRoundOutcome[];
} & (
  | {
      status: 'caught-up';
      checkpoint: {
        status: 'verified';
        nextBlock: bigint;
      };
    }
  | {
      status: 'anchor-unavailable';
      durableBlock: bigint;
      checkpoint: {
        status: 'anchor-unavailable';
        error: unknown;
      };
    }
  | { 
      status: 'scanned';
      fromBlock: bigint;
      toBlock: bigint;
      anchor: BlockAnchor;
      checkpoint: DurableCheckpointDecision;
    }
);

export interface ReconcileDurableRequestsOptions
  extends Omit<ProcessQuicknetRequestsOptions, 'requests'> {
  consumer: Address;
  nextBlock: bigint;
  durableBlock: bigint;
  maxBlockRange: bigint;
}

// Bracket the log scan, imports, and historical storage reads.
// The caller owns checkpoint persistence.
export async function reconcileDurableRequests(
  options: ReconcileDurableRequestsOptions,
): Promise<DurableRequestResult> {
  if (
    options.nextBlock < 0n ||
    options.durableBlock < 0n ||
    options.maxBlockRange <= 0n
  ) {
    throw new RangeError('Invalid durable scan bounds.');
  }

  if (options.nextBlock > options.durableBlock) {
    return {
      status: 'caught-up',
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'verified',
        nextBlock: options.nextBlock,
      },
    };
  }

  let anchor: BlockAnchor;

  try {
    anchor = await getBlockAnchor(
      options.publicClient,
      options.durableBlock,
    );
  } catch (error) {
    return {
      status: 'anchor-unavailable',
      durableBlock: options.durableBlock,
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'anchor-unavailable',
        error,
      },
    };
  }

  const scan = await scanQuicknetRequests({
    publicClient: options.publicClient,
    consumers: [options.consumer],
    nextBlock: options.nextBlock,
    throughBlock: anchor.blockNumber,
    maxBlockRange: options.maxBlockRange,
  });

  if (scan.status === 'caught-up') {
    return {
      status: 'caught-up',
      imports: [],
      fulfillment: [],
      checkpoint: {
        status: 'verified',
        nextBlock: options.nextBlock,
      },
    };
  }

  if (scan.status !== 'scanned') {
    throw new Error('Expected a non-empty durable block range.');
  }

  // Reject inconsistent RPC metadata before deriving a prefix.
  for (const request of scan.requests) {
    if (
      request.consumer.toLowerCase() !== options.consumer.toLowerCase() ||
      request.blockNumber < scan.fromBlock ||
      request.blockNumber > scan.toBlock
    ) {
      throw new Error('Request log is outside the durable scan.');
    }
  }

  const imports = await processQuicknetRequestsWithOutcomes({
    ...options,
    requests: scan.requests,
  });

  const fulfillment: DurableRoundOutcome[] = [];
  let nextBlock = scan.nextBlock;

  const registry = createRegistryReader({
    client: options.publicClient,
    deployment: options.deployment,
  });

  // Check every round, including failed or deferred imports. Another
  // relayer may have fulfilled it durably.
  for (const outcome of imports) {
    const state = await readFulfillment(
      registry,
      outcome.round,
      anchor,
    );

    fulfillment.push({
      round: outcome.round,
      firstRequestBlock: outcome.firstRequestBlock,
      fulfillment: state,
    });

    if (
      state.status !== 'stored' &&
      outcome.firstRequestBlock < nextBlock
    ) {
      nextBlock = outcome.firstRequestBlock;
    }
  }

  let checkpoint: DurableCheckpointDecision;

  try {
    const after = await getBlockAnchor(
      options.publicClient,
      anchor.blockNumber,
    );

    if (blockAnchorsMatch(anchor, after)) {
      checkpoint = {
        status: 'verified',
        nextBlock,
      };
    } else {
      checkpoint = {
        status: 'anchor-changed',
        observedAnchor: after,
      };
    }
  } catch (error) {
    checkpoint = {
      status: 'anchor-unavailable',
      error,
    };
  }

  return {
    status: 'scanned',
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    anchor,
    imports,
    fulfillment,
    checkpoint,
  };
}

async function readFulfillment(
  registry: ReturnType<typeof createRegistryReader>,
  round: bigint,
  anchor: BlockAnchor,
): Promise<DurableFulfillment> {
  try {
    const stored = await registry.isStored(
      round,
      anchor.blockNumber,
    );

    if (stored === true) {
      return { status: 'stored' };
    }

    if (stored === false) {
      return { status: 'not-stored' };
    }

    throw new TypeError('Invalid durable storage response.');
  } catch (error) {
    return {
      status: 'unavailable',
      error,
    };
  }
}