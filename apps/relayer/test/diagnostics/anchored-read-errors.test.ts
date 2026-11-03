import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  anchoredReadDetails,
  registerAnchoredReadFailure,
  type AnchoredReadContext,
} from '../../src/diagnostics/anchored-read-errors.js';

const HASH = '0x' + 'aa'.repeat(32);

function context(): AnchoredReadContext {
  return {
    method: 'eth_getTransactionCount',
    blockNumber: 100n,
    expectedBlockHash: HASH,
    durationMs: 12.5,
  };
}

describe('anchored read failure context', () => {
  it('registers against the original frozen error without modifying it', () => {
    const error = Object.freeze(new Error('RPC failed.'));
    const before = Object.getOwnPropertyDescriptors(error);

    registerAnchoredReadFailure(error, context());

    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);

    expect(anchoredReadDetails(error)).toEqual({
      method: 'eth_getTransactionCount',
      blockNumber: '100',
      expectedBlockHash: HASH,
      durationMs: 12.5,
    });
  });

  it('preserves rejection identity', async () => {
    const error = new Error('RPC failed.');

    async function read(): Promise<never> {
      try {
        throw error;
      } catch (failure) {
        registerAnchoredReadFailure(failure, context());
        throw failure;
      }
    }

    await expect(read()).rejects.toBe(error);
  });

  it('does not inspect properties on the error', () => {
    const getter = vi.fn(() => {
      throw new Error('Must not inspect provider properties.');
    });

    const error = Object.create(null);

    Object.defineProperty(error, 'message', {
      get: getter,
    });

    registerAnchoredReadFailure(error, context());

    expect(getter).not.toHaveBeenCalled();
    expect(anchoredReadDetails(error)).toBeDefined();
  });

  it.each([
    undefined,
    null,
    'RPC failed.',
    123,
    false,
    1n,
    Symbol('failure'),
  ])('omits context for primitive failure %s', error => {
    expect(() => {
      registerAnchoredReadFailure(error, context());
    }).not.toThrow();

    expect(anchoredReadDetails(error)).toBeUndefined();
  });

  it('captures values independently of subsequent input mutation', () => {
    const error = new Error();
    const input = context();

    registerAnchoredReadFailure(error, input);

    input.blockNumber = 200n;
    input.durationMs = 99;

    expect(anchoredReadDetails(error)).toMatchObject({
      blockNumber: '100',
      durationMs: 12.5,
    });
  });

  it('returns an independent copy for each summary', () => {
    const error = new Error();

    registerAnchoredReadFailure(error, context());

    const first = anchoredReadDetails(error)!;
    first.blockNumber = '200';

    expect(anchoredReadDetails(error)?.blockNumber).toBe('100');
  });

  it('omits the expected hash when none is known', () => {
    const error = new Error();

    registerAnchoredReadFailure(error, {
      method: 'eth_getBlockByNumber',
      blockNumber: 0n,
      durationMs: 0,
    });

    expect(anchoredReadDetails(error)).toEqual({
      method: 'eth_getBlockByNumber',
      blockNumber: '0',
      durationMs: 0,
    });
  });

  it.each([
    { method: 'eth_sendRawTransaction' },
    { blockNumber: -1n },
    { blockNumber: 1n << 256n },
    { blockNumber: '100' },
    { durationMs: -1 },
    { durationMs: Number.NaN },
    { durationMs: Number.POSITIVE_INFINITY },
    { expectedBlockHash: 'invalid' },
  ])('omits invalid context case %#', invalid => {
    const error = new Error();

    const input = {
      ...context(),
      ...invalid,
    } as unknown as AnchoredReadContext;

    expect(() => {
      registerAnchoredReadFailure(error, input);
    }).not.toThrow();

    expect(anchoredReadDetails(error)).toBeUndefined();
  });

  it('does not invoke context accessors', () => {
    const error = new Error();
    const getter = vi.fn(() => 100n);
    const input = context();

    Object.defineProperty(input, 'blockNumber', {
      get: getter,
    });

    registerAnchoredReadFailure(error, input);

    expect(getter).not.toHaveBeenCalled();
    expect(anchoredReadDetails(error)).toBeUndefined();
  });

  it('isolates throwing context proxies', () => {
    const error = new Error();

    const input = new Proxy(context(), {
      getOwnPropertyDescriptor() {
        throw new Error('Diagnostic capture failed.');
      },
    });

    expect(() => {
      registerAnchoredReadFailure(error, input);
    }).not.toThrow();

    expect(anchoredReadDetails(error)).toBeUndefined();
  });

  it('does not copy undeclared fields into diagnostic context', () => {
    const error = new Error();

    const input = {
      ...context(),
      url: 'https://user:secret@example.invalid/private',
      message: 'Provider-controlled text',
    };

    registerAnchoredReadFailure(error, input);

    expect(anchoredReadDetails(error)).not.toHaveProperty('url');
    expect(anchoredReadDetails(error)).not.toHaveProperty('message');
  });

  it('preserves the first registered read context', () => {
    const error = new Error('RPC failed.');

    registerAnchoredReadFailure(error, context());

    registerAnchoredReadFailure(error, {
      method: 'eth_getBlockByNumber',
      blockNumber: 200n,
      expectedBlockHash: '0x' + 'bb'.repeat(32),
      durationMs: 99,
    });

    expect(anchoredReadDetails(error)).toEqual({
      method: 'eth_getTransactionCount',
      blockNumber: '100',
      expectedBlockHash: HASH,
      durationMs: 12.5,
    });
  });
});