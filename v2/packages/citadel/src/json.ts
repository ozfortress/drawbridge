/**
 * Lossless parsing for Citadel response bodies.
 *
 * Citadel serialises Discord snowflakes and Steam 64 IDs as bare JSON numbers
 * (`123456789012345678`), which `JSON.parse` silently rounds. This parser
 * keeps the exact text of every number that a JavaScript `number` cannot
 * represent safely and returns it as a string; every other value parses to a
 * normal JavaScript value. Malformed bodies raise a typed `CitadelParseError`
 * instead of an anonymous `SyntaxError`.
 *
 * Citadel bodies must always go through `parseCitadelJson`, never `JSON.parse`.
 */
import {
  isLosslessNumber,
  isSafeNumber,
  parse as losslessParse,
  type Reviver,
} from 'lossless-json';

/** Raised when a Citadel response body cannot be parsed or validated. */
export class CitadelParseError extends Error {
  override readonly name = 'CitadelParseError';
}

const revive: Reviver = (_key, value) => {
  if (!isLosslessNumber(value)) return value;
  const { value: literal } = value;
  // Safe values become plain numbers; unsafe ones (every integer beyond
  // Number.MAX_SAFE_INTEGER) stay the exact string Citadel sent.
  return isSafeNumber(literal) ? (value.valueOf() as number) : literal;
};

/** Parses a Citadel body without losing integer precision. */
export function parseCitadelJson(text: string): unknown {
  try {
    return losslessParse(text, revive);
  } catch (cause) {
    throw new CitadelParseError('Citadel returned a malformed JSON body', { cause });
  }
}
