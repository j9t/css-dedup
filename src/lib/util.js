// Small helpers shared across the engine. Kept allocation-free—every one of
// them sits on a hot path (the merge-safety scan calls into all three).

// Reads `key` from `cache`, computing and storing it on a miss. `compute` is
// called as `compute(key, extra)`, so a two-argument computation passes its
// second argument through rather than closing over it—a closure allocated per
// lookup would cost more than the cache saves.
export function memoized(cache, key, compute, extra) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const computed = compute(key, extra);
  cache.set(key, computed);
  return computed;
}

// Appends to a `Map`’s array value, creating the array on first use
export function pushTo(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

// Every `decl` node directly inside `container`, skipping comments and any
// nested rules (which belong to their own scope)
export function declsOf(container) {
  return container.nodes.filter(node => node.type === 'decl');
}
