import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  DEFAULT_STATUS_MAX_AGE_MS,
  parseStatusConfig,
} from '../../src/config/status-config.js';

const SIGNER = `0x${'ab'.repeat(20)}` as const;

describe('parseStatusConfig', () => {
  function input() {
    return {
      chainId: '4663',
      signer: SIGNER,
      source: 'daemon-snapshot',
    };
  }

  it('uses the default age threshold for explicit snapshot status', () => {
    expect(parseStatusConfig(input())).toEqual({
      identity: {
        chainId: 4663,
        signer: SIGNER,
      },
      source: 'daemon-snapshot',
      maxAgeMs: DEFAULT_STATUS_MAX_AGE_MS,
    });
  });

  it('accepts an explicit snapshot age threshold', () => {
    expect(parseStatusConfig({
      ...input(),
      source: 'daemon-snapshot',
      maxAgeMs: '300000',
    })).toEqual({
      identity: {
        chainId: 4663,
        signer: SIGNER,
      },
      source: 'daemon-snapshot',
      maxAgeMs: 300_000,
    });
  });

  it('selects journal inspection without a snapshot threshold', () => {
    expect(parseStatusConfig({
      ...input(),
      source: 'journal',
    })).toEqual({
      identity: {
        chainId: 4663,
        signer: SIGNER,
      },
      source: 'journal',
    });
  });

  it('rejects a snapshot threshold in journal mode', () => {
    expect(() => parseStatusConfig({
      ...input(),
      source: 'journal',
      maxAgeMs: '120000',
    })).toThrow(
      'Snapshot maximum age is not applicable to journal status.',
    );
  });

  it('returns detached, frozen configuration', () => {
    const supplied = input();
    const result = parseStatusConfig(supplied);

    supplied.chainId = '1';

    expect(result.identity.chainId).toBe(4663);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
  });

  it('accepts signer casing without changing the supplied address', () => {
    const signer = `0x${'AB'.repeat(20)}`;

    expect(parseStatusConfig({
      ...input(),
      signer,
    }).identity.signer).toBe(signer);
  });

  it('accepts decimal integers with leading zeroes', () => {
    expect(parseStatusConfig({
      ...input(),
      chainId: '004663',
      maxAgeMs: '001000',
    })).toMatchObject({
      identity: { chainId: 4663 },
      maxAgeMs: 1_000,
    });
  });

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    '0x1237',
    '1e3',
    ' 4663',
    '4663 ',
    '9007199254740992',
  ])('rejects invalid chain ID %j', (chainId) => {
    expect(() => parseStatusConfig({
      ...input(),
      chainId,
    })).toThrow('Invalid status chain ID.');
  });

  it.each([
    '',
    '0x',
    `0x${'ab'.repeat(19)}`,
    `0x${'ab'.repeat(21)}`,
    `0x${'zz'.repeat(20)}`,
    ' ' + SIGNER,
  ])('rejects invalid signer %j', (signer) => {
    expect(() => parseStatusConfig({
      ...input(),
      signer,
    })).toThrow('Invalid status signer.');
  });

  it.each([
    '',
    'snapshot',
    'auto',
    'JOURNAL',
  ])('rejects unsupported source %j', (source) => {
    expect(() => parseStatusConfig({
      ...input(),
      source,
    })).toThrow('Invalid status source.');
  });

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '1e3',
    ' 1000',
    '9007199254740992',
  ])('rejects invalid maximum age %j', (maxAgeMs) => {
    expect(() => parseStatusConfig({
      ...input(),
      maxAgeMs,
    })).toThrow('Invalid daemon snapshot maximum age.');
  });

  it('does not include rejected input in its error message', () => {
    const secret = 'credential-canary';

    expect(() => parseStatusConfig({
      ...input(),
      source: secret,
    })).toThrow('Invalid status source.');

    try {
      parseStatusConfig({ ...input(), source: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects a missing source instead of choosing one', () => {
    const supplied = input();
    Reflect.deleteProperty(supplied, 'source');

    expect(() => parseStatusConfig(supplied))
      .toThrow('Invalid status source.');
  });
});