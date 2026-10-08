import type {
  Address,
  Hex,
  WalletClient,
} from 'viem';

import type {
  PreparedRelayerTransaction,
} from './sign-prepared-transaction.js';

export interface PrepareRelayerTransactionOptions {
  readonly walletClient: WalletClient;
  readonly signer: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas?: bigint | undefined;
}

/**
 * Prepares gas and fees without allocating a nonce, signing, or sending.
 * The coordinator supplies the journal's chain and nonce when signing.
 */
export async function prepareRelayerTransaction(
  options: PrepareRelayerTransactionOptions,
): Promise<PreparedRelayerTransaction> {
  const {
    walletClient,
    signer,
    to,
    data,
    value,
    gas,
  } = options;

  const prepared = await walletClient.prepareTransactionRequest({
    chain: walletClient.chain,
    account: signer,
    to,
    data,
    value,
    gas,
    parameters: ['gas', 'fees', 'type'],
  });

  const common = {
    to,
    data,
    value,
    gas: prepared.gas,
  };

  if (prepared.type === 'legacy') {
    return Object.freeze({
      ...common,
      type: 'legacy',
      gasPrice: prepared.gasPrice,
    });
  }

  if (prepared.type === 'eip1559') {
    return Object.freeze({
      ...common,
      type: 'eip1559',
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    });
  }

  throw new TypeError('Unsupported prepared transaction type.');
}