import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  PublicClient,
} from 'viem';

import type {
  SignerRecoveryCycleResult,
} from '../../src/state/signer-recovery-cycle.js';

const anchorMocks = vi.hoisted(() => ({
  getBlockAnchor: vi.fn(),
}));

vi.mock(
  '../../src/chain/block-anchor.js',
  () => anchorMocks,
);

import {
  recoverSignerAtHeads,
} from '../../src/state/recover-signer-at-heads.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER = `0x${'bb'.repeat(32)}` as const;

function setup() {
  const publicClient = {} as PublicClient;

  const anchor = {
    blockNumber: 100n,
    blockHash: HASH,
  };

  const head = {
    blockNumber: 110n,
    blockHash: OTHER,
  };

  const result: SignerRecoveryCycleResult = {
    inspection: {
      status: 'no-attempt',
      observation: {
        anchor,
        nonce: 4n,
      },
    },
    inclusions: null,
    broadcast: null,
    retryDelayMs: null,
  };

  const run = vi.fn().mockResolvedValue(result);

  const readChainHeads = vi.fn().mockResolvedValue({
    durableBlock: 100n,
    latestBlock: 110n,
  });

  anchorMocks.getBlockAnchor
    .mockResolvedValueOnce(anchor)
    .mockResolvedValueOnce(head);

  return {
    anchor,
    head,
    result,
    run,
    readChainHeads,
    options: {
      publicClient,
      recovery: { run },
      readChainHeads,
      maxBlockRange: 2n,
    },
  };
}

describe('signer recovery at chain heads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes durable and latest anchors to the shared recovery cycle', async () => {
    const t = setup();

    expect(await recoverSignerAtHeads(t.options, 7))
      .toBe(t.result);

    expect(t.readChainHeads).toHaveBeenCalledOnce();

    expect(anchorMocks.getBlockAnchor).toHaveBeenNthCalledWith(
      1,
      t.options.publicClient,
      100n,
    );

    expect(anchorMocks.getBlockAnchor).toHaveBeenNthCalledWith(
      2,
      t.options.publicClient,
      110n,
    );

    expect(t.run).toHaveBeenCalledExactlyOnceWith({
      publicClient: t.options.publicClient,
      anchor: t.anchor,
      head: t.head,
      maxBlockRange: 2n,
    }, 7);
  });

  it('uses one anchor lookup when latest and durable heights match', async () => {
    const t = setup();

    t.readChainHeads.mockResolvedValue({
      durableBlock: 100n,
      latestBlock: 100n,
    });

    await recoverSignerAtHeads(t.options);

    expect(anchorMocks.getBlockAnchor).toHaveBeenCalledOnce();

    expect(t.run).toHaveBeenCalledWith({
      publicClient: t.options.publicClient,
      anchor: t.anchor,
      head: t.anchor,
      maxBlockRange: 2n,
    }, undefined);
  });

  it('rejects reversed heads before looking up anchors', async () => {
    const t = setup();

    t.readChainHeads.mockResolvedValue({
      durableBlock: 111n,
      latestBlock: 110n,
    });

    await expect(
      recoverSignerAtHeads(t.options),
    ).rejects.toThrow('durable block ahead of latest');

    expect(anchorMocks.getBlockAnchor).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('honors cancellation before reading heads', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    controller.abort(reason);

    await expect(recoverSignerAtHeads({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(t.readChainHeads).not.toHaveBeenCalled();
    expect(anchorMocks.getBlockAnchor).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('stops when cancellation arrives during an anchor lookup', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('Stop');

    anchorMocks.getBlockAnchor.mockReset();
    anchorMocks.getBlockAnchor.mockImplementationOnce(async () => {
      controller.abort(reason);
      return t.anchor;
    });

    await expect(recoverSignerAtHeads({
      ...t.options,
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(anchorMocks.getBlockAnchor).toHaveBeenCalledOnce();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('passes cancellation through to the recovery cycle', async () => {
    const t = setup();
    const controller = new AbortController();

    await recoverSignerAtHeads({
      ...t.options,
      signal: controller.signal,
    });

    expect(t.run).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
      undefined,
    );
  });

  it('does not run recovery after an anchor lookup fails', async () => {
    const t = setup();
    const error = new Error('Anchor lookup failed');

    anchorMocks.getBlockAnchor.mockReset();
    anchorMocks.getBlockAnchor.mockRejectedValueOnce(error);

    await expect(
      recoverSignerAtHeads(t.options),
    ).rejects.toBe(error);

    expect(t.run).not.toHaveBeenCalled();
  });
});