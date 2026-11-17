import type {
  SignerBlocker,
} from '../../src/state/signer-gate.js';

import type {
  TransactionReconciliationReport,
} from '../../src/state/transaction-manager-types.js';

export function recoveryReport(
  blocker: SignerBlocker | null = null,
  chainId = 46630,
): TransactionReconciliationReport {
  return {
    state: {
      chainId,
      journalInitialized: true,
      busy: false,
      open: blocker === null,
      primaryReason: blocker,
      blockers: blocker === null ? [] : [blocker],
      recoveryComplete: true,
      inclusionChecksComplete: true,
      persistenceState: 'idle',
      blockedSince: null,
      attempts: [],
    },
    recoveryStatus: 'no-attempt',
    inclusionStatus: 'inspected',
    broadcast: null,
    retryDelayMs: null,
  };
}

