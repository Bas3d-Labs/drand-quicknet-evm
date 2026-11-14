import {
  decodeAcceptanceTicket,
  MAX_ACCEPTANCE_TICKET_BYTES,
  type AcceptanceTicket,
} from '../state/acceptance-ticket.js';

import {
  readOperatorTicket,
} from './read-operator-ticket.js';

export async function readAcceptanceTicket(
  path: string,
): Promise<AcceptanceTicket> {
  return await readOperatorTicket(
    path,
    MAX_ACCEPTANCE_TICKET_BYTES,
    decodeAcceptanceTicket,
    'Invalid operator acceptance ticket file.',
  );
}
