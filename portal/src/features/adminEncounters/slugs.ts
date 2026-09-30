/**
 * Slug/key generation for new encounters and vendors.
 *
 * The API's create routes are **upserts keyed on slug** for encounters (a
 * POST with an existing slug replaces that encounter), so a generated slug
 * must never collide with one that exists. {@link uniqueSlug} is how the
 * editor guarantees that without asking the author to think about it.
 */

/** The server's slug rule: lowercase snake_case, 1–64 characters. */
export const SLUG_PATTERN = /^[a-z0-9_]+$/;
export const SLUG_MAX = 64;

export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX && SLUG_PATTERN.test(value);
}

/** "A Strange Door!" → "a_strange_door". Falls back to `fallback` when nothing survives. */
export function slugify(name: string, fallback = 'encounter'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/_+$/g, '');
  return slug || fallback;
}

/** `base`, or `base_2`, `base_3`… — the first one not in `taken`. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
