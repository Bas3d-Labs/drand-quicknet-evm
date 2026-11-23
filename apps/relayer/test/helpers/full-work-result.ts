import type {
  RunDaemonCycleResult,
} from '../../src/daemon/daemon-cycle.js';

import type {
  DaemonWorkResult,
} from '../../src/daemon/daemon.js';

/** Existing combined-scan fixtures expressed at the active reporting boundary. */
export function fullWorkResult(
  cycle: RunDaemonCycleResult,
): DaemonWorkResult {
  return {
    cycle,
    discoveryCompleted: false,
    discoveryFailures: [],
    waitingRejectedOffers: cycle.waitingRejectedOffers ?? 0n,
    consumers: cycle.consumers.map((outcome) => {
      if (outcome.status === 'failed') {
        return { consumer: outcome.consumer.address, status: 'failed' };
      }

      const scan = outcome.iteration;

      return {
        consumer: outcome.consumer.address,
        status: 'healthy',
        latestBlock: scan.latestBlock,
        durableBlock: scan.durableBlock,
        durableNextBlock: scan.durableNextBlock,
        softNextBlock: scan.softCursor.nextBlock,
        ...(scan.latestBlockObservedAt === undefined
          ? {}
          : { latestBlockObservedAt: scan.latestBlockObservedAt }),
        ...(scan.durableBlockObservedAt === undefined
          ? {}
          : { durableBlockObservedAt: scan.durableBlockObservedAt }),
      };
    }),
  };
}
