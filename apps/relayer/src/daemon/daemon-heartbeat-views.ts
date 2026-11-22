import type {
  Address,
} from 'viem';

import type {
  ConsumerHealth,
} from '../diagnostics/relayer-log.js';

export interface DiscoveryHeartbeatView {
  readonly latestBlock: bigint;
  readonly softNextBlock: bigint;
  readonly latestBlockObservedAt?: string;
}

export interface DurableHeartbeatView {
  readonly durableBlock: bigint;
  readonly durableNextBlock: bigint;
  readonly durableBlockObservedAt?: string;
}

interface ConsumerView {
  readonly consumer: Address;
  discovery?: DiscoveryHeartbeatView;
  durable?: DurableHeartbeatView;
}

/**
 * An isolated presentation view, not evidence of reconciliation or readiness.
 * Callers supply completed observations. Reading never samples a clock.
 */
export class DaemonHeartbeatViews {
  private readonly consumers = new Map<string, ConsumerView>();

  constructor(
    consumers: readonly Address[],
  ) {
    for (const consumer of consumers) {
      this.consumers.set(consumer.toLowerCase(), { consumer });
    }
  }

  discoveryCompleted(
    consumer: Address,
    view: DiscoveryHeartbeatView,
  ): void {
    // Copy only the discovery pair and its observation time. Full-work
    // readings must never replace either member of this pair.
    this.get(consumer).discovery = {
      latestBlock: view.latestBlock,
      softNextBlock: view.softNextBlock,
      ...(view.latestBlockObservedAt === undefined
        ? {}
        : { latestBlockObservedAt: view.latestBlockObservedAt }),
    };
  }

  fullCompleted(
    consumer: Address,
    view: DurableHeartbeatView,
  ): void {
    this.get(consumer).durable = {
      durableBlock: view.durableBlock,
      durableNextBlock: view.durableNextBlock,
      ...(view.durableBlockObservedAt === undefined
        ? {}
        : { durableBlockObservedAt: view.durableBlockObservedAt }),
    };
  }

  discoveryFailed(
    consumer: Address,
  ): void {
    delete this.get(consumer).discovery;
  }

  fullFailed(
    consumer: Address,
  ): void {
    delete this.get(consumer).durable;
  }

  snapshot(): readonly ConsumerHealth[] {
    return [...this.consumers.values()].map((view): ConsumerHealth => {
      const { consumer, discovery, durable } = view;

      // The frozen heartbeat format has no "not observed" status. Until
      // both sides have succeeded, use its existing failed row without heads.
      if (discovery === undefined || durable === undefined) {
        return { consumer, status: 'failed' };
      }

      return {
        consumer,
        status: 'healthy',
        ...discovery,
        ...durable,
      };
    });
  }

  private get(
    consumer: Address,
  ): ConsumerView {
    const view = this.consumers.get(consumer.toLowerCase());

    if (view === undefined) {
      throw new TypeError('Unknown heartbeat consumer.');
    }

    return view;
  }
}
