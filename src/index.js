// Public entry point. The engine itself lives in `analyze.js` (read-only
// detection) and `consolidate.js` (the rewriting passes); the README’s
// “Working on CSS Dedup” maps the modules.

export { analyze, analyzeRoot } from './analyze.js';
export { dedup, dedupRoot } from './consolidate.js';
