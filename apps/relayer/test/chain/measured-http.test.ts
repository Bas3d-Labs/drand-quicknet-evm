import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createPublicClient,
  type HttpTransportConfig,
} from 'viem';

import {
  measuredHttp,
} from '../../src/chain/measured-http.js';

import {
  createRpcMetrics,
} from '../../src/diagnostics/rpc-metrics.js';

const SECRET = 'rpc-metrics-credential-canary';
const RPC_URL = `https://rpc.example/${SECRET}`;

function reply(
  result: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    result,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function setup(config: HttpTransportConfig) {
  const metrics = createRpcMetrics();

  const client = createPublicClient({
    transport: measuredHttp(RPC_URL, metrics, 'public', {
      retryCount: 0,
      ...config,
    }),
  });

  return {
    client,
    metrics,
  };
}

describe('measured HTTP transport', () => {
  it('counts an action using the captured transport request and returns its result', async () => {
    const { client, metrics } = setup({
      fetchFn: async () => reply('0x2a'),
    });

    expect(
      await client.getBlockNumber({ cacheTime: 0 }),
    ).toBe(42n);

    const snapshot = metrics.snapshot();

    expect(snapshot.logical).toEqual([
      expect.objectContaining({
        client: 'public',
        method: 'eth_blockNumber',
        started: 1,
        succeeded: 1,
        failed: 0,
        inFlight: 0,
      }),
    ]);

    expect(snapshot.http).toEqual([
      expect.objectContaining({
        client: 'public',
        started: 1,
        succeeded: 1,
        failed: 0,
        inFlight: 0,
        statuses: {
          '2xx': 1,
          '3xx': 0,
          '4xx': 0,
          '5xx': 0,
        },
      }),
    ]);

    expect(snapshot.logical[0]!.durationMs)
      .toBeGreaterThanOrEqual(0);

    expect(snapshot.http[0]!.durationMs)
      .toBeGreaterThanOrEqual(0);

    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it('counts retries as HTTP attempts without multiplying logical calls', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError(SECRET))
      .mockResolvedValueOnce(reply('0x2a'));

    const { client, metrics } = setup({
      fetchFn,
      retryCount: 1,
      retryDelay: 0,
    });

    expect(await client.request({
      method: 'eth_blockNumber',
    })).toBe('0x2a');

    expect(fetchFn).toHaveBeenCalledTimes(2);

    expect(metrics.snapshot().logical[0]).toMatchObject({
      started: 1,
      succeeded: 1,
      failed: 0,
      inFlight: 0,
    });

    expect(metrics.snapshot().http[0]).toMatchObject({
      started: 2,
      succeeded: 1,
      failed: 1,
      inFlight: 0,
      statuses: {
        '2xx': 1,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    });

    expect(JSON.stringify(metrics.snapshot())).not.toContain(SECRET);
  });

  it('counts one batch envelope for two logical calls', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (_input, init) => {
        // Fixture response generation only.
        // Production metrics never inspect bodies.
        const requests = JSON.parse(
          init!.body as string,
        ) as { id: number }[];

        expect(requests).toHaveLength(2);

        return new Response(JSON.stringify(
          requests.map(({ id }) => ({
            jsonrpc: '2.0',
            id,
            result: '0x2a',
          })),
        ), {
          headers: {
            'Content-Type': 'application/json',
          },
        });
      },
    );

    const { client, metrics } = setup({
      batch: true,
      fetchFn,
    });

    const results = await Promise.all([
      client.request({ method: 'eth_blockNumber' }),
      client.request({ method: 'eth_chainId' }),
    ]);

    expect(results).toEqual(['0x2a', '0x2a']);
    expect(fetchFn).toHaveBeenCalledOnce();

    expect(
      metrics.snapshot().logical.map((row) => row.started),
    ).toEqual([1, 1]);

    expect(metrics.snapshot().http[0]).toMatchObject({
      started: 1,
      succeeded: 1,
      failed: 0,
      inFlight: 0,
    });
  });

  it('distinguishes an HTTP response from a JSON-RPC failure', async () => {
    const { client, metrics } = setup({
      fetchFn: async () => new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32602,
          message: SECRET,
        },
      }), {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    });

    await expect(client.request({
      method: 'eth_blockNumber',
    })).rejects.toThrow();

    expect(metrics.snapshot().logical[0]).toMatchObject({
      failed: 1,
      succeeded: 0,
      inFlight: 0,
    });

    expect(metrics.snapshot().http[0]).toMatchObject({
      failed: 0,
      succeeded: 1,
      inFlight: 0,
      statuses: {
        '2xx': 1,
      },
    });

    expect(JSON.stringify(metrics.snapshot())).not.toContain(SECRET);
  });

  it('records HTTP status even when the logical call fails', async () => {
    const { client, metrics } = setup({
      fetchFn: async () => new Response(SECRET, {
        status: 503,
      }),
    });

    await expect(client.request({
      method: 'eth_blockNumber',
    })).rejects.toThrow();

    expect(metrics.snapshot().http[0]).toMatchObject({
      succeeded: 1,
      failed: 0,
      inFlight: 0,
      statuses: {
        '5xx': 1,
      },
    });

    expect(metrics.snapshot().logical[0]).toMatchObject({
      failed: 1,
      inFlight: 0,
    });

    expect(JSON.stringify(metrics.snapshot())).not.toContain(SECRET);
  });

  it('forwards cancellation and counts a fetch rejection', async () => {
    const controller = new AbortController();

    const { client, metrics } = setup({
      fetchFn: async (_input, init) => {
        expect(init!.signal).toBe(controller.signal);

        controller.abort();
        init!.signal!.throwIfAborted();

        return reply('0x0');
      },
    });

    await expect(client.request({
      method: 'eth_blockNumber',
    }, {
      signal: controller.signal,
    })).rejects.toThrow();

    expect(metrics.snapshot().http[0]).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 1,
      inFlight: 0,
      statuses: {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      },
    });

    expect(metrics.snapshot().logical[0]).toMatchObject({
      failed: 1,
      inFlight: 0,
    });
  });

  it('keeps snapshots independent and uses a bounded unknown-method bucket', async () => {
    const metrics = createRpcMetrics();
    const failure = new Error(SECRET);

    await expect(metrics.logical(
      'wallet',
      SECRET,
      async () => {
        throw failure;
      },
    )).rejects.toBe(failure);

    await metrics.logical(
      'wallet',
      'another-unknown-method',
      async () => 1,
    );

    await metrics.http('wallet', async () => reply('0x0'));

    const snapshot = metrics.snapshot();

    expect(snapshot.logical).toHaveLength(1);

    expect(snapshot.logical[0]).toMatchObject({
      method: 'other',
      started: 2,
      failed: 1,
      succeeded: 1,
    });

    snapshot.logical[0]!.started = 999;
    snapshot.http[0]!.statuses['2xx'] = 999;

    expect(metrics.snapshot().logical[0]!.started).toBe(2);
    expect(metrics.snapshot().http[0]!.statuses['2xx']).toBe(1);

    expect(JSON.stringify(metrics.snapshot())).not.toContain(SECRET);
  });

  it('exposes in-flight work until it settles', async () => {
    const metrics = createRpcMetrics();

    let finish!: (value: number) => void;

    const pending = metrics.logical(
      'public',
      'eth_call',
      () => new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );

    try {
      expect(metrics.snapshot().logical[0]).toMatchObject({
        started: 1,
        inFlight: 1,
        succeeded: 0,
        failed: 0,
      });
    } finally {
      finish(7);
      await pending;
    }

    expect(await pending).toBe(7);

    expect(metrics.snapshot().logical[0]).toMatchObject({
      inFlight: 0,
      succeeded: 1,
      failed: 0,
    });
  });

  it.each([
    [200, '2xx'],
    [299, '2xx'],
    [300, '3xx'],
    [399, '3xx'],
    [400, '4xx'],
    [499, '4xx'],
    [500, '5xx'],
    [599, '5xx'],
  ] as const)(
    'classifies HTTP status %i as %s',
    async (status, expectedClass) => {
      const metrics = createRpcMetrics();
      const response = new Response(null, { status });

      const result = await metrics.http(
        'public',
        async () => response,
      );

      const statuses = {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
      };

      statuses[expectedClass] = 1;

      expect(result).toBe(response);
      expect(metrics.snapshot().http).toEqual([
        {
          client: 'public',
          started: 1,
          succeeded: 1,
          failed: 0,
          inFlight: 0,
          durationMs: expect.any(Number),
          statuses,
        },
      ]);
    },
  );

  it.each([
    0,
    199,
    600,
    999,
    200.5,
    Number.NaN,
  ])(
    'preserves an unclassified response with status %s',
    async (status) => {
      const metrics = createRpcMetrics();

      // Preserve the exact status without Response constructor
      // validation or numeric coercion.
      const response = { status } as Response;

      const result = await metrics.http(
        'public',
        async () => response,
      );

      expect(result).toBe(response);
      expect(metrics.snapshot().http).toEqual([
        {
          client: 'public',
          started: 1,
          succeeded: 1,
          failed: 0,
          inFlight: 0,
          durationMs: expect.any(Number),
          statuses: {
            '2xx': 0,
            '3xx': 0,
            '4xx': 0,
            '5xx': 0,
          },
        },
      ]);
    },
  );

  it('preserves collector identity across snapshots and separates collectors', async () => {
    const metrics = createRpcMetrics();
    const before = metrics.snapshot();

    await metrics.logical(
      'public',
      'eth_blockNumber',
      async () => '0x2a',
    );

    const after = metrics.snapshot();
    const another = createRpcMetrics().snapshot();

    expect(before.collectorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(after.collectorId).toBe(before.collectorId);
    expect(after.startedAt).toBe(before.startedAt);

    expect(new Date(before.startedAt).toISOString())
      .toBe(before.startedAt);

    expect(another.collectorId).not.toBe(before.collectorId);

    expect(before.logical).toEqual([]);
    expect(after.logical[0]).toMatchObject({
      started: 1,
      succeeded: 1,
    });
  });

  it('keeps the logical call in flight when the response body stalls', async () => {
    vi.useFakeTimers();

    try {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      let observeHeaders!: () => void;

      const headersObserved = new Promise<void>((resolve) => {
        observeHeaders = resolve;
      });

      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const { client, metrics } = setup({
        timeout: 10,
        fetchFn: async () => response,
        onFetchResponse() {
          observeHeaders();
        },
      });

      let settled = false;

      // Handle rejection immediately, including during fixture cleanup.
      const pending = client.request({
        method: 'eth_blockNumber',
      }).then(
        (value) => {
          settled = true;
          return { kind: 'fulfilled' as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { kind: 'rejected' as const, error };
        },
      );

      try {
        // Surface an early request failure rather than waiting forever
        // for a response hook that was never called.
        await Promise.race([
          headersObserved,
          pending.then(() => {
            throw new Error(
              'Request settled before body-stall observation.',
            );
          }),
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(settled).toBe(false);

        const snapshot = metrics.snapshot();

        expect(snapshot.http[0]).toMatchObject({
          started: 1,
          succeeded: 1,
          failed: 0,
          inFlight: 0,
          statuses: {
            '2xx': 1,
          },
        });

        expect(snapshot.logical[0]).toMatchObject({
          started: 1,
          succeeded: 0,
          failed: 0,
          inFlight: 1,
        });
      } finally {
        // Terminate the reader even if an assertion fails.
        bodyController.error(new Error('Fixture body terminated.'));
        await pending;
      }

      expect((await pending).kind).toBe('rejected');

      expect(metrics.snapshot().logical[0]).toMatchObject({
        succeeded: 0,
        failed: 1,
        inFlight: 0,
      });

      expect(metrics.snapshot().http[0]).toMatchObject({
        succeeded: 1,
        failed: 0,
        inFlight: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});