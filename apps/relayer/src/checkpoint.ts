import type { 
  Address,
} from "viem";

/// Stores the next block that should be scanned for each consumer.
/// A checkpoint is the next unprocessed block, not the last processed block.
///
/// For example, after successfully processing blocks 1000 through 1099,
/// the persisted checkpoint should be 1100.
export interface CheckpointStore {
  /// Returns the next block that should be scanned for `consumer`.
  /// Returns undefined when no checkpoint has been persisted yet.
  load(consumer: Address): Promise<bigint | undefined>;

  /// Persists the next block that should be scanned for `consumer`.
  ///
  /// Callers must only advance this value after all requests in the
  /// preceding scanned range have been processed successfully.
  save(consumer: Address, nextBlock: bigint): Promise<void>;
}