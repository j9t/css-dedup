/**
 * TypeScript type definition tests
 *
 * This file is compiled by TypeScript during testing to verify that the
 * declaration files are valid and types are correctly exported and usable.
 *
 * This file is not executed—it only needs to type-check successfully.
 */

import postcss from 'postcss';
import { analyze, analyzeRoot, dedup, dedupRoot } from './index.js';
import type { AnalyzeResult, DedupResult } from './index.js';
import cssdedup from './plugin.js';

// `analyze` accepts a CSS string and an options object, and returns `{ findings }`
const analyzeResult: AnalyzeResult = analyze('.a { color: red; color: red; }', {
  from: 'test.css',
  ignoreSelectors: [/^\.legacy-/, '*html'],
  ignoreSelectorsDefaults: false,
  aggressive: true,
});
const { findings } = analyzeResult;

// `dedup` accepts a CSS string, and returns `{ css, applied, skipped, bytes }`
const dedupResult: DedupResult = dedup('.a { color: red; color: red; }', { savingsOnly: true });
const { css, applied, skipped, bytes, withheld } = dedupResult;

// `analyzeRoot`/`dedupRoot` operate on an already-parsed PostCSS root instead of a CSS string
const root = postcss.parse('.a { color: red; }');
analyzeRoot(root);
dedupRoot(root, { aggressive: true });

// `analyze`/`dedup` reject non-string input
// @ts-expect-error
analyze(null);
// @ts-expect-error
dedup(42);

// The PostCSS plugin factory accepts the shared options plus `fix`, and returns a usable plugin
const plugin = cssdedup({ fix: true, aggressive: true, savingsOnly: true });
postcss([plugin]);

// @ts-expect-error
cssdedup({ fix: 'yes' });

export { findings, css, applied, skipped, bytes, withheld, plugin };
