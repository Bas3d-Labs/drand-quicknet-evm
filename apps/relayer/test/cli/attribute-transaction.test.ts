import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  attributeTransaction,
  type AttributionResult,
} from '../../src/state/attribute-transaction.js';

import {
  decodeAttributionTicket,
  type AttributionTicket,
} from '../../src/state/attribution-ticket.js';

import {
  renderAttributionOutput,
} from '../../src/cli/output/attribution-output.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  FileTransactionJournalStore,
} from '../../src/state/file-transaction-journal-store.js';

import {
  journalJson,
} from '../../src/state/journal-ledger-validation.js';

import {
  assertServiceLockHeld,
  ServiceLockNotHeldError,
} from '../../src/state/service-lock.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  DURABLE,
  IDENTITY,
  OTHER_HASH,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

vi.mock('../../src/state/file-transaction-journal-store.js', () => ({
  FileTransactionJournalStore: {
    read: vi.fn(),
    open: vi.fn(),
  },
}));

vi.mock('../../src/state/service-lock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/service-lock.js')>(),
  assertServiceLockHeld: vi.fn(),
}));

const OWNERSHIP = {
  stateDirectory: '/verified-state',
  dev: 1n,
  ino: 2n,
};

describe('operator attribution command service', () => {
  let snapshot: TransactionJournalSnapshot;

  let rpc: ReturnType<typeof client>;

  let lines: string[];

  const save = vi.fn(async (next: TransactionJournalSnapshot) => {
    snapshot = next;
  });

  const createErrorSummary = () => ({
    scrubText: createScrubber({
      rpcUrls: [],
    }),
  });

  function options() {
    return {
      publicClient: rpc.publicClient,
      identity: IDENTITY,
      finality: {
        type: 'safe' as const,
      },
      env: {
        QUICKNET_STATE_DIR: '/verified-state',
      },
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write(line: string) {
            lines.push(line);
          },
        },
      }),
    };
  }

  async function preview() {
    const result = await attributeTransaction({
      ...options(),
      mode: 'dry-run',
      request: request(),
    });

    expect(result.status).toBe('preview');

    if (result.status !== 'preview') {
      throw new Error('Missing preview.');
    }

    return result;
  }

  async function apply(ticket: AttributionTicket, signal?: AbortSignal) {
    return attributeTransaction({
      ...options(),
      mode: 'apply',
      ticket,
      ...(signal === undefined ? {} : {
        signal,
      }),
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    snapshot = await fixture();
    rpc = client();
    lines = [];

    const originalBlock = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      if (input?.blockTag === 'safe') {
        return {
          number: DURABLE.blockNumber,
        } as never;
      }

      return originalBlock(input);
    });

    Object.assign(rpc.publicClient, {
      getChainId: vi.fn().mockResolvedValue(IDENTITY.chainId),
      getBlockNumber: vi.fn().mockResolvedValue(106n),
    });

    save.mockImplementation(async (next) => {
      snapshot = next;
    });

    vi.mocked(assertServiceLockHeld).mockReturnValue(OWNERSHIP);
    vi.mocked(FileTransactionJournalStore.read).mockImplementation(async () => ({
      kind: 'present',
      snapshot,
    }));

    vi.mocked(FileTransactionJournalStore.open).mockResolvedValue({
      load: async () => ({
        kind: 'present',
        snapshot,
      }),
      save,
    } as unknown as FileTransactionJournalStore);
  });

  it('previews without a lock, write, mutation, journal output or signed bytes', async () => {
    const before = structuredClone(snapshot);

    const result = await preview();

    expect(assertServiceLockHeld).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
    expect(result.preview).toMatchObject({
      previousDurableNextNonce: 4n,
      durableNextNonce: 5n,
      supersededNoMatch: true,
      blockers: ['recovery-incomplete'],
    });

    const output = renderAttributionOutput(result);

    expect(decodeAttributionTicket(JSON.stringify(JSON.parse(output).ticket))).toEqual(result.ticket);
    expect(output).not.toContain('signedTransaction');
    expect(output).not.toContain(before.attempts[0]!.signedTransactions[0].signedTransaction);
    expect(lines).toEqual([]);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('applies fresh evidence, confirms the row, and repeats without RPC, save or event', async () => {
    const result = await preview();

    expect(await apply(result.ticket)).toEqual({
      status: 'committed',
      outcome: result.preview.outcome,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot.attempts).toEqual([]);
    expect(snapshot.ledger.outcomes).toEqual([result.preview.outcome]);

    const events = lines.filter((line) => line.includes('signer_attempt_operator_attributed'));

    expect(events).toHaveLength(1);

    rpc.getBlock.mockClear();
    save.mockClear();
    vi.mocked(FileTransactionJournalStore.open).mockClear();
    lines.length = 0;

    expect(await apply(result.ticket)).toEqual({
      status: 'already-recorded',
      outcome: result.preview.outcome,
    });

    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('confirms the acknowledged row after retry, without a second evidence pass or event', async () => {
    const result = await preview();

    save.mockRejectedValueOnce(new Error('uncertain'));
    rpc.getBlock.mockClear();

    expect((await apply(result.ticket)).status).toBe('committed');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![0]).toEqual(save.mock.calls[1]![0]);
    expect(rpc.getBlock.mock.calls.filter(([input]) => input?.includeTransactions)).toHaveLength(1);
    expect(lines.filter((line) => line.includes('signer_attempt_operator_attributed'))).toHaveLength(1);
  });

  it('does not report success or emit attribution when both writes fail', async () => {
    const result = await preview();

    const before = structuredClone(snapshot);

    save.mockRejectedValue(new Error('uncertain'));

    await expect(apply(result.ticket)).rejects.toThrow('Journal persistence did not complete.');
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot).toEqual(before);
    expect(lines.some((line) => line.includes('signer_attempt_operator_attributed'))).toBe(false);
  });

  it.each([
    ['snapshotDigest', 'snapshot-changed'],
    ['proposalDigest', 'proposal-changed'],
    ['operator', 'proposal-changed'],
    ['at', 'proposal-changed'],
    ['requestId', 'proposal-changed'],
    ['attemptId', 'wrong-attempt'],
    ['hintHash', 'invalid-match'],
    ['inclusion-height', 'invalid-match'],
    ['inclusion-hash', 'proposal-changed'],
    ['durable-height', 'ticket-anchor-not-durable'],
    ['durable-hash', 'anchor-changed'],
    ['durable-nonce', 'proposal-changed'],
    ['chain', 'configuration-mismatch'],
    ['signer', 'configuration-mismatch'],
    ['signer-case', 'configuration-mismatch'],
    ['finality', 'configuration-mismatch'],
  ])('refuses tampered %s with %s before opening a writable store', async (field, reason) => {
    const result = await preview();

    const ticket = structuredClone(result.ticket) as any;

    switch (field) {
      case 'snapshotDigest':
      case 'proposalDigest':
      case 'hintHash':
        ticket[field] = OTHER_HASH;
        break;
      case 'operator':
        ticket.operator = 'another operator';
        break;
      case 'at':
        ticket.at = '2026-11-12T00:00:01.000Z';
        break;
      case 'requestId':
      case 'attemptId':
        ticket[field] = '33333333-3333-4333-8333-333333333333';
        break;
      case 'inclusion-height':
        ticket.inclusion.blockNumber = 100n;
        break;
      case 'inclusion-hash':
        ticket.inclusion.blockHash = OTHER_HASH;
        break;
      case 'durable-height':
        ticket.durable.anchor.blockNumber = 105n;
        break;
      case 'durable-hash':
        ticket.durable.anchor.blockHash = OTHER_HASH;
        break;
      case 'durable-nonce':
        ticket.durable.nonce = 6n;
        break;
      case 'chain':
        ticket.identity.chainId++;
        break;
      case 'signer':
        ticket.identity.signer = `0x${'22'.repeat(20)}`;
        break;
      case 'signer-case':
        ticket.identity.signer = ticket.identity.signer.toLowerCase();
        expect(ticket.identity.signer).not.toBe(result.ticket.identity.signer);
        break;
      case 'finality':
        ticket.finality = {
          type: 'finalized',
        };
        break;
    }

    expect(await apply(ticket)).toEqual({
      status: 'refused',
      reason,
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a changed snapshot before RPC and a reused request with changed metadata', async () => {
    const result = await preview();

    const before = snapshot;

    snapshot = {
      ...snapshot,
      lastObservation: {
        ...snapshot.lastObservation,
        nonce: 6n,
      },
    };
    rpc.getBlock.mockClear();

    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'snapshot-changed',
    });
    expect(rpc.getBlock).not.toHaveBeenCalled();

    snapshot = before;
    await apply(result.ticket);

    expect(await apply({
      ...result.ticket,
      operator: 'changed',
    })).toEqual({
      status: 'refused',
      reason: 'request-conflict',
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports the disposition for a new request naming the disposed attempt', async () => {
    const result = await preview();

    await apply(result.ticket);

    rpc.getBlock.mockClear();
    lines.length = 0;
    vi.mocked(FileTransactionJournalStore.open).mockClear();

    const resultForOtherRequest = await apply({
      ...result.ticket,
      requestId: '33333333-3333-4333-8333-333333333333',
      hintHash: OTHER_HASH,
    });

    expect(resultForOtherRequest).toEqual({
      status: 'attempt-already-attributed',
      requestedRequestId: '33333333-3333-4333-8333-333333333333',
      outcome: result.preview.outcome,
    });
    expect(JSON.parse(renderAttributionOutput(resultForOtherRequest))).toMatchObject({
      status: 'attempt-already-attributed',
      requestedRequestId: '33333333-3333-4333-8333-333333333333',
      outcome: {
        requestId: result.ticket.requestId,
        replacement: {
          transactionHash: result.ticket.hintHash,
        },
      },
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('refuses apply without ownership before journal inspection or RPC', async () => {
    const result = await preview();

    vi.mocked(assertServiceLockHeld).mockImplementation(() => {
      throw new ServiceLockNotHeldError('descriptor');
    });

    vi.mocked(FileTransactionJournalStore.read).mockClear();
    rpc.getBlock.mockClear();

    await expect(apply(result.ticket)).rejects.toThrow('Required relayer service lock');
    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('projects away unexpected output fields and refuses unbounded refusal text', async () => {
    const result = await preview();

    const signed = snapshot.attempts[0]!.signedTransactions[0].signedTransaction;

    const output = renderAttributionOutput({
      ...result,
      journal: snapshot,
    } as AttributionResult);

    expect(output).not.toContain(signed);
    expect(() => renderAttributionOutput({
      status: 'refused',
      reason: signed,
    } as unknown as AttributionResult)).toThrow();
  });

  it('returns ordinary receipt evidence in dry-run and refuses a changed disposition at ticketed apply', async () => {
    const result = await preview();

    rpc.getTransactionReceipt.mockResolvedValue({
      transactionHash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
      blockNumber: 101n,
      blockHash: result.ticket.inclusion.blockHash,
      status: 'success',
    } as never);

    const ordinary = await attributeTransaction({
      ...options(),
      mode: 'dry-run',
      request: request(),
    });

    expect(ordinary.status).toBe('ordinary-resolution-available');
    expect(renderAttributionOutput(ordinary)).not.toContain('ticket');
    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'proposal-changed',
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a moved closing D after positive full-block evidence', async () => {
    const result = await preview();

    const original = rpc.getBlock.getMockImplementation()!;

    let fullRead = false;

    rpc.getBlock.mockImplementation(async (input) => {
      const block = await original(input);

      if (input?.includeTransactions) {
        fullRead = true;
      } else if (fullRead && input?.blockNumber === DURABLE.blockNumber) {
        return {
          ...block,
          hash: OTHER_HASH,
        } as never;
      }

      return block;
    });

    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'anchor-changed',
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rechecks lock identity before opening the writer', async () => {
    const result = await preview();

    vi.mocked(assertServiceLockHeld)
      .mockReturnValueOnce(OWNERSHIP)
      .mockReturnValue({
        ...OWNERSHIP,
        ino: 3n,
      });

    await expect(apply(result.ticket)).rejects.toThrow('Required relayer service lock');
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['dry-run', 'apply'] as const)('refuses an RPC chain mismatch in %s before head reads', async (mode) => {
    const result = await preview();

    vi.mocked(rpc.publicClient.getChainId).mockResolvedValue(IDENTITY.chainId + 1);
    rpc.getBlock.mockClear();

    let actual: AttributionResult;

    if (mode === 'apply') {
      actual = await apply(result.ticket);
    } else {
      actual = await attributeTransaction({
        ...options(),
        mode,
        request: request(),
      });
    }

    expect(actual).toEqual({
      status: 'refused',
      reason: 'chain-mismatch',
    });
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses an unchanged ticket when the selected durable height falls below its D', async () => {
    const result = await preview();

    const original = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      if (input?.blockTag === 'safe') {
        return {
          number: 103n,
        } as never;
      }

      return original(input);
    });
    rpc.getBlock.mockClear();

    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'ticket-anchor-not-durable',
    });
    expect(rpc.getBlock.mock.calls).toEqual([[{
      blockTag: 'safe',
    }]]);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects journal changes on the final pre-open read without opening or retrying a writer', async () => {
    const result = await preview();

    const changed = {
      ...snapshot,
      lastObservation: {
        ...snapshot.lastObservation,
        nonce: 6n,
      },
    };

    vi.mocked(FileTransactionJournalStore.read).mockClear();
    vi.mocked(FileTransactionJournalStore.read)
      .mockResolvedValueOnce({
        kind: 'present',
        snapshot,
      })
      .mockResolvedValue({
        kind: 'present',
        snapshot: changed,
      });

    await expect(apply(result.ticket)).rejects.toThrow('Operator attribution journal changed.');
    expect(FileTransactionJournalStore.read).toHaveBeenCalledTimes(2);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(snapshot.ledger.outcomes).toEqual([]);
    expect(lines.some((line) => line.includes('signer_attempt_operator_attributed'))).toBe(false);
  });

  it.each(['dry-run', 'apply'] as const)('honors cancellation before %s reads state or RPC', async (mode) => {
    const result = await preview();

    const controller = new AbortController();

    controller.abort();
    rpc.getBlock.mockClear();
    vi.mocked(FileTransactionJournalStore.read).mockClear();

    let operation: Promise<AttributionResult>;

    if (mode === 'apply') {
      operation = apply(result.ticket, controller.signal);
    } else {
      operation = attributeTransaction({
        ...options(), mode, request: request(), signal: controller.signal,
      });
    }

    await expect(operation).rejects.toBe(controller.signal.reason);
    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves cancellation during the final pre-open read, without persistence retry', async () => {
    const result = await preview();

    const controller = new AbortController();

    vi.mocked(FileTransactionJournalStore.read).mockClear();
    vi.mocked(FileTransactionJournalStore.read)
      .mockResolvedValueOnce({
        kind: 'present',
        snapshot,
      })
      .mockImplementation(async () => {
        controller.abort();
        return {
          kind: 'present',
          snapshot,
        };
      });

    const error = await apply(result.ticket, controller.signal).catch((failure) => failure);

    expect(controller.signal.aborted).toBe(true);
    expect(error).toBe(controller.signal.reason);
    expect(FileTransactionJournalStore.read).toHaveBeenCalledTimes(2);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['opening', 'save', 'retry', 'failed-opening'] as const)(
    'preserves commitment when cancelled during %s', async (boundary) => {
      const result = await preview();

      const controller = new AbortController();

      const originalOpen = vi.mocked(FileTransactionJournalStore.open).getMockImplementation()!;

      if (boundary === 'opening' || boundary === 'failed-opening') {
        vi.mocked(FileTransactionJournalStore.open).mockImplementationOnce(async (input) => {
          controller.abort();

          if (boundary === 'failed-opening') {
            throw new Error('Opening durability failed.');
          }

          return originalOpen(input);
        });
      } else {
        save.mockImplementationOnce(async (next) => {
          controller.abort();

          if (boundary === 'retry') {
            throw new Error('Save durability uncertain.');
          }

          snapshot = next;
        });
      }

      expect(await apply(result.ticket, controller.signal)).toEqual({
        status: 'committed', outcome: result.preview.outcome,
      });
      expect(controller.signal.aborted).toBe(true);
      expect(snapshot.ledger.outcomes).toEqual([result.preview.outcome]);
      expect(save).toHaveBeenCalledTimes(boundary === 'retry' ? 2 : 1);
      expect(lines.filter((line) => line.includes('signer_attempt_operator_attributed'))).toHaveLength(1);
    },
  );

  it('preserves a persistence failure over cancellation after both save attempts fail', async () => {
    const result = await preview();

    const controller = new AbortController();

    save.mockImplementation(async () => {
      controller.abort();
      throw new Error('Save durability uncertain.');
    });

    await expect(apply(result.ticket, controller.signal)).rejects.toThrow('Journal persistence did not complete.');
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot.ledger.outcomes).toEqual([]);
    expect(lines.some((line) => line.includes('signer_attempt_operator_attributed'))).toBe(false);
  });
});
