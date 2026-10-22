import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  JournalBoundsExceededError,
  journalBoundsViolations,
} from '../../src/state/journal-bounds-error.js';

function boundsError(): JournalBoundsExceededError {
  return new JournalBoundsExceededError([
    {
      bound: 'signed-transactions-per-attempt',
      maximum: 16,
      observed: 17,
      attemptId: '11111111-1111-4111-8111-111111111111',
      message: 'Fixture convenience text.',
    },
  ]);
}

describe('journal bounds diagnostics', () => {
  it('recognizes a registered error and renders structured reasons', () => {
    const error = boundsError();

    expect(journalBoundsViolations(error)).toEqual(error.violations);

    expect(JSON.parse(renderDiagnostic(error))).toEqual({
      event: 'cli_failed',
      kind: 'signer-journal',
      code: 'journal-bounds-exceeded',
      message:
        'Retained journal state exceeds the configured runtime bounds. '
        + 'Inspect the journal before restarting. Do not delete it '
        + 'or initialize a replacement.',
      violations: [
        {
          bound: 'signed-transactions-per-attempt',
          maximum: 16,
          observed: 17,
          attemptId: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });
  });

  it('uses captured violations despite mutations to public error fields', () => {
    const error = boundsError();
    const before = renderDiagnostic(error);

    error.message = 'private-diagnostic-canary';

    Object.assign(error, {
      violations: [],
      path: '/private-diagnostic-canary/journal.json',
    });

    const output = renderDiagnostic(error);

    expect(output).toBe(before);
    expect(output).not.toContain('private-diagnostic-canary');
    expect(output).not.toContain('Fixture convenience text.');
  });

  it('does not recognize an unrelated error with matching fields', () => {
    const error = Object.assign(new Error('unrelated'), {
      name: 'JournalBoundsExceededError',
      code: 'journal-bounds-exceeded',
      violations: boundsError().violations,
    });

    expect(journalBoundsViolations(error)).toBeUndefined();
    expect(JSON.parse(renderDiagnostic(error))).toMatchObject({
      kind: 'operation',
    });
  });

  it('does not recognize an object inheriting from a registered error', () => {
    const inherited = Object.create(boundsError());

    expect(journalBoundsViolations(inherited)).toBeUndefined();
  });

  it.each([undefined, null, 'journal-bounds-exceeded', 6])(
    'does not recognize a primitive: %s',
    (value) => {
      expect(journalBoundsViolations(value)).toBeUndefined();
    },
  );
});