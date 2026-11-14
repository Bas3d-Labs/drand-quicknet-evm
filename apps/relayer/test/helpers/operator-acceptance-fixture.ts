import {
  readAcceptedOutcome,
} from '../../src/state/journal-ledger-validation.js';

import {
  request,
} from './operator-attribution-fixture.js';

import {
  maximumOutcome,
} from './operator-outcome-fixture.js';

export function acceptanceRequest() {
  const { hint, ...metadata } = request();

  return {
    ...metadata,
    attemptId: hint.attemptId,
  };
}

export function maximumAcceptedOutcome(index = 0, nonce = 1n) {
  const { replacement: _replacement, ...common } = maximumOutcome(index, nonce);

  return readAcceptedOutcome({
    ...common,
    kind: 'operator-accepted-unattributed',
  });
}
