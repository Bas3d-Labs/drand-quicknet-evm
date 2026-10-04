import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
  MAX_JOURNAL_BYTES,
} from '../../src/state/transaction-journal-serialization.js';

// Public test fixture only.
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

const IDENTITY = {
  chainId: 4663,
  signer: ACCOUNT.address,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const LARGE_BLOCK = 9_007_199_254_740_993n;
const FAILURE = 'Invalid transaction journal encoding.';

async function fixture(): Promise<TransactionJournalSnapshot> {
  const signedTransaction = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce: 4,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const observation = {
    anchor: {
      blockNumber: LARGE_BLOCK,
      blockHash: HASH,
    },
    nonce: 4n,
  };

  return {
    version: 1,
    identity: { ...IDENTITY },
    baseline: observation,
    lastObservation: observation,
    nextNonce: 4n,
    attempt: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      transactionHash: keccak256(signedTransaction),
      signedTransaction,
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      replacementSearch: {
        lowerBound: observation,
        searchedThrough: null,
      },
    },
  };
}

describe('transaction journal serialization', () => {
  it('round-trips a signed attempt without integer precision loss', async () => {
    const input = await fixture();
    const contents = await encodeJournalSnapshot(input, IDENTITY);
    const raw = JSON.parse(contents);

    expect(raw.baseline.anchor.blockNumber)
      .toBe(LARGE_BLOCK.toString());
    expect(raw.nextNonce).toBe('4');
    expect(raw.attempt.nonce).toBe('4');

    const decoded = await decodeJournalSnapshot(contents, IDENTITY);

    expect(decoded).toEqual(input);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.attempt)).toBe(true);

    expect(await encodeJournalSnapshot(decoded, IDENTITY))
      .toBe(contents);
  });

  it('round-trips initialized state without an attempt', async () => {
    const input = {
      ...await fixture(),
      attempt: null,
    };

    const contents = await encodeJournalSnapshot(input, IDENTITY);

    expect(await decodeJournalSnapshot(contents, IDENTITY))
      .toEqual(input);
  });

  it('round-trips a replacement-search progress boundary', async () => {
    const input = await fixture();
    const attempt = input.attempt!;

    const updated = {
      ...input,
      lastObservation: {
        anchor: {
          blockNumber: LARGE_BLOCK + 20n,
          blockHash: HASH,
        },
        nonce: 5n,
      },
      attempt: {
        ...attempt,
        replacementSearch: {
          lowerBound: input.baseline,
          searchedThrough: {
            blockNumber: LARGE_BLOCK + 10n,
            blockHash: HASH,
          },
        },
      },
    };

    const contents = await encodeJournalSnapshot(updated, IDENTITY);

    expect(await decodeJournalSnapshot(contents, IDENTITY))
      .toEqual(updated);
  });

  it.each([
    4,
    null,
    '',
    '04',
    '-1',
    '+4',
    '4.0',
    '4e0',
    '0x04',
    ' 4',
    '4\n',
    '9'.repeat(79),
    (1n << 256n).toString(),
  ])('rejects invalid decimal encoding: %#', async (value) => {
    const input = await fixture();
    const raw = JSON.parse(await encodeJournalSnapshot(input, IDENTITY));

    raw.nextNonce = value;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('rejects unsupported versions', async () => {
    const raw = JSON.parse(
      await encodeJournalSnapshot(await fixture(), IDENTITY),
    );

    raw.version = 2;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('rejects missing attempt state instead of treating it as clear', async () => {
    const raw = JSON.parse(
      await encodeJournalSnapshot(await fixture(), IDENTITY),
    );

    delete raw.attempt;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('rejects a mismatched configured identity', async () => {
    const contents = await encodeJournalSnapshot(
      await fixture(),
      IDENTITY,
    );

    await expect(decodeJournalSnapshot(contents, {
      ...IDENTITY,
      chainId: 1,
    })).rejects.toThrow(FAILURE);
  });

  it('verifies signed transactions when decoding', async () => {
    const raw = JSON.parse(
      await encodeJournalSnapshot(await fixture(), IDENTITY),
    );

    raw.attempt.transactionHash = `0x${'00'.repeat(32)}`;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('verifies signed transactions when encoding', async () => {
    const input = await fixture();

    const invalid = {
      ...input,
      attempt: {
        ...input.attempt!,
        transactionHash: `0x${'00'.repeat(32)}` as const,
      },
    };

    await expect(encodeJournalSnapshot(invalid, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('contains JSON parser errors without retaining secret text', async () => {
    const secret = 'journal-serialization-parser-canary';
    let failure: unknown;

    try {
      await decodeJournalSnapshot(`{"attempt":"${secret}`, IDENTITY);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toHaveProperty('message', FAILURE);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(secret);
  });

  it('accepts exactly the byte limit and rejects one byte more', async () => {
    const contents = await encodeJournalSnapshot({
      ...await fixture(),
      attempt: null,
    }, IDENTITY);

    const padded = contents + ' '.repeat(
      MAX_JOURNAL_BYTES - Buffer.byteLength(contents, 'utf8'),
    );

    await expect(decodeJournalSnapshot(padded, IDENTITY))
      .resolves.toHaveProperty('attempt', null);

    await expect(decodeJournalSnapshot(padded + ' ', IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects oversized signed bytes on encode', async () => {
    const input = await fixture();

    const oversized = {
      ...input,
      attempt: {
        ...input.attempt!,
        signedTransaction:
          `0x${'ab'.repeat(MAX_JOURNAL_BYTES / 2)}` as const,
      },
    };

    await expect(encodeJournalSnapshot(oversized, IDENTITY))
      .rejects.toThrow(FAILURE);
  });
});