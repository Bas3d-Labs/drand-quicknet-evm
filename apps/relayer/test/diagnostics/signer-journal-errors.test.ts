import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

import {
  isPriorSignerStateError,
  priorSignerStateError,
} from '../../src/diagnostics/signer-journal-errors.js';

describe('signer journal diagnostics', () => {
  it('recognizes a registered prior-state error', () => {
    const error = priorSignerStateError();

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('prior-state-present');
    expect(isPriorSignerStateError(error)).toBe(true);
  });

  it('renders a fixed, actionable startup refusal', () => {
    const error = priorSignerStateError();

    // Neither mutable error text nor extra fields belong in this output.
    error.message = 'private-diagnostic-canary';
    Object.assign(error, {
      path: '/private-diagnostic-canary/checkpoint.json',
    });

    const output = renderDiagnostic(error);

    expect(JSON.parse(output)).toEqual({
      event: 'cli_failed',
      kind: 'signer-journal',
      code: 'prior-state-present',
      message:
        'Checkpoint state exists but the signer transaction journal is missing. ' +
        'Automatic initialization is blocked. ' +
        'Verify the configured state directory and restore the matching ' +
        'journal from backup if available. ' +
        'Do not delete checkpoint state to bypass this check.',
    });

    expect(output).not.toContain('private-diagnostic-canary');
  });

  it('does not classify an unrelated error by its code', () => {
    const error = Object.assign(
      new Error('private-diagnostic-canary'),
      { code: 'prior-state-present' },
    );

    expect(isPriorSignerStateError(error)).toBe(false);

    const output = renderDiagnostic(error);

    expect(JSON.parse(output)).toMatchObject({
      event: 'cli_failed',
      kind: 'operation',
    });

    expect(output).not.toContain('private-diagnostic-canary');
  });

  it('does not recognize an object inheriting from a registered error', () => {
    const error = Object.create(priorSignerStateError());

    expect(isPriorSignerStateError(error)).toBe(false);
  });

  it('does not inspect properties while recognizing errors', () => {
    let inspected = false;

    const error = new Proxy({}, {
      get() {
        inspected = true;
        throw new Error('Must not read properties');
      },
      getOwnPropertyDescriptor() {
        inspected = true;
        throw new Error('Must not inspect descriptors');
      },
      getPrototypeOf() {
        inspected = true;
        throw new Error('Must not inspect prototypes');
      },
    });

    expect(isPriorSignerStateError(error)).toBe(false);
    expect(inspected).toBe(false);
  });
});