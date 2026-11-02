import {
  submissionRecording,
} from '../state/transaction-manager.js';

export function isOperationCancelled(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal === undefined || !signal.aborted) {
    return false;
  }

  if (error === signal.reason) {
    return true;
  }

  if (submissionRecording(error) === undefined) {
    return false;
  }

  const cause = Object.getOwnPropertyDescriptor(error, 'cause');

  return (
    cause !== undefined &&
    Object.hasOwn(cause, 'value') &&
    cause.value === signal.reason
  );
}