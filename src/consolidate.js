// Consolidation: the run context, the fixed-point loop driving the merge
// strategies in `merge.js`, and the `savingsOnly` gate.

import postcss from 'postcss';
import { resetCaches } from './lib/caches.js';
import { resolveIgnorePatterns } from './lib/hacks.js';
import { declarationKey, normalizeProp } from './lib/normalization.js';
import { foldSameSelectorRules, mergeDuplicateGroups, removeRedundantDuplicates } from './merge.js';
import {
  atRuleLabel,
  collectDeclOnlyContainers,
  collectMergedScopes,
  collectScopes,
  describeScope,
  eligibleRules,
  ownSelectors,
} from './lib/scopes.js';
import { usesMultilineSelectors, usesSpacedCommas } from './lib/style.js';

// Conditional group rules whose empty block is inert. `@layer` is deliberately
// absent: a layer’s position in the layer order is set by its first
// appearance, so removing an emptied early `@layer x {}` shell could reorder
// the cascade.
const INERT_WHEN_EMPTY_ATRULES = new Set(['media', 'supports', 'container']);

// Aggressive mode’s cross-block merges can drain the earlier of two
// same-condition blocks completely. This removes such blocks—only ones this
// run emptied, and only where emptiness is provably inert. The walk collects
// candidates parents-first, so the reverse pass sees each inner block before
// its parent and a parent emptied by its child’s removal is caught in the same
// sweep.
function removeEmptiedConditionBlocks(root, initiallyEmpty) {
  const candidates = [];
  root.walkAtRules(atrule => {
    if (INERT_WHEN_EMPTY_ATRULES.has(atrule.name.toLowerCase())) candidates.push(atrule);
  });

  for (const atrule of candidates.reverse()) {
    if (atrule.nodes && !atrule.nodes.length && !initiallyEmpty.has(atrule)) atrule.remove();
  }
}

// Everything the merge strategies need from this run. The normalization mode
// is bound once here, so no call site can fall back to default-mode
// normalization by forgetting a flag—which would silently give one declaration
// two different keys in different phases of an aggressive run.
function createContext(root, options, settle) {
  const aggressive = options.aggressive ?? false;
  return {
    aggressive,
    ignorePatterns: resolveIgnorePatterns(options),
    keyOf: decl => declarationKey(decl.prop, decl.value, decl.important, aggressive),
    propOf: prop => normalizeProp(prop, aggressive),
    multilineSelectors: usesMultilineSelectors(root),
    spacedCommas: usesSpacedCommas(root),
    applied: [],
    skipped: [],
    // The `savingsOnly` gate in `merge.js` needs the whole style sheet to
    // weigh one merge (a cross-block merge’s saving lands outside the scope it
    // happens in) and `settle()` to see the state it would actually ship
    savingsOnly: options.savingsOnly ?? false,
    root,
    settle,
    // Running size of the style sheet, carried between clusters (see `gated()`)
    bytesNow: null,
    declined: [],
  };
}

// One pass of every strategy, in dependency order: verbatim repeats collapse
// first (so the cross-container passes only ever see one occurrence per
// container per key), then same-selector folds, then declaration merges.
function runPass(root, ctx) {
  // Aggressive mode merges same-condition blocks into one scope, accepting
  // that rules from other scopes sitting between the blocks stay invisible to
  // the intervening-rule check; default mode keeps one scope per physical
  // container
  const scopes = ctx.aggressive ? collectMergedScopes(root) : collectScopes(root);

  for (const scope of scopes) {
    for (const rule of eligibleRules(scope, ctx.ignorePatterns)) {
      ctx.applied.push(...removeRedundantDuplicates(ctx, rule, scope.label, ownSelectors(rule.selector)));
    }
  }
  for (const atrule of collectDeclOnlyContainers(root)) {
    ctx.applied.push(...removeRedundantDuplicates(ctx, atrule, describeScope(atrule), [atRuleLabel(atrule)]));
  }
  for (const scope of scopes) foldSameSelectorRules(ctx, scope);
  for (const scope of scopes) mergeDuplicateGroups(ctx, scope);
}

function consolidateRoot(root, options = {}) {
  resetCaches();

  // Taken before any mutation, so it reflects the file as it stood on disk.
  // Bytes, not characters—the effectiveness this measures (fewer bytes over
  // the wire) is a transfer-size concern.
  const before = Buffer.byteLength(root.toString(), 'utf8');

  // Blocks already empty in the source, so the cleanup at the end only ever
  // removes what this run emptied
  const initiallyEmpty = new Set();
  const aggressive = options.aggressive ?? false;
  if (aggressive) {
    root.walkAtRules(atrule => {
      if (atrule.nodes && !atrule.nodes.length) initiallyEmpty.add(atrule);
    });
  }

  // Bringing the style sheet to the state it would ship in. Idempotent, so the
  // gate can call it around every merge it weighs and the run can call it once
  // more at the end.
  const settle = () => {
    if (aggressive) removeEmptiedConditionBlocks(root, initiallyEmpty);
  };
  const ctx = createContext(root, options, settle);

  // One merge can unblock or create another: a fresh merged rule may twin with
  // an existing one, and an emptied rule stops fencing the spans it sat in—so
  // passes repeat until nothing changes. Termination is guaranteed, since
  // every productive pass strictly reduces the number of declarations or
  // rules. `skipped` is rebuilt each pass, so it describes what remains at the
  // end, not intermediate states.
  let appliedCount = -1;
  while (ctx.applied.length !== appliedCount) {
    appliedCount = ctx.applied.length;
    ctx.skipped.length = 0;
    ctx.declined.length = 0;
    // The phases before the gated merges change the style sheet, so the
    // running size has to be taken afresh each pass
    ctx.bytesNow = null;
    runPass(root, ctx);
  }

  settle();

  const after = Buffer.byteLength(root.toString(), 'utf8');
  return {
    applied: ctx.applied,
    skipped: ctx.skipped,
    declined: ctx.declined,
    bytes: { before, after, saved: before - after },
  };
}

// The `savingsOnly` gate is decided per cluster, inside `merge.js`: Every
// merge that would grow the style sheet is performed, measured, and undone,
// leaving the ones that pay for themselves in place. A file therefore keeps
// its savings even when other merges in it would have cost more than the whole
// consolidation gains—the case that used to sink every merge in the file with
// it. A net-zero merge still applies (deduplicated at no byte cost).
//
// What was declined arrives as `withheld: { count, bytes }`: How many merges,
// and the byte counts the style sheet would have had with them applied, too.
// Absent when nothing was declined.
export function dedupRoot(root, options = {}) {
  const { declined, ...result } = consolidateRoot(root, options);
  if (!declined.length) return result;

  // Clusters are independent by construction, so the cost of applying the
  // declined merges as well is the sum of what each was measured to cost
  const cost = declined.reduce((total, entry) => total + entry.cost, 0);
  const count = declined.reduce((total, entry) => total + entry.count, 0);
  return {
    ...result,
    withheld: {
      count,
      bytes: { before: result.bytes.after, after: result.bytes.after + cost, saved: -cost },
    },
  };
}

// A `/*# sourceMappingURL=… */` comment means a build tool generated this
// style sheet alongside a source map. Consolidation shifts the positions that
// map records, so it stops describing the file—reported, never removed or
// regenerated.
const RE_SOURCE_MAP = /^#\s*sourceMappingURL=/;

// Matched against parsed comments rather than raw text: the same string in a
// declaration value (`content: "/*# sourceMappingURL=… */"`) parses as a
// value, not an annotation, and mustn’t count as one
function referencesSourceMap(root) {
  let found = false;
  root.walkComments(comment => {
    if (!RE_SOURCE_MAP.test(comment.text)) return undefined;
    found = true;
    return false;
  });
  return found;
}

export function dedup(css, options = {}) {
  const root = postcss.parse(css, { from: options.from });
  const result = dedupRoot(root, options);
  // Only a rewrite invalidates the map: a run that applied nothing (or had its
  // consolidation withheld) leaves the style sheet exactly as it was
  const stale = result.applied.length > 0 && referencesSourceMap(root);
  return { css: root.toString(), ...result, ...(stale && { sourceMapStale: true }) };
}
