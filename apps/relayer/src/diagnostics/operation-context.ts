import type {
  Hash,
} from 'viem';

export type RoundImportProgress = {
  round: bigint;
} & (
  | {
      phase:
        | 'verify-deployment'
        | 'check-stored'
        | 'wait-for-beacon'
        | 'fetch-beacon'
        | 'validate-beacon'
        | 'prepare-submission'
        | 'submit-transaction';
    }
  | {
      phase:
        | 'wait-for-receipt'
        | 'verify-stored-beacon';
      transactionHash: Hash;
  }
);

export type OperationContext =
  | {
      name: 'load-checkpoint' | 'read-chain-heads';
    }
  | {
      name: 'scan-requests';
      scanType: 'durable' | 'soft';
      fromBlock: bigint;
      throughBlock: bigint;
      maxBlockRange: bigint;
    }
  | {
      name: 'process-requests';
      scanType: 'durable' | 'soft';
      fromBlock: bigint;
      toBlock: bigint;
    }
  | {
      name: 'save-checkpoint';
      nextBlock: bigint;
    }
  | ({
      name: 'import-round';
      scanType: 'durable' | 'soft';
      fromBlock: bigint;
      toBlock: bigint;
    } & RoundImportProgress);

export function reportImportProgress(
  observer: ((progress: RoundImportProgress) => void) | undefined,
  progress: RoundImportProgress,
): void {
  try {
    observer?.(progress);
  } catch {
    // Diagnostics must not interrupt an import or replace its error.
  }
}