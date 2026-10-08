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
  JournalAttempt,
  JournalInclusionObservation,
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
const OTHER = `0x${'bb'.repeat(32)}` as const;
const LARGE_BLOCK = 9_007_199_254_740_993n;
const FAILURE = 'Invalid transaction journal encoding.';

async function signedTransaction(nonce = 4, maxFeePerGas = 2n) {
  const bytes = await ACCOUNT.signTransaction({
    type: 'eip1559',
    chainId: IDENTITY.chainId,
    nonce,
    gas: 21_000n,
    to: ACCOUNT.address,
    value: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas: 1n,
  });

  return {
    transactionHash: keccak256(bytes),
    signedTransaction: bytes,
  };
}

async function fixture(): Promise<TransactionJournalSnapshot> {
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
    nextNonce: 5n,
    durableNextNonce: 4n,
    attempts: [{
      attemptId: '11111111-1111-4111-8111-111111111111',
      nonce: 4n,
      signedTransactions: [await signedTransaction()],
      createdAt: '2026-10-04T00:00:00.000Z',
      phase: 'broadcast-may-have-occurred',
      inclusion: null,
      replacementSearch: {
        lowerBound: observation,
        searchedThrough: null,
      },
    }],
  };
}

async function emptyFixture(): Promise<TransactionJournalSnapshot> {
  return {
    ...await fixture(),
    nextNonce: 4n,
    durableNextNonce: 4n,
    attempts: [],
  };
}

async function encodedFixture() {
  return JSON.parse(
    await encodeJournalSnapshot(await fixture(), IDENTITY),
  );
}

async function expectRoundTrip(input: TransactionJournalSnapshot) {
  const contents = await encodeJournalSnapshot(input, IDENTITY);
  const decoded = await decodeJournalSnapshot(contents, IDENTITY);

  expect(decoded).toEqual(input);
  expect(await encodeJournalSnapshot(decoded, IDENTITY))
    .toBe(contents);

  return { contents, decoded };
}

describe('transaction journal serialization', () => {
  it('pins the v1 layout without integer precision loss', async () => {
    const input = await fixture();
    const { contents, decoded } = await expectRoundTrip(input);
    const raw = JSON.parse(contents);

    expect(raw).toEqual({
      version: 1,
      identity: IDENTITY,
      baseline: {
        anchor: {
          blockNumber: LARGE_BLOCK.toString(),
          blockHash: HASH,
        },
        nonce: '4',
      },
      lastObservation: {
        anchor: {
          blockNumber: LARGE_BLOCK.toString(),
          blockHash: HASH,
        },
        nonce: '4',
      },
      nextNonce: '5',
      durableNextNonce: '4',
      attempts: [{
        attemptId: input.attempts[0]!.attemptId,
        nonce: '4',
        createdAt: input.attempts[0]!.createdAt,
        signedTransactions: input.attempts[0]!.signedTransactions,
        replacementSearch: {
          lowerBound: {
            anchor: {
              blockNumber: LARGE_BLOCK.toString(),
              blockHash: HASH,
            },
            nonce: '4',
          },
          searchedThrough: null,
        },
        phase: 'broadcast-may-have-occurred',
        inclusion: null,
      }],
    });

    expect(contents.endsWith('\n')).toBe(true);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.attempts)).toBe(true);
    expect(Object.isFrozen(decoded.attempts[0])).toBe(true);
    expect(
      Object.isFrozen(decoded.attempts[0]!.signedTransactions),
    ).toBe(true);
    expect(
      Object.isFrozen(decoded.attempts[0]!.signedTransactions[0]),
    ).toBe(true);
  });

  it('round-trips initialized state without attempts', async () => {
    await expectRoundTrip(await emptyFixture());
  });

  it('round-trips a signed attempt without a replacement search', async () => {
    const input = await fixture();

    await expectRoundTrip({
      ...input,
      attempts: [{
        ...input.attempts[0]!,
        phase: 'signed',
        inclusion: null,
        replacementSearch: null,
      }],
    });
  });

  it('round-trips a replacement-search progress boundary', async () => {
    const input = await fixture();

    await expectRoundTrip({
      ...input,
      lastObservation: {
        anchor: {
          blockNumber: LARGE_BLOCK + 20n,
          blockHash: HASH,
        },
        nonce: 5n,
      },
      attempts: [{
        ...input.attempts[0]!,
        replacementSearch: {
          lowerBound: input.baseline,
          searchedThrough: {
            blockNumber: LARGE_BLOCK + 10n,
            blockHash: HASH,
          },
        },
      }],
    });
  });

  it('round-trips multiple attempts and signed transactions', async () => {
    const input = await fixture();
    const first = input.attempts[0]!;

    const attempts: JournalAttempt[] = [
      {
        ...first,
        signedTransactions: [
          first.signedTransactions[0],
          await signedTransaction(4, 4n),
        ],
      },
      {
        ...first,
        attemptId: '22222222-2222-4222-8222-222222222222',
        nonce: 5n,
        signedTransactions: [await signedTransaction(5)],
      },
    ];

    await expectRoundTrip({
      ...input,
      nextNonce: 6n,
      attempts,
    });
  });

  it.each(['success', 'reverted', 'replaced'] as const)(
    'round-trips an included %s observation',
    async (outcome) => {
      const input = await fixture();
      const attempt = input.attempts[0]!;

      const anchors = {
        inclusion: {
          blockNumber: LARGE_BLOCK + 10n,
          blockHash: OTHER,
        },
        observedAt: {
          blockNumber: LARGE_BLOCK + 20n,
          blockHash: HASH,
        },
      };

      const observation: JournalInclusionObservation =
        outcome === 'replaced'
          ? {
              ...anchors,
              outcome,
              replacementTransactionHash: OTHER,
              nonceAtAnchor: 5n,
            }
          : {
              ...anchors,
              outcome,
              transactionHash:
                attempt.signedTransactions[0].transactionHash,
            };

      const { contents, decoded } = await expectRoundTrip({
        ...input,
        lastObservation: {
          anchor: anchors.observedAt,
          nonce: 5n,
        },
        attempts: [{
          ...attempt,
          phase: 'included',
          inclusion: observation,
        }],
      });

      const raw = JSON.parse(contents).attempts[0].inclusion;

      expect(raw.inclusion.blockNumber)
        .toBe((LARGE_BLOCK + 10n).toString());
      expect(raw.observedAt.blockNumber)
        .toBe((LARGE_BLOCK + 20n).toString());

      if (outcome === 'replaced') {
        expect(raw.nonceAtAnchor).toBe('5');
      }

      expect(Object.isFrozen(decoded.attempts[0]!.inclusion))
        .toBe(true);
    },
  );

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
    const raw = await encodedFixture();

    raw.nextNonce = value;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it.each([
    'durableNextNonce',
    'attemptNonce',
    'inclusionBlock',
    'observedAtBlock',
    'replacementNonce',
  ])('requires decimal strings for %s', async (field) => {
    const raw = await encodedFixture();

    raw.attempts[0].phase = 'included';
    raw.attempts[0].inclusion = {
      outcome: 'replaced',
      replacementTransactionHash: OTHER,
      nonceAtAnchor: '5',
      inclusion: {
        blockNumber: (LARGE_BLOCK + 10n).toString(),
        blockHash: OTHER,
      },
      observedAt: {
        blockNumber: (LARGE_BLOCK + 20n).toString(),
        blockHash: HASH,
      },
    };

    // Confirm the unmodified encoded fixture is accepted.
    await decodeJournalSnapshot(JSON.stringify(raw), IDENTITY);

    switch (field) {
      case 'durableNextNonce':
        raw.durableNextNonce = 4;
        break;
      case 'attemptNonce':
        raw.attempts[0].nonce = 4;
        break;
      case 'inclusionBlock':
        raw.attempts[0].inclusion.inclusion.blockNumber = 110;
        break;
      case 'observedAtBlock':
        raw.attempts[0].inclusion.observedAt.blockNumber = 120;
        break;
      case 'replacementNonce':
        raw.attempts[0].inclusion.nonceAtAnchor = 5;
        break;
    }

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('rejects unsupported versions', async () => {
    const raw = await encodedFixture();
    raw.version = 2;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it.each([
    'attempts',
    'durableNextNonce',
    'signedTransactions',
    'inclusion',
    'replacementSearch',
  ])('rejects missing %s', async (field) => {
    const raw = await encodedFixture();

    if (field === 'attempts' || field === 'durableNextNonce') {
      delete raw[field];
    } else {
      delete raw.attempts[0][field];
    }

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it.each(['attempts', 'signedTransactions'])(
    'rejects null instead of the %s array',
    async (field) => {
      const raw = await encodedFixture();

      if (field === 'attempts') {
        raw.attempts = null;
      } else {
        raw.attempts[0].signedTransactions = null;
      }

      await expect(decodeJournalSnapshot(
        JSON.stringify(raw),
        IDENTITY,
      )).rejects.toThrow(FAILURE);
    },
  );

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
    const raw = await encodedFixture();

    raw.attempts[0].signedTransactions[0].transactionHash =
      `0x${'00'.repeat(32)}`;

    await expect(decodeJournalSnapshot(
      JSON.stringify(raw),
      IDENTITY,
    )).rejects.toThrow(FAILURE);
  });

  it('verifies signed transactions when encoding', async () => {
    const input = await fixture();
    const attempt = input.attempts[0]!;

    const invalid: TransactionJournalSnapshot = {
      ...input,
      attempts: [{
        ...attempt,
        signedTransactions: [{
          ...attempt.signedTransactions[0],
          transactionHash: `0x${'00'.repeat(32)}`,
        }],
      }],
    };

    await expect(encodeJournalSnapshot(invalid, IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('contains JSON parser errors without retaining secret text', async () => {
    const secret = 'journal-serialization-parser-canary';
    let failure: unknown;

    try {
      await decodeJournalSnapshot(`{"attempts":"${secret}`, IDENTITY);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toHaveProperty('message', FAILURE);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain(secret);
  });

  it('accepts exactly the byte limit and rejects one byte more', async () => {
    const contents = await encodeJournalSnapshot(
      await emptyFixture(),
      IDENTITY,
    );

    const padded = contents + ' '.repeat(
      MAX_JOURNAL_BYTES - Buffer.byteLength(contents, 'utf8'),
    );

    await expect(decodeJournalSnapshot(padded, IDENTITY))
      .resolves.toHaveProperty('attempts', []);

    await expect(decodeJournalSnapshot(padded + ' ', IDENTITY))
      .rejects.toThrow(FAILURE);
  });

  it('rejects oversized signed bytes on encode', async () => {
    const input = await fixture();
    const attempt = input.attempts[0]!;

    const oversized: TransactionJournalSnapshot = {
      ...input,
      attempts: [{
        ...attempt,
        signedTransactions: [{
          ...attempt.signedTransactions[0],
          signedTransaction:
            `0x${'ab'.repeat(MAX_JOURNAL_BYTES / 2)}`,
        }],
      }],
    };

    await expect(encodeJournalSnapshot(oversized, IDENTITY))
      .rejects.toThrow(FAILURE);
  });
});