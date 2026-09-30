import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createScrubber,
} from '../../src/diagnostics/text-scrubber.js';

const SECRET = 'sk_live_credential_canary';

const scrub = createScrubber({
  rpcUrls: [],
  secrets: [SECRET],
});

describe('percent-encoded diagnostic text', () => {
  it.each([
    'sk%5Flive_credential_canary',
    'sk%5flive_credential_canary',
    'sk%255Flive_credential_canary',
    '%73k_live_credential_canary',
    'sk_live_credential_canar%79',
    '%2573k%5Flive_credential_canar%2579',
  ])('redacts mixed literal and encoded credentials: %#', (encoded) => {
    expect(scrub(`before ${encoded} after`)).toEqual({
      text: 'before [REDACTED] after',
      removed: true,
    });
  });

  it('matches partially encoded mixed-case private keys', () => {
    const key = '0x' + 'aB12'.repeat(16);

    const local = createScrubber({
      rpcUrls: [],
      privateKey: key,
    });

    const encoded = key.toUpperCase().replace('AB12', '%41B12');

    expect(local(`key=${encoded}`)).toEqual({
      text: 'key=[REDACTED]',
      removed: true,
    });
  });

  it('maps UTF-8 credentials back to their original spans', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ['café😀credential'],
    });

    const prefix = 'İ %F0%9F%98%80 ';

    expect(
      local(prefix + 'caf%C3%A9%F0%9F%98%80credential end'),
    ).toEqual({
      text: prefix + '[REDACTED] end',
      removed: true,
    });
  });

  it.each([
    '%',
    '%2',
    '%GG',
    '%FF',
    '%C0%AF',
    '%ED%A0%80',
    '%F4%90%80%80',
    '%E2%82',
  ])('continues scanning after malformed encoding: %s', (invalid) => {
    expect(
      scrub(`${invalid} sk%5Flive_credential_canary`),
    ).toEqual({
      text: `${invalid} [REDACTED]`,
      removed: true,
    });
  });

  it('preserves original encoding when nothing requires redaction', () => {
    const text = 'safe%20text %FF + plus';

    expect(scrub(text)).toEqual({
      text,
      removed: false,
    });
  });

  it('scans decoded authorization fields', () => {
    const local = createScrubber({ rpcUrls: [] });

    expect(
      local('Authorization%3A%20Bearer%20unknown-secret'),
    ).toEqual({
      text: 'Authorization%3A%20[REDACTED]',
      removed: true,
    });
  });

  it('omits text requiring more than two decoding layers', () => {
    expect(scrub('sk%25255Flive_credential_canary')).toEqual({
      text: '[diagnostic text omitted: encoding limit]',
      removed: true,
    });
  });

  it('redacts the complete encoded secret before output truncation', () => {
    const prefix = 'x'.repeat(4_080);

    expect(scrub(prefix + 'sk%5Flive_credential_canary')).toEqual({
      text: prefix + '[REDACTED]',
      removed: true,
    });
  });

  it('retains the input length limit before decoding', () => {
    expect(scrub('%41'.repeat(22_000))).toEqual({
      text: '[diagnostic text omitted: input limit]',
      removed: true,
    });
  });

  it('retains broad matching for short configured URL credentials', () => {
    const local = createScrubber({
      rpcUrls: ['https://user:pw@rpc.example/?key=1'],
    });

    // Characterization: keep this behavior until a replacement policy exists.
    expect(local('Round 11; username; pw')).toEqual({
      text: 'Round [REDACTED]; [REDACTED]name; [REDACTED]',
      removed: true,
    });
  });

  it('retains broad matching for short explicitly supplied secrets', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ['1'],
    });

    expect(local('nonce 41')).toEqual({
      text: 'nonce 4[REDACTED]',
      removed: true,
    });
  });
});