import type {
  SummarizeErrorOptions,
} from '../diagnostics/error-summary.js';

import type {
  RoundImportProgress,
} from '../diagnostics/operation-context.js';

export interface CliOptions {
  onDiagnostics?: (
    policy: SummarizeErrorOptions | undefined,
  ) => void;
  onImportFailure?: (
    error: unknown,
    progress: RoundImportProgress,
  ) => void;
}

export type CliOutcome =
  | 'success'
  | 'failure'
  | 'pending'
  | 'deferred'
  | 'interrupted';