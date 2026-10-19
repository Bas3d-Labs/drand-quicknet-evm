type ReadBytes = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number }>;

/**
 * Reads from position zero until EOF or the byte limit is reached.
 * Callers can request one extra byte to detect oversized files.
 */
export async function readFilePrefix(
  read: ReadBytes,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let length = 0;

  while (length < buffer.length) {
    const result = await read(
      buffer,
      length,
      buffer.length - length,
      length,
    );

    if (result.bytesRead === 0) {
      break;
    }

    length += result.bytesRead;
  }

  return buffer.subarray(0, length);
}