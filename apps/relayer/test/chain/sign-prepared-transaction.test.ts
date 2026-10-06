import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
  parseTransaction,
  type LocalAccount,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  signPreparedTransaction,
  type PreparedRelayerTransaction,
} from '../../src/chain/sign-prepared-transaction.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const OTHER_ACCOUNT = privateKeyToAccount(`0x${'22'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const TO = `0x${'33'.repeat(20)}` as const;
const SLOT = `0x${'44'.repeat(32)}` as const;
const MESSAGE = 'Could not sign the prepared relayer transaction.';

function transaction() {
  return {
    type: 'eip1559' as const,
    to: TO,
    data: '0x1234' as const,
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    accessList: [{
      address: TO,
      storageKeys: [SLOT],
    }],
  };
}

function sign(
  input: PreparedRelayerTransaction = transaction(),
  account: LocalAccount = ACCOUNT,
  nonce = 4n,
) {
  return signPreparedTransaction({
    identity: IDENTITY,
    nonce,
    account,
    transaction: input,
  });
}

describe('prepared transaction signing', () => {
  it.each([
    'legacy',
    'eip2930',
    'eip1559',
  ] as const)(
    'signs and verifies a prepared %s transaction',
    async (type) => {
      const common = {
        to: TO,
        data: '0x1234' as const,
        value: 0n,
        gas: 100_000n,
      };

      let input: PreparedRelayerTransaction = transaction();

      if (type === 'legacy') {
        input = {
          ...common,
          type,
          gasPrice: 2n,
        };
      } else if (type === 'eip2930') {
        input = {
          ...common,
          type,
          gasPrice: 2n,
          accessList: [{
            address: TO,
            storageKeys: [SLOT],
          }],
        };
      }

      const result = await sign(input);
      const parsed = parseTransaction(result.signedTransaction);

      expect({
        ...parsed,
        value: parsed.value ?? 0n,
      }).toMatchObject({
        ...input,
        chainId: IDENTITY.chainId,
        nonce: 4,
      });

      expect(result.transactionHash)
        .toBe(keccak256(result.signedTransaction));

      expect(result.nonce).toBe(4n);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it('takes chain and nonce from the journal arguments', async () => {
    const input = {
      ...transaction(),
      chainId: 1,
      nonce: 99,
    };

    const result = await sign(input);

    expect(parseTransaction(result.signedTransaction)).toMatchObject({
      chainId: 4663,
      nonce: 4,
    });
  });

  it.each([
    -1n,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  ])(
    'rejects an unsupported nonce %s before signing',
    async (nonce) => {
      const signTransaction = vi.fn(ACCOUNT.signTransaction);

      await expect(sign(
        transaction(),
        { ...ACCOUNT, signTransaction },
        nonce,
      )).rejects.toThrow(MESSAGE);

      expect(signTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects the wrong account before signing', async () => {
    const signTransaction = vi.fn(OTHER_ACCOUNT.signTransaction);

    await expect(sign(
      transaction(),
      { ...OTHER_ACCOUNT, signTransaction },
    )).rejects.toThrow(MESSAGE);

    expect(signTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { gas: 0n },
    { value: -1n },
    { data: '0x1' },
    { to: '0x1234' },
    { maxFeePerGas: 0n },
    { maxPriorityFeePerGas: -1n },
    { type: 'eip7702' },
  ])(
    'rejects invalid prepared fields before signing: %#',
    async (change) => {
      const signTransaction = vi.fn(ACCOUNT.signTransaction);

      const input = {
        ...transaction(),
        ...change,
      } as PreparedRelayerTransaction;

      await expect(sign(
        input,
        { ...ACCOUNT, signTransaction },
      )).rejects.toThrow(MESSAGE);

      expect(signTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { to: OTHER_ACCOUNT.address },
    { data: '0xabcd' },
    { value: 1n },
    { gas: 90_000n },
    { maxFeePerGas: 3n },
    { maxPriorityFeePerGas: 2n },
    { accessList: [] },
    { chainId: 1 },
    { nonce: 5 },
  ] as const)(
    'rejects signed transaction changes: %#',
    async (change) => {
      const account: LocalAccount = {
        ...ACCOUNT,
        signTransaction: async () => ACCOUNT.signTransaction({
          ...transaction(),
          chainId: 4663,
          nonce: 4,
          ...change,
        }),
      };

      await expect(
        sign(transaction(), account),
      ).rejects.toThrow(MESSAGE);
    },
  );

  it('rejects a signature from a different key', async () => {
    const account: LocalAccount = {
      ...ACCOUNT,
      signTransaction: (input) =>
        OTHER_ACCOUNT.signTransaction(input),
    };

    await expect(
      sign(transaction(), account),
    ).rejects.toThrow(MESSAGE);
  });

  it('captures transaction and identity before the signer awaits', async () => {
    const input = transaction();
    const identity = { ...IDENTITY };

    const account: LocalAccount = {
      ...ACCOUNT,
      async signTransaction(prepared) {
        Object.assign(input, { value: 999n });

        input.accessList[0]!.storageKeys[0] =
          `0x${'55'.repeat(32)}`;

        identity.chainId = 1;

        return ACCOUNT.signTransaction(prepared);
      },
    };

    const result = await signPreparedTransaction({
      identity,
      nonce: 4n,
      account,
      transaction: input,
    });

    const parsed = parseTransaction(result.signedTransaction);

    expect({
      ...parsed,
      value: parsed.value ?? 0n,
    }).toMatchObject({
      chainId: 4663,
      value: 0n,
      accessList: [{
        address: TO,
        storageKeys: [SLOT],
      }],
    });
  });

  it('does not retain signing errors or secret-bearing causes', async () => {
    const secret = 'signing-secret-canary';

    const account: LocalAccount = {
      ...ACCOUNT,
      async signTransaction() {
        throw new Error(secret, {
          cause: new Error(secret),
        });
      },
    };

    const failure = await sign(
      transaction(),
      account,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty('message', MESSAGE);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(secret);
  });

  it('rejects malformed signed bytes without retaining them', async () => {
    const account: LocalAccount = {
      ...ACCOUNT,
      signTransaction: async () => '0x1234',
    };

    await expect(
      sign(transaction(), account),
    ).rejects.toThrow(MESSAGE);
  });
});