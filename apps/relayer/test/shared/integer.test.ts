import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  isPositiveSafeInteger,
} from '../../src/shared/integer.js';

describe('isPositiveSafeInteger', () => {
  it.each([
    1,
    2_147_483_647,
    Number.MAX_SAFE_INTEGER,
  ])('accepts %s', (value) => {
    expect(isPositiveSafeInteger(value)).toBe(true);
  });

  it.each([
    0,
    -0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '1',
    1n,
    true,
    null,
    undefined,
    {},
  ])('rejects %s', (value) => {
    expect(isPositiveSafeInteger(value)).toBe(false);
  });
});