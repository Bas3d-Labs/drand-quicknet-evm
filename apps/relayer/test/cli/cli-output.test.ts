import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderCliOutput,
  renderOutputFailure,
  type CliOutput,
} from '../../src/cli/cli-output.js';

const ROUND = 1000n;

const RANDOMNESS = `0x${'11'.repeat(32)}` as const;
const HASH = `0x${'22'.repeat(32)}` as const;

const IMPORTED = {
  status: 'imported',
  round: ROUND,
  randomness: RANDOMNESS,
  transactionHash: HASH,
} as const;

describe('submission output', () => {
  it('reports witness submission without a fallback reason', () => {
    const output = renderCliOutput({
      type: 'import-result',
      round: ROUND,
      result: {
        ...IMPORTED,
        submission: 'witness',
      },
    });

    expect(output).toContain('Submission: witness');
    expect(output).not.toContain('Fallback reason');
  });

  it.each([
    'witness-rejected',
    'witness-decode-failed',
  ] as const)(
    'reports compressed submission and %s',
    (fallbackReason) => {
      const output = renderCliOutput({
        type: 'import-result',
        round: ROUND,
        result: {
          ...IMPORTED,
          submission: 'compressed',
          fallbackReason,
        },
      });

      expect(output).toContain('Submission: compressed');

      expect(output).toContain(
        'Fallback reason: ' + fallbackReason,
      );
    },
  );

  it('does not invent a submission method for an already-stored round', () => {
    const output = renderCliOutput({
      type: 'import-result',
      round: ROUND,
      result: {
        status: 'already-stored',
        round: ROUND,
        randomness: RANDOMNESS,
      },
    });

    expect(output).not.toContain('Submission:');
  });

  it.each([
    'submission',
    'fallbackReason',
  ] as const)(
    'rejects an unknown %s before returning output',
    (field) => {
      const output = {
        type: 'import-result',
        round: ROUND,
        result: {
          ...IMPORTED,
          submission: 'compressed',
          fallbackReason: 'witness-rejected',
          [field]: 'credential-canary',
        },
      } as unknown as CliOutput;

      expect(() => renderCliOutput(output)).toThrow(TypeError);
    },
  );
});

describe('incomplete import output', () => {
  const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

  function pending(
    reason: 'broadcast-not-acknowledged' | 'receipt-timeout',
  ) {
    return {
      status: 'pending',
      round: ROUND,
      attemptId: ATTEMPT_ID,
      transactionHash: HASH,
      reason,
    } as const;
  }

  const deferred = {
    status: 'deferred',
    round: ROUND,
    reason: 'signer-unavailable',
    blocker: 'unresolved-attempt',
  } as const;

  it.each([
    'broadcast-not-acknowledged',
    'receipt-timeout',
  ] as const)('renders pending %s and preserves output-failure context', (reason) => {
    const output: CliOutput = {
      type: 'import-result',
      round: ROUND,
      result: pending(reason),
    };

    expect(renderCliOutput(output)).toBe([
      'Quicknet round 1000 import is pending.',
      'Reason: ' + reason,
      'Attempt: ' + ATTEMPT_ID,
      'Transaction: ' + HASH,
    ].join('\n'));

    expect(JSON.parse(renderOutputFailure(
      output,
      new Error('Writer failed.'),
    ))).toEqual({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'import-result',
      round: '1000',
      status: 'pending',
      attemptId: ATTEMPT_ID,
      transactionHash: HASH,
      reason,
      err: expect.any(Object),
    });
  });

  it('renders deferral and preserves its blocker without attempt identity', () => {
    const output: CliOutput = {
      type: 'import-result',
      round: ROUND,
      result: deferred,
    };

    expect(renderCliOutput(output)).toBe([
      'Quicknet round 1000 import is deferred.',
      'Reason: signer-unavailable',
      'Signer blocker: unresolved-attempt',
    ].join('\n'));

    expect(JSON.parse(renderOutputFailure(
      output,
      new Error('Writer failed.'),
    ))).toEqual({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'import-result',
      round: '1000',
      status: 'deferred',
      reason: 'signer-unavailable',
      blocker: 'unresolved-attempt',
      err: expect.any(Object),
    });
  });

  it.each([
    { status: 'pending', field: 'attemptId' },
    { status: 'pending', field: 'transactionHash' },
    { status: 'pending', field: 'reason' },
    { status: 'deferred', field: 'reason' },
    { status: 'deferred', field: 'blocker' },
  ] as const)(
    'rejects invalid $status $field without retaining partial context',
    ({ status, field }) => {
      const secret = 'cli-output-credential-canary';

      const output = {
        type: 'import-result',
        round: ROUND,
        result: {
          ...(status === 'pending'
            ? pending('receipt-timeout')
            : deferred),
          [field]: secret,
        },
      } as unknown as CliOutput;

      expect(() => renderCliOutput(output)).toThrow(TypeError);

      const diagnostic = renderOutputFailure(
        output,
        new Error('Writer failed.'),
      );

      expect(JSON.parse(diagnostic)).toEqual({
        event: 'output_failed',
        code: 'CLI_OUTPUT_FAILED',
        output: 'unknown',
        err: expect.any(Object),
      });

      expect(diagnostic).not.toContain(secret);
    },
  );
});