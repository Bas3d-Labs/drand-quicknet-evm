import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  loadBroadcastRetryConfig,
} from '../../src/config/signer-config.js';

import {
  configDiagnostic,
  RelayerConfigError,
} from '../../src/diagnostics/config-errors.js';

describe('broadcast retry configuration', () => {
  it('uses frozen defaults when settings are absent', () => {
    const config = loadBroadcastRetryConfig({});

    expect(config).toEqual({
      initialDelayMs: 5_000,
      maxDelayMs: 60_000,
    });

    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts custom delays and a fixed retry interval', () => {
    expect(loadBroadcastRetryConfig({
      QUICKNET_BROADCAST_RETRY_INITIAL_MS: '2500',
      QUICKNET_BROADCAST_RETRY_MAX_MS: '2500',
    })).toEqual({
      initialDelayMs: 2_500,
      maxDelayMs: 2_500,
    });
  });

  it('accepts the supported delay boundaries', () => {
    expect(loadBroadcastRetryConfig({
      QUICKNET_BROADCAST_RETRY_INITIAL_MS: '1',
      QUICKNET_BROADCAST_RETRY_MAX_MS: '2147483647',
    })).toEqual({
      initialDelayMs: 1,
      maxDelayMs: 2_147_483_647,
    });
  });

  it.each([
    'QUICKNET_BROADCAST_RETRY_INITIAL_MS',
    'QUICKNET_BROADCAST_RETRY_MAX_MS',
  ] as const)(
    'rejects invalid values for %s without retaining them',
    (setting) => {
      for (const value of [
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
        '2147483648',
        '9007199254740992',
        'credential-canary',
      ]) {
        let caught: unknown;

        try {
          loadBroadcastRetryConfig({
            [setting]: value,
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(RelayerConfigError);

        expect(configDiagnostic(caught)).toEqual({
          code: 'INVALID_BROADCAST_RETRY_DELAY',
          setting,
        });

        expect((caught as Error).message).toBe(
          `${setting} must be a decimal integer between 1 and 2147483647 milliseconds.`,
        );

        expect(
          Object.hasOwn(caught as object, 'cause'),
        ).toBe(false);
      }
    },
  );

  it.each([
    {
      QUICKNET_BROADCAST_RETRY_INITIAL_MS: '60001',
    },
    {
      QUICKNET_BROADCAST_RETRY_MAX_MS: '4999',
    },
    {
      QUICKNET_BROADCAST_RETRY_INITIAL_MS: '10000',
      QUICKNET_BROADCAST_RETRY_MAX_MS: '9999',
    },
  ])(
    'rejects a maximum below the initial delay: %j',
    (env) => {
      expect(() => loadBroadcastRetryConfig(env)).toThrow(
        'QUICKNET_BROADCAST_RETRY_MAX_MS must be greater than or equal to QUICKNET_BROADCAST_RETRY_INITIAL_MS.',
      );
    },
  );
});