import {
  createRpcMetrics,
} from '../../../src/diagnostics/rpc/rpc-metrics.js';

import {
  createRpcUsageSnapshot,
} from '../../../src/diagnostics/rpc/rpc-usage-snapshot.js';

export const IDENTITY = {
  chainId: 46630,
  signer: `0x${'ab'.repeat(20)}` as const,
};

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const AT = '2026-11-20T00:00:00.000Z';

export function statusFixture(
  metrics = createRpcMetrics(),
) {
  return {
    version: 1,
    identity: IDENTITY,
    runId: RUN_ID,
    observedAt: AT,
    lastCompletedCycle: { cycle: 1, completedAt: AT },
    lastRetryObservation: null,
    journalInitialized: true,
    operatorHistory: { count: 0, limit: 32 },
    queue: null,
    storedFactDispute: null,
    attemptSummary: {
      retainedCount: 0,
      includedCount: 0,
      unresolvedCount: 0,
      lowestNonce: null,
      highestNonce: null,
      detailedCount: 0,
      omittedCount: 0,
    },
    attempts: [],
    lastObservedGate: {
      open: true,
      primaryReason: null,
      blockers: [],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: null,
    },
    rpcUsage: createRpcUsageSnapshot(metrics.snapshot(), AT),
  };
}
