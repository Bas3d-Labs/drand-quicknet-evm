import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  Hash,
  PublicClient,
} from 'viem';

import {
  searchAttemptReplacement,
  type SearchAttemptReplacementOptions,
} from '../../src/chain/search-attempt-replacement.js';

const SIGNER = `0x${'aa'.repeat(20)}` as const;
const OTHER_SIGNER = `0x${'bb'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
const REPLACEMENT = `0x${'bb'.repeat(32)}` as const;
const FORK = `0x${'ff'.repeat(32)}` as const;
const BUMP = `0x${'cc'.repeat(32)}` as const;

function blockHash(number: bigint): Hash {
  return `0x${number.toString(16).padStart(64, '0')}`;
}

function anchorAt(number: bigint) {
  return {
    blockNumber: number,
    blockHash: blockHash(number),
  };
}

function transaction(hash: Hash = REPLACEMENT) {
  return {
    hash,
    from: SIGNER,
    nonce: 4,
  };
}

function setup() {
  const transactions = new Map<bigint, unknown[]>();

  const getBlock = vi.fn(async (request: {
    blockNumber: bigint;
    includeTransactions?: boolean;
  }) => ({
    number: request.blockNumber,
    hash: blockHash(request.blockNumber),
    parentHash: blockHash(request.blockNumber - 1n),
    transactions: transactions.get(request.blockNumber) ?? [],
  }));

  const options: SearchAttemptReplacementOptions = {
    publicClient: {
      getBlock,
    } as unknown as PublicClient,
    signer: SIGNER,
    attempt: {
      nonce: 4n,
      signedTransactions: [{
        transactionHash: HASH,
      }],
      replacementSearch: {
        lowerBound: {
          anchor: anchorAt(100n),
          nonce: 4n,
        },
        searchedThrough: null,
      },
    },
    observation: {
      anchor: anchorAt(105n),
      nonce: 5n,
    },
    maxBlockRange: 2n,
  };

  const scanned = () => getBlock.mock.calls
    .filter(([request]) => request.includeTransactions === true)
    .map(([request]) => request.blockNumber);

  const run = () => searchAttemptReplacement(options);

  return {
    options,
    transactions,
    getBlock,
    scanned,
    run,
  };
}

describe('bounded replacement search', () => {
  it('returns durable replacement evidence after the closing anchor check', async () => {
    const fixture = setup();
    fixture.transactions.set(102n, [transaction()]);

    expect(await fixture.run()).toEqual({
      status: 'replacement-found',
      evidence: {
        outcome: 'replaced',
        anchor: anchorAt(105n),
        inclusion: anchorAt(102n),
        replacementTransactionHash: REPLACEMENT,
        nonceAtAnchor: 5n,
      },
    });

    expect(fixture.scanned()).toEqual([101n, 102n]);

    expect(fixture.getBlock.mock.calls.at(-1)).toEqual([
      { blockNumber: 105n },
    ]);
  });

  it('routes the recorded transaction back to receipt reconciliation', async () => {
    const fixture = setup();

    fixture.transactions.set(101n, [
      transaction(`0x${HASH.slice(2).toUpperCase()}`),
    ]);

    expect(await fixture.run()).toEqual({
      status: 'recorded-transaction-found',
      transactionHash: HASH,
      anchor: anchorAt(105n),
      inclusion: anchorAt(101n),
    });

    expect(fixture.scanned()).toEqual([101n]);
  });

  it('matches sender case-insensitively and ignores other senders or nonces', async () => {
    const fixture = setup();

    fixture.transactions.set(101n, [
      {
        ...transaction(),
        from: OTHER_SIGNER,
      },
      {
        ...transaction(),
        nonce: 3,
      },
      {
        ...transaction(),
        from: `0x${SIGNER.slice(2).toUpperCase()}`,
      },
    ]);

    expect(await fixture.run()).toMatchObject({
      status: 'replacement-found',
    });
  });

  it('bounds work and resumes after the saved boundary', async () => {
    const fixture = setup();
    const first = await fixture.run();

    expect(first).toEqual({
      status: 'not-found',
      searchedThrough: anchorAt(102n),
      scannedBlocks: 2n,
      remainingBlocks: 3n,
    });

    if (first.status !== 'not-found') {
      throw new Error('Expected progress.');
    }

    fixture.options.attempt = {
      ...fixture.options.attempt,
      replacementSearch: {
        lowerBound: {
          anchor: anchorAt(100n),
          nonce: 4n,
        },
        searchedThrough: first.searchedThrough,
      },
    };

    fixture.getBlock.mockClear();

    expect(await fixture.run()).toMatchObject({
      status: 'not-found',
      searchedThrough: anchorAt(104n),
      remainingBlocks: 1n,
    });

    expect(fixture.scanned()).toEqual([103n, 104n]);

    expect(fixture.getBlock.mock.calls.slice(0, 3)).toEqual([
      [{ blockNumber: 105n }],
      [{ blockNumber: 100n }],
      [{ blockNumber: 102n }],
    ]);
  });

  it('caps the range at the anchor and leaves a fully searched conflict unresolved', async () => {
    const fixture = setup();
    fixture.options.maxBlockRange = 100n;

    expect(await fixture.run()).toEqual({
      status: 'not-found',
      searchedThrough: anchorAt(105n),
      scannedBlocks: 5n,
      remainingBlocks: 0n,
    });

    expect(fixture.scanned()).toEqual([
      101n,
      102n,
      103n,
      104n,
      105n,
    ]);
  });

  it('does not rescan an already exhausted range', async () => {
    const fixture = setup();

    fixture.options.attempt = {
      ...fixture.options.attempt,
      replacementSearch: {
        lowerBound: {
          anchor: anchorAt(100n),
          nonce: 4n,
        },
        searchedThrough: anchorAt(105n),
      },
    };

    expect(await fixture.run()).toMatchObject({
      status: 'not-found',
      scannedBlocks: 0n,
      remainingBlocks: 0n,
    });

    expect(fixture.scanned()).toEqual([]);
  });

  it('does not invent a missing lower bound', async () => {
    const fixture = setup();

    fixture.options.attempt = {
      ...fixture.options.attempt,
      replacementSearch: null,
    };

    expect(await fixture.run()).toEqual({
      status: 'missing-lower-bound',
    });

    expect(fixture.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    'lower-bound',
    'searched-through',
  ] as const)(
    'rejects a changed %s before scanning',
    async (boundary) => {
      const fixture = setup();

      fixture.options.attempt = {
        ...fixture.options.attempt,
        replacementSearch: {
          lowerBound: {
            anchor: anchorAt(100n),
            nonce: 4n,
          },
          searchedThrough: anchorAt(102n),
        },
      };

      const original = fixture.getBlock.getMockImplementation()!;

      fixture.getBlock.mockImplementation(async (request) => {
        const block = await original(request);

        let changedNumber = 100n;

        if (boundary === 'searched-through') {
          changedNumber = 102n;
        }

        if (request.blockNumber === changedNumber) {
          block.hash = FORK;
        }

        return block;
      });

      expect(await fixture.run()).toMatchObject({
        status: 'boundary-changed',
        boundary,
      });

      expect(fixture.scanned()).toEqual([]);
    },
  );

  it.each(['opening', 'closing'])(
    'discards work when the %s anchor changes',
    async (stage) => {
      const fixture = setup();
      fixture.transactions.set(101n, [transaction()]);

      const original = fixture.getBlock.getMockImplementation()!;
      let anchorReads = 0;

      fixture.getBlock.mockImplementation(async (request) => {
        const block = await original(request);

        if (request.blockNumber === 105n) {
          anchorReads += 1;

          if (stage === 'opening' || anchorReads === 2) {
            block.hash = FORK;
          }
        }

        return block;
      });

      expect(await fixture.run()).toMatchObject({
        status: 'anchor-changed',
      });

      if (stage === 'opening') {
        expect(fixture.scanned()).toEqual([]);
      }
    },
  );

  it('does not skip backwards when the anchor is behind the saved boundary', async () => {
    const fixture = setup();

    fixture.options.observation = {
      anchor: anchorAt(101n),
      nonce: 5n,
    };

    fixture.options.attempt = {
      ...fixture.options.attempt,
      replacementSearch: {
        lowerBound: {
          anchor: anchorAt(100n),
          nonce: 4n,
        },
        searchedThrough: anchorAt(102n),
      },
    };

    expect(await fixture.run()).toEqual({
      status: 'anchor-behind-search',
    });

    expect(fixture.scanned()).toEqual([]);
  });

  it.each([
    { parentHash: FORK },
    { number: 999n },
    { hash: 'invalid' },
    { transactions: null },
  ])(
    'rejects inconsistent block data %# without returning progress',
    async (invalid) => {
      const fixture = setup();
      const original = fixture.getBlock.getMockImplementation()!;

      fixture.getBlock.mockImplementation(async (request) => {
        const block = await original(request);

        if (request.includeTransactions) {
          Object.assign(block, invalid);
        }

        return block;
      });

      await expect(fixture.run()).rejects.toThrow(
        'Invalid replacement search block.',
      );
    },
  );

  it.each([
    HASH,
    {
      ...transaction(),
      nonce: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...transaction(),
      from: 'invalid',
    },
    {
      ...transaction(),
      hash: 'invalid',
    },
  ])(
    'rejects incomplete or invalid transaction data %#',
    async (invalid) => {
      const fixture = setup();
      fixture.transactions.set(101n, [invalid]);

      await expect(fixture.run()).rejects.toThrow(
        'Invalid replacement search transaction.',
      );
    },
  );

  it('rejects duplicate sender and nonce matches', async () => {
    const fixture = setup();

    fixture.transactions.set(101n, [
      transaction(),
      transaction(HASH),
    ]);

    await expect(fixture.run()).rejects.toThrow(
      'Multiple transactions matched the recorded nonce.',
    );
  });

  it.each(['scan', 'closing'])(
    'propagates %s RPC failure without publishing progress',
    async (stage) => {
      const fixture = setup();
      const original = fixture.getBlock.getMockImplementation()!;
      const failure = new Error('RPC unavailable');

      let anchorReads = 0;

      fixture.getBlock.mockImplementation(async (request) => {
        if (request.blockNumber === 105n) {
          anchorReads += 1;
        }

        if (
          (stage === 'scan' && request.includeTransactions) ||
          anchorReads === 2
        ) {
          throw failure;
        }

        return original(request);
      });

      await expect(fixture.run()).rejects.toBe(failure);
    },
  );

  it.each([0n, -1n])(
    'rejects invalid range budget %s',
    async (maxBlockRange) => {
      const fixture = setup();
      fixture.options.maxBlockRange = maxBlockRange;

      await expect(fixture.run()).rejects.toThrow(
        'Invalid replacement search input.',
      );

      expect(fixture.getBlock).not.toHaveBeenCalled();
    },
  );

  it('requires an observation proving the nonce has advanced', async () => {
    const fixture = setup();

    fixture.options.observation = {
      anchor: anchorAt(105n),
      nonce: 4n,
    };

    await expect(fixture.run()).rejects.toThrow(
      'Invalid replacement search input.',
    );
  });

  it('rejects a lower bound whose nonce was already consumed', async () => {
    const fixture = setup();

    fixture.options.attempt = {
      ...fixture.options.attempt,
      replacementSearch: {
        lowerBound: {
          anchor: anchorAt(100n),
          nonce: 5n,
        },
        searchedThrough: null,
      },
    };

    await expect(fixture.run()).rejects.toThrow(
      'Invalid replacement search lower bound.',
    );
  });

  it('captures inputs before awaiting and returns frozen detached evidence', async () => {
    const fixture = setup();
    fixture.transactions.set(101n, [transaction()]);

    const pending = fixture.run();

    Object.assign(fixture.options.attempt, {
      nonce: 99n,
      signedTransactions: [{
        transactionHash: REPLACEMENT,
      }],
    });

    Object.assign(
      fixture.options.observation.anchor,
      anchorAt(999n),
    );

    Object.assign(fixture.options.observation, {
      nonce: 100n,
    });

    const result = await pending;

    expect(result).toMatchObject({
      status: 'replacement-found',
      evidence: {
        anchor: anchorAt(105n),
        nonceAtAnchor: 5n,
      },
    });

    if (result.status !== 'replacement-found') {
      throw new Error('Expected evidence.');
    }

    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.anchor)).toBe(true);
    expect(Object.isFrozen(result.evidence.inclusion)).toBe(true);
  });

  it('rejects a full block that disagrees with the selected anchor', async () => {
    const fixture = setup();

    fixture.options.maxBlockRange = 5n;
    fixture.transactions.set(105n, [transaction()]);

    const original = fixture.getBlock.getMockImplementation()!;

    fixture.getBlock.mockImplementation(async (request) => {
      const block = await original(request);

      if (
        request.includeTransactions &&
        request.blockNumber === 105n
      ) {
        block.hash = FORK;
      }

      return block;
    });

    expect(await fixture.run()).toEqual({
      status: 'anchor-changed',
      observedAnchor: {
        blockNumber: 105n,
        blockHash: FORK,
      },
    });
  });

  it.each([HASH, BUMP])(
    'recognizes recorded transaction %s without producing replacement evidence',
    async (hash) => {
      const fixture = setup();

      fixture.options.attempt = {
        ...fixture.options.attempt,
        signedTransactions: [
          { transactionHash: HASH },
          { transactionHash: BUMP },
        ],
      };

      fixture.transactions.set(101n, [
        transaction(`0x${hash.slice(2).toUpperCase()}`),
      ]);

      expect(await fixture.run()).toEqual({
        status: 'recorded-transaction-found',
        transactionHash: hash,
        anchor: anchorAt(105n),
        inclusion: anchorAt(101n),
      });

      expect(fixture.scanned()).toEqual([101n]);
      expect(fixture.getBlock.mock.calls.at(-1)).toEqual([
        { blockNumber: 105n },
      ]);
    },
  );

  it('still identifies an external replacement when multiple hashes are recorded', async () => {
    const fixture = setup();

    fixture.options.attempt = {
      ...fixture.options.attempt,
      signedTransactions: [
        { transactionHash: HASH },
        { transactionHash: BUMP },
      ],
    };

    fixture.transactions.set(102n, [transaction(REPLACEMENT)]);

    expect(await fixture.run()).toMatchObject({
      status: 'replacement-found',
      evidence: {
        replacementTransactionHash: REPLACEMENT,
        nonceAtAnchor: 5n,
      },
    });
  });

  it('captures every recorded hash before awaiting', async () => {
    const fixture = setup();

    const signedTransactions: { transactionHash: Hash }[] = [
      { transactionHash: HASH },
      { transactionHash: BUMP },
    ];

    fixture.options.attempt = {
      ...fixture.options.attempt,
      signedTransactions,
    };

    fixture.transactions.set(101n, [transaction(BUMP)]);

    const pending = fixture.run();

    signedTransactions[1]!.transactionHash = FORK;
    signedTransactions.length = 0;

    expect(await pending).toEqual({
      status: 'recorded-transaction-found',
      transactionHash: BUMP,
      anchor: anchorAt(105n),
      inclusion: anchorAt(101n),
    });
  });

  it.each([
    { hashes: [] },
    { hashes: [HASH, HASH] },
    { hashes: [HASH, `0x${'AA'.repeat(32)}`] },
    { hashes: ['invalid'] },
  ])(
    'rejects invalid recorded hash collections before RPC calls: %#',
    async ({ hashes }) => {
      const fixture = setup();

      fixture.options.attempt = {
        ...fixture.options.attempt,
        signedTransactions: hashes.map((hash) => ({
          transactionHash: hash as Hash,
        })),
      };

      await expect(fixture.run())
        .rejects.toThrow('Invalid replacement search input.');

      expect(fixture.getBlock).not.toHaveBeenCalled();
    },
  );
});