// Identity normalisation for the natural keys used by upserts.
//
// The same channel appears as "TV Derana", "tv derana", "TV  Derana" and
// "TV Derana " across workbooks. If those land as four rows the ratings join
// falls apart, so names are canonicalised on the way in. The `raw` JSONB column
// keeps whatever the source actually said.

/** Title-ish canonical form: collapse whitespace, strip wrapping punctuation. */
export function canonicalName(value) {
  if (value === null || value === undefined) return null;
  const s = String(value)
    .replace(/\s+/g, ' ')
    .replace(/^[\s'"`(\[]+|[\s'"`)\]]+$/g, '')
    .trim();
  return s || null;
}

/** Case-insensitive comparison key. Not stored - used for in-memory dedupe. */
export function comparisonKey(value) {
  const s = canonicalName(value);
  return s ? s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}

/**
 * Key columns in adex_data are NOT NULL DEFAULT '' so the UNIQUE constraint
 * actually fires (NULL != NULL in Postgres). Missing values become ''.
 */
export function keyText(value) {
  const s = canonicalName(value);
  return s === null ? '' : s;
}

/** Split a free-text audience/language field into lowercase tokens for matching. */
export function tokens(value) {
  if (!value) return [];
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}
