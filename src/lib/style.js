// Reading the style sheet’s own formatting conventions, so consolidated
// output matches what the file already does. Every one of these is a majority
// vote over what’s already in the source, never a fixed house style.

import { splitSelectors, hasSpacedTopLevelComma } from './selectors.js';
import { memoized } from './util.js';

const RE_MULTILINE_SELECTOR_SEPARATOR = /,\s*\n/;
const RE_TRAILING_INDENT = /[ \t]*$/;

// Memoized per container for one run, by node identity: by the time a second
// residual asks, the container already holds the residuals this run inserted
// (each carrying this very separator), so a fresh tally would count its own
// output.
let separatorCache = new WeakMap();

export function resetSeparatorCache() {
  separatorCache = new WeakMap();
}

// The gap most sibling nodes carry—the container’s prevailing “normal”
// separation between rules. A majority vote, not just whichever neighbor is
// handy, since that neighbor can be the anomaly. A gap straight after a
// comment is skipped rather than voted on: it’s comment-to-rule attachment
// spacing, near-always tight regardless of the file’s rule-to-rule
// convention.
export function typicalSeparator(container) {
  return memoized(separatorCache, container, computeTypicalSeparator);
}

function computeTypicalSeparator(container) {
  const counts = new Map();
  for (let i = 1; i < container.nodes.length; i++) {
    if (container.nodes[i - 1].type === 'comment') continue;
    const before = container.nodes[i].raws.before ?? '\n';
    counts.set(before, (counts.get(before) ?? 0) + 1);
  }

  let best = '\n';
  let bestCount = 0;
  for (const [before, count] of counts) {
    if (count > bestCount) { best = before; bestCount = count; }
  }
  return best;
}

// Tallies every rule into one of two buckets and returns whether the first
// wins—the shared shape of the three convention votes below. `classify`
// returns `true`, `false`, or `null` to abstain.
function majority(root, classify) {
  let yes = 0;
  let no = 0;
  root.walkRules(rule => {
    const verdict = classify(rule);
    if (verdict === true) yes++;
    else if (verdict === false) no++;
  });
  return { yes, no, decided: yes > 0 || no > 0 };
}

// Whether multi-selector rules are written one selector per line (`.a,\n.b`)
// rather than inline (`.a, .b`). Ties and files with no multi-selector rule
// default to inline.
export function usesMultilineSelectors(root) {
  const { yes, no } = majority(root, rule => (
    splitSelectors(rule.selector).length < 2 ? null : RE_MULTILINE_SELECTOR_SEPARATOR.test(rule.selector)
  ));
  return yes > no;
}

// Whether inline selector lists put a space after the comma (`.a, .b`) rather
// than not (`.a,.b`, as a minifier writes it). Only rules already written
// inline count—a multiline rule says nothing about inline comma spacing.
export function usesSpacedCommas(root) {
  const { yes, no, decided } = majority(root, rule => (
    RE_MULTILINE_SELECTOR_SEPARATOR.test(rule.selector) ? null : hasSpacedTopLevelComma(rule.selector)
  ));
  if (decided) return yes >= no;

  // No multi-selector rule to learn from (the merge about to run may be
  // creating the file’s first)—fall back to whether rules already omit the
  // space before their opening brace, which a minifier strips just as
  // consistently
  return usesSpacedBraces(root);
}

function usesSpacedBraces(root) {
  const { yes, no } = majority(root, rule => (rule.raws.between ?? ' ') !== '');
  return yes >= no;
}

export function joinSelectors(selectors, rule, multiline, spacedCommas) {
  if (!multiline) return selectors.join(spacedCommas ? ', ' : ',');
  const indent = (rule.raws.before ?? '').match(RE_TRAILING_INDENT)[0];
  return selectors.join(`,\n${indent}`);
}

// Inserts `node` after `anchor` and gives it `separator`. The assignment has
// to follow the insertion: for a rule sitting directly in the root,
// `Root#normalize()` overwrites a freshly inserted node’s `raws.before` with
// its anchor’s own, discarding whatever the node already carried.
export function insertAfter(anchor, node, separator) {
  anchor.after(node);
  node.raws.before = separator;
}
