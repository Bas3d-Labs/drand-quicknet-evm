import type {
  Hash,
} from 'viem';

import {
  isFixedHex,
} from '../shared/hex.js';

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
      name: 
        | 'load-checkpoint'
        | 'read-chain-heads'
        | 'prepare-attempt'
        | 'broadcast-attempt'
        | 'reconcile-attempt'
        | 'search-supersession'
        | 'persist-journal';
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

export interface RoundImportDiagnostic {
  round: string;
  phase: RoundImportProgress['phase'];
  transactionHash?: Hash;
}

export function projectRoundImportProgress(
  input: unknown,
): RoundImportDiagnostic {
  const round = progressField(input, 'round');
  const phase = progressField(input, 'phase');

  if (
    typeof round !== 'bigint' ||
    round <= 0n ||
    round > (1n << 64n) - 1n
  ) {
    throw new TypeError('Invalid diagnostic round.');
  }

  switch (phase) {
    case 'verify-deployment':
    case 'check-stored':
    case 'wait-for-beacon':
    case 'fetch-beacon':
    case 'validate-beacon':
    case 'prepare-submission':
    case 'submit-transaction':
      return {
        round: round.toString(),
        phase,
      };

    case 'wait-for-receipt':
    case 'verify-stored-beacon': {
      const transactionHash = progressField(
        input,
        'transactionHash',
      );

      if (!isFixedHex(transactionHash, 32)) {
        throw new TypeError('Invalid diagnostic transaction hash.');
      }

      return {
        round: round.toString(),
        phase,
        transactionHash,
      };
    }
    
    default:
      throw new TypeError('Invalid import phase.');
  }
}

function progressField(
  input: unknown,
  key: string,
): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Invalid import progress.');
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) {
    return undefined;
  }

  if (!Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Accessor in import progress.');
  }

  return descriptor.value;
}