// Appending one array to another with `target.push(...source)` passes every
// element as a function argument, and V8 caps that at a few tens of thousands
// before throwing "Maximum call stack size exceeded". A media watch spot log or
// an adex workbook is well past that, so the spread form turned a large upload
// into a 500. Append in a loop instead: no argument-count limit, same result.

/** Append every element of `source` onto `target` in place. Returns `target`. */
export function pushAll(target, source) {
  if (!source) return target;
  for (let i = 0; i < source.length; i += 1) target.push(source[i]);
  return target;
}
