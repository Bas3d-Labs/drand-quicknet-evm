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
    };