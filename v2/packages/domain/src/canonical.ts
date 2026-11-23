/**
 * Canonical JSON: one stable text for one value.
 *
 * A hash over a JSON document only means something when the same data always
 * produces the same bytes. The canonical form sorts the keys of every object,
 * keeps the order of every array and drops `undefined` members, so two
 * documents that carry the same data hash the same way - no matter in which
 * order the keys were written down.
 */

/** A value that has a canonical JSON form. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/** Recursively sorts the keys of every object inside `value`. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * Renders `value` as canonical JSON.
 *
 * Object keys are sorted, array order is kept and `undefined` members are
 * dropped. `space` indents the result the way `JSON.stringify` does.
 */
export function canonicalJson(value: unknown, space?: number | string): string {
  const text = JSON.stringify(canonicalize(value), null, space);
  return text === undefined ? 'null' : text;
}
