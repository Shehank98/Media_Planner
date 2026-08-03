// ---------------------------------------------------------------------------
// PT / Non-PT and Value Addition / Spot classification.
//
// The prime-time boundary is a setting, not a constant (the spec is explicit:
// "The boundary may change later"). Defaults follow the brief - Non-PT is
// 06:00-18:00, PT is 18:00-24:00 - and everything outside a stated PT window
// falls to Non-PT. Category comes from the theme -> category map; an unmapped
// theme defaults to Spot so nothing is silently dropped, and the planner is
// shown the unmapped themes to classify.
// ---------------------------------------------------------------------------

/** Hour (0-23) from a "HH:MM" or "HH:MM:SS" clock string, or null. */
export function hourOf(clock) {
  if (clock === null || clock === undefined) return null;
  const m = String(clock).trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/**
 * Classify a clock time as PT or Non-PT.
 *
 * @param {string} clock         advt_time, e.g. "20:05"
 * @param {Object} [b]           boundary { ptStartHour, ptEndHour }
 * @returns {'PT'|'Non-PT'|null}  null only when the time is unreadable
 */
export function daypartForTime(clock, { ptStartHour = 18, ptEndHour = 24 } = {}) {
  const h = hourOf(clock);
  if (h === null) return null;
  // A window that wraps midnight (e.g. 18 -> 02) is still one PT block.
  const inPt = ptEndHour <= ptStartHour
    ? (h >= ptStartHour || h < ptEndHour)
    : (h >= ptStartHour && h < ptEndHour);
  return inPt ? 'PT' : 'Non-PT';
}

/**
 * Category for a theme.
 *
 * @param {string} theme        Advt_Theme
 * @param {Map<string,string>} map  lowercased theme -> 'Value Addition' | 'Spot'
 * @returns {'Value Addition'|'Spot'}
 */
export function categoryForTheme(theme, map) {
  const key = String(theme || '').trim().toLowerCase();
  if (key && map && map.has(key)) return map.get(key);
  return 'Spot';
}
