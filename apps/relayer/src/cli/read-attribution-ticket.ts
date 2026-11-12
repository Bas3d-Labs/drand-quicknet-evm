import {
  constants,
} from 'node:fs';

import {
  open,
} from 'node:fs/promises';

import {
  readFilePrefix,
} from '../state/read-file-prefix.js';

import {
  decodeAttributionTicket,
  MAX_ATTRIBUTION_TICKET_BYTES,
  type AttributionTicket,
} from '../state/attribution-ticket.js';

export async function readAttributionTicket(
  path: string,
): Promise<AttributionTicket> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ATTRIBUTION_TICKET_BYTES) {
        throw new TypeError();
      }

      const bytes = await readFilePrefix(file.read.bind(file), MAX_ATTRIBUTION_TICKET_BYTES + 1);

      return decodeAttributionTicket(new TextDecoder('utf-8', {
        fatal: true,
      }).decode(bytes));
    } finally {
      await file.close();
    }
  } catch {
    throw new TypeError('Invalid operator attribution ticket file.');
  }
}
