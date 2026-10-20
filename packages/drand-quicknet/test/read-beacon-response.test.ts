import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  readBeaconResponse,
} from '../src/read-beacon-response.js';

const MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function chunkedResponse(
  chunks: readonly Uint8Array[],
): Response {
  let index = 0;

  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];

      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
  }));
}

describe('readBeaconResponse', () => {
  it('reads JSON across chunks and split UTF-8 characters', async () => {
    const value = {
      round: 100,
      label: 'é',
    };

    const bytes = encoder.encode(JSON.stringify(value));
    const split = bytes.indexOf(0xc3) + 1;

    const response = chunkedResponse([
      bytes.subarray(0, split),
      bytes.subarray(split),
    ]);

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).resolves.toEqual(value);

    expect(response.body!.locked).toBe(false);
  });

  it('accepts exactly the byte limit', async () => {
    const response = new Response(
      '{}' + ' '.repeat(MAX_BYTES - 2),
    );

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).resolves.toEqual({});

    expect(response.body!.locked).toBe(false);
  });

  it('counts cumulative bytes instead of trusting Content-Length', async () => {
    const cancel = vi.fn();
    let index = 0;

    const chunks = [
      encoder.encode('{}' + ' '.repeat(MAX_BYTES - 2)),
      encoder.encode(' '),
    ];

    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index++];

          if (chunk !== undefined) {
            controller.enqueue(chunk);
          }
        },
        cancel,
      }),
      {
        headers: {
          'Content-Length': '2',
        },
      },
    );

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).rejects.toThrow(
      'Invalid Quicknet response: body exceeds 16384 bytes',
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it.each(['rejects', 'never settles'] as const)(
    'preserves an oversized-body error when cleanup %s',
    async (cleanup) => {
      const cancel = vi.fn(() => {
        if (cleanup === 'rejects') {
          return Promise.reject(new Error('Cleanup failed'));
        }

        return new Promise<void>(() => {});
      });

      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_BYTES + 1));
          },
          cancel,
        }),
      );

      await expect(
        readBeaconResponse(response, activeSignal()),
      ).rejects.toThrow(
        'Invalid Quicknet response: body exceeds 16384 bytes',
      );

      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
    },
  );

  it('preserves caller cancellation during a pending body read', async () => {
    const controller = new AbortController();
    const reason = { code: 'TEST_CANCELLED' };
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();

    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          reading.resolve();
          // Leave the read pending until cancellation.
        },
        cancel,
      }),
    );

    const result = expect(
      readBeaconResponse(response, controller.signal),
    ).rejects.toBe(reason);

    await reading.promise;
    controller.abort(reason);
    await result;

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it('cancels the body when the supplied signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = { code: 'TEST_CANCELLED' };
    const cancel = vi.fn();

    controller.abort(reason);

    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
    );

    await expect(
      readBeaconResponse(response, controller.signal),
    ).rejects.toBe(reason);

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it('preserves a body-stream failure and releases the reader', async () => {
    const failure = new Error('Body read failed');

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure);
        },
      }),
    );

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).rejects.toBe(failure);

    expect(response.body!.locked).toBe(false);
  });

  it('rejects malformed JSON and releases the reader', async () => {
    const response = new Response('{');

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).rejects.toThrow(SyntaxError);

    expect(response.body!.locked).toBe(false);
  });

  it('rejects a missing body', async () => {
    await expect(
      readBeaconResponse(new Response(null), activeSignal()),
    ).rejects.toThrow('Invalid Quicknet response: missing body');
  });

  it('rejects invalid UTF-8 and releases the reader', async () => {
    const response = new Response(new Uint8Array([0xff]));

    await expect(
      readBeaconResponse(response, activeSignal()),
    ).rejects.toThrow(TypeError);

    expect(response.body!.locked).toBe(false);
  });
});