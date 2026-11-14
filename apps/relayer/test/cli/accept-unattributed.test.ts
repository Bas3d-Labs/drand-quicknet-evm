import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  attributeTransaction,
} from '../../src/state/attribute-transaction.js';

import {
  acceptUnattributed,
  type AcceptanceResult,
} from '../../src/state/accept-unattributed.js';

import {
  decodeAcceptanceTicket,
  type AcceptanceTicket,
} from '../../src/state/acceptance-ticket.js';

import {
  renderAcceptanceOutput,
} from '../../src/cli/output/acceptance-output.js';

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
  anchor,
  request,
} from '../helpers/operator-attribution-fixture.js';

import {
  acceptanceRequest,
} from '../helpers/operator-acceptance-fixture.js';

const ACCEPTANCE_EVENT = 'signer_attempt_operator_accepted_unattributed';

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

describe('operator acceptance command service', () => {
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
      maxBlockRange: 2n,
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
    const result = await acceptUnattributed({
      ...options(),
      mode: 'dry-run',
      request: acceptanceRequest(),
    });

    expect(result.status).toBe('preview');

    if (result.status !== 'preview') {
      throw new Error('Missing preview.');
    }

    return result;
  }

  async function apply(ticket: AcceptanceTicket, signal?: AbortSignal) {
    return acceptUnattributed({
      ...options(),
      mode: 'apply',
      ticket,
      ...(signal === undefined ? {} : {
        signal,
      }),
    });
  }

  function configureClient(height = 200n) {
    rpc = client(height);

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
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    snapshot = await fixture();
    lines = [];
    configureClient();

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
      unattributedActivityRemains: false,
      blockers: ['recovery-incomplete'],
    });

    const output = renderAcceptanceOutput(result);

    expect(decodeAcceptanceTicket(JSON.stringify(JSON.parse(output).ticket)))
      .toEqual(result.ticket);
    expect(output).not.toContain('signedTransaction');
    expect(output).not.toContain(before.attempts[0]!.signedTransactions[0].signedTransaction);
    expect(lines).toEqual([]);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('applies once and repeats without RPC, save or event', async () => {
    const result = await preview();

    expect(await apply(result.ticket)).toEqual({
      status: 'committed',
      outcome: result.preview.outcome,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot.attempts).toEqual([]);
    expect(snapshot.ledger.outcomes).toEqual([result.preview.outcome]);

    const events = lines.filter((line) => line.includes(ACCEPTANCE_EVENT));

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

  it('confirms retry without a second evidence pass or event', async () => {
    const result = await preview();

    save.mockRejectedValueOnce(new Error('uncertain'));
    rpc.getBlock.mockClear();

    expect((await apply(result.ticket)).status).toBe('committed');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![0]).toEqual(save.mock.calls[1]![0]);
    expect(rpc.getBlock.mock.calls.filter(([input]) => input?.includeTransactions)).toHaveLength(2);
    expect(lines.filter((line) => line.includes(ACCEPTANCE_EVENT))).toHaveLength(1);
  });

  it('does not report success or emit acceptance when both writes fail', async () => {
    const result = await preview();

    const before = structuredClone(snapshot);

    save.mockRejectedValue(new Error('uncertain'));

    await expect(apply(result.ticket)).rejects.toThrow('Journal persistence did not complete.');
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot).toEqual(before);
    expect(lines.some((line) => line.includes(ACCEPTANCE_EVENT))).toBe(false);
  });

  it.each([
    ['snapshotDigest', 'snapshot-changed'],
    ['proposalDigest', 'proposal-changed'],
    ['operator', 'proposal-changed'],
    ['at', 'proposal-changed'],
    ['requestId', 'proposal-changed'],
    ['attemptId', 'wrong-attempt'],
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

  it('refuses snapshot changes and conflicting request reuse', async () => {
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
    });

    expect(resultForOtherRequest).toEqual({
      status: 'attempt-already-accounted',
      requestedRequestId: '33333333-3333-4333-8333-333333333333',
      outcome: result.preview.outcome,
    });
    expect(JSON.parse(renderAcceptanceOutput(resultForOtherRequest))).toMatchObject({
      status: 'attempt-already-accounted',
      requestedRequestId: '33333333-3333-4333-8333-333333333333',
      outcome: {
        requestId: result.ticket.requestId,
        kind: 'operator-accepted-unattributed',
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

    const output = renderAcceptanceOutput({
      ...result,
      journal: snapshot,
    } as AcceptanceResult);

    expect(output).not.toContain(signed);
    expect(() => renderAcceptanceOutput({
      status: 'refused',
      reason: signed,
    } as unknown as AcceptanceResult)).toThrow();
  });

  it('previews ordinary receipts but refuses them at ticketed apply', async () => {
    const result = await preview();

    rpc.getTransactionReceipt.mockResolvedValue({
      transactionHash: snapshot.attempts[0]!.signedTransactions[0].transactionHash,
      blockNumber: 101n,
      blockHash: anchor(101n).blockHash,
      status: 'success',
    } as never);

    const ordinary = await acceptUnattributed({
      ...options(),
      mode: 'dry-run',
      request: acceptanceRequest(),
    });

    expect(ordinary.status).toBe('ordinary-resolution-available');
    expect(renderAcceptanceOutput(ordinary)).not.toContain('ticket');

    const before = journalJson(snapshot);

    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'proposal-changed',
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(journalJson(snapshot)).toBe(before);
    expect(lines.filter((line) => line.includes(ACCEPTANCE_EVENT))).toEqual([]);
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

  it.each(['dry-run', 'apply'] as const)('refuses wrong chain in %s before heads', async (mode) => {
    const result = await preview();

    vi.mocked(rpc.publicClient.getChainId).mockResolvedValue(IDENTITY.chainId + 1);
    rpc.getBlock.mockClear();

    let actual: AcceptanceResult;

    if (mode === 'apply') {
      actual = await apply(result.ticket);
    } else {
      actual = await acceptUnattributed({
        ...options(),
        mode,
        request: acceptanceRequest(),
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

  it('rejects a changed journal before opening the writer', async () => {
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

    await expect(apply(result.ticket)).rejects.toThrow('Operator acceptance journal changed.');
    expect(FileTransactionJournalStore.read).toHaveBeenCalledTimes(2);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(snapshot.ledger.outcomes).toEqual([]);
    expect(lines.some((line) => line.includes(ACCEPTANCE_EVENT))).toBe(false);
  });

  it.each(['dry-run', 'apply'] as const)('cancels before %s reads state or RPC', async (mode) => {
    const result = await preview();

    const controller = new AbortController();

    controller.abort();
    rpc.getBlock.mockClear();
    vi.mocked(FileTransactionJournalStore.read).mockClear();

    let operation: Promise<AcceptanceResult>;

    if (mode === 'apply') {
      operation = apply(result.ticket, controller.signal);
    } else {
      operation = acceptUnattributed({
        ...options(), mode, request: acceptanceRequest(), signal: controller.signal,
      });
    }

    await expect(operation).rejects.toBe(controller.signal.reason);
    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels the final pre-open read without retry', async () => {
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
      expect(lines.filter((line) => line.includes(ACCEPTANCE_EVENT))).toHaveLength(1);
    },
  );

  it('preserves write failure over cancellation', async () => {
    const result = await preview();

    const controller = new AbortController();

    save.mockImplementation(async () => {
      controller.abort();
      throw new Error('Save durability uncertain.');
    });

    await expect(apply(result.ticket, controller.signal))
      .rejects.toThrow('Journal persistence did not complete.');
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot.ledger.outcomes).toEqual([]);
    expect(lines.some((line) => line.includes(ACCEPTANCE_EVENT))).toBe(false);
  });

  it('refuses a lower-bound repair in place of the ticketed acceptance', async () => {
    const result = await preview();

    const before = structuredClone(snapshot);

    const original = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      const block = await original(input);

      if (input?.blockNumber === 98n || input?.blockNumber === 100n) {
        return {
          ...block,
          hash: anchor(input.blockNumber + 1000n).blockHash,
        } as never;
      }

      return block;
    });
    rpc.getTransactionCount.mockImplementation(async (input) => {
      if (input.blockNumber === 104n) {
        return 5;
      }

      return 4;
    });

    const inspection = await inspectSignerRecovery({
      snapshot,
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptanceAttemptId: result.ticket.attemptId,
    });

    expect(inspection.status).toBe('search-lower-bound-replacement-required');
    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'proposal-changed',
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
    expect(lines.join('')).not.toContain('signer_attempt_operator_accepted_unattributed');
  });

  it('refuses a newly found replacement instead of accepting the nonce', async () => {
    const result = await preview();

    configureClient(103n);

    expect(await apply(result.ticket)).toEqual({
      status: 'refused',
      reason: 'proposal-changed',
    });
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(lines.join('')).not.toContain('signer_attempt_operator_accepted_unattributed');
  });

  it('defers a gap larger than the budget without saving progress', async () => {
    const before = structuredClone(snapshot);

    const result = await acceptUnattributed({
      ...options(),
      maxBlockRange: 1n,
      mode: 'dry-run',
      request: acceptanceRequest(),
    });

    expect(result).toEqual({
      status: 'deferred',
      reason: 'search-incomplete',
      gap: {
        boundary: anchor(102n),
        durable: DURABLE,
        blocks: 2n,
        budget: 1n,
      },
    });
    expect(JSON.parse(renderAcceptanceOutput(result)).gap).toMatchObject({
      blocks: '2',
      budget: '1',
    });
    expect(result).not.toHaveProperty('ticket');
    expect(snapshot).toEqual(before);
    expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('warns that independently latched activity will still block submissions', async () => {
    snapshot = {
      ...snapshot,
      lastObservation: {
        anchor: DURABLE,
        nonce: 9n,
      },
    };

    const result = await preview();

    expect(result.preview.unattributedActivityRemains).toBe(true);
    expect(result.preview.lastObservation.nonce).toBe(9n);
    expect(result.preview.blockers).toContain('unattributed-signer-activity');

    const output = JSON.parse(renderAcceptanceOutput({
      ...result,
      preview: {
        ...result.preview,
        unattributedActivityRemains: false,
      },
    }));

    expect(output.preview.unattributedActivityRemains).toBe(true);
    expect(output.preview.message).toContain('will not unblock submissions');
  });

  it('rechecks the ticket D rather than replacing it with the newer durable head', async () => {
    const result = await preview();

    const original = rpc.getBlock.getMockImplementation()!;

    rpc.getBlock.mockImplementation(async (input) => {
      if (input?.blockTag === 'safe') {
        return {
          number: 106n,
        } as never;
      }

      return original(input);
    });
    rpc.getBlock.mockClear();

    expect((await apply(result.ticket)).status).toBe('committed');
    expect(snapshot.ledger.outcomes[0]!.durable.anchor).toEqual(DURABLE);
    expect(rpc.getBlock.mock.calls.some(([input]) =>
      input?.blockNumber !== undefined && input.blockNumber > 104n
    )).toBe(false);
  });

  it('rejects the other command ticket in both directions before state or RPC', async () => {
    const accepted = await preview();

    configureClient(103n);

    const attributed = await attributeTransaction({
      ...options(),
      mode: 'dry-run',
      request: request(103n),
    });

    if (attributed.status !== 'preview') {
      throw new Error('Expected attribution preview.');
    }

    vi.mocked(FileTransactionJournalStore.read).mockClear();
    rpc.getBlock.mockClear();
    rpc.getTransactionReceipt.mockClear();
    rpc.getTransactionCount.mockClear();

    await expect(apply(attributed.ticket as never))
      .rejects.toThrow('Invalid operator acceptance ticket.');
    await expect(attributeTransaction({
      ...options(),
      mode: 'apply',
      ticket: accepted.ticket as never,
    })).rejects.toThrow('Invalid operator attribution ticket.');
    expect(FileTransactionJournalStore.read).not.toHaveBeenCalled();
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
    expect(rpc.getTransactionCount).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['acceptance', 'attribution'] as const)(
    'reports a previous %s disposition to either command without applying its ticket',
    async (first) => {
      const accepted = await preview();

      configureClient(103n);

      const attributed = await attributeTransaction({
        ...options(),
        mode: 'dry-run',
        request: request(103n),
      });

      if (attributed.status !== 'preview') {
        throw new Error('Expected attribution preview.');
      }

      let recorded;

      if (first === 'acceptance') {
        configureClient();
        await apply(accepted.ticket);
        recorded = accepted.preview.outcome;
      } else {
        await attributeTransaction({
          ...options(),
          mode: 'apply',
          ticket: attributed.ticket,
        });
        recorded = attributed.preview.outcome;
      }

      rpc.getBlock.mockClear();
      save.mockClear();
      vi.mocked(FileTransactionJournalStore.open).mockClear();
      lines.length = 0;

      let conflicting;

      if (first === 'acceptance') {
        conflicting = await attributeTransaction({
          ...options(),
          mode: 'apply',
          ticket: attributed.ticket,
        });
      } else {
        conflicting = await apply(accepted.ticket);
      }

      expect(conflicting).toEqual({
        status: 'refused',
        reason: 'request-conflict',
      });

      const requestedRequestId = '33333333-3333-4333-8333-333333333333';

      const results = [
        await apply({
          ...accepted.ticket,
          requestId: requestedRequestId,
        }),
        await attributeTransaction({
          ...options(),
          mode: 'apply',
          ticket: {
            ...attributed.ticket,
            requestId: requestedRequestId,
          },
        }),
      ];

      for (const result of results) {
        expect(result).toEqual({
          status: 'attempt-already-accounted',
          requestedRequestId,
          outcome: recorded,
        });
      }

      expect(rpc.getBlock).not.toHaveBeenCalled();
      expect(FileTransactionJournalStore.open).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    },
  );
});
