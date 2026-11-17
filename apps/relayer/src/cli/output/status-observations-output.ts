import type {
  OperatorHistoryObservation,
  QueueObservation,
  StoredFactDisputeObservation,
} from '../../state/status-observations.js';

export function renderOperatorHistory(history: OperatorHistoryObservation | null): string[] {
  if (history === null) {
    return ['Operator history: unavailable'];
  }

  return [
    'Acknowledged operator history: ' + history.count + ' / ' + history.limit,
    'Operator history counts acceptance and attribution outcomes, not ordinary resolutions.',
  ];
}

export function renderQueue(queue: QueueObservation | null): string[] {
  if (queue === null) {
    return ['Queued work: unavailable'];
  }

  return [
    'Last observed queued work: ' + queue.queuedCount + ' / ' + queue.limit,
    'Last observed due work: ' + queue.dueCount,
    'Rejected offers this daemon run: ' + queue.rejectedOffers,
    'Due work follows the capture clock; it is not necessarily capacity-deferred.',
    'Rejected offers are cumulative offers, not unique requests or evictions.',
    'Queue and retained-attempt populations can overlap; do not add them.',
  ];
}

export function renderStoredFactDispute(
  dispute: StoredFactDisputeObservation | null,
): string[] {
  if (dispute === null) {
    return ['Last observed stored-fact dispute: none recorded in observed daemon run'];
  }

  const { detail } = dispute;

  const lines = [
    'Last observed stored-fact dispute: ' + detail.reason,
    'Dispute observed at: ' + dispute.observedAt,
    'Dispute origin: ' + dispute.origin,
    'Disputed anchor: ' + detail.anchor.blockNumber + ' / ' + detail.anchor.blockHash,
  ];

  for (const [label, fact] of [['First', detail.first], ['Second', detail.second]] as const) {
    lines.push(
      label + ' attempt: ' + fact.attemptId,
      '  Fact: ' + fact.kind + '; provenance: ' + fact.source + '; nonce: ' + fact.nonce,
    );
  }

  lines.push(
    'Neither disputed nonce is established as correct by this diagnostic.',
    'A preparation candidate ID may never have been saved in the journal.',
    'This historical observation can linger; it does not establish a current gate reason.',
  );

  return lines;
}
