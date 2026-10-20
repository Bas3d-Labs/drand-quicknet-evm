const MAX_RESPONSE_BYTES = 16 * 1024;

export async function readBeaconResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) {
    signal.throwIfAborted();
    throw new Error('Invalid Quicknet response: missing body');
  }

  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_RESPONSE_BYTES);

  let length = 0;
  let complete = false;

  // Cleanup must not delay cancellation or replace the original error.
  function cancel(): void {
    void reader.cancel().catch(() => {});
  }

  try {
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });

    while (true) {
      signal.throwIfAborted();

      const result = await reader.read();

      // Cancelling a reader can resolve a pending read with done: true.
      // Preserve the signal reason before treating that as normal EOF.
      signal.throwIfAborted();

      if (result.done) {
        complete = true;
        break;
      }

      if (result.value.byteLength > MAX_RESPONSE_BYTES - length) {
        throw new Error(
          `Invalid Quicknet response: body exceeds ${MAX_RESPONSE_BYTES} bytes`
        )
      }

      buffer.set(result.value, length);
      length += result.value.byteLength;
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );

    return JSON.parse(text) as unknown;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);

    if (!complete) {
      cancel();
    }

    reader.releaseLock();
  }
}