import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderAcceptanceOutput,
} from '../../src/cli/output/acceptance-output.js';

import {
  renderAttributionOutput,
} from '../../src/cli/output/attribution-output.js';

import {
  FACT_CONFLICT,
} from '../helpers/search-fact-fixture.js';

describe.each([
  ['acceptance', renderAcceptanceOutput],
  ['attribution', renderAttributionOutput],
] as const)('%s conflict output', (_name, render) => {
  it('reports both facts without arbitrary extra properties', () => {
    const detail = {
      ...FACT_CONFLICT,
      secret: 'must-not-escape',
      first: { ...FACT_CONFLICT.first, secret: 'must-not-escape' },
    };

    const rendered = render({
      status: 'refused',
      reason: 'inconsistent-observations',
      detail,
    });

    expect(JSON.parse(rendered)).toEqual({
      status: 'refused',
      reason: 'inconsistent-observations',
      detail: {
        ...FACT_CONFLICT,
        anchor: { ...FACT_CONFLICT.anchor, blockNumber: '120' },
        first: { ...FACT_CONFLICT.first, nonce: '6' },
        second: { ...FACT_CONFLICT.second, nonce: '5' },
      },
    });
    expect(rendered).not.toContain('must-not-escape');
  });

  it('rejects a conflict attached to an unrelated refusal', () => {
    expect(() => render({
      status: 'refused',
      reason: 'journal-missing',
      detail: FACT_CONFLICT,
    })).toThrow();
  });

  it('rejects unsafe diagnostic identifiers', () => {
    expect(() => render({
      status: 'refused',
      reason: 'inconsistent-observations',
      detail: {
        ...FACT_CONFLICT,
        first: { ...FACT_CONFLICT.first, attemptId: 'arbitrary secret' },
      },
    })).toThrow();
  });
});
