import type {
  Address,
  Hash,
} from 'viem';

// Diagnostic copies only. Processing and scheduling retain their request type.
export interface RequestDiscovery {
  readonly consumer: Address;
  readonly round: bigint;
  readonly blockNumber: bigint;
  readonly transactionHash: Hash;
  readonly logIndex: number;
  readonly blockHash?: Hash;
}

export type RequestDiscoveryObserver = (observation: RequestDiscovery) => void;

export type ScanDiscoveryObserver = (
  scanType: 'durable' | 'soft',
  observation: RequestDiscovery,
) => void;
