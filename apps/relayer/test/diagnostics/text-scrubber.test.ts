import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  BaseError,
  createPublicClient,
  http,
  parseAbi,
} from 'viem';

import {
  createScrubber,
  lowercaseAscii,
  normalizePercentEscapes,
} from '../../src/diagnostics/text-scrubber.js';

const TOKEN = 'rpc-credential-canary';
const KEY = `0x${'aB12'.repeat(16)}`;
const RPC_URL =
  `https://rpc.example/v3/${TOKEN}?apiKey=query-canary`;

const scrub = createScrubber({
  rpcUrls: [RPC_URL],
  privateKey: KEY,
});

describe('createScrubber', () => {
  it('preserves an actionable registry mismatch unchanged', () => {
    const text =
      'Consumer registry 0x692100c4863adAED9f560F6Ce982cF878F083e93 ' +
      'differs from configured registry ' +
      '0x25CA96ff9CAC264b801e5a0E06a9545360494A7E.';

    expect(scrub(text)).toEqual({
      text,
      removed: false,
    });
  });

  it.each([
    encodeURIComponent(RPC_URL),
    encodeURIComponent(encodeURIComponent(RPC_URL)),
    TOKEN,
    'query-canary',
    KEY,
    KEY.toUpperCase(),
    KEY.slice(2),
    KEY.slice(2).toLowerCase(),
  ])('removes a configured secret form: case %#', (secret) => {
    expect(scrub(`Failure: ${secret}`)).toEqual({
      text: 'Failure: [REDACTED]',
      removed: true,
    });
  });

  it.each([
    {
      input: RPC_URL,
      expected: 'https://rpc.example/[REDACTED]',
      removed: true,
    },
    {
      input: RPC_URL.replaceAll('/', '\\/'),
      expected: String.raw`https:\/\/rpc.example\/[REDACTED]`,
      removed: true,
    },
    {
      input: 'https://rpc.example',
      expected: 'https://rpc.example',
      removed: false,
    },
  ])('preserves URL endpoint identity: case %#', ({
    input,
    expected,
    removed,
  }) => {
    expect(scrub(input)).toEqual({
      text: expected,
      removed,
    });
  });

  it('handles encoded credentials and literal punctuation', () => {
    const token = 'secret+A/B?C';
    const encoded = encodeURIComponent(token);

    const local = createScrubber({
      rpcUrls: [
        'https://user-canary:pass-canary@rpc.example/' +
        `v3/${encoded}?apiKey=${encoded}`,
      ],
    });

    for (const secret of [
      token,
      encoded,
      'user-canary',
      'pass-canary',
    ]) {
      expect(local(`RPC rejected ${secret}`)).toEqual({
        text: 'RPC rejected [REDACTED]',
        removed: true,
      });
    }

    expect(local('secretXA/BXC')).toEqual({
      text: 'secretXA/BXC',
      removed: false,
    });
  });

  it.each([
    'Authorization: Bearer unknown-token',
    'Proxy-Authorization: Basic dXNlcjpwYXNz',
    '"Authorization":"Bearer unknown-token"',
    'Bearer unknown-token',
    'https://other.example/unknown-credential',
    'wss://other.example/unknown-credential',
  ])('removes recognizable credentials: case %#', (text) => {
    const local = createScrubber({ rpcUrls: [] });
    const result = local(text);

    expect(result.removed).toBe(true);
    expect(result.text).not.toContain('unknown-token');
    expect(result.text).not.toContain('unknown-credential');
    expect(result.text).not.toContain('dXNlcjpwYXNz');
  });

  it.each([
    [
      'https://routeme.sh',
      'https://routeme.sh',
    ],
    [
      'https://lb.routeme.sh/rpc/evm/4663',
      'https://lb.routeme.sh/[REDACTED]',
    ],
    [
      'https://rpc.example:8545?token=abc',
      'https://rpc.example:8545?[REDACTED]',
    ],
    [
      'https://user:pass@rpc.example/path',
      'https://[REDACTED]@rpc.example/[REDACTED]',
    ],
    [
      'wss://[::1]:8546/path',
      'wss://[::1]:8546/[REDACTED]',
    ],
    [
      'https://rpc.example#secret',
      'https://rpc.example#[REDACTED]',
    ],
    [
      'https://rpc.example/',
      'https://rpc.example/',
    ],
  ])('redacts URL components: case %#', (input, expected) => {
    const local = createScrubber({ rpcUrls: [] });

    expect(local(input)).toEqual({
      text: expected,
      removed: input !== expected,
    });
  });

  it('still redacts an explicitly registered hostname', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ['rpc.example'],
    });

    expect(local('https://rpc.example/path')).toEqual({
      text: 'https://[REDACTED]/[REDACTED]',
      removed: true,
    });
  });

  it.each(['http:', 'https:', 'ws:', 'wss:'])(
    'handles unknown %s URLs with ordinary and escaped slashes',
    (scheme) => {
      const local = createScrubber({ rpcUrls: [] });
      const escapedSlash = '\\/';

      const slashPairs = [
        '//',
        escapedSlash + escapedSlash,
        '/' + escapedSlash,
        escapedSlash + '/',
      ];

      for (const prefix of [scheme, scheme.toUpperCase()]) {
        for (const slashes of slashPairs) {
          const origin = `${prefix}${slashes}rpc.example`;

          expect(local(`RPC failed: ${origin}/path/unknown-token`))
            .toEqual({
              text: `RPC failed: ${origin}/[REDACTED]`,
              removed: true,
            });
        }
      }
    },
  );

  it.each([' ', '\n', '\t', '"', "'", '<', '>'])(
    'preserves the URL delimiter and following text: case %#',
    (delimiter) => {
      const local = createScrubber({ rpcUrls: [] });
      const text =
        `https://rpc.example/unknown-token${delimiter}details`;

      expect(local(text)).toEqual({
        text: `https://rpc.example/[REDACTED]${delimiter}details`,
        removed: true,
      });
    },
  );

  it('keeps escaped URL slashes and stops at other backslashes', () => {
    const local = createScrubber({ rpcUrls: [] });
    const text =
      String.raw`https:\/\/rpc.example\/unknown-token\nDetails`;

    expect(local(text)).toEqual({
      text: String.raw`https:\/\/rpc.example\/[REDACTED]\nDetails`,
      removed: true,
    });
  });

  it('finds multiple URLs and preserves the text between them', () => {
    const local = createScrubber({ rpcUrls: [] });
    const text =
      'http://first.example/key then WSS://second.example/key';

    expect(local(text)).toEqual({
      text:
        'http://first.example/[REDACTED] then ' +
        'WSS://second.example/[REDACTED]',
      removed: true,
    });
  });

  it.each([
    'RPC failed: rpc.example:443',
    'connect ECONNREFUSED 127.0.0.1:443',
    'https:/rpc.example/path',
    'https://',
  ])('preserves text outside URL detection: case %#', (text) => {
    const local = createScrubber({ rpcUrls: [] });

    expect(local(text)).toEqual({
      text,
      removed: false,
    });
  });

  it('redacts an entire URL when its authority cannot be parsed', () => {
    const local = createScrubber({ rpcUrls: [] });

    expect(local('failed https://rpc.example:bad/secret')).toEqual({
      text: 'failed [REDACTED]',
      removed: true,
    });
  });

  it('preserves offsets before an escaped URL', () => {
    const local = createScrubber({ rpcUrls: [] });
    const prefix = 'İ 😀 failure: ';

    expect(local(prefix + String.raw`https:\/\/rpc.example\/secret`))
      .toEqual({
        text: prefix + String.raw`https:\/\/rpc.example\/[REDACTED]`,
        removed: true,
      });
  });

  it('preserves newline and tab while escaping unsafe controls', () => {
    expect(scrub('failed\n\t\u001b[31m\r\u202e')).toEqual({
      text: 'failed\n\t\\u001b[31m\\u000d\\u202e',
      removed: true,
    });
  });

  it('leaves ordinary multiline text unchanged', () => {
    const text = 'RPC failed\n\tGas estimation failed.';

    expect(scrub(text)).toEqual({
      text,
      removed: false,
    });
  });

  it('scrubs before truncating and omits oversized inputs', () => {
    const result = scrub('x'.repeat(4_080) + TOKEN);

    expect(result.removed).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4_096);
    expect(result.text).not.toContain(TOKEN);

    expect(scrub('x'.repeat(65_537))).toEqual({
      text: '[diagnostic text omitted: input limit]',
      removed: true,
    });

    expect(scrub('x'.repeat(5_000)).text).toHaveLength(4_096);
  });

  it('keeps scrubbers independent and snapshots configuration', () => {
    const rpcUrls = [RPC_URL];
    const first = createScrubber({ rpcUrls });
    const second = createScrubber({ rpcUrls: [] });

    rpcUrls.length = 0;

    expect(first(TOKEN).text).toBe('[REDACTED]');
    expect(first(TOKEN).text).toBe('[REDACTED]');

    expect(second(TOKEN)).toEqual({
      text: TOKEN,
      removed: false,
    });
  });

  it('rejects invalid configuration without echoing it', () => {
    expect(() => createScrubber({
      rpcUrls: [TOKEN],
    })).toThrow('Invalid RPC URL for diagnostic scrubbing.');

    expect(() => createScrubber({
      rpcUrls: [],
      privateKey: TOKEN,
    })).toThrow('Invalid private key for diagnostic scrubbing.');
  });

  it('merges a URL match with an overlapping configured secret', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ["ab'cd-credential-canary"],
    });

    expect(local("failed https://rpc.example/ab'cd-credential-canary"))
      .toEqual({
        text: 'failed https://rpc.example/[REDACTED]',
        removed: true,
      });
  });

  it('redacts configured URL userinfo containing an apostrophe', () => {
    const url = "https://user:p'ass@rpc.example/rpc";
    const local = createScrubber({ rpcUrls: [url] });

    expect(local(`failed ${url}`)).toEqual({
      text: 'failed https://[REDACTED]@rpc.example/[REDACTED]',
      removed: true,
    });
  });

  it.each([
    {
      name: 'different overlapping secrets',
      secrets: ['abcdef', 'defghi'],
      text: 'abcdefghi',
    },
    {
      name: 'overlapping occurrences of one secret',
      secrets: ['aba'],
      text: 'ababa',
    },
    {
      name: 'adjacent secrets',
      secrets: ['abc', 'def'],
      text: 'abcdef',
    },
    {
      name: 'a secret contained within another',
      secrets: ['abcdef', 'bcd'],
      text: 'abcdef',
    },
  ])('merges $name', ({ secrets, text }) => {
    const local = createScrubber({
      rpcUrls: [],
      secrets,
    });

    expect(local(text)).toEqual({
      text: '[REDACTED]',
      removed: true,
    });
  });

  it('preserves offsets before a mixed-case private key', () => {
    const key = `0x${'aB12'.repeat(16)}`;
    const prefix = 'İ 😀 failure: ';

    const local = createScrubber({
      rpcUrls: [],
      privateKey: key,
    });

    expect(local(prefix + key.toUpperCase())).toEqual({
      text: prefix + '[REDACTED]',
      removed: true,
    });
  });

  it('normalizes percent escapes without folding ordinary token text', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ['Ab/C?'],
    });

    for (const text of ['Ab/C?', 'Ab%2fC%3f', 'Ab%252fC%253f']) {
      expect(local(text)).toEqual({
        text: '[REDACTED]',
        removed: true,
      });
    }

    expect(local('ab/c?')).toEqual({
      text: 'ab/c?',
      removed: false,
    });
  });

  it('does not scan newly inserted redaction markers', () => {
    const local = createScrubber({
      rpcUrls: [],
      secrets: ['credential', 'REDACTED'],
    });

    expect(local('credential').text).toBe('[REDACTED]');
  });

  it('preserves normalization lengths across 400 generated strings', () => {
    const fragments = [
      '',
      'AZaz09',
      '%',
      '%2',
      '%GG',
      '%2F',
      '%2f',
      '%252F',
      '%25252f',
      'İ',
      'é',
      'ß',
      'Σ',
      '😀',
      '𐐀',
      '\ud800',
      '\udc00',
      '\n',
      '\t',
      '\0',
    ];

    // Include malformed escapes and isolated and paired surrogates.
    for (const left of fragments) {
      for (const right of fragments) {
        const text = `${left}%25${right}|${right}${left}`;

        expect(lowercaseAscii(text)).toHaveLength(text.length);
        expect(normalizePercentEscapes(text)).toHaveLength(text.length);
      }
    }
  });

  it.each(['', '0x', '0X'])(
    'accepts private-key prefix %j',
    (prefix) => {
      const key = 'aB12'.repeat(16);

      const local = createScrubber({
        rpcUrls: [],
        privateKey: prefix + key,
      });

      expect(local(key.toUpperCase())).toEqual({
        text: '[REDACTED]',
        removed: true,
      });
    },
  );

  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g' + 'a'.repeat(63),
    'a'.repeat(63) + '\n',
    'a'.repeat(62) + '😀',
  ])('rejects invalid private-key shape: case %#', (privateKey) => {
    expect(() => createScrubber({
      rpcUrls: [],
      privateKey,
    })).toThrow('Invalid private key for diagnostic scrubbing.');
  });

  it.each([
    [
      'Authorization: Bearer unknown-token\nstatus=429',
      'Authorization: [REDACTED]\nstatus=429',
    ],
    [
      'pRoXy-AuThOrIzAtIoN\t=\tBasic dXNlcjpwYXNz; retries=2',
      'pRoXy-AuThOrIzAtIoN\t=\t[REDACTED]; retries=2',
    ],
    [
      '{"Authorization":"Bearer unknown-token","status":429}',
      '{"Authorization":"[REDACTED]","status":429}',
    ],
    [
      "{'Proxy-Authorization': 'custom-token', 'status': 401}",
      "{'Proxy-Authorization': '[REDACTED]', 'status': 401}",
    ],
    [
      String.raw`{"Authorization":"token\"tail","status":401}`,
      '{"Authorization":"[REDACTED]","status":401}',
    ],
    [
      String.raw`Authorization: "token\\"; status=401`,
      'Authorization: "[REDACTED]"; status=401',
    ],
    [
      'Authorization: "unterminated-token\nstatus=401',
      'Authorization: "[REDACTED]\nstatus=401',
    ],
    [
      'Authorization=custom-token, status=401',
      'Authorization=[REDACTED], status=401',
    ],
    [
      'Authorization: first-token\nAuthorization: second-token',
      'Authorization: [REDACTED]\nAuthorization: [REDACTED]',
    ],
    [
      'İ 😀 Authorization: custom-token',
      'İ 😀 Authorization: [REDACTED]',
    ],
  ])(
    'redacts authorization values and preserves context: case %#',
    (input, expected) => {
      const local = createScrubber({ rpcUrls: [] });

      expect(local(input)).toEqual({
        text: expected,
        removed: true,
      });
    },
  );

  it.each([
    'Authorization failed during startup.',
    'authorizationStatus=failed',
    'Authorization:',
    'Authorization: ""',
    'Authorization:\nstatus=401',
  ])(
    'preserves text without an authorization value: case %#',
    (text) => {
      const local = createScrubber({ rpcUrls: [] });

      expect(local(text)).toEqual({
        text,
        removed: false,
      });
    },
  );

  it.each([
    'bEaReR abc.def-123',
    'bAsIc dXNlcjpwYXNz==',
  ])(
    'redacts standalone authentication tokens: case %#',
    (text) => {
      const local = createScrubber({ rpcUrls: [] });

      expect(local(text)).toEqual({
        text: '[REDACTED]',
        removed: true,
      });
    },
  );

  it('handles repeated header names inside a single long value', () => {
    const local = createScrubber({ rpcUrls: [] });
    const text =
      'Authorization: ' + 'Authorization: '.repeat(4_000);

    expect(local(text)).toEqual({
      text: 'Authorization: [REDACTED]',
      removed: true,
    });
  });

  it.each([
    [
      'myhttps://rpc.example/path',
      'myhttps://rpc.example/[REDACTED]',
    ],
    [
      '_https://rpc.example/path',
      '_https://rpc.example/[REDACTED]',
    ],
    [
      '1HTTPS://rpc.example/path',
      '1HTTPS://rpc.example/[REDACTED]',
    ],
    [
      'prefixwss://rpc.example/path',
      'prefixwss://rpc.example/[REDACTED]',
    ],
    [
      String.raw`prefixhttps:\/\/rpc.example\/path`,
      String.raw`prefixhttps:\/\/rpc.example\/[REDACTED]`,
    ],
    [
      'prefix%68ttps%3A%2F%2Frpc.example%2Fpath',
      'prefix%68ttps%3A%2F%2Frpc.example%2F[REDACTED]',
    ],
    [
      'prefixhttps://user:password@rpc.example/path',
      'prefixhttps://[REDACTED]@rpc.example/[REDACTED]',
    ],
  ])(
    'redacts URL components after a word character: %#',
    (input, expected) => {
      const local = createScrubber({ rpcUrls: [] });

      expect(local(input)).toEqual({
        text: expected,
        removed: true,
      });
    },
  );

  it.each([200, 429])(
    'scrubs actual viem errors from a fixture RPC (HTTP %i)',
    async (status) => {
      const server = createServer((request, response) => {
        let body = '';

        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });

        request.on('end', () => {
          if (status === 429) {
            response.writeHead(429, {
              'content-type': 'text/plain',
            });
            response.end('Too Many Requests');
            return;
          }

          const rpcRequest = JSON.parse(body) as { id: number };

          response.writeHead(status, {
            'content-type': 'application/json',
          });

          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.id,
            error: {
              code: -32000,
              message:
                'execution reverted: InvalidRound(32577683); ' +
                `token=${TOKEN}; key=${KEY}`,
            },
          }));
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        const origin = `http://127.0.0.1:${port}`;
        const url = `${origin}/v3/${TOKEN}`;

        const client = createPublicClient({
          transport: http(url, { retryCount: 0 }),
        });

        let failure: unknown;

        try {
          await client.estimateContractGas({
            account: '0x0000000000000000000000000000000000000001',
            address: '0x0000000000000000000000000000000000000002',
            abi: parseAbi([
              'function submitBeacon(uint64 round, bytes signature)',
            ]),
            functionName: 'submitBeacon',
            args: [32577683n, '0x'],
          });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(Error);

        if (!(failure instanceof Error)) {
          throw new Error('Expected a fixture RPC failure.');
        }

        expect(failure.message).toContain(TOKEN);

        const local = createScrubber({
          rpcUrls: [url],
          privateKey: KEY,
        });

        let cause: unknown = failure;

        // Exercise real composite messages and short messages at each level.
        while (cause instanceof Error) {
          const fields = [cause.message];

          if (cause instanceof BaseError) {
            fields.push(cause.shortMessage);
          }

          for (const field of fields) {
            const clean = local(field).text;

            expect(clean).not.toContain(TOKEN);
            expect(clean.toLowerCase())
              .not.toContain(KEY.slice(2).toLowerCase());

            if (field.includes(url)) {
              expect(clean).toContain(`${origin}/[REDACTED]`);
            }
          }

          cause = cause.cause;
        }

        const result = local(failure.message);

        expect(result.removed).toBe(true);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text.toLowerCase())
          .not.toContain(KEY.slice(2).toLowerCase());
        expect(result.text).not.toContain(url);

        if (status === 200) {
          expect(result.text).toContain('InvalidRound(32577683)');
        } else {
          expect(result.text).toContain('429');
          expect(result.text).toContain(`${origin}/[REDACTED]`);
        }
      } finally {
        server.closeAllConnections();

        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );
});