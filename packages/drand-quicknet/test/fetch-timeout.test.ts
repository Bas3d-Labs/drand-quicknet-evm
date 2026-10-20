import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  fetchBeacon,
  fetchBeaconFromEndpoint,
} from '../src/fetch.js';

const ENDPOINTS = [
  'https://first.test/v2',
  'https://second.test/v2',
] as const;

const SIGNATURE = 'ab'.repeat(48);

function response(): Response {
  return new Response(JSON.stringify({
    round: 100,
    signature: SIGNATURE,
  }));
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    signal.addEventListener(
      'abort',
      () => reject(signal.reason),
      { once: true },
    );
  });
}

function requestSignal(init?: RequestInit): AbortSignal {
  if (!init?.signal) {
    throw new Error('Expected a request signal.');
  }

  return init.signal;
}

describe('Quicknet endpoint deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses a five-second deadline by default', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        rejectWhenAborted(requestSignal(init)),
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = expect(
      fetchBeaconFromEndpoint(ENDPOINTS[0], 100n),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Quicknet endpoint request timed out.',
    });

    await vi.advanceTimersByTimeAsync(4_999);

    expect(requestSignal(fetchMock.mock.calls[0]![1]).aborted)
      .toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline across headers and body consumption', async () => {
    const bodyStarted = vi.fn();
    const cancel = vi.fn();

    const bodyResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          bodyStarted();
        },
        cancel,
      }, {
        highWaterMark: 0,
      }),
    );

    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 60);
        });

        return bodyResponse;
      },
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = expect(
      fetchBeaconFromEndpoint(ENDPOINTS[0], 100n, {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(bodyStarted).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(39);
    expect(requestSignal(fetchMock.mock.calls[0]![1]).aborted)
      .toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(cancel).toHaveBeenCalledOnce();
    expect(bodyResponse.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails over after a timeout without aborting the caller', async () => {
    const controller = new AbortController();

    const fetchMock = vi.fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          rejectWhenAborted(requestSignal(init)),
      )
      .mockResolvedValueOnce(response());

    vi.stubGlobal('fetch', fetchMock);

    const result = expect(fetchBeacon(100n, ENDPOINTS, {
      signal: controller.signal,
      timeoutMs: 100,
    })).resolves.toEqual({
      round: 100n,
      signature: `0x${SIGNATURE}`,
    });

    await vi.advanceTimersByTimeAsync(100);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives each endpoint a fresh deadline and retains timeout errors', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        rejectWhenAborted(requestSignal(init)),
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = expect(fetchBeacon(100n, ENDPOINTS, {
      timeoutMs: 100,
    })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ name: 'TimeoutError' }),
        expect.objectContaining({ name: 'TimeoutError' }),
      ],
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSignal(fetchMock.mock.calls[1]![1]).aborted)
      .toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await result;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation and clears the deadline', async () => {
    const controller = new AbortController();
    const reason = { code: 'TEST_CANCELLED' };

    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        rejectWhenAborted(requestSignal(init)),
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = expect(fetchBeacon(100n, ENDPOINTS, {
      signal: controller.signal,
      timeoutMs: 100,
    })).rejects.toBe(reason);

    controller.abort(reason);
    await result;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'failure'] as const)(
    'clears the deadline after immediate %s',
    async (outcome) => {
      const failure = new Error('Network unavailable');
      const fetchMock = vi.fn();

      if (outcome === 'success') {
        fetchMock.mockResolvedValue(response());
      } else {
        fetchMock.mockRejectedValue(failure);
      }

      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchBeaconFromEndpoint(ENDPOINTS[0], 100n, {
        timeoutMs: 100,
      });

      if (outcome === 'success') {
        await expect(pending).resolves.toMatchObject({
          round: 100n,
        });
      } else {
        await expect(pending).rejects.toBe(failure);
      }

      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    60_001,
  ])('rejects invalid timeout %s before fetching', async (timeoutMs) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBeacon(100n, ENDPOINTS, { timeoutMs }),
    ).rejects.toThrow(RangeError);

    await expect(
      fetchBeaconFromEndpoint(ENDPOINTS[0], 100n, { timeoutMs }),
    ).rejects.toThrow(RangeError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts the maximum timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBeaconFromEndpoint(ENDPOINTS[0], 100n, {
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({
      round: 100n,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation during body consumption and clears the deadline', async () => {
    const controller = new AbortController();
    const reason = { code: 'TEST_CANCELLED' };
    const bodyStarted = Promise.withResolvers<void>();
    const cancel = vi.fn();

    const bodyResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          bodyStarted.resolve();
        },
        cancel,
      }, {
        highWaterMark: 0,
      }),
    );

    const fetchMock = vi.fn().mockResolvedValue(bodyResponse);
    vi.stubGlobal('fetch', fetchMock);

    const result = expect(fetchBeacon(100n, ENDPOINTS, {
      signal: controller.signal,
      timeoutMs: 100,
    })).rejects.toBe(reason);

    await bodyStarted.promise;
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(reason);
    await result;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(bodyResponse.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});