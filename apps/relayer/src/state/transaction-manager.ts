import type {
  SubmissionRecording,
} from './transaction-manager-types.js';

const registeredRecordings = new WeakMap<object, SubmissionRecording>();

function captureSubmissionRecording(
  recording: SubmissionRecording,
): SubmissionRecording {
  switch (recording.status) {
    case 'none':
      return Object.freeze({
        status: 'none',
      });

    case 'uncertain':
      return Object.freeze({
        status: 'uncertain',
        attempt: Object.freeze({
          workId: recording.attempt.workId,
          attemptId: recording.attempt.attemptId,
        }),
      });

    case 'retained':
      return Object.freeze({
        status: 'retained',
        attempt: Object.freeze({
          workId: recording.attempt.workId,
          attemptId: recording.attempt.attemptId,
        }),
      });
  }
}

class TransactionSubmissionError extends Error {
  constructor(
    cause: unknown,
    recording: SubmissionRecording,
  ) {
    const captured = captureSubmissionRecording(recording);

    super('Transaction submission did not complete.', { cause });

    this.name = 'TransactionSubmissionError';

    registeredRecordings.set(this, captured);
  }
}

export function submissionRecording(
  error: unknown,
): SubmissionRecording | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  return registeredRecordings.get(error);
}