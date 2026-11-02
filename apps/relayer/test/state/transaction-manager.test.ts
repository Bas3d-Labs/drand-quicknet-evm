import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  submissionRecording,
} from '../../src/state/transaction-manager.js';

describe('submissionRecording', () => {
  it('returns undefined for values without a registered recording', () => {
    const values: unknown[] = [
      undefined,
      null,
      false,
      0,
      '',
      Symbol('submission'),
      () => undefined,
      {},
      new Error('Unregistered failure.'),
    ];

    for (const value of values) {
      expect(submissionRecording(value)).toBeUndefined();
    }
  });

  it('rejects an error with a forged name and recording', () => {
    const error = Object.assign(
      new Error('Transaction submission did not complete.'),
      {
        name: 'TransactionSubmissionError',
        recording: {
          status: 'retained',
          attempt: {
            workId: 'test-work:4',
            attemptId: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
    );

    expect(submissionRecording(error)).toBeUndefined();
  });

  it('does not inspect getters on an unregistered object', () => {
    const getter = vi.fn(() => {
      throw new Error('Unexpected property access.');
    });

    const error = Object.create(null);

    for (const property of ['name', 'recording', 'cause']) {
      Object.defineProperty(error, property, {
        get: getter,
      });
    }

    expect(submissionRecording(error)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not inspect proxy properties', () => {
    const get = vi.fn(() => {
      throw new Error('Unexpected property access.');
    });

    const error = new Proxy({}, { get });

    expect(submissionRecording(error)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});