import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadReceiptTimeoutMs,
  validateReceiptTimeoutMs,
} from '../../src/config/receipt-config.js';

import {
  configDiagnostic,
  RelayerConfigError,
} from '../../src/diagnostics/config-errors.js';

import {
  renderDiagnostic,
} from '../../src/diagnostics/diagnostics.js';

describe('receipt timeout configuration', () => {
  it('defaults to thirty seconds', () => {
    expect(loadReceiptTimeoutMs({})).toBe(30_000);
  });

  it.each([
    ['1', 1],
    ['45000', 45_000],
    ['00030000', 30_000],
    ['2147483647', 2_147_483_647],
  ] as const)('accepts %s milliseconds', (value, expected) => {
    expect(loadReceiptTimeoutMs({
      QUICKNET_RECEIPT_TIMEOUT_MS: value,
    })).toBe(expected);
  });

  it.each([
    '',
    ' ',
    ' 30000',
    '30000 ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '0x1000',
    'NaN',
    'Infinity',
    '2147483648',
    '9007199254740992',
    'credential-canary',
  ])('rejects invalid setting %j with a registered diagnostic', (value) => {
    let caught: unknown;

    try {
      loadReceiptTimeoutMs({
        QUICKNET_RECEIPT_TIMEOUT_MS: value,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RelayerConfigError);

    expect(configDiagnostic(caught)).toEqual({
      code: 'INVALID_RECEIPT_TIMEOUT',
      setting: 'QUICKNET_RECEIPT_TIMEOUT_MS',
    });

    expect((caught as Error).message).toBe(
      'QUICKNET_RECEIPT_TIMEOUT_MS must be a decimal integer between 1 and 2147483647 milliseconds.',
    );

    expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
  });

  it('does not emit the rejected setting value', () => {
    let caught: unknown;

    try {
      loadReceiptTimeoutMs({
        QUICKNET_RECEIPT_TIMEOUT_MS: 'credential-canary',
      });
    } catch (error) {
      caught = error;
    }

    const output = renderDiagnostic(caught);

    expect(JSON.parse(output)).toMatchObject({
      event: 'cli_failed',
      kind: 'configuration',
      code: 'INVALID_RECEIPT_TIMEOUT',
      setting: 'QUICKNET_RECEIPT_TIMEOUT_MS',
    });

    expect(output).not.toContain('credential-canary');
  });
});

describe('programmatic receipt timeout validation', () => {
  it.each([
    1,
    30_000,
    2_147_483_647,
  ])('accepts %s milliseconds', (value) => {
    expect(validateReceiptTimeoutMs(value)).toBe(value);
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
  ])('rejects invalid timeout %s', (value) => {
    expect(() => validateReceiptTimeoutMs(value))
      .toThrow('Invalid receipt timeout.');
  });
});