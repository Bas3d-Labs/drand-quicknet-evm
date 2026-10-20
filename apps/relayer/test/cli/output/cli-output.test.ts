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

  const WORK_ID = ' work:e\u0301 ';

  const retained = {
    status: 'deferred',
    round: ROUND,
    reason: 'already-retained',
    attemptId: ATTEMPT_ID,
    workId: WORK_ID,
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

  it('renders retained work and preserves its exact output-failure context', () => {
    const output: CliOutput = {
      type: 'import-result',
      round: ROUND,
      result: retained,
    };

    expect(renderCliOutput(output)).toBe([
      'Quicknet round 1000 import is deferred.',
      'Reason: already-retained',
      'Retained attempt: ' + ATTEMPT_ID,
      'Work identity: ' + WORK_ID,
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
      reason: 'already-retained',
      attemptId: ATTEMPT_ID,
      workId: WORK_ID,
      err: expect.any(Object),
    });
  });

  it.each([
    { name: 'missing attempt ID', field: 'attemptId', remove: true },
    { name: 'missing work identity', field: 'workId', remove: true },
    {
      name: 'invalid attempt ID',
      field: 'attemptId',
      value: 'not-a-uuid',
    },
    { name: 'undefined work identity', field: 'workId', value: undefined },
    { name: 'null work identity', field: 'workId', value: null },
    { name: 'numeric work identity', field: 'workId', value: 42 },
    { name: 'empty work identity', field: 'workId', value: '' },
    {
      name: 'overlong work identity',
      field: 'workId',
      value: 'x'.repeat(257),
    },
    { name: 'C0 control', field: 'workId', value: 'work\nforged' },
    { name: 'C1 control', field: 'workId', value: 'work\u0085forged' },
  ])('rejects $name without retaining partial context', (testCase) => {
    const result: Record<string, unknown> = { ...retained };

    if (testCase.remove === true) {
      delete result[testCase.field];
    } else {
      result[testCase.field] = testCase.value;
    }

    // Deliberately bypass typing to exercise the public validation boundary.
    const output = {
      type: 'import-result',
      round: ROUND,
      result,
    } as unknown as CliOutput;

    expect(() => renderCliOutput(output)).toThrow(TypeError);

    expect(JSON.parse(renderOutputFailure(
      output,
      new Error('Writer failed.'),
    ))).toEqual({
      event: 'output_failed',
      code: 'CLI_OUTPUT_FAILED',
      output: 'unknown',
      err: expect.any(Object),
    });
  });

  it('accepts a work identity at the maximum length in both output paths', () => {
    const workId = 'x'.repeat(256);

    const output: CliOutput = {
      type: 'import-result',
      round: ROUND,
      result: { ...retained, workId },
    };

    expect(renderCliOutput(output)).toBe([
      'Quicknet round 1000 import is deferred.',
      'Reason: already-retained',
      'Retained attempt: ' + ATTEMPT_ID,
      'Work identity: ' + workId,
    ].join('\n'));

    expect(JSON.parse(renderOutputFailure(
      output,
      new Error('Writer failed.'),
    ))).toMatchObject({
      output: 'import-result',
      reason: 'already-retained',
      attemptId: ATTEMPT_ID,
      workId,
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