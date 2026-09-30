import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  summarizeError,
} from '../../src/diagnostics/error-summary.js';

import {
  summarizeErrorForOutput,
} from '../../src/diagnostics/error-output.js';

vi.mock('../../src/diagnostics/error-summary.js', () => ({
  summarizeError: vi.fn(),
}));

const SECRET = 'summary-failure-canary';

const FALLBACK = {
  name: 'UnknownError',
  code: 'SUMMARY_UNAVAILABLE',
  message: '[diagnostic summary unavailable]',
  textModified: true,
};

describe('summarizeErrorForOutput failure containment', () => {
  beforeEach(() => {
    vi.mocked(summarizeError).mockReset();
  });

  it('returns a fixed summary when summarization throws', () => {
    vi.mocked(summarizeError).mockImplementation(() => {
      throw new Error(SECRET);
    });

    const summary = summarizeErrorForOutput(new Error(SECRET));

    expect(summary).toEqual(FALLBACK);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('returns a fixed summary when serialization throws', () => {
    vi.mocked(summarizeError).mockReturnValue({
      name: 'Error',
      get message(): string {
        throw new Error(SECRET);
      },
    });

    const summary = summarizeErrorForOutput(new Error(SECRET));

    expect(summary).toEqual(FALLBACK);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('contains a summary that the fitter cannot reduce', () => {
    // Simulate a future summary field omitted from the shortening logic.
    const oversized = Object.assign({
      name: 'Error',
      message: 'Operation failed.',
    }, {
      unexpected: SECRET.repeat(2_000),
    });

    vi.mocked(summarizeError).mockReturnValue(oversized);

    const summary = summarizeErrorForOutput(new Error(SECRET));

    expect(summary).toEqual(FALLBACK);
    expect(Buffer.byteLength(JSON.stringify(summary)))
      .toBeLessThanOrEqual(8_192);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });
});