/**
 * Executor-enforced bound on the work identity persisted in the journal
 * and exposed through diagnostics, measured in UTF-16 code units.
 */
export const MAX_WORK_ID_LENGTH = 256;

/**
 * Work identifiers are opaque to execution.
 * 
 * Adapters own their namespace, scope, and canonical representation.
 * Execution compares identities exactly, without trimming, case folding,
 * normalization, or parsing adapter-specific fields.
 *  
 * Work identifiers must be well-formed UTF-16.
 * C0/C1 control characters are forbidden because identities appear in
 * diagnostics. This does not establish general Unicode display safety.
 * 
 * An identity names application work, not transaction intent or proof
 * of fulfillment. It must not contain credentials or secrets.
 */
export function isWorkId(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORK_ID_LENGTH ||
    !value.isWellFormed()
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }

  return true;
}