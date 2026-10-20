import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  renderCliOutput,
  renderOutputFailure,
  type CliOutput,
} from '../../../src/cli/output/cli-output.js';

import {
  renderDaemonSnapshotStatusOutput,
} from '../../../src/cli/output/daemon-snapshot-status-output.js';

import {
  renderJournalStatusOutput,
} from '../../../src/cli/output/journal-status-output.js';

import type {
  RelayerStatus,
} from '../../../src/cli/read-relayer-status.js';

import {
  readDaemonStatusSnapshot,
} from '../../../src/state/daemon-status-snapshot.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'ab'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;
const AT = '2026-10-12T12:00:00.000Z';
const SECRET = 'signed-bytes-canary';

const OBSERVATION = {
  anchor: {
    blockNumber: '100',
    blockHash: HASH,
  },
  nonce: '4',
};

const SNAPSHOT = readDaemonStatusSnapshot({
  version: 1,
  identity: IDENTITY,
  runId: '11111111-1111-4111-8111-111111111111',
  observedAt: AT,
  journalInitialized: true,
  attempts: [],
  lastCompletedCycle: null,
  lastRetryObservation: null,
  lastObservedGate: {
    open: true,
    primaryReason: null,
    blockers: [],
    recoveryComplete: true,
    inclusionChecksComplete: true,
    persistenceState: 'idle',
    blockedSince: null,
  },
}, IDENTITY);

const CASES: {
  name: string;
  result: RelayerStatus;
  context: Record<string, unknown>;
}[] = [
  {
    name: 'missing journal',
    result: {
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    },
    context: {
      source: 'journal',
      journal: 'missing',
      gate: 'unknown',
    },
  },
  {
    name: 'present journal',
    result: {
      source: 'journal',
      journal: 'present',
      gate: 'unknown',
      identity: IDENTITY,
      baseline: OBSERVATION,
      lastObservation: OBSERVATION,
      nextNonce: '4',
      durableNextNonce: '4',
      attempts: [],
      repairs: [],
    },
    context: {
      source: 'journal',
      journal: 'present',
      gate: 'unknown',
    },
  },
  {
    name: 'missing snapshot',
    result: {
      source: 'daemon-snapshot',
      snapshot: 'missing',
      gate: 'unknown',
    },
    context: {
      source: 'daemon-snapshot',
      snapshot: 'missing',
      gate: 'unknown',
    },
  },
  {
    name: 'present snapshot',
    result: {
      source: 'daemon-snapshot',
      snapshot: 'present',
      gate: 'unknown',
      age: {
        status: 'fresh',
        ageMs: 0,
      },
      observation: SNAPSHOT,
    },
    context: {
      source: 'daemon-snapshot',
      snapshot: 'present',
      gate: 'unknown',
    },
  },
];

function output(result: RelayerStatus): CliOutput {
  return {
    type: 'relayer-status',
    result,
  };
}

// Deliberately malformed values exercise the runtime output boundary.
function invalidOutput(result: unknown): CliOutput {
  return {
    type: 'relayer-status',
    result,
  } as CliOutput;
}

describe('relayer status CLI output', () => {
  it.each(CASES)(
    'delegates rendering for $name',
    ({ result }) => {
      const expected = result.source === 'journal'
        ? renderJournalStatusOutput(result)
        : renderDaemonSnapshotStatusOutput(result);

      expect(renderCliOutput(output(result))).toBe(expected);
    },
  );

  it.each(CASES)(
    'preserves only compact validated failure context for $name',
    ({ result, context }) => {
      const record = JSON.parse(renderOutputFailure(
        output(result),
        new Error('Output destination failed'),
      ));

      const { err, ...fields } = record;

      expect(fields).toEqual({
        event: 'output_failed',
        code: 'CLI_OUTPUT_FAILED',
        output: 'relayer-status',
        ...context,
      });

      expect(err).toBeDefined();
    },
  );

  it.each([
    { source: 'unknown', gate: 'unknown' },
    { source: 'journal', journal: 'missing', gate: 'open' },
    {
      source: 'daemon-snapshot',
      snapshot: 'missing',
      gate: 'open',
    },
    {
      source: 'journal',
      journal: 'present',
      gate: 'unknown',
    },
    {
      source: 'daemon-snapshot',
      snapshot: 'present',
      gate: 'unknown',
    },
  ])('rejects malformed results and drops failure context: %j', (result) => {
    const value = invalidOutput(result);

    expect(() => renderCliOutput(value)).toThrow();

    const record = JSON.parse(renderOutputFailure(
      value,
      new Error('Output failed'),
    ));

    const { err, ...fields } = record;

    expect(fields).toEqual({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'unknown',
    });

    expect(err).toBeDefined();
  });

  it.each(CASES)(
    'excludes undeclared fields and serialization hooks for $name',
    ({ result }) => {
      const toJSON = vi.fn(() => SECRET);

      const extended = {
        ...result,
        signedTransaction: SECRET,
        toJSON,
      };

      const value = output(extended);

      expect(renderCliOutput(value)).not.toContain(SECRET);

      expect(renderOutputFailure(
        value,
        new Error('Output failed'),
      )).not.toContain(SECRET);

      expect(toJSON).not.toHaveBeenCalled();
    },
  );

  it('rejects a result getter without invoking it', () => {
    const getter = vi.fn(() => {
      throw new Error(SECRET);
    });

    const value = { type: 'relayer-status' };

    Object.defineProperty(value, 'result', {
      get: getter,
    });

    expect(() => renderCliOutput(value as CliOutput)).toThrow();

    const diagnostic = renderOutputFailure(
      value as CliOutput,
      new Error('Output failed'),
    );

    expect(JSON.parse(diagnostic).output).toBe('unknown');
    expect(diagnostic).not.toContain(SECRET);
    expect(getter).not.toHaveBeenCalled();
  });
});