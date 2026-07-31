// Selectors matching these patterns are excluded from duplicate detection and
// consolidation by default. Grouping a vendor-prefixed pseudo-class/element
// into a shared selector list is risky: Browsers that don’t recognize it can
// drop the entire rule, not just that one selector. Legacy hacks that rely on
// a selector being invalid/valid in specific browsers have the same problem.
export const DEFAULT_IGNORE_PATTERNS = [
  /::?-(?:moz|webkit|ms|o)-/i, // vendor-prefixed pseudo-classes/elements
  /\*\s*html/i,                // IE6 star-html hack
  /\*\s*\+\s*html/i,           // IE7 star-plus-html hack
];

// `lastIndex` is reset per pattern: A caller-supplied `ignoreSelectors` entry
// may carry the `g` or `y` flag, and `test()` advances that cursor, so the same
// selector would otherwise match only on every other call
export function isIgnoredSelector(selector, patterns = DEFAULT_IGNORE_PATTERNS) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(selector);
  });
}

export function resolveIgnorePatterns({ ignoreSelectors = [], ignoreSelectorsDefaults = true } = {}) {
  return [
    ...(ignoreSelectorsDefaults ? DEFAULT_IGNORE_PATTERNS : []),
    ...ignoreSelectors,
  ];
}