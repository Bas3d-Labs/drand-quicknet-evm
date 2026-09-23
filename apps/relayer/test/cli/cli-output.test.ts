import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderCliOutput,
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