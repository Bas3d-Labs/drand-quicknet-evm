import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderCliOutput,
  renderOutputFailure,
  type CliOutput,
} from '../../../src/cli/output/cli-output.js';

const IDENTITY = {
  chainId: 4663,
  signer: `0x${'11'.repeat(20)}` as const,
};

const HASH = `0x${'aa'.repeat(32)}` as const;

const REPAIR = {
  kind: 'sync-nonce' as const,
  at: '2026-10-12T12:00:00.000Z',
  previousNextNonce: 4n,
  nextNonce: 8n,
  observation: {
    anchor: {
      blockNumber: 110n,
      blockHash: HASH,
    },
    nonce: 8n,
  },
};

function applied(): CliOutput {
  return {
    type: 'nonce-sync-result',
    identity: IDENTITY,
    mode: 'apply',
    result: {
      status: 'applied',
      repair: REPAIR,
    },
  };
}

describe('nonce sync output', () => {
  it('renders a committed repair', () => {
    expect(renderCliOutput(applied())).toBe([
      'Nonce sync: applied',
      'Mode: apply',
      'Chain ID: 4663',
      'Signer: ' + IDENTITY.signer,
      'Previous next nonce: 4',
      'Next nonce: 8',
      'Durable block: 110',
      'Durable block hash: ' + HASH,
      'Repair timestamp: ' + REPAIR.at,
    ].join('\n'));
  });

  it('renders preview without inspecting its full snapshot', () => {
    const output: CliOutput = {
      type: 'nonce-sync-result',
      identity: IDENTITY,
      mode: 'preview',
      result: {
        status: 'repair-available',
        repair: REPAIR,
        get snapshot(): never {
          throw new Error('The output boundary must not read the snapshot.');
        },
      },
    };

    const rendered = renderCliOutput(output);

    expect(rendered).toContain('Nonce sync: repair-available');
    expect(rendered).toContain('Proposed repair timestamp: ' + REPAIR.at);
    expect(rendered).toContain('Preview only. No journal changes were made.');

    const failure = JSON.parse(renderOutputFailure(
      output,
      new Error('Writer failed'),
    ));

    expect(failure).toMatchObject({
      output: 'nonce-sync-result',
      mode: 'preview',
      status: 'repair-available',
      previousNextNonce: '4',
      nextNonce: '8',
    });

    expect(failure).not.toHaveProperty('snapshot');
  });

  it('renders an already-synchronized result', () => {
    expect(renderCliOutput({
      type: 'nonce-sync-result',
      identity: IDENTITY,
      mode: 'apply',
      result: {
        status: 'already-synchronized',
      },
    })).toBe([
      'Nonce sync: already-synchronized',
      'Mode: apply',
      'Chain ID: 4663',
      'Signer: ' + IDENTITY.signer,
    ].join('\n'));
  });

  it.each([
    { status: 'deferred', reason: 'nonce-count-mismatch' },
    { status: 'deferred', reason: 'anchor-changed' },
    { status: 'refused', reason: 'journal-missing' },
    { status: 'refused', reason: 'journal-changed' },
    { status: 'refused', reason: 'retained-attempts' },
    { status: 'refused', reason: 'nonce-regression' },
    { status: 'refused', reason: 'anchor-regression' },
    { status: 'refused', reason: 'anchor-conflict' },
  ] as const)(
    'renders $status: $reason',
    (result) => {
      const output: CliOutput = {
        type: 'nonce-sync-result',
        identity: IDENTITY,
        mode: 'preview',
        result,
      };

      expect(renderCliOutput(output)).toContain(
        'Reason: ' + result.reason,
      );

      expect(JSON.parse(renderOutputFailure(
        output,
        new Error('Writer failed'),
      ))).toMatchObject({
        output: 'nonce-sync-result',
        status: result.status,
        reason: result.reason,
      });
    },
  );

  it('preserves committed repair details when output fails', () => {
    const diagnostic = JSON.parse(renderOutputFailure(
      applied(),
      new Error('Writer failed'),
    ));

    expect(diagnostic).toMatchObject({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'nonce-sync-result',
      chainId: IDENTITY.chainId,
      signer: IDENTITY.signer,
      mode: 'apply',
      status: 'applied',
      previousNextNonce: '4',
      nextNonce: '8',
      durableBlock: '110',
      durableBlockHash: HASH,
      repairAt: REPAIR.at,
    });

    expect(diagnostic).not.toHaveProperty('snapshot');
  });

  it('rejects an applied result labelled as preview', () => {
    const output = {
      ...applied(),
      mode: 'preview',
    } as CliOutput;

    expect(() => renderCliOutput(output))
      .toThrow('Invalid nonce sync outcome mode.');
  });

  it('does not expose an arbitrary refusal reason', () => {
    const secret = 'untrusted-secret-value';

    const output = {
      type: 'nonce-sync-result',
      identity: IDENTITY,
      mode: 'preview',
      result: {
        status: 'refused',
        reason: secret,
      },
    } as unknown as CliOutput;

    expect(() => renderCliOutput(output))
      .toThrow('Invalid nonce sync reason.');

    const rendered = renderOutputFailure(
      output,
      new Error('Writer failed'),
    );

    expect(rendered).not.toContain(secret);
    expect(JSON.parse(rendered).output).toBe('unknown');
  });

  it('rejects repair counts inconsistent with the observation', () => {
    const output: CliOutput = {
      type: 'nonce-sync-result',
      identity: IDENTITY,
      mode: 'apply',
      result: {
        status: 'applied',
        repair: {
          ...REPAIR,
          observation: {
            ...REPAIR.observation,
            nonce: 9n,
          },
        },
      },
    };

    expect(() => renderCliOutput(output))
      .toThrow('Invalid nonce repair observation.');
  });
});