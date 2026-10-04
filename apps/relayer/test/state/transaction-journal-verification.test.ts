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
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
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
    nextNonce: 4n,
    attempt: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      transactionHash: keccak256(signedTransaction),
      signedTransaction,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'signed' as const,
      replacementSearch: null,
    },
  } satisfies TransactionJournalSnapshot;
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
      expect(Object.isFrozen(snapshot.attempt)).toBe(true);
    },
  );

  it('accepts a structurally valid snapshot without an attempt', async () => {
    const input = {
      ...await fixture(),
      attempt: null,
    };

    expect(
      (await verifyJournalSnapshot(input, IDENTITY)).attempt,
    ).toBeNull();
  });

  it('rejects a recorded hash that differs from the byte hash', async () => {
    const input = await fixture();
    input.attempt.transactionHash = `0x${'00'.repeat(32)}`;

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

    input.nextNonce = 5n;
    input.attempt.nonce = 5n;

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

    input.attempt.signedTransaction = bytes;
    input.attempt.transactionHash = keccak256(bytes);

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects a high-s signature even when its byte hash matches', async () => {
    const input = await fixture();
    const parsed = parseTransaction(input.attempt.signedTransaction);

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

    input.attempt.signedTransaction = bytes;
    input.attempt.transactionHash = keccak256(bytes);

    await expect(verifyJournalSnapshot(input, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('contains parser failures without retaining signed bytes', async () => {
    const input = await fixture();
    const bytes = `0x${'ab'.repeat(64)}` as const;

    input.attempt.signedTransaction = bytes;
    input.attempt.transactionHash = keccak256(bytes);

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