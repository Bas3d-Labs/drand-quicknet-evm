const MAX_INPUT_LENGTH = 65_536;
const MAX_OUTPUT_LENGTH = 4_096;
const MIN_INFERRED_SECRET_LENGTH = 16;
const REDACTED = '[REDACTED]';

const AUTH_HEADER_PATTERN =
  /\b(?:proxy-authorization|authorization)\b/gi;

const AUTH_TOKEN_PATTERN =
  /\b(?:Bearer|Basic)[ \t]+[a-z0-9._~+/=-]+/gi;
  
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>\\]+/gi;

const CREDENTIAL_QUERY_NAMES = new Set([
  'apikey',
  'api_key',
  'key',
  'token',
  'access_token',
  'auth',
  'secret',
  'password',
]);

const UNSAFE_CONTROLS = new RegExp(
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f' +
  '\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);

export interface CreateScrubberOptions {
  rpcUrls: readonly string[];
  privateKey?: string;
  secrets?: readonly string[];
}

export interface ScrubbedText {
  text: string;
  removed: boolean;
}

interface TextRange {
  start: number;
  end: number;
}

export function createScrubber(
  options: CreateScrubberOptions,
): (text: string) => ScrubbedText {
  const configuredUrls = new Set<string>();
  const secrets = new Map<string, boolean>();

  function addSecret(
    value: string,
    ignoreCase = false,
  ): void {
    if (value.length === 0) {
      return;
    }

    // Include literal, JSON-escaped, and once/twice URL-encoded forms.
    let encoded = value;

    for (let index = 0; index < 3; index += 1) {
      const forms = [
        encoded,
        JSON.stringify(encoded).slice(1, -1),
      ];

      for (const form of forms) {
        secrets.set(
          form,
          ignoreCase || secrets.get(form) === true,
        );
      }

      encoded = encodeURIComponent(encoded);
    }
  }

  function addUrlValue(
    value: string,
    required = false,
  ): void {
    const forms = [value];

    // URL properties may already contain percent-encoded credentials.
    for (let index = 0; index < 2; index += 1) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) {
          break;
        }

        value = decoded;
        forms.push(value);
      } catch {
        break;
      }
    }

    // The threshold limits over-removal. Shorter values can still be secrets.
    if (!required && value.length < MIN_INFERRED_SECRET_LENGTH) {
      return;
    }

    for (const form of forms) {
      addSecret(form);
    }
  }

  for (const value of options.rpcUrls) {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new TypeError('Invalid RPC URL for diagnostic scrubbing.');
    }

    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new TypeError('Unsupported RPC URL protocol for scrubbing.');
    }

    configuredUrls.add(value);
    configuredUrls.add(url.href);

    // Whole encoded URLs remain opaque secret strings.
    // Ordinary URLs are handled by component redaction below.
    addSecret(encodeURIComponent(value));
    addSecret(encodeURIComponent(url.href));

    addUrlValue(url.username, true);
    addUrlValue(url.password, true);

    // Infer long component secrets. Named credentials bypass the threshold.
    for (const segment of url.pathname.split('/')) {
      addUrlValue(segment);
    }

    for (const [name, queryValue] of url.searchParams) {
      addUrlValue(
        queryValue,
        CREDENTIAL_QUERY_NAMES.has(name.toLowerCase()),
      );
    }

    addUrlValue(url.hash.slice(1));
  }

  for (const secret of options.secrets ?? []) {
    addSecret(secret);
  }

  if (options.privateKey !== undefined) {
    let key = options.privateKey;

    if (key.startsWith('0x') || key.startsWith('0X')) {
      key = key.slice(2);
    }

    if (key.length !== 64 || ![...key].every(isHexDigit)) {
      throw new TypeError(
        'Invalid private key for diagnostic scrubbing.',
      );
    }

    addSecret(key, true);
    addSecret(`0x${key}`, true);
  }

  const exactSecrets = new Set<string>();
  const foldedSecrets = new Set<string>();

  for (const [value, ignoreCase] of secrets) {
    const normalized = normalizePercentEscapes(value);

    if (ignoreCase) {
      foldedSecrets.add(lowercaseAscii(normalized));
    } else {
      exactSecrets.add(normalized);
    }
  }

  return function scrub(text: string): ScrubbedText {
    if (text.length > MAX_INPUT_LENGTH) {
      return {
        text: '[diagnostic text omitted: input limit]',
        removed: true,
      };
    }

    const ranges: TextRange[] = [];
    const normalized = normalizePercentEscapes(text);

    for (const secret of exactSecrets) {
      collectLiteralRanges(normalized, secret, ranges);
    }

    if (foldedSecrets.size > 0) {
      const folded = lowercaseAscii(normalized);

      for (const secret of foldedSecrets) {
        collectLiteralRanges(folded, secret, ranges);
      }
    }

    collectUrlRanges(text, ranges, configuredUrls);
    collectUrlRanges(text, ranges, configuredUrls);
    collectAuthorizationRanges(text, ranges);

    for (const match of text.matchAll(AUTH_TOKEN_PATTERN)) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    let output = redactRanges(text, ranges);

    output = output.replace(
      UNSAFE_CONTROLS,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );

    let removed = ranges.length > 0 || output !== text;

    // Truncate only after scrubbing, so a cut cannot expose a secret prefix.
    if (output.length > MAX_OUTPUT_LENGTH) {
      const suffix = ' [truncated]';

      output =
        output.slice(0, MAX_OUTPUT_LENGTH - suffix.length) +
        suffix;

      removed = true;
    }

    return { text: output, removed };
  };
}

export function lowercaseAscii(text: string): string {
  const characters: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code >= 65 && code <= 90) {
      characters.push(String.fromCharCode(code + 32));
    } else {
      characters.push(text.charAt(index));
    }
  }

  return characters.join('');
}

export function normalizePercentEscapes(text: string): string {
  const characters = text.split('');

  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) !== '%') {
      continue;
    }

    let digit = index + 1;

    // %25 represents an encoded percent sign.
    // Skip nested encodings before normalizing the final hex pair.
    while (text.startsWith('25', digit)) {
      digit += 2;
    }

    if (
      isHexDigit(text.charAt(digit)) &&
      isHexDigit(text.charAt(digit + 1))
    ) {
      characters[digit] = text.charAt(digit).toLowerCase();
      characters[digit + 1] =
        text.charAt(digit + 1).toLowerCase();

      index = digit + 1;
    } else {
      index = digit - 1;
    }
  }

  return characters.join('');
}

function collectUrlRanges(
  text: string,
  ranges: TextRange[],
  configuredUrls: ReadonlySet<string>,
): void {
  const view = unescapeUrlSlashes(text);
  const candidates = new Map<number, string>();

  for (const match of view.text.matchAll(URL_PATTERN)) {
    candidates.set(match.index, match[0]);
  }

  // A configured URL can contain a quote that ends the generic match early.
  for (const url of configuredUrls) {
    let start = view.text.indexOf(url);
    
    while (start !== -1) {
      const existing = candidates.get(start);
      if (existing === undefined || url.length > existing.length) {
        candidates.set(start, url);
      }

      start = view.text.indexOf(url, start + 1);
    }
  }

  function addRange(start: number, end: number): void {
    // Every view boundary has an original offset, including the final one.
    ranges.push({
      start: view.offsets[start]!,
      end: view.offsets[end]!,
    });
  }

  for (const [start, candidate] of candidates) {
    const separator = candidate.indexOf('://');
    if (separator === -1 || candidate.includes('\\')) {
      addRange(start, start + candidate.length);
      continue;
    }

    try {
      new URL(candidate);
    } catch {
      // Hide the whole span if its authority cannot be parsed reliably.
      addRange(start, start + candidate.length);
      continue;
    }

    const authorityStart = separator + 3;
    let authorityEnd = authorityStart;

    while (
      authorityEnd < candidate.length &&
      !'/?#'.includes(candidate.charAt(authorityEnd))
    ) {
      authorityEnd += 1;
    }

    const userInfoEnd = candidate.lastIndexOf('@', authorityEnd - 1);
    if (userInfoEnd >= authorityStart) {
      addRange(
        start + authorityStart,
        start + userInfoEnd,
      );
    }

    // Preserve the first separator, then hide path/query/fragment contents.
    const suffixStart = authorityEnd + 1;
    if (suffixStart < candidate.length) {
      addRange(
        start + suffixStart,
        start + candidate.length,
      );
    }
  }
}

function unescapeUrlSlashes(text: string): {
  text: string;
  offsets: number[];
} {
  const characters: string[] = [];
  const offsets: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    offsets.push(index);

    if (
      text.charAt(index) === '\\' &&
      text.charAt(index + 1) === '/'
    ) {
      index += 1;
    }

    characters.push(text.charAt(index));
  }

  offsets.push(text.length);

  return {
    text: characters.join(''),
    offsets,
  };
}

function collectLiteralRanges(
  text: string,
  secret: string,
  ranges: TextRange[],
): void {
  if (secret.length === 0) {
    return;
  }

  let start = text.indexOf(secret);

  while (start !== -1) {
    ranges.push({
      start,
      end: start + secret.length,
    });

    // Advance one character so overlapping occurrences remain visible.
    start = text.indexOf(secret, start + 1);
  }
}

function redactRanges(
  text: string,
  ranges: TextRange[],
): string {
  ranges.sort((left, right) => left.start - right.start);

  const merged: TextRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);

    if (
      previous !== undefined &&
      range.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const parts: string[] = [];
  let cursor = 0;

  for (const range of merged) {
    parts.push(
      text.slice(cursor, range.start),
      REDACTED,
    );

    cursor = range.end;
  }

  parts.push(text.slice(cursor));

  return parts.join('');
}

function collectAuthorizationRanges(
  text: string,
  ranges: TextRange[],
): void {
  let coveredUntil = 0;

  for (const match of text.matchAll(AUTH_HEADER_PATTERN)) {
    if (match.index < coveredUntil) {
      continue;
    }

    let cursor = match.index + match[0].length;

    // Permit a quoted field name, such as "Authorization": "...".
    if (
      text.charAt(cursor) === '"' ||
      text.charAt(cursor) === "'"
    ) {
      cursor += 1;
    }

    cursor = skipHorizontalWhitespace(text, cursor);

    if (
      text.charAt(cursor) !== ':' &&
      text.charAt(cursor) !== '='
    ) {
      continue;
    }

    let start = skipHorizontalWhitespace(text, cursor + 1);
    let quote = '';

    if (
      text.charAt(start) === '"' ||
      text.charAt(start) === "'"
    ) {
      quote = text.charAt(start);
      start += 1;
    }

    let end = start;
    while (end < text.length) {
      const character = text.charAt(end);
      if (character === '\r' || character === '\n') {
        break;
      }

      if (quote !== '') {
        if (character === quote) {
          break;
        }

        if (
          character === '\\' &&
          end + 1 < text.length &&
          text.charAt(end + 1) !== '\r' &&
          text.charAt(end + 1) !== '\n'
        ) {
          end += 2;
          continue;
        }
      } else if (
        character === ',' ||
        character === ';' ||
        character === '}'
      ) {
        break;
      }

      end += 1;
    }

    if (end > start) {
      ranges.push({
        start,
        end
      });
    }

    // Avoid rescanning header-like text inside an already covered value.
    coveredUntil = end;
  }
}

function skipHorizontalWhitespace(
  text: string,
  start: number,
): number {
  let cursor = start;

  while (
    text.charAt(cursor) === ' ' ||
    text.charAt(cursor) === '\t'
  ) {
    cursor += 1;
  }

  return cursor;
}

function isHexDigit(character: string): boolean {
  return character.length === 1 &&
    '0123456789abcdefABCDEF'.includes(character);
}