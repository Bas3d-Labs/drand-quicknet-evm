import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  keccak256,
} from 'viem';

import * as recoveryPlanner from '../../src/state/plan-signer-recovery.js';

import {
  inspectSignerRecovery,
} from '../../src/chain/inspect-signer-recovery.js';

import {
  createRelayerLog,
} from '../../src/diagnostics/relayer-log.js';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

import {
  planSignerRecovery,
} from '../../src/state/plan-signer-recovery.js';

import {
  SignerCoordinator,
} from '../../src/state/signer-coordinator.js';

import {
  decodeJournalSnapshot,
  encodeJournalSnapshot,
} from '../../src/state/transaction-journal-serialization.js';

import {
  MAX_UINT256,
} from '../../src/shared/uint.js';

import {
  maximumOutcome,
} from '../helpers/operator-outcome-fixture.js';

import {
  validateAcceptanceRequest,
} from '../../src/state/operator-acceptance.js';

import {
  readAcceptedOutcome,
  journalJson,
} from '../../src/state/journal-ledger-validation.js';

import {
  durableRecoveryRevision,
} from '../../src/state/durable-recovery-revision.js';

import type {
  TransactionJournalSnapshot,
} from '../../src/state/transaction-journal.js';

import {
  ACCOUNT,
  ATTEMPT_ID,
  DURABLE,
  IDENTITY,
  anchor,
  client,
  fixture,
  request,
} from '../helpers/operator-attribution-fixture.js';

function acceptance() {
  const { hint: _hint, ...metadata } = request();

  return {
    ...metadata,
    attemptId: ATTEMPT_ID,
  };
}

async function prepare(fact = 100n, cursor = 102n, budget = 2n) {
  const snapshot = await fixture(fact, cursor);

  const rpc = client(200n);

  const inspection = await inspectSignerRecovery({
    publicClient: rpc.publicClient,
    snapshot,
    anchor: DURABLE,
    maxBlockRange: budget,
    acceptanceAttemptId: ATTEMPT_ID,
  });

  const plan = planSignerRecovery({
    identity: IDENTITY,
    snapshot,
    inspection,
    acceptance: acceptance(),
    unattributedActivity: false,
  });

  return {
    snapshot,
    rpc,
    inspection,
    plan,
  };
}

async function coordinatorFor(snapshot: TransactionJournalSnapshot | null) {
  const save = vi.fn(async (next: TransactionJournalSnapshot) => {
    await decodeJournalSnapshot(await encodeJournalSnapshot(next, IDENTITY), IDENTITY);
  });

  const lines: string[] = [];

  const createErrorSummary = () => ({
    scrubText: createScrubber({
      rpcUrls: [],
      secrets: [],
    }),
  });

  const coordinator = await SignerCoordinator.create({
    identity: IDENTITY,
    maxRetainedAttempts: 16,
    createErrorSummary,
    log: createRelayerLog({
      chainId: IDENTITY.chainId,
      errorSummary: createErrorSummary(),
      destination: {
        write: (line) => {
          lines.push(line);
        },
      },
    }),
    store: {
      load: async () => {
        if (snapshot === null) {
          return {
            kind: 'missing',
          };
        }

        return {
          kind: 'present',
          snapshot,
        };
      },
      save,
    },
  });

  return {
    coordinator,
    save,
    lines,
  };
}

describe('operator acceptance evidence and persistence', () => {
  it.each([
    {
      fact: 104n,
      cursor: 104n,
      budget: 1n,
      reads: [
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '98:false',
        '104:false',
      ],
    },
    {
      fact: 100n,
      cursor: 102n,
      budget: 2n,
      reads: [
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '98:false',
        '102:false',
        '100:false',
        '103:true',
        '104:true',
        '104:false',
      ],
    },
  ])('pins reads and leaves ordinary recovery unchanged at fact $fact', async (row) => {
    const { snapshot, rpc, inspection, plan } = await prepare(row.fact, row.cursor, row.budget);

    expect(inspection.status).toBe('operator-acceptance-available');
    expect(plan.kind).toBe('persist');
    expect(rpc.calls.filter((value) => value.includes(':'))).toEqual(row.reads);

    const ordinary = client(200n);

    const result = await inspectSignerRecovery({
      publicClient: ordinary.publicClient,
      snapshot,
      anchor: DURABLE,
      maxBlockRange: row.budget,
    });

    expect(result.status).toBe('unresolved');

    if (row.fact === 104n) {
      expect(ordinary.calls.filter((value) => value.includes(':'))).toEqual([
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '104:false',
        '98:false',
        '104:false',
        '104:false',
      ]);
    } else {
      expect(ordinary.calls).toEqual(rpc.calls);
    }

    expect(snapshot.ledger.outcomes).toEqual([]);
  });

  it('defers an unfinished gap without writing search progress', async () => {
    const { inspection, plan } = await prepare(100n, 102n, 1n);

    expect(inspection).toEqual({
      status: 'operator-acceptance-refused',
      observation: {
        anchor: DURABLE,
        nonce: 5n,
      },
      reason: 'search-incomplete',
      gap: {
        boundary: anchor(102n),
        durable: DURABLE,
        blocks: 2n,
        budget: 1n,
      },
    });
    expect(plan).toEqual({
      kind: 'unchanged',
      reason: 'inspection-not-committable',
    });
  });

  it('round-trips an acceptance without redundant fields or a fulfillment claim', async () => {
    const { snapshot, plan } = await prepare();

    if (plan.kind !== 'persist' || plan.completion.kind !== 'operator-acceptance') {
      throw new Error('Expected acceptance.');
    }

    expect(plan.snapshot.attempts).toEqual([]);
    expect(plan.snapshot.durableNextNonce).toBe(5n);
    expect(plan.snapshot.nextNonce).toBe(snapshot.nextNonce);
    expect(plan.snapshot.baseline).toEqual(snapshot.baseline);
    expect(plan.snapshot.repairs).toEqual(snapshot.repairs);
    expect(plan.snapshot.ledger.obligations).toEqual([]);
    expect(Object.keys(plan.completion.outcome)).toEqual([
      'kind',
      'requestId',
      'snapshotDigest',
      'proposalDigest',
      'operator',
      'at',
      'attemptId',
      'workId',
      'nonce',
      'candidateHashes',
      'durable',
      'finality',
      'lowerBound',
      'priorSearch',
    ]);

    const encoded = await encodeJournalSnapshot(plan.snapshot, IDENTITY);

    expect(await decodeJournalSnapshot(encoded, IDENTITY)).toEqual(plan.snapshot);

    const noHistory = {
      ...plan.snapshot,
      ledger: {
        outcomes: [],
        obligations: [] as const,
      },
    };

    expect(durableRecoveryRevision({
      kind: 'present',
      snapshot: plan.snapshot,
    }, new Set()))
      .toBe(durableRecoveryRevision({
        kind: 'present',
        snapshot: noHistory,
      }, new Set()));
    expect(durableRecoveryRevision({
      kind: 'present',
      snapshot,
    }, new Set()))
      .not.toBe(durableRecoveryRevision({
        kind: 'present',
        snapshot: plan.snapshot,
      }, new Set()));
  });

  it.each(['replacement', 'exhausted', 'fulfilled', 'supersededNoMatch'])(
    'rejects extra %s on encode and decode', async (key) => {
      const { plan } = await prepare();

      if (plan.kind !== 'persist') {
        throw new Error('Expected acceptance.');
      }

      const malformed = structuredClone(plan.snapshot);

      Object.assign(malformed.ledger.outcomes[0]!, {
        [key]: null,
      });

      await expect(encodeJournalSnapshot(malformed, IDENTITY)).rejects.toThrow();

      const raw = JSON.parse(await encodeJournalSnapshot(plan.snapshot, IDENTITY));

      raw.ledger.outcomes[0][key] = null;

      await expect(decodeJournalSnapshot(JSON.stringify(raw), IDENTITY)).rejects.toThrow();
    },
  );

  it.each(['lower', 'fact', 'cursor', 'nonce', 'metadata'] as const)(
    'refuses evidence against a changed %s snapshot', async (fault) => {
      const { snapshot, inspection } = await prepare();

      const changed = structuredClone(snapshot);

      const search = changed.attempts[0]!.replacementSearch!;

      if (fault === 'lower') {
        Object.assign(search, {
          lowerBound: {
            anchor: anchor(97n),
            nonce: 4n,
          },
        });
      } else if (fault === 'fact') {
        Object.assign(search, {
          exhausted: {
            anchor: anchor(101n),
            nonce: 5n,
          },
        });
      } else if (fault === 'cursor') {
        Object.assign(search, {
          searchedThrough: anchor(103n),
        });
      } else if (fault === 'nonce') {
        Object.assign(changed, {
          lastObservation: {
            anchor: DURABLE,
            nonce: 6n,
          },
        });
      } else {
        Object.assign(changed.attempts[0]!, {
          createdAt: '2026-11-13T00:00:00.000Z',
        });
      }

      expect(planSignerRecovery({
        identity: IDENTITY,
        snapshot: changed,
        inspection,
        acceptance: acceptance(),
        unattributedActivity: false,
      })).toEqual({ kind: 'unchanged', reason: 'inspection-not-committable' });
    },
  );

  it.each([false, true])('closes and emits once after ack (retry=%s)', async (retry) => {
    let stored: TransactionJournalSnapshot = await fixture();

    stored = {
      ...stored,
      lastObservation: {
        anchor: DURABLE,
        nonce: 9n,
      },
    };

    const lines: string[] = [];

    const createErrorSummary = () => ({
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [],
      }),
    });

    const save = vi.fn(async (next: TransactionJournalSnapshot) => {
      if (retry && save.mock.calls.length === 1) {
        throw new Error('uncertain save');
      }

      stored = await decodeJournalSnapshot(await encodeJournalSnapshot(next, IDENTITY), IDENTITY);
    });

    const create = () => SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write: (line) => {
            lines.push(line);
          },
        },
      }),
      store: {
        load: async () => ({
          kind: 'present',
          snapshot: stored,
        }),
        save,
      },
    });

    const coordinator = await create();

    const rpc = client(200n);

    const operation = coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptance: acceptance(),
    }, 21);

    if (retry) {
      await expect(operation).rejects.toThrow('Journal persistence did not complete.');
      expect(stored.attempts).toHaveLength(1);
      expect(lines.join('')).not.toContain('signer_attempt_operator_accepted_unattributed');
      await coordinator.retryPersistence(22);
    } else {
      expect((await operation).status).toBe('operator-acceptance-committed');
    }

    expect(stored.lastObservation.nonce).toBe(9n);
    expect(coordinator.status.recoveryComplete).toBe(false);
    expect(coordinator.status.open).toBe(false);
    expect(coordinator.status.blockers).toContain('unattributed-signer-activity');
    expect((await create()).status.blockers).toContain('unattributed-signer-activity');
    expect(coordinator.operatorOutcome(acceptance().requestId)?.kind)
      .toBe('operator-accepted-unattributed');
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();

    const events = lines.map((line) => JSON.parse(line))
      .filter((event) => event.event === 'signer_attempt_operator_accepted_unattributed');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 40,
      cycle: retry ? 22 : 21,
    });
    expect(lines.join('')).not.toContain('signedTransaction');
    expect(lines.join('')).not.toContain('0x02f8');
    expect(readAcceptedOutcome(stored.ledger.outcomes[0]).durable.nonce).toBe(5n);
  });

  it('closes the owned inspection before another recovery or latest pass', async () => {
    const snapshot = await fixture();

    const createErrorSummary = () => ({
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [],
      }),
    });

    const save = vi.fn();

    const coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write: () => {},
        },
      }),
      store: {
        load: async () => ({
          kind: 'present',
          snapshot,
        }),
        save,
      },
    });

    const rpc = client(200n);

    const owner = coordinator.beginInspection({
      publicClient: rpc.publicClient,
      head: DURABLE,
      durableAnchor: DURABLE,
    });

    const options = {
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptance: acceptance(),
    };

    try {
      expect((await owner.recover(options)).status).toBe('operator-acceptance-committed');
      rpc.getBlock.mockClear();
      rpc.getTransactionCount.mockClear();
      rpc.getTransactionReceipt.mockClear();

      await expect(owner.recover(options)).rejects.toThrow();
      await expect(owner.checkInclusions({
        publicClient: rpc.publicClient,
        head: DURABLE,
      }))
        .rejects.toThrow();
      expect(() => owner.finish()).toThrow('has not completed successfully');
      expect(rpc.getBlock).not.toHaveBeenCalled();
      expect(rpc.getTransactionCount).not.toHaveBeenCalled();
      expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledOnce();
      expect(coordinator.canBroadcast).toBe(false);
    } finally {
      await owner.abandon();
    }
  });

  it.each([false, true])('bounds the largest acceptance row (escaped=%s)', (escaped) => {
    const { replacement: _replacement, ...common } = maximumOutcome(0, MAX_UINT256 - 1n, escaped);

    const outcome = readAcceptedOutcome({
      ...common,
      kind: 'operator-accepted-unattributed',
    });

    expect(Buffer.byteLength(journalJson(outcome), 'utf8')).toBeLessThanOrEqual(8_192);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.priorSearch)).toBe(true);
    expect(Object.isFrozen(outcome.candidateHashes)).toBe(true);
  });

  it.each([
    'operator',
    'at',
    'requestId',
    'attemptId',
    'finality',
  ] as const)(
    'rejects malformed %s metadata with a fixed error',
    (key) => {
      const malformed = {
        ...acceptance(),
        [key]: null,
      };

      expect(() => validateAcceptanceRequest(malformed as never))
        .toThrow('Invalid operator acceptance request.');
    },
  );

  it.each([
    'requestId',
    'attemptId',
    'nonce',
  ] as const)(
    'rejects a duplicate %s across both outcome kinds',
    async (key) => {
      const { plan } = await prepare();

      if (plan.kind !== 'persist') {
        throw new Error('Expected acceptance.');
      }

      const accepted = plan.snapshot.ledger.outcomes[0]!;

      const attributed = maximumOutcome(1, 3n);

      Object.assign(attributed, {
        [key]: accepted[key],
      });

      const changed = {
        ...plan.snapshot,
        baseline: {
          anchor: anchor(0n),
          nonce: 0n,
        },
        ledger: {
          outcomes: [attributed, accepted],
          obligations: [] as const,
        },
      };

      await expect(encodeJournalSnapshot(changed, IDENTITY)).rejects.toThrow();
      await expect(decodeJournalSnapshot(journalJson(changed), IDENTITY)).rejects.toThrow();
    },
  );

  it('rejects invalid request metadata before RPC or persistence', async () => {
    const snapshot = await fixture();

    const save = vi.fn();

    const createErrorSummary = () => ({
      scrubText: createScrubber({
        rpcUrls: [],
        secrets: [],
      }),
    });

    const coordinator = await SignerCoordinator.create({
      identity: IDENTITY,
      maxRetainedAttempts: 16,
      createErrorSummary,
      log: createRelayerLog({
        chainId: IDENTITY.chainId,
        errorSummary: createErrorSummary(),
        destination: {
          write: () => {},
        },
      }),
      store: {
        load: async () => ({
          kind: 'present',
          snapshot,
        }),
        save,
      },
    });

    const rpc = client(200n);

    const owner = coordinator.beginInspection({
      publicClient: rpc.publicClient,
      head: DURABLE,
      durableAnchor: DURABLE,
    });

    try {
      await expect(owner.recover({
        publicClient: rpc.publicClient,
        anchor: DURABLE,
        maxBlockRange: 2n,
        acceptance: {
          ...acceptance(),
          operator: '',
        },
      })).rejects.toThrow('Invalid operator acceptance request.');
      expect(rpc.calls).toEqual([]);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await owner.abandon();
    }
  });

  it('accounts only the oldest nonce when the durable nonce is higher', async () => {
    const snapshot = await fixture();

    const rpc = client(200n);

    rpc.getTransactionCount.mockResolvedValue(9);

    const inspection = await inspectSignerRecovery({
      publicClient: rpc.publicClient,
      snapshot,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptanceAttemptId: ATTEMPT_ID,
    });

    const plan = planSignerRecovery({
      identity: IDENTITY,
      snapshot,
      inspection,
      acceptance: acceptance(),
      unattributedActivity: true,
    });

    expect(plan.kind).toBe('persist');

    if (plan.kind !== 'persist') {
      throw new Error('Expected acceptance.');
    }

    expect(plan.snapshot.durableNextNonce).toBe(5n);
    expect(plan.snapshot.nextNonce).toBe(5n);
    expect(plan.snapshot.lastObservation.nonce).toBe(9n);
    expect(plan.snapshot.ledger.outcomes[0]!.durable.nonce).toBe(9n);
  });

  it.each([
    {
      plannerReason: 'ledger-capacity-reached',
      refusalReason: 'ledger-capacity-reached',
    },
    {
      plannerReason: 'inspection-not-committable',
      refusalReason: 'stale-evidence',
    },
  ] as const)('maps planner refusal $refusalReason without saving', async (row) => {
    const snapshot = await fixture();

    const { coordinator, save, lines } = await coordinatorFor(snapshot);

    const rpc = client(200n);

    const attemptsBefore = coordinator.attempts;

    // Inject only the planner result to isolate the coordinator's mapping.
    // The inspector still produces real, closed acceptance evidence.
    const planner = vi.spyOn(recoveryPlanner, 'planSignerRecovery').mockReturnValue({
      kind: 'unchanged',
      reason: row.plannerReason,
    });

    try {
      expect(await coordinator.recover({
        publicClient: rpc.publicClient,
        anchor: DURABLE,
        maxBlockRange: 2n,
        acceptance: acceptance(),
      })).toEqual({
        status: 'operator-acceptance-refused',
        observation: {
          anchor: DURABLE,
          nonce: 5n,
        },
        reason: row.refusalReason,
      });
      expect(planner).toHaveBeenCalledOnce();
      expect(planner.mock.calls[0]![0].inspection.status)
        .toBe('operator-acceptance-available');
      expect(save).not.toHaveBeenCalled();
      expect(coordinator.attempts).toEqual(attemptsBefore);
      expect(coordinator.operatorOutcome(acceptance().requestId)).toBeUndefined();
      expect(coordinator.status.recoveryComplete).toBe(false);
      expect(coordinator.canBroadcast).toBe(false);
      expect(lines.join('')).not.toContain('signer_attempt_operator_accepted_unattributed');
    } finally {
      planner.mockRestore();
    }
  });

  it('preserves the second retained attempt and its exhaustion blocker', async () => {
    const original = await fixture();

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
      ...original.attempts[0]!,
      attemptId: '33333333-3333-4333-8333-333333333333',
      workId: 'acceptance:5',
      nonce: 5n,
      signedTransactions: [{
        signedTransaction,
        transactionHash: keccak256(signedTransaction),
      }] as const,
      replacementSearch: {
        ...original.attempts[0]!.replacementSearch!,
        exhausted: {
          anchor: anchor(100n),
          nonce: 6n,
        },
      },
    };

    const snapshot = await decodeJournalSnapshot(await encodeJournalSnapshot({
      ...original,
      nextNonce: 6n,
      lastObservation: {
        anchor: DURABLE,
        nonce: 6n,
      },
      attempts: [original.attempts[0]!, later],
    }, IDENTITY), IDENTITY);

    const { coordinator, save } = await coordinatorFor(snapshot);

    const rpc = client(200n);

    rpc.getTransactionCount.mockResolvedValue(6);

    expect((await coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptance: acceptance(),
    })).status).toBe('operator-acceptance-committed');
    expect(save).toHaveBeenCalledOnce();

    const saved = save.mock.calls[0]![0];

    expect(saved.attempts).toEqual([later]);
    expect(saved.durableNextNonce).toBe(5n);
    expect(saved.nextNonce).toBe(6n);
    expect(saved.ledger.outcomes).toHaveLength(1);
    expect(saved.ledger.outcomes[0]!.attemptId).toBe(ATTEMPT_ID);
    expect(coordinator.status.blockers).toContain('conflict-search-exhausted');

    const reloaded = await coordinatorFor(saved);

    expect(reloaded.coordinator.attempts).toEqual(coordinator.attempts);
    expect(reloaded.coordinator.status.blockers).toContain('conflict-search-exhausted');
  });

  it('rejects simultaneous attribution and acceptance before any read', async () => {
    const snapshot = await fixture();

    const { coordinator, save, lines } = await coordinatorFor(snapshot);

    const rpc = client(200n);

    const startupLines = [...lines];

    await expect(coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      attribution: request(),
      acceptance: acceptance(),
    })).rejects.toThrow('Conflicting operator recovery requests.');
    expect(rpc.calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(lines).toEqual(startupLines);
  });

  it('names acceptance when no journal is present', async () => {
    const { coordinator, save } = await coordinatorFor(null);

    const rpc = client(200n);

    await expect(coordinator.recover({
      publicClient: rpc.publicClient,
      anchor: DURABLE,
      maxBlockRange: 2n,
      acceptance: acceptance(),
    })).rejects.toThrow('Operator acceptance requires a retained attempt.');
    expect(rpc.calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});
