import {
  constants,
} from 'node:fs';

import {
  open,
} from 'node:fs/promises';

import {
  readFilePrefix,
} from '../state/read-file-prefix.js';

export async function readOperatorTicket<T>(
  path: string,
  maxBytes: number,
  decode: (contents: string) => T,
  invalidFileMessage: string,
): Promise<T> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
        throw new TypeError();
      }

      const bytes = await readFilePrefix(file.read.bind(file), maxBytes + 1);

      return decode(new TextDecoder('utf-8', {
        fatal: true,
      }).decode(bytes));
    } finally {
      await file.close();
    }
  } catch {
    throw new TypeError(invalidFileMessage);
  }
}
