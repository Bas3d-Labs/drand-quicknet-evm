import type {
  Address,
  PublicClient,
} from 'viem';

import {
  roundScheduledTime,
} from '@based-labs/drand-quicknet';

import {
  readLatestHead,
  type LatestHead,
} from '../chain/latest-head.js';

import type {
  QuicknetRandomnessRequest,
} from '../consumers/request-events.js';

import {
  scanQuicknetRequests,
  type ScanQuicknetRequestsResult,
} from '../consumers/request-scanner.js';

import type {
  RequestDiscoveryObserver,
} from '../diagnostics/request-discovery.js';

import {
  terminalRoundReason,
  type TerminalRoundReason,
} from '../rounds/terminal-round-reason.js';

import type {
  FutureRoundScheduler,
} from './future-round-scheduler.js';

export interface DiscoverRequestsOptions {
  publicClient: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>;
  queue: Pick<FutureRoundScheduler, 'admit'>;
  consumer: Address;
  nextBlock: bigint;
  maxBlockRange: bigint;
  now?: () => number;
  observationClock?: (() => number) | undefined;
  onRequestDiscovered?: RequestDiscoveryObserver | undefined;
  signal?: AbortSignal;
}

export type DiscoveryAdmission = {
  request: QuicknetRandomnessRequest;
} & (
  | {
      status: 'released' | 'queued';
      admission: 'accepted' | 'duplicate';
      workId: string;
      releaseTime: bigint;
    }
  | {
      status: 'rejected';
      workId: string;
      releaseTime: bigint;
    }
  | {
      status: 'unfulfillable';
      reason: TerminalRoundReason;
    }
);

export interface DiscoverRequestsResult extends LatestHead {
  scan: ScanQuicknetRequestsResult;
  admissions: readonly DiscoveryAdmission[];
}

/** One bounded consumer scan. Admission cannot dispatch, import or sign. */
export async function discoverRequests(
  options: DiscoverRequestsOptions,
): Promise<DiscoverRequestsResult> {
  if (options.nextBlock < 0n) {
    throw new Error('nextBlock must not be negative.');
  }

  if (options.maxBlockRange <= 0n) {
    throw new Error('maxBlockRange must be greater than zero.');
  }

  options.signal?.throwIfAborted();

  const head = await readLatestHead({
    publicClient: options.publicClient,
    observationClock: options.observationClock,
  });

  options.signal?.throwIfAborted();

  const scan = await scanQuicknetRequests({
    publicClient: options.publicClient,
    consumers: [options.consumer],
    nextBlock: options.nextBlock,
    throughBlock: head.latestBlock,
    maxBlockRange: options.maxBlockRange,
    onRequestDiscovered: options.onRequestDiscovered,
  });

  options.signal?.throwIfAborted();

  const admissions: DiscoveryAdmission[] = [];

  if (scan.status === 'scanned') {
    const now = options.now ?? Date.now;

    for (const request of scan.requests) {
      const reason = terminalRoundReason(request.round);

      if (reason !== undefined) {
        admissions.push({ request, status: 'unfulfillable', reason });

        continue;
      }

      const releaseTime = roundScheduledTime(request.round);
      const released = releaseTime * 1000n <= BigInt(now());

      const admission = options.queue.admit(request, releaseTime, 'soft');

      if (admission.status === 'rejected') {
        admissions.push({
          request,
          status: 'rejected',
          workId: admission.workId,
          releaseTime,
        });

        continue;
      }

      let status: 'released' | 'queued' = 'queued';

      if (released) {
        status = 'released';
      }

      admissions.push({
        request,
        status,
        admission: admission.status,
        workId: admission.workId,
        releaseTime,
      });
    }
  }

  // Rejection does not pin the soft cursor. Durable scans remain the guarantee.
  // A released admission is a wake-up fact; dispatch must recheck wall time.
  return { ...head, scan, admissions };
}
