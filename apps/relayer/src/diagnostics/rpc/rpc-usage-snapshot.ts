import type {
  RpcHttpUsageRow,
  RpcLogicalUsageRow,
} from './rpc-usage-report.js';

export type RpcLogicalUsageSnapshotRow = Omit<
  RpcLogicalUsageRow,
  'averageDurationMs'
>;

export type RpcHttpUsageSnapshotRow = Omit<
  RpcHttpUsageRow,
  'averageDurationMs'
>;

/**
 * Persisted cumulative RPC usage.
 */
export interface RpcUsageSnapshot {
  readonly collectorId: string;
  readonly startedAt: string;

  /** Wall-clock measurement time, captured with the collector snapshot. */
  readonly observedAt: string;

  readonly logical: readonly RpcLogicalUsageSnapshotRow[];
  readonly http: readonly RpcHttpUsageSnapshotRow[];
}