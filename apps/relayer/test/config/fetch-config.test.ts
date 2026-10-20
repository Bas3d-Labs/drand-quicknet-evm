import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadFetchTimeoutMs,
  validateFetchTimeoutMs,
} from '../../src/config/fetch-config.js';

import {
  configDiagnostic,
  RelayerConfigError,
} from '../../src/diagnostics/config-errors.js';

describe('fetch timeout configuration', () => {
  it('defaults to five seconds', () => {
    expect(loadFetchTimeoutMs({})).toBe(5_000);
  });

  it.each([
    ['1', 1],
    ['5000', 5_000],
    ['0005000', 5_000],
    ['60000', 60_000],
  ] as const)('accepts %s milliseconds', (value, expected) => {
    expect(loadFetchTimeoutMs({
      QUICKNET_FETCH_TIMEOUT_MS: value,
    })).toBe(expected);
  });

  it.each([
    '',
    ' ',
    ' 5000',
    '5000 ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '0x1000',
    'NaN',
    'Infinity',
    '60001',
    '9007199254740992',
    'credential-canary',
  ])('rejects invalid setting %j safely', (value) => {
    let caught: unknown;

    try {
      loadFetchTimeoutMs({
        QUICKNET_FETCH_TIMEOUT_MS: value,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RelayerConfigError);
    expect(configDiagnostic(caught)).toEqual({
      code: 'INVALID_FETCH_TIMEOUT',
      setting: 'QUICKNET_FETCH_TIMEOUT_MS',
    });

    expect((caught as Error).message).toBe(
      'QUICKNET_FETCH_TIMEOUT_MS must be a decimal integer between 1 and 60000 milliseconds.',
    );

    expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    60_001,
  ])('rejects invalid programmatic timeout %s', (value) => {
    expect(() => validateFetchTimeoutMs(value))
      .toThrow(RangeError);
  });

  it.each([1, 5_000, 60_000])(
    'accepts programmatic timeout %s',
    (value) => {
      expect(validateFetchTimeoutMs(value)).toBe(value);
    },
  );
});