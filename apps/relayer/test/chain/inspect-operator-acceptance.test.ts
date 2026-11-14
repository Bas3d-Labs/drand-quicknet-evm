import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  ATTEMPT_ID,
  DURABLE,
  IDENTITY,
  anchor,
  client,
  fixture,
} from '../helpers/operator-attribution-fixture.js';

import {
  maximumOutcome,
} from '../helpers/operator-outcome-fixture.js';

async function input(fact: bigint | null = 100n, cursor: bigint | null = 102n) {
  const snapshot = await fixture(fact, cursor);

  const rpc = client(200n);

  return {
    snapshot,
    rpc,
    inspect: (attemptId = ATTEMPT_ID) => inspectSignerRecovery({
      snapshot,
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptanceAttemptId: attemptId,
    }),
  };
}

describe('acceptance refusal and search dispatch', () => {
  it.each([null, 102n, 104n])('reuses the fact at D with cursor %s', async (cursor) => {
    // Latest inclusion invalidation can clear a cursor while retaining its fact.
    // Subsequent partial progress can therefore leave the cursor below the fact.
    const { rpc, inspect } = await input(104n, cursor);

    expect((await inspect()).status).toBe('operator-acceptance-available');

    const reads = [
      '104:false',
      '104:false',
      '104:false',
      '104:false',
      '104:false',
      '98:false',
    ];

    if (cursor === 102n) {
      reads.push('102:false');
    }

    reads.push('104:false');
    expect(rpc.calls.filter((value) => value.includes(':'))).toEqual(reads);
  });

  it.each(['lower', 'cursor', 'closing', 'closing-error'] as const)(
    'refuses %s during fact reuse after ordinary brackets',
    async (fault) => {
      const { rpc, inspect } = await input(104n, 102n);

      const original = rpc.getBlock.getMockImplementation()!;

      let durableReads = 0;

      rpc.getBlock.mockImplementation(async (options) => {
        const block = await original(options);

        if (options?.blockNumber === 104n) {
          durableReads++;
        }

        if (fault === 'closing-error' && durableReads === 6) {
          throw new Error('header unavailable');
        }

        if (
          (fault === 'lower' && options?.blockNumber === 98n) ||
          (fault === 'cursor' && options?.blockNumber === 102n) ||
          (fault === 'closing' && durableReads === 6)
        ) {
          return {
            ...block,
            hash: anchor(999n).blockHash,
          };
        }

        return block;
      });

      if (fault === 'closing-error') {
        await expect(inspect()).rejects.toThrow();
      } else {
        const result = await inspect();

        if (fault === 'closing') {
          expect(result.status).toBe('anchor-changed');
        } else {
          expect(result).toMatchObject({
            status: 'operator-acceptance-refused',
            reason: 'correction-required',
          });
        }

        expect(result).not.toHaveProperty('snapshotDigest');
        expect(result).not.toHaveProperty('observations');
      }
    },
  );

  it('refuses a moved closing anchor after a completed continuation', async () => {
    const { rpc, inspect } = await input();

    const original = rpc.getBlock.getMockImplementation()!;

    let durableReads = 0;

    rpc.getBlock.mockImplementation(async (options) => {
      const block = await original(options);

      if (options?.blockNumber === 104n) {
        durableReads++;
      }

      if (durableReads === 7) {
        return {
          ...block,
          hash: anchor(999n).blockHash,
        };
      }

      return block;
    });

    const result = await inspect();

    expect(result.status).toBe('anchor-changed');
    expect(result).not.toHaveProperty('snapshotDigest');
    expect(result).not.toHaveProperty('observations');
  });

  it.each(['wrong-attempt', 'nonce-unconsumed', 'missing-lower-bound'] as const)(
    'refuses %s before search reads',
    async (reason) => {
      const { snapshot, rpc, inspect } = await input(null, null);

      let attemptId = ATTEMPT_ID as string;

      if (reason === 'wrong-attempt') {
        attemptId = '33333333-3333-4333-8333-333333333333';
      } else if (reason === 'nonce-unconsumed') {
        rpc.getTransactionCount.mockImplementation(async () => {
          rpc.calls.push('nonce');
          return 4;
        });
      } else {
        Object.assign(snapshot.attempts[0]!, {
          replacementSearch: null,
        });
      }

      expect(await inspect(attemptId)).toMatchObject({
        status: 'operator-acceptance-refused',
        reason,
      });
      expect(rpc.calls).toEqual([
        '104:false',
        'receipt',
        '104:false',
        '104:false',
        'nonce',
        '104:false',
      ]);
    },
  );

  it.each(['reverted', 'success'] as const)('prioritizes a %s receipt', async (status) => {
    const { snapshot, rpc, inspect } = await input();

    rpc.getTransactionReceipt.mockResolvedValue({
      transactionHash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
      blockNumber: 100n,
      blockHash: anchor(100n).blockHash,
      status,
    } as never);

    expect(await inspect()).toMatchObject({
      status: 'resolution-available',
      evidence: {
        outcome: status,
      },
    });
    expect(rpc.calls).not.toContain('98:false');
  });

  it('routes a found external transaction to ordinary resolution', async () => {
    const { snapshot } = await input();

    const rpc = client(103n);

    expect(await inspectSignerRecovery({
      snapshot,
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptanceAttemptId: ATTEMPT_ID,
    })).toMatchObject({ status: 'resolution-available', evidence: { outcome: 'replaced' } });
  });

  it('refuses a found retained hash without a qualifying receipt', async () => {
    const { snapshot, rpc, inspect } = await input();

    const original = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (options) => {
      const block = await original(options);

      if (options?.includeTransactions && options.blockNumber === 103n) {
        return {
          ...block,
          transactions: [{
            hash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
            from: IDENTITY.signer,
            nonce: 4,
          }],
        } as never;
      }

      return block;
    });

    expect(await inspect()).toMatchObject({
      status: 'operator-acceptance-refused',
      reason: 'retained-candidate-unresolved',
    });
  });

  it('refuses full history after receipt/nonce reads and before search', async () => {
    const { snapshot, rpc, inspect } = await input(null, null);

    Object.assign(snapshot, {
      baseline: {
        anchor: anchor(0n),
        nonce: 0n,
      },
      durableNextNonce: 32n,
      nextNonce: 33n,
      lastObservation: {
        anchor: DURABLE,
        nonce: 33n,
      },
      ledger: {
        outcomes: Array.from({
          length: 32,
        }, (_, i) => maximumOutcome(i, BigInt(i))),
        obligations: [],
      },
      attempts: [{
        ...snapshot.attempts[0]!,
        nonce: 32n,
      }],
    });
    // Inspector structural validation does not verify signed bytes. The codec
    // tests separately cover signed-byte validation; this row isolates capacity.
    rpc.getTransactionCount.mockImplementation(async () => {
      rpc.calls.push('nonce');
      return 33;
    });

    expect(await inspect()).toMatchObject({
      status: 'operator-acceptance-refused',
      reason: 'ledger-capacity-reached',
    });
    expect(rpc.calls).toEqual([
      '104:false',
      'receipt',
      '104:false',
      '104:false',
      'nonce',
      '104:false',
    ]);
  });

  it('refuses an older fact whose nonce exceeds the fresh durable nonce', async () => {
    const { snapshot, rpc, inspect } = await input();

    Object.assign(snapshot.attempts[0]!.replacementSearch!.exhausted!, {
      nonce: 6n,
    });

    expect(await inspect()).toEqual({
      status: 'inconsistent-observations',
      observation: {
        anchor: DURABLE,
        nonce: 5n,
      },
    });
    expect(rpc.calls).toEqual([
      '104:false',
      'receipt',
      '104:false',
      '104:false',
      'nonce',
      '104:false',
    ]);
  });

  it('reports the lower-bound gap when no cursor is stored', async () => {
    const { rpc, inspect } = await input(null, null);

    expect(await inspect()).toEqual({
      status: 'operator-acceptance-refused',
      observation: {
        anchor: DURABLE,
        nonce: 5n,
      },
      reason: 'search-incomplete',
      gap: {
        boundary: anchor(98n),
        durable: DURABLE,
        blocks: 6n,
        budget: 2n,
      },
    });
    expect(rpc.calls).toEqual([
      '104:false',
      'receipt',
      '104:false',
      '104:false',
      'nonce',
      '104:false',
      '104:false',
      '98:false',
      '99:true',
      '100:true',
      '104:false',
    ]);
  });

});
