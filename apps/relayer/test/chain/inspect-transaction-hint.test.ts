import {
  keccak256,
} from 'viem';

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import {
  ACCOUNT,
  DURABLE,
  HINT_HASH,
  IDENTITY,
  OTHER_HASH,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

const PREFIX = [
  '104:false',
  'receipt',
  '104:false',
  '104:false',
  'nonce',
  '104:false',
];

const cases = [
  {
    fact: null,
    cursor: null,
    t: 99n,
    body: [98n],
  },
  {
    fact: null,
    cursor: null,
    t: 101n,
    body: [98n, 100n],
  },
  {
    fact: null,
    cursor: 102n,
    t: 99n,
    body: [98n, 102n],
  },
  {
    fact: null,
    cursor: 102n,
    t: 101n,
    body: [98n, 102n, 100n],
  },
  {
    fact: 100n,
    cursor: null,
    t: 99n,
    body: [98n, 100n],
  },
  {
    fact: 100n,
    cursor: null,
    t: 103n,
    body: [98n, 100n, 102n],
  },
  {
    fact: 100n,
    cursor: 102n,
    t: 99n,
    body: [98n, 100n, 102n],
  },
  {
    fact: 100n,
    cursor: 102n,
    t: 102n,
    body: [98n, 100n, 102n, 101n],
  },
  {
    fact: 100n,
    cursor: 102n,
    t: 101n,
    body: [98n, 100n, 102n],
  },
  {
    fact: 104n,
    cursor: 104n,
    t: 99n,
    body: [98n],
  },
  {
    fact: 104n,
    cursor: 104n,
    t: 104n,
    body: [98n, 103n],
  },
  {
    fact: 100n,
    cursor: 100n,
    t: 99n,
    body: [98n, 100n],
  },
  {
    fact: null,
    cursor: 102n,
    t: 104n,
    body: [98n, 103n],
  },
];

describe('operator hint evidence', () => {
  it.each(cases)('pins bracket: fact=$fact cursor=$cursor T=$t', async ({ fact, cursor, t, body }) => {
    const snapshot = await fixture(fact, cursor);

    const rpc = client(t);

    const result = await inspectSignerRecovery({
      publicClient: rpc.publicClient,
      snapshot,
      anchor: DURABLE,
      maxBlockRange: 1n,
      hint: request(t).hint,
    });

    expect(result.status).toBe('operator-attribution-available');
    expect(rpc.calls).toEqual([
      ...PREFIX,
      '104:false',
      ...body.map((height) => `${height}:false`),
      `${t}:true`,
      '104:false',
    ]);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  },
  );

  it.each([
    {
      fault: 'wrong-parent',
      reason: 'invalid-parent',
    },
    {
      fault: 'duplicate-match',
      reason: 'invalid-match',
    },
    {
      fault: 'hint-is-not-match',
      reason: 'invalid-match',
    },
    {
      fault: 'closing-moved',
      reason: 'anchor-changed',
    },
    {
      fault: 'closing-failed',
      reason: null,
    },
    {
      fault: 'cursor-changed',
      reason: 'correction-required',
    },
    {
      fault: 'lower-changed',
      reason: 'correction-required',
    },
    {
      fault: 'fact-changed',
      reason: 'correction-required',
    },
    {
      fault: 'at-lower',
      reason: 'inclusion-outside-bound',
    },
    {
      fault: 'above-durable',
      reason: 'inclusion-outside-bound',
    },
    {
      fault: 'missing-bound',
      reason: 'missing-lower-bound',
    },
  ])('refuses $fault for $reason before planning any write', async ({ fault, reason }) => {
    let snapshot = await fixture();

    let height = 101n;

    if (fault === 'at-lower') {
      height = 98n;
    }

    if (fault === 'above-durable') {
      height = 105n;
    }

    if (fault === 'missing-bound') {
      snapshot = {
        ...snapshot,
        attempts: [{
          ...snapshot.attempts[0]!,
          replacementSearch: null,
        }],
      };
    }

    const rpc = client(height);

    const original = rpc.getBlock.getMockImplementation()!;

    let durableReads = 0;

    rpc.getBlock.mockImplementation(async (input) => {
      const block = await original(input);

      if (input?.blockNumber === 104n) {
        durableReads += 1;

        if (durableReads === 6 && fault === 'closing-failed') {
          throw new Error('closed read failed');
        }

        if (durableReads === 6 && fault === 'closing-moved') {
          return {
            ...block,
            hash: OTHER_HASH,
          };
        }
      }

      if (
        (fault === 'cursor-changed' && input?.blockNumber === 102n) ||
        (fault === 'lower-changed' && input?.blockNumber === 98n) ||
        (fault === 'fact-changed' && input?.blockNumber === 100n)
      ) {
        return {
          ...block,
          hash: OTHER_HASH,
        };
      }

      if (input?.includeTransactions) {
        if (fault === 'wrong-parent') {
          return {
            ...block,
            parentHash: OTHER_HASH,
          };
        }

        if (fault === 'duplicate-match') {
          return {
            ...block,
            transactions: [
              ...block.transactions,
              {
                hash: OTHER_HASH,
                from: ACCOUNT.address,
                nonce: 4,
              },
            ],
          } as never;
        }

        if (fault === 'hint-is-not-match') {
          return {
            ...block,
            transactions: [
              {
                hash: HINT_HASH,
                from: `0x${'22'.repeat(20)}`,
                nonce: 4,
              },
              {
                hash: OTHER_HASH,
                from: ACCOUNT.address,
                nonce: 4,
              },
            ],
          } as never;
        }
      }

      return block;
    });

    const pending = inspectSignerRecovery({
      publicClient: rpc.publicClient,
      snapshot,
      anchor: DURABLE,
      maxBlockRange: 1n,
      hint: request(height).hint,
    });

    if (fault === 'closing-failed') {
      await expect(pending).rejects.toThrow('closed read failed');

      return;
    }

    const result = await pending;

    expect(result).toMatchObject({
      status: 'operator-hint-refused',
      reason,
    });
    expect(result).not.toHaveProperty('observations');
    expect(planSignerRecovery({
      identity: IDENTITY,
      snapshot,
      inspection: result,
      unattributedActivity: false,
      attribution: request(height),
    })).toEqual({
      kind: 'unchanged',
      reason: 'inspection-not-committable',
    });
  },
  );

  it('routes a retained hint through ordinary resolution without a ledger row', async () => {
    const snapshot = await fixture();

    const hash = snapshot.attempts[0]!.signedTransactions[0].transactionHash;

    const rpc = client();

    rpc.getTransactionReceipt.mockResolvedValue({
      transactionHash: hash,
      blockNumber: 101n,
      blockHash: anchor(101n).blockHash,
      status: 'success',
    } as never);

    const inspection = await inspectSignerRecovery({
      publicClient: rpc.publicClient,
      snapshot,
      anchor: DURABLE,
      maxBlockRange: 1n,
      hint: {
        ...request().hint,
        transactionHash: hash,
      },
    });

    const plan = planSignerRecovery({
      identity: IDENTITY,
      snapshot,
      inspection,
      unattributedActivity: false,
      attribution: request(),
    });

    expect(inspection.status).toBe('resolution-available');
    expect(plan.kind).toBe('persist');

    if (plan.kind === 'persist') {
      expect(plan.snapshot.ledger.outcomes).toEqual([]);
      expect(plan.completion.kind).toBe('resolution');
    }

    expect(rpc.getBlock.mock.calls.some(([input]) => input?.includeTransactions)).toBe(false);
  },
  );
},
);

it('keeps a later contradicted fact ahead of an otherwise valid hint', async () => {
  const initial = await fixture();

  const signedTransaction = await ACCOUNT.signTransaction({
    chainId: IDENTITY.chainId,
    nonce: 5,
    gas: 21_000n,
    to: ACCOUNT.address,
    type: 'eip1559',
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });

  const later = {
    ...initial.attempts[0]!,
    attemptId: '33333333-3333-4333-8333-333333333333',
    workId: 'hint:5',
    nonce: 5n,
    signedTransactions: [{
      transactionHash: keccak256(signedTransaction),
      signedTransaction,
    }] as const,
    replacementSearch: {
      lowerBound: {
        anchor: anchor(98n),
        nonce: 4n,
      },
      searchedThrough: {
        ...DURABLE,
        blockHash: OTHER_HASH,
      },
      exhausted: {
        anchor: {
          ...DURABLE,
          blockHash: OTHER_HASH,
        },
        nonce: 6n,
      },
    },
  };

  const snapshot = {
    ...initial,
    nextNonce: 6n,
    attempts: [...initial.attempts, later],
  };

  const rpc = client();

  const original = rpc.getBlock.getMockImplementation()!;

  rpc.getBlock.mockImplementation(async (input) => {
    const block = await original(input);

    if (input?.blockNumber === 98n) {
      return {
        ...block,
        hash: OTHER_HASH,
      };
    }

    return block;
  });

  const result = await inspectSignerRecovery({
    publicClient: rpc.publicClient,
    snapshot,
    anchor: DURABLE,
    maxBlockRange: 1n,
    hint: request().hint,
  });

  expect(result.status).toBe('inconsistent-observations');
  expect(rpc.calls).toEqual([...PREFIX, '104:false', '98:false']);
  expect(planSignerRecovery({
    identity: IDENTITY,
    snapshot,
    inspection: result,
    attribution: request(),
    unattributedActivity: false,
  }).kind).toBe('unchanged');
},
);

it('refuses a canonical fact whose nonce exceeds the new consumed observation', async () => {
  const input = await fixture();

  const oldest = input.attempts[0]!;

  const snapshot = {
    ...input,
    attempts: [{
      ...oldest,
      replacementSearch: {
        ...oldest.replacementSearch!,
        exhausted: {
          anchor: anchor(100n),
          nonce: 7n,
        },
      },
    }],
  };

  const rpc = client();

  const result = await inspectSignerRecovery({
    publicClient: rpc.publicClient,
    snapshot,
    anchor: DURABLE,
    maxBlockRange: 1n,
    hint: request().hint,
  });

  expect(result).toMatchObject({
    status: 'operator-hint-refused',
    reason: 'inconsistent-observations',
  });
  expect(result).not.toHaveProperty('observations');
  expect(rpc.calls.at(-1)).toBe('104:false');
},
);
