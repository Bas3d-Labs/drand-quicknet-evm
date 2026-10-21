import type {
  JournalBoundViolation,
} from './journal-bounds.js';

export class JournalBoundsExceededError extends Error {
  readonly violations: readonly JournalBoundViolation[];

  constructor(
    violations: readonly JournalBoundViolation[],
  ) {
    if (violations.length === 0) {
      throw new TypeError('Expected at least one journal bound violation.');
    }

    const captured = Object.freeze(
      violations.map((violation) => Object.freeze({
        ...violation,
      })),
    );

    super(captured.map((violation) => violation.message).join(' '));

    this.name = 'JournalBoundsExceededError';
    this.violations = captured;
  }
}