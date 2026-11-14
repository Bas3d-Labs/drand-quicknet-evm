import {
  decodeAttributionTicket,
  MAX_ATTRIBUTION_TICKET_BYTES,
  type AttributionTicket,
} from '../state/attribution-ticket.js';

import {
  readOperatorTicket,
} from './read-operator-ticket.js';

export async function readAttributionTicket(
  path: string,
): Promise<AttributionTicket> {
  return await readOperatorTicket(
    path,
    MAX_ATTRIBUTION_TICKET_BYTES,
    decodeAttributionTicket,
    'Invalid operator attribution ticket file.',
  );
}
