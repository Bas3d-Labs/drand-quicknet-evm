import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Hex,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  JournalSignedTransaction,
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  verifyJournalAttempt,
  verifyJournalSnapshot,
} from '../../src/state/transaction-journal-verification.js';

// Public test fixture only.
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const ANCHOR = {
  blockNumber: 100n,
  blockHash: `0x${'aa'.repeat(32)}` as const,
};

const FAILURE = 'Invalid journal signed transaction.';

type TestSignedTransaction = {
  -readonly [K in keyof JournalSignedTransaction]:
    JournalSignedTransaction[K];
};

type TestSignedTransactions = [
  TestSignedTransaction,
  ...TestSignedTransaction[],
];

type FixtureType = 'legacy' | 'eip2930' | 'eip1559';

async function fixture(type: FixtureType = 'eip1559') {
  const base = {
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
  };

  let signedTransaction: Hex;

  if (type === 'eip1559') {
    signedTransaction = await ACCOUNT.signTransaction({
      ...base,
      type,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
  } else {
    signedTransaction = await ACCOUNT.signTransaction({
      ...base,
      type,
      gasPrice: 2n,
    });
  }

  const signedTransactions: TestSignedTransactions = [{
    transactionHash: keccak256(signedTransaction),
    signedTransaction,
  }];

  return {
    version: 1 as const,
    identity: { ...IDENTITY },
    baseline: {
      anchor: { ...ANCHOR },
      nonce: 4n,
    },
    lastObservation: {
      anchor: { ...ANCHOR },
      nonce: 4n,
    },
    nextNonce: 5n,
    durableNextNonce: 4n,
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      signedTransactions,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'signed' as const,
      inclusion: null,
      replacementSearch: null,
    }],
  } satisfies TransactionJournalSnapshot;
}

async function signTransaction(
  changes: {
    chainId?: number;
    nonce?: number;
    gas?: bigint;
    to?: typeof ACCOUNT.address;
    value?: bigint;
    data?: Hex;
    accessList?: {
      address: typeof ACCOUNT.address;
      storageKeys: Hex[];
    }[];
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } = {},
  account = ACCOUNT,
) {
  const signedTransaction = await account.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    ...changes,
  });

  return {
    transactionHash: keccak256(signedTransaction),
    signedTransaction,
  };
}

describe('journal signed transaction verification', () => {
  it.each(['legacy', 'eip2930', 'eip1559'] as const)(
    'verifies a signed %s transaction',
    async (type) => {
      const input = await fixture(type);
      const snapshot = await verifyJournalSnapshot(input, IDENTITY);

      expect(snapshot).toEqual(input);
      expect(snapshot).not.toBe(input);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.attempts[0])).toBe(true);
    },
  );

  it('accepts a structurally valid snapshot without attempts', async () => {
    const input = {
      ...await fixture(),
      nextNonce: 4n,
      durableNextNonce: 4n,
      attempts: [],
    };

    expect(
      (await verifyJournalSnapshot(input, IDENTITY)).attempts,
    ).toEqual([]);
  });

  it('rejects a recorded hash that differs from the byte hash', async () => {
    const input = await fixture();
    input.attempts[0]!.signedTransactions[0]!.transactionHash =
      `0x${'00'.repeat(32)}`;

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a transaction signed for another chain', async () => {
    const input = await fixture();
    input.identity.chainId = 1;

    // Structural identity matches; the signed transaction does not.
    await expect(verifyJournalSnapshot(input, input.identity))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a transaction signed by another signer', async () => {
    const input = await fixture();

    input.identity.signer =
      '0x2222222222222222222222222222222222222222';

    await expect(verifyJournalSnapshot(input, input.identity))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a transaction whose nonce differs from the journal', async () => {
    const input = await fixture();

    input.durableNextNonce = 5n;
    input.nextNonce = 6n;
    input.attempts[0]!.nonce = 5n;

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects an unsigned transaction even when its hash matches', async () => {
    const input = await fixture();

    const bytes = serializeTransaction({
      type: 'eip1559',
      chainId: IDENTITY.chainId,
      nonce: 4,
      gas: 21_000n,
      to: ACCOUNT.address,
      value: 0n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });

    input.attempts[0]!.signedTransactions[0]!.signedTransaction = bytes;
    input.attempts[0]!.signedTransactions[0]!.transactionHash =
      keccak256(bytes);

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a high-s signature even when its byte hash matches', async () => {
    const input = await fixture();
    const parsed = parseTransaction(
      input.attempts[0]!.signedTransactions[0]!.signedTransaction,
    );

    const order =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

    const highS = order - BigInt(parsed.s!);

    let yParity = 0;
    if (parsed.yParity === 0) {
      yParity = 1;
    }

    const bytes = serializeTransaction(parsed, {
      r: parsed.r!,
      s: `0x${highS.toString(16).padStart(64, '0')}`,
      yParity,
    });

    input.attempts[0]!.signedTransactions[0]!.signedTransaction = bytes;
    input.attempts[0]!.signedTransactions[0]!.transactionHash =
      keccak256(bytes);

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('contains parser failures without retaining signed bytes', async () => {
    const input = await fixture();
    const bytes = `0x${'ab'.repeat(64)}` as const;

    input.attempts[0]!.signedTransactions[0]!.signedTransaction = bytes;
    input.attempts[0]!.signedTransactions[0]!.transactionHash =
      keccak256(bytes);

    let failure: unknown;

    try {
      await verifyJournalSnapshot(input, IDENTITY);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toHaveProperty('message', FAILURE);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(bytes);
  });
});

describe('journal attempt signed transactions', () => {
  it.each(['legacy', 'eip2930', 'eip1559'] as const)(
    'accepts fee replacements for %s',
    async (type) => {
      const input = await fixture(type);
      const attempt = input.attempts[0]!;
      const original = attempt.signedTransactions[0]!;

      const base = {
        chainId: IDENTITY.chainId,
        nonce: 4,
        gas: 21_000n,
        to: ACCOUNT.address,
        value: 0n,
      };

      const signedTransaction = type === 'eip1559'
        ? await ACCOUNT.signTransaction({
            ...base,
            type,
            maxFeePerGas: 4n,
            maxPriorityFeePerGas: 2n,
          })
        : await ACCOUNT.signTransaction({
            ...base,
            type,
            gasPrice: 4n,
          });

      const replacement = {
        transactionHash: keccak256(signedTransaction),
        signedTransaction,
      };

      expect(replacement.transactionHash)
        .not.toBe(original.transactionHash);

      attempt.signedTransactions.push(replacement);

      const snapshot = await verifyJournalSnapshot(input, IDENTITY);

      expect(snapshot.attempts[0]!.signedTransactions).toEqual([
        original,
        replacement,
      ]);
    },
  );

  it('does not impose fee-bump policy during verification', async () => {
    const input = await fixture();

    input.attempts[0]!.signedTransactions.push(
      await signTransaction({
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }),
    );

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .resolves.toEqual(input);
  });

  const changedFields = [
    { name: 'chain', changes: { chainId: 1 } },
    { name: 'nonce', changes: { nonce: 5 } },
    { name: 'gas limit', changes: { gas: 30_000n } },
    {
      name: 'destination',
      changes: {
        to: '0x2222222222222222222222222222222222222222' as const,
      },
    },
    { name: 'value', changes: { value: 1n } },
    { name: 'calldata', changes: { data: '0x1234' as const } },
    {
      name: 'access list',
      changes: {
        accessList: [{
          address: ACCOUNT.address,
          storageKeys: [`0x${'00'.repeat(32)}` as Hex],
        }],
      },
    },
  ];

  it.each(changedFields)(
    'rejects a later signed transaction with a different $name',
    async ({ changes }) => {
      const input = await fixture();

      input.attempts[0]!.signedTransactions.push(
        await signTransaction(changes),
      );

      await expect(verifyJournalSnapshot(input, IDENTITY))
        .rejects.toThrow(FAILURE);
    },
  );

  it('rejects a change between legacy and EIP-2930 transactions', async () => {
    const input = await fixture('legacy');
    const other = await fixture('eip2930');

    input.attempts[0]!.signedTransactions.push(
      other.attempts[0]!.signedTransactions[0]!,
    );

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a later transaction signed by another account', async () => {
    const input = await fixture();
    const otherAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`);

    input.attempts[0]!.signedTransactions.push(
      await signTransaction(
        { maxFeePerGas: 4n },
        otherAccount,
      ),
    );

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('checks the recorded hash of every signed transaction', async () => {
    const input = await fixture();
    const replacement = await signTransaction({
      maxFeePerGas: 4n,
    });

    replacement.transactionHash = `0x${'00'.repeat(32)}`;
    input.attempts[0]!.signedTransactions.push(replacement);

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('verifies every retained attempt independently', async () => {
    const input = await fixture();
    const secondTransactions: TestSignedTransactions = [
      await signTransaction({
        nonce: 5,
        data: '0x1234',
        gas: 30_000n,
      }),
    ];

    const second = {
      ...input.attempts[0]!,
      attemptId: '22222222-2222-4222-8222-222222222222',
      nonce: 5n,
      signedTransactions: secondTransactions,
    };

    input.attempts.push(second);
    input.nextNonce = 6n;

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .resolves.toEqual(input);

    second.signedTransactions[0]!.transactionHash =
      `0x${'00'.repeat(32)}`;

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects duplicate transactions through the direct attempt API', async () => {
    const input = await fixture();
    const attempt = input.attempts[0]!;

    attempt.signedTransactions.push({
      ...attempt.signedTransactions[0]!,
    });

    await expect(verifyJournalAttempt(IDENTITY, attempt))
      .rejects.toThrow(FAILURE);
  });

  it('captures all signed transactions before awaiting recovery', async () => {
    const input = await fixture();
    const attempt = input.attempts[0]!;

    attempt.signedTransactions.push(
      await signTransaction({ maxFeePerGas: 4n }),
    );

    const identity = { ...IDENTITY };
    const pending = verifyJournalAttempt(identity, attempt);

    identity.chainId = 1;
    attempt.nonce = 99n;

    Object.assign(attempt.signedTransactions[1]!, {
      transactionHash: `0x${'00'.repeat(32)}`,
      signedTransaction: '0x',
    });

    await expect(pending).resolves.toBeUndefined();
  });
});