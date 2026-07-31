// The memoization the hot paths rely on is all per run: reused across one
// style sheet’s passes, never carried over to the next. A long-lived process
// (a PostCSS watch build) must not accumulate every selector, property, or
// container it has ever seen—so both top-level entry points reset here first.

import { resetPropertyCache } from './normalization.js';
import { resetSelectorCaches } from './selectors.js';
import { resetSeparatorCache } from './style.js';

export function resetCaches() {
  resetSelectorCaches();
  resetPropertyCache();
  resetSeparatorCache();
}
