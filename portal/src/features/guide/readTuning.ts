/**
 * Defensive readers for the opaque tuning blob (plan §8.9).
 *
 * `GET /content/tables` is documented as balance tuning whose nested shape is
 * **explicitly not part of the frozen v1 contract** — it is re-tuned routinely.
 * So the Guide never destructures it. It asks for a path, gets a value only if
 * that value is actually the type it wanted, and otherwise omits the sentence.
 *
 * The result: a balance patch can rename or drop any key and the Guide loses a
 * line of prose rather than throwing, and the Portal never has to be redeployed
 * in step with a tuning change.
 */

function walk(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A finite number at `path`, or `null`. */
export function readNumber(source: unknown, ...path: string[]): number | null {
  const value = walk(source, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-empty string at `path`, or `null`. */
export function readString(source: unknown, ...path: string[]): string | null {
  const value = walk(source, path);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** A boolean at `path`, or `null`. */
export function readBoolean(source: unknown, ...path: string[]): boolean | null {
  const value = walk(source, path);
  return typeof value === 'boolean' ? value : null;
}

/**
 * A `{ key: number }` map at `path`, keeping only the numeric entries.
 *
 * Used for `capture.baseRatesByRarity`. Returns `null` rather than an empty
 * object when nothing usable is there, so a caller can drop the whole section.
 */
export function readNumberRecord(
  source: unknown,
  ...path: string[]
): Record<string, number> | null {
  const value = walk(source, path);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : null;
}
