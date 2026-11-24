import {
  SignerRestartRequiredError,
} from '../state/signer-restart-required-error.js';

import {
  submissionRecording,
} from '../state/transaction-manager.js';

/** Recognizes the typed failure directly or in one registered submission. */
export function isSignerRestartFailure(error: unknown): boolean {
  try {
    if (error instanceof SignerRestartRequiredError) {
      return true;
    }

    if (submissionRecording(error) === undefined) {
      return false;
    }

    const cause = Object.getOwnPropertyDescriptor(error, 'cause');

    return cause !== undefined &&
      Object.hasOwn(cause, 'value') &&
      cause.value instanceof SignerRestartRequiredError;
  } catch {
    // Uninspectable errors do not acquire fatal classification.
    return false;
  }
}
