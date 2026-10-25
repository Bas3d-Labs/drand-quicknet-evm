import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  keccak256,
  size,
} from 'viem';

import {
  privateKeyToAccount,
} from 'viem/accounts';

import {
  drandQuicknetBeaconRegistryAbi,
} from '@based-labs/drand-quicknet-registry';

import {
  MAX_WORK_ID_LENGTH,
} from '../../src/execution/work-identity.js';

import {
  encodeBeaconSubmission,
} from '../../src/rounds/encode-beacon-submission.js';

import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import {
  MAX_RETAINED_ATTEMPTS,
  MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
} from '../../src/state/journal-bounds.js';

import {
  MAX_RETAINED_NONCE_REPAIRS,
  type JournalAttempt,
  type JournalNonceRepair,
  type JournalSignedTransaction,
  type TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
  MAX_JOURNAL_BYTES,
} from '../../src/state/transaction-journal-serialization.js';

const ACCOUNT = privateKeyToAccount(
  `0x${'11'.repeat(32)}`,
);

const IDENTITY = {
  chainId: Number.MAX_SAFE_INTEGER,
  signer: ACCOUNT.address,
};

const REGISTRY = `0x${'22'.repeat(20)}` as const;
const BLOCK_HASH = `0x${'aa'.repeat(32)}` as const;
const REPLACEMENT_HASH = `0x${'bb'.repeat(32)}` as const;

const TIMESTAMP = '+275760-09-13T00:00:00.000Z';

function anchor(blockNumber: bigint) {
  return {
    blockNumber,
    blockHash: BLOCK_HASH,
  };
}

describe('beacon journal size', () => {
  it(
    'fits 16 attempts with 16 signed witness variants and full journal metadata',
    async () => {
      expect(MAX_RETAINED_ATTEMPTS).toBe(16);
      expect(MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT).toBe(16);
      expect(MAX_RETAINED_NONCE_REPAIRS).toBe(8);
      expect(MAX_WORK_ID_LENGTH).toBe(256);
      expect(MAX_JOURNAL_BYTES).toBe(1_048_576);

      const round = (1n << 64n) - 1n;
      const signature = `0x${'ff'.repeat(48)}` as const;

      const compressed = encodeBeaconSubmission({
        address: REGISTRY,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeacon',
        args: [round, signature],
      });

      const witness = encodeBeaconSubmission({
        address: REGISTRY,
        abi: drandQuicknetBeaconRegistryAbi,
        functionName: 'submitBeaconWithWitness',
        args: [
          round,
          signature,
          (1n << 128n) - 1n,
          MAX_UINT256,
        ],
      });

      // With the current ABI and a 48-byte Quicknet signature,
      // witness submission is the larger supported calldata shape.
      expect(size(compressed.data)).toBe(164);
      expect(size(witness.data)).toBe(228);
      expect(size(witness.data))
        .toBeGreaterThan(size(compressed.data));

      let largestSubmission = compressed;

      if (size(witness.data) > size(compressed.data)) {
        largestSubmission = witness;
      }

      expect(largestSubmission).toBe(witness);

      // All allocated transaction nonces remain safely representable
      // by the transaction parser and signing path.
      const nextNonce = BigInt(Number.MAX_SAFE_INTEGER);
      const durableNextNonce =
        nextNonce - BigInt(MAX_RETAINED_ATTEMPTS);

      const baselineNonce =
        durableNextNonce - BigInt(MAX_RETAINED_NONCE_REPAIRS);

      const baseline = {
        anchor: anchor(MAX_UINT256 - 4n),
        nonce: baselineNonce,
      };

      const repairs: JournalNonceRepair[] = Array.from(
        { length: MAX_RETAINED_NONCE_REPAIRS },
        (_, index) => {
          const previousNextNonce =
            baselineNonce + BigInt(index);

          return {
            kind: 'sync-nonce',
            at: TIMESTAMP,
            previousNextNonce,
            nextNonce: previousNextNonce + 1n,
            observation: {
              anchor: anchor(MAX_UINT256 - 3n),
              nonce: previousNextNonce + 1n,
            },
          };
        },
      );

      const attempts: JournalAttempt[] = [];

      for (
        let attemptIndex = 0;
        attemptIndex < MAX_RETAINED_ATTEMPTS;
        attemptIndex += 1
      ) {
        const nonce =
          durableNextNonce + BigInt(attemptIndex);

        const variants: JournalSignedTransaction[] = [];

        for (
          let variantIndex = 0;
          variantIndex < MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT;
          variantIndex += 1
        ) {
          // Distinct, increasing fees preserve the original call.
          // Both fee fields retain their full 32-byte encoding width.
          const fee = MAX_UINT256
            - BigInt(
              MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT
              - 1
              - variantIndex,
            );

          const signedTransaction = await ACCOUNT.signTransaction({
            type: 'eip1559',
            chainId: IDENTITY.chainId,
            nonce: Number(nonce),
            to: largestSubmission.to,
            data: largestSubmission.data,
            value: largestSubmission.value,
            gas: MAX_UINT256,
            maxFeePerGas: fee,
            maxPriorityFeePerGas: fee,
          });

          variants.push({
            transactionHash: keccak256(signedTransaction),
            signedTransaction,
          });
        }

        const firstVariant = variants[0];

        if (firstVariant === undefined) {
          throw new Error('Expected a signed transaction.');
        }

        const signedTransactions: JournalAttempt['signedTransactions'] = [
          firstVariant,
          ...variants.slice(1),
        ];

        // Every code unit occupies three UTF-8 bytes. The final
        // character makes each work identity unique without reducing
        // its byte width.
        const workId =
          '\u0800'.repeat(MAX_WORK_ID_LENGTH - 1)
          + String.fromCharCode(0x0801 + attemptIndex);

        expect(workId).toHaveLength(MAX_WORK_ID_LENGTH);
        expect(Buffer.byteLength(workId, 'utf8')).toBe(768);

        attempts.push({
          attemptId:
            '00000000-0000-4000-8000-'
            + attemptIndex.toString(16).padStart(12, '0'),
          workId,
          nonce,
          createdAt: TIMESTAMP,
          phase: 'included',
          signedTransactions,
          replacementSearch: {
            lowerBound: {
              anchor: anchor(MAX_UINT256 - 3n),
              nonce,
            },
            searchedThrough: anchor(MAX_UINT256 - 2n),
          },
          inclusion: {
            // Replacement evidence is wider than success/revert
            // evidence because it also retains nonceAtAnchor.
            outcome: 'replaced',
            replacementTransactionHash: REPLACEMENT_HASH,
            nonceAtAnchor: MAX_UINT256,
            inclusion: anchor(MAX_UINT256 - 1n),
            observedAt: anchor(MAX_UINT256),
          },
        });
      }

      const snapshot: TransactionJournalSnapshot = {
        version: 1,
        identity: IDENTITY,
        baseline,
        lastObservation: {
          anchor: anchor(MAX_UINT256),
          nonce: MAX_UINT256,
        },
        nextNonce,
        durableNextNonce,
        repairs,
        attempts,
      };

      expect(snapshot.attempts).toHaveLength(16);
      expect(snapshot.repairs).toHaveLength(8);

      for (const attempt of snapshot.attempts) {
        expect(attempt.signedTransactions).toHaveLength(16);
      }

      expect(snapshot.attempts.flatMap(
        (attempt) => attempt.signedTransactions,
      )).toHaveLength(256);

      // Exercise the real structural validation, transaction hash
      // checks, signer recovery, and replacement-intent verification.
      const contents = await encodeJournalSnapshot(
        snapshot,
        IDENTITY,
      );

      const byteLength = Buffer.byteLength(contents, 'utf8');

      expect(byteLength).toBeLessThanOrEqual(MAX_JOURNAL_BYTES);

      // Record the actual fixture size in test output for review.
      console.info({
        submissionShape: 'submitBeaconWithWitness',
        calldataBytes: size(largestSubmission.data),
        retainedAttempts: snapshot.attempts.length,
        signedVariantsPerAttempt:
          MAX_SIGNED_TRANSACTIONS_PER_ATTEMPT,
        journalBytes: byteLength,
        journalLimitBytes: MAX_JOURNAL_BYTES,
        remainingBytes: MAX_JOURNAL_BYTES - byteLength,
      });

      expect(await decodeJournalSnapshot(contents, IDENTITY))
        .toEqual(snapshot);
    },
    30_000,
  );
});