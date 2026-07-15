import postcss from 'postcss';
import { normalizeProp, declarationKey } from './normalization.js';
import { isIgnoredSelector, resolveIgnorePatterns } from './hacks.js';
import { splitSelectors, selectorsAreMutuallyExclusive, selectorsLikelyDisjoint, resetSubjectIdentities } from './selectors.js';
import { propertiesOverlap } from './shorthands.js';

function normalizeScopeSegment(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// An anonymous `@layer {}` block is its own, distinct cascade layer—unlike
// two same-name `@layer x {}` blocks, which share one layer—so each block
// gets a unique label and never matches another scope. Keyed by node
// identity (a WeakMap, so labels stay stable across passes within a run and
// entries fall away with their nodes).
const layersAnonymous = new WeakMap();
let layersAnonymousCount = 0;

function atRuleScopeSegment(node) {
  if (node.name.toLowerCase() === 'layer' && !node.params.trim()) {
    if (!layersAnonymous.has(node)) layersAnonymous.set(node, ++layersAnonymousCount);
    return `@layer (anonymous ${layersAnonymous.get(node)})`;
  }
  return normalizeScopeSegment(`@${node.name} ${node.params}`);
}

// A “scope” is a DRY boundary: the root style sheet, or the direct contents of
// one specific `@media`/`@supports`/`@layer`/etc. condition, or one specific
// selector used as a nesting host (native CSS nesting). This computes the
// label identifying that boundary—used both to keep unrelated scopes apart,
// and (see `mergeScopesByLabel()` below) to recognize the same boundary
// when it’s written as two separate physical blocks. The label is always the
// full ancestor chain: a `.card` nesting host at the root and one inside
// `@media print` are different boundaries, so a bare-selector label would
// wrongly identify them (and let aggressive mode merge across the
// condition). Whitespace is normalized here (not case—`@layer` names and
// selectors can be case-sensitive) so `@media (min-width: 768px)` and
// `@media (min-width:768px)` produce the same label regardless of
// formatting.
function describeScope(container) {
  if (container.type === 'root') return 'root';

  const chain = [];
  let node = container;
  while (node && node.type !== 'root') {
    chain.unshift(node.type === 'rule'
      ? normalizeScopeSegment(node.selector)
      : atRuleScopeSegment(node));
    node = node.parent;
  }
  return chain.join(' > ');
}

function compareSourceOrder(a, b) {
  const aStart = a.source?.start;
  const bStart = b.source?.start;
  if (!aStart || !bStart) return 0;
  return aStart.line !== bStart.line ? aStart.line - bStart.line : aStart.column - bStart.column;
}

// Two blocks with the same condition are the same DRY boundary even when
// written separately in the source—two `@media (min-width: 768px) {}`
// blocks apply under the exact same runtime condition, so a declaration
// duplicated across them is exactly as redundant as one repeated within a
// single block. Scopes sharing a label are combined here, with their rules
// re-sorted into true document order.
//
// Safe for reporting, not for merging: A merge keeps the last occurrence’s
// rule in its own original container and deletes the others, so within one
// already-contiguous container nothing’s position relative to the outside
// changes—the container is a firewall the merge-safety “intervening rule”
// check can reason about using just its own rules. Fold two containers into
// one scope and that firewall is gone: A rule sitting between them in the
// raw document (in some other scope entirely) can matter for the merge
// without the intervening-rule check ever seeing it. So `dedupRoot` uses
// `collectScopes()` directly (one scope per physical container, never
// merged); only `analyzeRoot`, which never moves anything, uses the merged
// view via `collectMergedScopes()`—except in aggressive mode, where
// `dedupRoot` accepts exactly this risk and merges across same-condition
// blocks, too.
function mergeScopesByLabel(scopes) {
  const byLabel = new Map();
  const order = [];

  for (const scope of scopes) {
    if (!byLabel.has(scope.label)) {
      byLabel.set(scope.label, { label: scope.label, rules: [] });
      order.push(scope.label);
    }
    byLabel.get(scope.label).rules.push(...scope.rules);
  }

  for (const label of order) {
    byLabel.get(label).rules.sort(compareSourceOrder);
  }

  return order.map(label => byLabel.get(label));
}

function collectScopes(root) {
  const scopes = [];

  function walk(container) {
    // Statement-form at-rules (`@layer reset, base;`, `@import url(x.css);`)
    // have no block, so there’s nothing to scope or recurse into
    if (!container.nodes) return;

    const rules = container.nodes.filter(node => node.type === 'rule');
    if (rules.length) scopes.push({ rules, label: describeScope(container) });

    for (const node of container.nodes) {
      // Recurse into at-rules (`@media`, `@layer`, …) and into rules
      // themselves, since native CSS nesting puts rules inside rules
      if (node.type === 'atrule' || node.type === 'rule') walk(node);
    }
  }

  walk(root);
  return scopes;
}

// See the comment on `mergeScopesByLabel()`: safe for `analyzeRoot()`
// (read-only reporting), not for `dedupRoot()` (which mutates)
function collectMergedScopes(root) {
  return mergeScopesByLabel(collectScopes(root));
}

// At-rules like `@font-face`, `@page`, and `@property` can hold declarations
// directly, with no selector wrapping them—`collectScopes()` above only ever
// looks at `rule`-type nodes, so those declarations would otherwise be
// invisible to any duplicate check. Unlike a scope’s rules, these blocks are
// never compared against each other (there’s no selector list to fold two
// `@font-face` blocks into, and repeating the same declaration across two
// of them usually isn’t a mistake—each still describes its own, independent
// face). This only looks for a declaration repeated within one block.
function collectDeclOnlyContainers(root) {
  const containers = [];

  function walk(container) {
    if (!container.nodes) return;
    if (container.type === 'atrule' && container.nodes.some(node => node.type === 'decl')) {
      containers.push(container);
    }

    for (const node of container.nodes) {
      if (node.type === 'atrule' || node.type === 'rule') walk(node);
    }
  }

  walk(root);
  return containers;
}

// `@font-face`, `@page`, and similar at-rules have no selector of their
// own—this stands in for one, both in scope labels and in occurrence/applied
// output
function atRuleLabel(atrule) {
  return `@${atrule.name}${atrule.params ? ` ${atrule.params}` : ''}`;
}

// Canonical identity of a rule’s selector list, order- and
// whitespace-insensitive—`.b, .a` matches the same elements with the same
// specificities as `.a, .b`. Whitespace is only collapsed outside quotes:
// `[data-x="a  b"]` and `[data-x="a b"]` are different selectors.
function selectorSetKey(rule) {
  return splitSelectors(rule.selector)
    .map(selector => selector.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\s+/g, (match, quoted) => quoted ?? ' '))
    .sort()
    .join(',');
}

function eligibleRules(scope, ignorePatterns) {
  return scope.rules.filter(rule => {
    const selectors = splitSelectors(rule.selector);
    // A rule is only eligible if none of its selectors are ignored—a mixed
    // list like `.foo, *html .bar` can’t have just the hack part dropped,
    // since that would silently orphan the hack selector’s declaration, and
    // it can’t have all parts merged as-is, since that would contaminate the
    // merged rule with a selector meant to stay isolated
    return !selectors.some(selector => isIgnoredSelector(selector, ignorePatterns));
  });
}

export function analyzeRoot(root, options = {}) {
  const ignorePatterns = resolveIgnorePatterns(options);
  const aggressive = options.aggressive ?? false;
  // The normalization mode is bound once per run (see `consolidateRoot()`)
  const keyOf = decl => declarationKey(decl.prop, decl.value, decl.important, aggressive);
  const scopes = collectMergedScopes(root);
  const findings = [];

  for (const scope of scopes) {
    const byKey = new Map();

    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const seenInRule = new Set();

      // Only compare a rule’s own direct declarations—not those of any
      // nested rules inside it, which belong to their own scope
      for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
        const key = keyOf(decl);
        const occurrence = { rule, decl };

        if (seenInRule.has(key)) {
          findings.push({
            scope: scope.label,
            key,
            redundant: true,
            occurrences: [describeOccurrence(occurrence)],
          });
        }
        seenInRule.add(key);

        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(occurrence);
      }
    }

    for (const [key, occurrences] of byKey) {
      const distinctRules = new Set(occurrences.map(occ => occ.rule));
      if (distinctRules.size < 2) continue;

      findings.push({
        scope: scope.label,
        key,
        occurrences: [...distinctRules].map(rule => describeOccurrence({ rule, decl: findDecl(occurrences, rule) })),
      });
    }
  }

  // A selector (list) written more than once within one scope is the same
  // maintainability smell one level up from a repeated declaration—the
  // later rule could hold its declarations in the earlier one. Detected on
  // physical containers (like `--fix`’s fold, not the merged reporting
  // view above), since two same-condition `@media` blocks legitimately
  // repeat their selectors by construction.
  for (const scope of collectScopes(root)) {
    const bySelector = new Map();
    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const key = selectorSetKey(rule);
      if (!bySelector.has(key)) bySelector.set(key, []);
      bySelector.get(key).push(rule);
    }

    for (const rules of bySelector.values()) {
      if (rules.length < 2) continue;
      findings.push({
        scope: scope.label,
        key: splitSelectors(rules[0].selector).join(', '),
        repeated: true,
        occurrences: rules.map(rule => ({
          selector: rule.selector,
          selectors: splitSelectors(rule.selector),
          line: rule.source?.start?.line,
        })),
      });
    }
  }

  for (const atrule of collectDeclOnlyContainers(root)) {
    const seenInAtrule = new Set();

    for (const decl of atrule.nodes.filter(node => node.type === 'decl')) {
      const key = keyOf(decl);

      if (seenInAtrule.has(key)) {
        findings.push({
          scope: describeScope(atrule),
          key,
          redundant: true,
          occurrences: [describeAtRuleOccurrence(atrule, decl)],
        });
      }
      seenInAtrule.add(key);
    }
  }

  return { findings };
}

export function analyze(css, options = {}) {
  const root = postcss.parse(css, { from: options.from });
  return analyzeRoot(root, options);
}

function findDecl(occurrences, rule) {
  return occurrences.find(occ => occ.rule === rule).decl;
}

function describeOccurrence({ rule, decl }) {
  return {
    selector: rule.selector,
    selectors: splitSelectors(rule.selector),
    prop: decl.prop,
    value: decl.value,
    line: decl.source?.start?.line,
    decl,
  };
}

// Mirrors `describeOccurrence()` for an at-rule with no selector of its
// own (`@font-face`, `@page`, …)—the at-rule’s own `@name params` stands in
// for the selector, both for CLI/plugin output and for callers that read
// `occurrences[].selector`
function describeAtRuleOccurrence(atrule, decl) {
  const label = atRuleLabel(atrule);
  return {
    selector: label,
    selectors: [label],
    prop: decl.prop,
    value: decl.value,
    line: decl.source?.start?.line,
    decl,
  };
}

const RE_MULTILINE_SELECTOR_SEPARATOR = /,\s*\n/;
const RE_TRAILING_INDENT = /[ \t]*$/;

// Detects whether this style sheet predominantly writes multi-selector rules
// one selector per line (`.a,\n.b {}`) or comma-separated on one line
// (`.a, .b {}`), by tallying the existing multi-selector rules already in
// the source. A merged selector list follows whichever style is prevalent,
// defaulting to one-line when the file has no existing multi-selector rules
// to go by (or is tied).
//
// The separator most sibling nodes in `container` carry is that container’s
// prevailing “normal” gap between rules—majority vote, not just whichever
// neighbor happens to be handy, since that neighbor can itself be the
// anomaly (e.g., a comment sitting flush above a rule, in a file that
// otherwise separates its rules with a blank line).
function typicalSeparator(container) {
  const counts = new Map();
  for (const node of container.nodes.slice(1)) {
    const before = node.raws.before ?? '\n';
    counts.set(before, (counts.get(before) ?? 0) + 1);
  }
  let best = '\n';
  let bestCount = 0;
  for (const [before, count] of counts) {
    if (count > bestCount) { best = before; bestCount = count; }
  }
  return best;
}

function usesMultilineSelectors(root) {
  let multiline = 0;
  let inline = 0;
  root.walkRules(rule => {
    if (splitSelectors(rule.selector).length < 2) return;
    if (RE_MULTILINE_SELECTOR_SEPARATOR.test(rule.selector)) multiline++;
    else inline++;
  });
  return multiline > inline;
}

function joinSelectors(selectors, rule, multiline) {
  if (!multiline) return selectors.join(', ');
  const indent = (rule.raws.before ?? '').match(RE_TRAILING_INDENT)[0];
  return selectors.join(`,\n${indent}`);
}

// Conditional group rules whose empty block is inert—an empty `@media`,
// `@supports`, or `@container` block styles nothing and declares nothing.
// `@layer` is deliberately absent: A layer’s position in the layer order is
// set by its first appearance, so removing an emptied early `@layer x {}`
// shell could reorder the cascade.
const INERT_WHEN_EMPTY_ATRULES = new Set(['media', 'supports', 'container']);

// Aggressive mode’s cross-block merges consolidate into the last of two
// same-condition blocks, which can drain the earlier one completely. This
// removes such emptied blocks—only ones this run emptied (`initiallyEmpty`
// snapshots the source state), and only where emptiness is provably inert.
// One walk collects the candidates in document order—parents before
// children—so the reverse pass below sees each inner block before its
// parent, and a parent emptied by its child’s removal is caught in the same
// sweep (no re-walking, no removal during traversal).
function removeEmptiedConditionBlocks(root, initiallyEmpty) {
  const candidates = [];
  root.walkAtRules(atrule => {
    if (INERT_WHEN_EMPTY_ATRULES.has(atrule.name.toLowerCase())) candidates.push(atrule);
  });

  for (const atrule of candidates.reverse()) {
    if (atrule.nodes && !atrule.nodes.length && !initiallyEmpty.has(atrule)) atrule.remove();
  }
}

// The `savingsOnly` gate: Consolidation runs on a detached clone first, and
// only a result that doesn’t grow the style sheet is grafted back onto the
// real root—so a growing result leaves the root untouched (“withheld”),
// which is what lets the PostCSS plugin and the CLI share one
// implementation of the policy. A withheld result reports `applied: []` and
// unchanged bytes (that’s what actually happened), with the would-be outcome
// under `withheld` so callers can explain what was declined. A net-zero
// result still applies (deduplicated at no byte cost).
export function dedupRoot(root, options = {}) {
  if (!options.savingsOnly) return consolidateRoot(root, options);

  const clone = root.clone();
  const result = consolidateRoot(clone, options);
  if (result.bytes.saved < 0) {
    return {
      applied: [],
      skipped: result.skipped,
      bytes: { before: result.bytes.before, after: result.bytes.before, saved: 0 },
      withheld: { count: result.applied.length, bytes: result.bytes },
    };
  }

  if (result.applied.length) {
    root.raws = clone.raws;
    root.removeAll();
    root.append(clone.nodes);
  }
  return result;
}

function consolidateRoot(root, options = {}) {
  // The subject-identity memoization is per run: fresh here, reused across
  // this run’s fixed-point passes, never carried over to the next style sheet
  resetSubjectIdentities();

  // Taken before any mutation, so it reflects the file as it stood on disk—
  // byte counts, not character counts, since the effectiveness this measures
  // (fewer bytes over the wire) is a transfer-size concern
  const before = Buffer.byteLength(root.toString(), 'utf8');

  const ignorePatterns = resolveIgnorePatterns(options);
  const aggressive = options.aggressive ?? false;
  const multilineSelectors = usesMultilineSelectors(root);
  const applied = [];
  const skipped = [];

  // Cross-block merges (aggressive mode) can drain a physical block
  // completely; blocks that were already empty in the source are recorded
  // here so the cleanup at the end only ever removes what this run emptied
  const initiallyEmpty = new Set();
  if (aggressive) {
    root.walkAtRules(atrule => {
      if (atrule.nodes && !atrule.nodes.length) initiallyEmpty.add(atrule);
    });
  }

  // The normalization mode is bound once per run: Everything below keys and
  // compares declarations through these two, so no call site can fall back
  // to default-mode normalization by forgetting a flag—which would silently
  // give the same declaration two different keys in different phases of an
  // aggressive run
  const keyOf = decl => declarationKey(decl.prop, decl.value, decl.important, aggressive);
  const propOf = prop => normalizeProp(prop, aggressive);

  // A declaration repeated verbatim (after normalization, so `RED`/`red` or
  // `.50`/`.5` count too) within the same rule or the same selector-less
  // at-rule block—`.a { color: red; color: red; }`—is always safe to collapse
  // on its own, unlike the cross-container merges below: Nothing relocates
  // across a rule boundary, so there’s no “intervening rule” risk to check
  // for. Later wins regardless of what’s earlier within one container, so
  // dropping every occurrence but the last never changes which value applies.
  // Runs first, so the cross-container merge passes below only ever see one
  // occurrence per container per key.
  function removeRedundantDuplicates(container, scopeLabel, selectors) {
    const collapsed = [];
    const byKey = new Map();

    for (const decl of container.nodes.filter(node => node.type === 'decl')) {
      const key = keyOf(decl);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(decl);
    }

    for (const [key, decls] of byKey) {
      if (decls.length < 2) continue;

      const last = decls.at(-1);
      // Same “keep whichever raw spelling is shortest” rule as the
      // cross-container merges below
      const shortestValue = decls.reduce((shortest, decl) => (
        decl.value.length < shortest.length ? decl.value : shortest
      ), decls[0].value);
      if (last.value !== shortestValue) last.value = shortestValue;

      for (const decl of decls) {
        if (decl !== last) decl.remove();
      }

      collapsed.push({ scope: scopeLabel, key, redundant: true, selectors, value: shortestValue });
    }

    return collapsed;
  }

  // “True” if a declaration overlapping `propNormalized` (and not itself the
  // declaration matching `excludeKey`) is a candidate “extra”—one that
  // doesn’t participate in the merge but sits close enough to it, within the
  // same rule, to affect the outcome
  function isOverlappingExtra(node, propNormalized, excludeKey) {
    return node.type === 'decl'
      && keyOf(node) !== excludeKey
      && propertiesOverlap(propOf(node.prop), propNormalized);
  }

  // Refuse to merge if any other rule sitting between the group’s first and
  // last occurrence also touches this property, or a shorthand/longhand
  // overlapping it (e.g. `margin-left` overlaps `margin`)—for any selector.
  // Moving the declaration past such a rule could change which value wins for
  // whatever that rule matches. Over-cautious by design: It leaves some
  // genuinely safe merges for manual review rather than risk breaking the
  // cascade.
  //
  // One exception: If every one of the intervening rule’s selectors is
  // provably mutually exclusive with every one of the group’s own selectors
  // (see `selectorsAreMutuallyExclusive()`—e.g. `html[lang="da"] a` vs.
  // `html[lang="de"] a`), it can never match an element the group’s rules do,
  // so scanning continues past it for a real blocker. Aggressive mode widens
  // this to selectors that are merely likely disjoint (see
  // `selectorsLikelyDisjoint()`—subject compounds sharing no class/ID/type),
  // trading the proof for what BEM-style class naming makes almost always
  // true in practice.
  //
  // `exemptRules` widens the “is this rule part of the merge” exclusion
  // beyond this one group’s own members to every rule in its entangled
  // cluster (see `mergeCluster()`): A fellow cluster member isn’t a real
  // intervening threat, since it’s being absorbed into the same coordinated
  // merge rather than staying behind.
  function findBlockingRule(scope, distinctRules, exemptRules, firstIndex, lastIndex, propNormalized) {
    const groupSelectors = distinctRules.flatMap(rule => splitSelectors(rule.selector));
    for (const [index, rule] of scope.rules.entries()) {
      if (index <= firstIndex || index >= lastIndex || exemptRules.has(rule)) continue;
      const conflict = rule.nodes.find(node => node.type === 'decl' && propertiesOverlap(propOf(node.prop), propNormalized));
      if (!conflict) continue;

      const candidateSelectors = splitSelectors(rule.selector);
      // The (memoized, cheap) heuristic goes first: In aggressive mode it
      // clears most pairs, saving the exclusivity proof’s full selector parse
      const disjoint = candidateSelectors.every(candidateSelector => (
        groupSelectors.every(groupSelector => (
          (aggressive && selectorsLikelyDisjoint(candidateSelector, groupSelector))
          || selectorsAreMutuallyExclusive(candidateSelector, groupSelector)
        ))
      ));
      if (disjoint) continue;

      return { rule, prop: propOf(conflict.prop) };
    }
    return null;
  }

  // Folds rules repeating the same selector (list) within one scope into
  // the last of them—`.a { color: red; } … .a { margin: 0; }` becomes one
  // `.a` rule. Earlier rules’ declarations move to the top of the last
  // rule, in source order, which preserves every same-selector cascade
  // outcome; each move only happens if no intervening rule (with a selector
  // that isn’t provably disjoint) touches any of the moved properties—the
  // same check declaration merges use below. Sources are processed nearest
  // the target first, so an earlier rule’s span check always sees any
  // same-selector rule that could *not* be folded still sitting in the way,
  // never one that has already moved. Only rules holding nothing but
  // declarations participate as sources—nested rules and comments stay put;
  // the target itself may hold anything, since its own content doesn’t
  // move. Runs before the declaration merges below, so a duplicate the fold
  // brings into one rule is collapsed right here rather than ever forming a
  // cross-rule group.
  function foldSameSelectorRules(scope) {
    const bySelector = new Map();
    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const key = selectorSetKey(rule);
      if (!bySelector.has(key)) bySelector.set(key, []);
      bySelector.get(key).push(rule);
    }

    for (const rules of bySelector.values()) {
      if (rules.length < 2) continue;
      const target = rules.at(-1);
      let merged = false;

      for (const rule of rules.slice(0, -1).reverse()) {
        if (!rule.nodes.length || !rule.nodes.every(node => node.type === 'decl')) continue;

        const ruleIndex = scope.rules.indexOf(rule);
        const targetIndex = scope.rules.indexOf(target);
        const exempt = new Set([rule, target]);
        let blocking = null;
        for (const decl of rule.nodes) {
          blocking = findBlockingRule(scope, [rule, target], exempt, ruleIndex, targetIndex, propOf(decl.prop));
          if (blocking) break;
        }
        if (blocking) {
          skipped.push({
            scope: scope.label,
            key: splitSelectors(rule.selector).join(', '),
            reason: `same selector written again on line ${target.source?.start?.line}, but an intervening \`${blocking.prop}\` declaration in \`${blocking.rule.selector}\` (line ${blocking.rule.source?.start?.line}) blocks folding the rules together`,
          });
          continue;
        }

        const anchor = target.first;
        for (const decl of [...rule.nodes]) {
          decl.remove();
          if (anchor) target.insertBefore(anchor, decl);
          else target.append(decl);
        }
        rule.remove();
        scope.rules.splice(scope.rules.indexOf(rule), 1);
        applied.push({
          scope: scope.label,
          key: splitSelectors(target.selector).join(', '),
          selectors: splitSelectors(target.selector),
          folded: true,
        });
        merged = true;
      }

      if (merged) {
        applied.push(...removeRedundantDuplicates(target, scope.label, splitSelectors(target.selector)));
      }
    }
  }

  // A duplicate-key group with no other declaration overlapping its
  // property, anywhere in its own rules, needs nothing beyond the basic
  // merge—fold every rule’s selector onto the last occurrence, drop the
  // declaration from the others.
  //
  // Two concerns, both handled by splitting an extra declaration out into
  // its own residual rule, but for different reasons: the target’s own
  // other declarations always need to move, overlapping or not, while a
  // non-target occurrence’s own extra only needs to move if it overlaps the
  // shared property and was declared after it.
  //
  // The caller’s intervening-rule check already confirmed nothing between
  // the group’s first and last occurrence (with a non-disjoint selector)
  // touches this property family, so relocating a residual to either side
  // of the target crosses no boundary that check didn’t already clear.
  function mergeSoloGroup(scope, group) {
    const { key, occurrences, distinctRules, propNormalized } = group;
    const target = distinctRules.at(-1);

    // A residual clones `target`, inheriting whatever separated target from
    // whatever preceded it in the source—correct only for a residual taking
    // over target’s own original slot (`beforeResidual`, below). One
    // inserted after target instead needs the file’s normal between-rules
    // separator, not target’s own (which can be anomalous, e.g. a comment
    // sitting flush above it).
    const interPieceSeparator = typicalSeparator(target.parent);
    // Also has to be reapplied after `.after()` runs, not just before it:
    // For a rule sitting directly in the root (not inside an @-rule/nested
    // rule), `Root#normalize()` overwrites a freshly inserted node’s
    // `raws.before` with its insertion anchor’s own, discarding whatever the
    // node already carried.

    const beforeExtrasByRule = new Map();
    const afterExtrasByRule = new Map();
    for (const rule of distinctRules) {
      const sharedDecl = occurrences.find(occ => occ.rule === rule).decl;
      const sharedIndex = rule.nodes.indexOf(sharedDecl);

      if (rule === target) {
        const isExtra = node => node.type === 'decl' && keyOf(node) !== key;
        const afterExtras = rule.nodes.filter((node, index) => index > sharedIndex && isExtra(node));
        const beforeExtras = rule.nodes.filter((node, index) => index < sharedIndex && isExtra(node));
        if (afterExtras.length) afterExtrasByRule.set(rule, afterExtras);
        if (beforeExtras.length) beforeExtrasByRule.set(rule, beforeExtras);
      } else {
        const afterExtras = rule.nodes.filter((node, index) => index > sharedIndex && isOverlappingExtra(node, propNormalized, key));
        if (afterExtras.length) afterExtrasByRule.set(rule, afterExtras);
      }
    }

    const mergedSelectors = [];
    for (const rule of distinctRules) {
      for (const selector of splitSelectors(rule.selector)) {
        if (!mergedSelectors.includes(selector)) mergedSelectors.push(selector);
      }
    }

    const targetOriginalSelector = target.selector;
    target.selector = joinSelectors(mergedSelectors, target, multilineSelectors);

    // All occurrences share a normalized key, so they’re equivalent by our
    // own equivalence rules—pick whichever raw spelling is shortest rather
    // than whatever the target rule happened to already have. This only
    // selects among text that already exists in the source; it doesn’t
    // synthesize a shorter spelling itself (that’s a minifier’s job).
    const shortestValue = occurrences.reduce((shortest, occ) => (
      occ.decl.value.length < shortest.length ? occ.decl.value : shortest
    ), occurrences[0].decl.value);

    const targetDecl = occurrences.find(occ => occ.rule === target).decl;
    if (targetDecl.value !== shortestValue) targetDecl.value = shortestValue;

    for (const rule of distinctRules) {
      if (rule === target) continue;
      for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
        if (keyOf(decl) === key) decl.remove();
      }
    }

    const makeResidual = (selector, extras) => {
      const residual = target.clone({ nodes: [] });
      residual.selector = selector;
      for (const decl of extras) {
        decl.remove();
        residual.append(decl);
      }
      return residual;
    };

    let beforeResidual = null;
    const targetBeforeExtras = beforeExtrasByRule.get(target);
    if (targetBeforeExtras) {
      beforeResidual = makeResidual(targetOriginalSelector, targetBeforeExtras);
      target.before(beforeResidual);
    }

    const afterResiduals = [];
    let insertPoint = target;
    for (const rule of distinctRules) {
      const extras = afterExtrasByRule.get(rule);
      if (!extras) continue;

      const residual = makeResidual(rule === target ? targetOriginalSelector : rule.selector, extras);
      insertPoint.after(residual);
      residual.raws.before = interPieceSeparator;
      insertPoint = residual;
      afterResiduals.push(residual);
    }

    for (const rule of distinctRules) {
      if (rule === target || rule.nodes.length > 0) continue;
      rule.remove();
    }

    // Later groups in this same scope also scan `scope.rules` for
    // intervening/self conflicts, and need to see these new residuals to
    // stay accurate
    let spliceIndex = scope.rules.indexOf(target);
    if (beforeResidual) {
      scope.rules.splice(spliceIndex, 0, beforeResidual);
      spliceIndex += 1;
    }
    if (afterResiduals.length) scope.rules.splice(spliceIndex + 1, 0, ...afterResiduals);

    applied.push({ scope: scope.label, key, selectors: mergedSelectors, value: shortestValue });
  }

  // A blocker fences a group, it doesn’t forbid it: The occurrences on one
  // side of the blocking rule can still merge among themselves, since that
  // merge only relocates declarations within a span of their own that the
  // safety check clears. Each maximal run of consecutive occurrences with
  // clean spans between neighbors merges like a small group in its own
  // right (clean neighbor spans compose—the member between two clean spans
  // is part of the merge itself). The group as a whole is still reported as
  // skipped, since the duplicate keeps existing across the blocker.
  //
  // Only for solo groups: In a multi-group cluster, a partial merge could
  // relocate a shared rule’s selector out from under the other groups, so
  // a blocked cluster stays untouched as a whole.
  function mergePartialGroup(scope, group, reason) {
    const { key, occurrences, distinctRules, propNormalized } = group;
    const exempt = new Set(distinctRules);

    const runs = [[distinctRules[0]]];
    for (let i = 1; i < distinctRules.length; i++) {
      const previousIndex = scope.rules.indexOf(distinctRules[i - 1]);
      const nextIndex = scope.rules.indexOf(distinctRules[i]);
      if (findBlockingRule(scope, distinctRules, exempt, previousIndex, nextIndex, propNormalized)) {
        runs.push([]);
      }
      runs.at(-1).push(distinctRules[i]);
    }

    for (const runRules of runs) {
      if (runRules.length < 2) continue;
      const runSet = new Set(runRules);
      mergeSoloGroup(scope, {
        key,
        occurrences: occurrences.filter(occ => runSet.has(occ.rule)),
        distinctRules: runRules,
        propNormalized,
      });
    }

    // Whatever merged above resurfaces as a smaller group on the next
    // fixed-point pass; this entry only survives from the final, quiescent
    // pass, where it describes exactly what remains split and why
    skipped.push({ scope: scope.label, key, reason });
  }

  // Twin rules are the copy-paste pattern: Two or more rules that all carry
  // exactly the same set of shared declarations (`.a { margin: 0; color:
  // red; } .b { margin: 0; color: red; }`). As a cluster they have several
  // full-membership rules, so no hub split applies—but none is needed: The
  // rules can be folded whole into the last one, keeping its declaration
  // order, when that’s provably safe. Every rule must consist of nothing but
  // the cluster’s own shared declarations (an extra would leak to the other
  // rules’ selectors), and the keys must either appear in the same order in
  // every rule or be pairwise non-overlapping—if two overlapping keys swap
  // order between rules, one rule’s elements would see their winner change.
  // The caller’s intervening-rule check has already cleared everything
  // sitting between the rules. Returns “false” (leaving the cluster to be
  // skipped) when the shape doesn’t match.
  function mergeTwinRules(scope, cluster, ruleKeyCounts) {
    const clusterSize = cluster.length;
    if (![...ruleKeyCounts.values()].every(keysHere => keysHere.size === clusterSize)) return false;

    const clusterKeys = new Set(cluster.map(group => group.key));
    const rules = [...ruleKeyCounts.keys()].sort((a, b) => scope.rules.indexOf(a) - scope.rules.indexOf(b));

    for (const rule of rules) {
      const allShared = rule.nodes.every(node => (
        node.type === 'decl' && clusterKeys.has(keyOf(node))
      ));
      if (!allShared) return false;
    }

    const sequences = rules.map(rule => (
      rule.nodes.map(node => keyOf(node)).join('\n')
    ));
    const sameOrder = sequences.every(sequence => sequence === sequences[0]);
    if (!sameOrder) {
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          if (propertiesOverlap(cluster[i].propNormalized, cluster[j].propNormalized)) return false;
        }
      }
    }

    const target = rules.at(-1);
    const mergedSelectors = [];
    for (const rule of rules) {
      for (const selector of splitSelectors(rule.selector)) {
        if (!mergedSelectors.includes(selector)) mergedSelectors.push(selector);
      }
    }
    target.selector = joinSelectors(mergedSelectors, target, multilineSelectors);

    for (const decl of target.nodes) {
      const key = keyOf(decl);
      const group = cluster.find(candidate => candidate.key === key);
      const shortestValue = group.occurrences.reduce((shortest, occ) => (
        occ.decl.value.length < shortest.length ? occ.decl.value : shortest
      ), group.occurrences[0].decl.value);
      if (decl.value !== shortestValue) decl.value = shortestValue;

      applied.push({ scope: scope.label, key, selectors: mergedSelectors, value: shortestValue });
    }

    for (const rule of rules) {
      if (rule === target) continue;
      rule.remove();
      scope.rules.splice(scope.rules.indexOf(rule), 1);
    }

    return true;
  }

  // For a group inside a cluster that can’t merge as a whole—blocked by an
  // outside rule, or shaped so no coordinated order exists—safe sub-runs of
  // its occurrences can still consolidate, under a stricter recipe than a
  // solo group’s, since fellow cluster rules must stay intact:
  //
  //   - The merged rule is a fresh one, inserted right after the run’s last
  //     member—no member’s selector is ever mutated, so entanglement can’t
  //     leak one group’s selectors into another’s.
  //   - Runs are fenced by any rule carrying an overlapping declaration,
  //     including fellow cluster members, which stay behind and remain part
  //     of the cascade (only the run’s own members are being absorbed).
  //   - A member whose own trailing declarations overlap the key is refused
  //     outright—relocating the key past its own tail would flip which
  //     wins. (The solo path splits such extras into residuals instead—
  //     here they may belong to other groups and must not move.) Skipping
  //     it still fences the runs around it, since its tail declaration is
  //     an intervening overlap like any other.
  function mergeClusterGroupRuns(scope, group) {
    const { key, occurrences, distinctRules, propNormalized } = group;

    const viable = rule => {
      const declIndex = rule.nodes.indexOf(occurrences.find(occ => occ.rule === rule).decl);
      return !rule.nodes.some((node, index) => (
        index > declIndex && node.type === 'decl' && propertiesOverlap(propOf(node.prop), propNormalized)
      ));
    };

    const runs = [[]];
    for (const rule of distinctRules) {
      if (!viable(rule)) {
        runs.push([]);
        continue;
      }
      const run = runs.at(-1);
      if (run.length) {
        const previousIndex = scope.rules.indexOf(run.at(-1));
        const nextIndex = scope.rules.indexOf(rule);
        if (findBlockingRule(scope, distinctRules, new Set(), previousIndex, nextIndex, propNormalized)) {
          runs.push([rule]);
          continue;
        }
      }
      run.push(rule);
    }

    for (const runRules of runs) {
      if (runRules.length < 2) continue;
      const lastRule = runRules.at(-1);
      const runOccurrences = occurrences.filter(occ => runRules.includes(occ.rule));

      const mergedSelectors = [];
      for (const rule of runRules) {
        for (const selector of splitSelectors(rule.selector)) {
          if (!mergedSelectors.includes(selector)) mergedSelectors.push(selector);
        }
      }

      const shortestValue = runOccurrences.reduce((shortest, occ) => (
        occ.decl.value.length < shortest.length ? occ.decl.value : shortest
      ), runOccurrences[0].decl.value);

      const mergedRule = lastRule.clone({ nodes: [] });
      mergedRule.selector = joinSelectors(mergedSelectors, lastRule, multilineSelectors);
      const lastDecl = runOccurrences.find(occ => occ.rule === lastRule).decl;
      lastDecl.remove();
      if (lastDecl.value !== shortestValue) lastDecl.value = shortestValue;
      mergedRule.append(lastDecl);
      lastRule.after(mergedRule);
      scope.rules.splice(scope.rules.indexOf(lastRule) + 1, 0, mergedRule);

      // `mergedRule` clones `lastRule`, inheriting whatever separated
      // `lastRule` from whatever preceded it in the source—right if
      // `lastRule` ends up empty and removed below (`mergedRule` then takes
      // over its old slot), wrong otherwise (`mergedRule` is then a fresh
      // insertion after a `lastRule` that keeps standing, and needs the
      // file’s normal between-rules separator instead). Reassigning after
      // `.after()` runs, not before, since `Root#normalize()` would
      // otherwise overwrite an earlier assignment with the insertion
      // anchor’s own `raws.before` for a rule sitting directly in the root.
      if (lastRule.nodes.length > 0) mergedRule.raws.before = typicalSeparator(lastRule.parent);

      for (const rule of runRules) {
        if (rule === lastRule) continue;
        runOccurrences.find(occ => occ.rule === rule).decl.remove();
        if (rule.nodes.length === 0) rule.remove();
      }
      if (lastRule.nodes.length === 0) lastRule.remove();

      applied.push({ scope: scope.label, key, selectors: mergedSelectors, value: shortestValue });
    }
  }

  // A cluster is two or more duplicate-key groups that share a rule—one
  // rule holding declarations for more than one of the group’s keys.
  // That’s unsafe to merge independently, key by key: Whichever key’s merge
  // runs first mutates that rule’s selector, and the next key’s merge would
  // then naively fold in that already-expanded selector list, leaking its
  // own declaration to selectors that were never meant to have it.
  //
  // This only handles the “star” case: A single rule (the hub) is a member
  // of every group in the cluster, and no other rule is shared between any
  // two of them. The hub is split into one rule per cluster key, in the
  // same order those keys’ declarations already had within the hub’s own
  // rule—always a valid order, read straight off one rule’s own
  // declaration sequence, the same way a solo merge’s before/after
  // placement is. Anything else in the hub travels along as its own small
  // residual, in the same relative slot, using the hub’s own original
  // selector.
  //
  // Any other topology—a chain with no single shared rule, multiple
  // candidate hubs—has no single anchor position that could satisfy every
  // pairwise ordering constraint at once. `mergeTwinRules()` still handles
  // the identical-rules shape; whatever remains falls back to
  // `mergeClusterGroupRuns()`, which consolidates each group’s safe
  // sub-runs individually and reports the rest.
  function mergeCluster(scope, cluster) {
    const ruleKeyCounts = new Map();
    for (const group of cluster) {
      for (const rule of group.distinctRules) {
        if (!ruleKeyCounts.has(rule)) ruleKeyCounts.set(rule, new Set());
        ruleKeyCounts.get(rule).add(group.key);
      }
    }

    const clusterSize = cluster.length;
    // Exactly one full-membership rule: With two candidate hubs, each
    // holds every cluster key in its own order, and splitting around
    // either would reorder the other’s declarations—so two hubs is not
    // a star, however clean the rest of the topology looks
    let hub = null;
    let hubCandidates = 0;
    for (const [rule, keysHere] of ruleKeyCounts) {
      if (keysHere.size === clusterSize) {
        hub ??= rule;
        hubCandidates++;
      }
    }
    const isStar = hub !== null && hubCandidates === 1 && [...ruleKeyCounts.values()].every(keysHere => (
      keysHere.size === clusterSize || keysHere.size === 1
    ));

    if (!isStar) {
      if (mergeTwinRules(scope, cluster, ruleKeyCounts)) return;

      for (const group of cluster) {
        mergeClusterGroupRuns(scope, group);
        skipped.push({
          scope: scope.label,
          key: group.key,
          reason: 'entangled with another duplicate group through more than one shared rule, with no single rule connecting them all',
        });
      }
      return;
    }

    const hubOriginalSelector = hub.selector;
    const hubIndex = scope.rules.indexOf(hub);

    // Every piece cloned from the hub inherits the hub’s own `raws.before`,
    // which is whatever separated the hub from whatever preceded IT (often
    // nothing, if the hub was the first rule in its container)—appropriate
    // for the first piece only. Later pieces need the file’s normal
    // between-rules separator instead, not the hub’s own (which can be
    // anomalous, e.g. a comment sitting flush above it). Also has to be
    // reapplied *after* `.after()` runs, not just before it: for a rule
    // sitting directly in the root (not inside an @-rule/nested rule),
    // `Root#normalize()` overwrites a freshly inserted node’s `raws.before`
    // with its insertion anchor’s own, discarding whatever the node already
    // carried.
    const interPieceSeparator = typicalSeparator(hub.parent);

    // Snapshot each cluster key’s shared declaration and its position
    // within the hub, before any mutation, then order the keys by that
    // position
    const anchors = cluster
      .map(group => {
        const decl = group.occurrences.find(occ => occ.rule === hub).decl;
        return { group, decl, index: hub.nodes.indexOf(decl) };
      })
      .sort((a, b) => a.index - b.index);

    const makeResidual = (selector, decls) => {
      const residual = hub.clone({ nodes: [] });
      residual.selector = selector;
      for (const decl of decls) {
        decl.remove();
        residual.append(decl);
      }
      return residual;
    };

    // The anchors’ indices are positions in the hub as it originally
    // stood, but the loop below removes declarations from the hub as it
    // goes (`makeResidual`, `sharedDecl.remove()`)—so gap lookups filter
    // a snapshot of the original nodes, not live `hub.nodes`, or a
    // declaration sitting between two anchors would be missed (and then
    // silently dropped with the hub itself)
    const hubOriginalNodes = [...hub.nodes];
    const gapDecls = (fromIndex, toIndex) => hubOriginalNodes.filter((node, index) => (
      node.type === 'decl' && index > fromIndex && index < toIndex
    ));

    const finalRules = [];
    for (let i = 0; i < anchors.length; i++) {
      const gap = gapDecls(i === 0 ? -1 : anchors[i - 1].index, anchors[i].index);
      if (gap.length) finalRules.push(makeResidual(hubOriginalSelector, gap));

      const { group, decl: sharedDecl } = anchors[i];
      const { key, occurrences, distinctRules, propNormalized } = group;

      const mergedSelectors = [];
      for (const rule of distinctRules) {
        for (const selector of splitSelectors(rule === hub ? hubOriginalSelector : rule.selector)) {
          if (!mergedSelectors.includes(selector)) mergedSelectors.push(selector);
        }
      }

      const shortestValue = occurrences.reduce((shortest, occ) => (
        occ.decl.value.length < shortest.length ? occ.decl.value : shortest
      ), occurrences[0].decl.value);
      if (sharedDecl.value !== shortestValue) sharedDecl.value = shortestValue;

      const anchorRule = hub.clone({ nodes: [] });
      anchorRule.selector = joinSelectors(mergedSelectors, hub, multilineSelectors);
      sharedDecl.remove();
      anchorRule.append(sharedDecl);

      // Each non-hub member’s own overlapping extras: The hub’s new
      // position for this key is the hub’s original slot, which may sit
      // either before or after a given member, so which side an extra
      // needs to end up on depends on that direction too—not always
      // “after,” the way a solo merge’s non-target always is
      const beforeExtras = [];
      const afterExtras = [];
      for (const rule of distinctRules) {
        if (rule === hub) continue;
        const memberSharedDecl = occurrences.find(occ => occ.rule === rule).decl;
        const memberSharedIndex = rule.nodes.indexOf(memberSharedDecl);
        const memberIsAfterHub = scope.rules.indexOf(rule) > hubIndex;

        if (memberIsAfterHub) {
          const beforeShared = rule.nodes.filter((node, index) => index < memberSharedIndex && isOverlappingExtra(node, propNormalized, key));
          beforeExtras.push(...beforeShared);
        } else {
          const afterShared = rule.nodes.filter((node, index) => index > memberSharedIndex && isOverlappingExtra(node, propNormalized, key));
          afterExtras.push(...afterShared);
        }

        memberSharedDecl.remove();
      }

      if (beforeExtras.length) finalRules.push(makeResidual(hubOriginalSelector, beforeExtras));
      finalRules.push(anchorRule);
      if (afterExtras.length) finalRules.push(makeResidual(hubOriginalSelector, afterExtras));

      applied.push({ scope: scope.label, key, selectors: mergedSelectors, value: shortestValue });
    }

    const trailingGap = gapDecls(anchors.at(-1).index, hubOriginalNodes.length);
    if (trailingGap.length) finalRules.push(makeResidual(hubOriginalSelector, trailingGap));

    hub.before(finalRules[0]);
    for (let i = 1; i < finalRules.length; i++) {
      finalRules[i - 1].after(finalRules[i]);
      finalRules[i].raws.before = interPieceSeparator;
    }
    hub.remove();

    for (const group of cluster) {
      for (const rule of group.distinctRules) {
        if (rule !== hub && rule.nodes.length === 0) rule.remove();
      }
    }

    scope.rules.splice(hubIndex, 1, ...finalRules);
  }

  function mergeDuplicateGroups(scope) {
    const rules = eligibleRules(scope, ignorePatterns);
    const byKey = new Map();

    for (const rule of rules) {
      for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
        const key = keyOf(decl);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ rule, decl });
      }
    }

    // Every 2+-occurrence key is a merge candidate
    const groups = [];
    for (const [key, occurrences] of byKey) {
      const distinctRules = [...new Set(occurrences.map(occ => occ.rule))];
      if (distinctRules.length < 2) continue;
      groups.push({ key, occurrences, distinctRules, propNormalized: propOf(occurrences[0].decl.prop) });
    }

    // Cluster the candidate groups by shared rule membership (union-find):
    // Two groups end up in the same cluster iff some rule is a member of
    // both. This runs before the intervening-rule check, since a rule that
    // looks like an outside blocker for one group can turn out to be a
    // fellow cluster member instead (see `findBlockingRule()`)—which this
    // clustering step is what identifies.
    const parent = new Map(groups.map(group => [group.key, group.key]));
    const find = k => {
      while (parent.get(k) !== k) {
        parent.set(k, parent.get(parent.get(k)));
        k = parent.get(k);
      }
      return k;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    const keysByRule = new Map();
    for (const group of groups) {
      for (const rule of group.distinctRules) {
        if (!keysByRule.has(rule)) keysByRule.set(rule, []);
        keysByRule.get(rule).push(group.key);
      }
    }
    for (const keysHere of keysByRule.values()) {
      for (let i = 1; i < keysHere.length; i++) union(keysHere[0], keysHere[i]);
    }

    const clusters = new Map();
    for (const group of groups) {
      const clusterId = find(group.key);
      if (!clusters.has(clusterId)) clusters.set(clusterId, []);
      clusters.get(clusterId).push(group);
    }

    // The intervening-rule check runs per cluster, against the file as it
    // stood before any of this scope’s merges start—but exempts every rule
    // in the cluster, not just this one group’s own two members, since a
    // fellow cluster member is being absorbed into the same coordinated
    // merge rather than staying behind. A blocked solo group still gets its
    // safe sub-runs merged (see `mergePartialGroup()`); a blocked
    // multi-group cluster falls back to per-group sub-run merges (see
    // `mergeClusterGroupRuns()`), which never touch a fellow member’s
    // selector and so can’t leak anything between the groups.
    for (const cluster of clusters.values()) {
      const clusterRules = new Set(cluster.flatMap(group => group.distinctRules));
      let outsideBlocker = null;

      for (const group of cluster) {
        const firstIndex = scope.rules.indexOf(group.distinctRules[0]);
        const lastIndex = scope.rules.indexOf(group.distinctRules.at(-1));
        const blocking = findBlockingRule(scope, group.distinctRules, clusterRules, firstIndex, lastIndex, group.propNormalized);
        if (blocking) { outsideBlocker = { group, blocking }; break; }
      }

      if (outsideBlocker) {
        const { group, blocking } = outsideBlocker;
        const propDescription = blocking.prop === group.propNormalized ? `\`${group.propNormalized}\`` : `overlapping \`${blocking.prop}\``;
        const reason = `intervening ${propDescription} declaration in \`${blocking.rule.selector}\` (line ${blocking.rule.source?.start?.line})`;

        if (cluster.length === 1) {
          mergePartialGroup(scope, group, reason);
          continue;
        }

        for (const member of cluster) {
          mergeClusterGroupRuns(scope, member);
          skipped.push({
            scope: scope.label,
            key: member.key,
            reason: member === group ? reason : `part of a duplicate group entangled with \`${group.key}\`, which is blocked: ${reason}`,
          });
        }
        continue;
      }

      if (cluster.length === 1) mergeSoloGroup(scope, cluster[0]);
      else mergeCluster(scope, cluster);
    }
  }

  // One merge can unblock or create another: A fresh merged rule may twin
  // with an existing rule, and an emptied rule stops fencing the spans it
  // sat in—so the passes repeat until nothing changes. Termination is
  // guaranteed, since every productive pass strictly reduces the number of
  // declarations or rules. `skipped` is rebuilt each pass, so it describes
  // what remains at the end, not intermediate states.
  let appliedCount = -1;
  while (applied.length !== appliedCount) {
    appliedCount = applied.length;
    skipped.length = 0;

    // Aggressive mode merges same-condition blocks into one scope, accepting
    // that rules from other scopes sitting between the blocks stay invisible
    // to the intervening-rule check; default mode keeps one scope per
    // physical container (see `mergeScopesByLabel()`)
    const scopes = aggressive ? collectMergedScopes(root) : collectScopes(root);
    for (const scope of scopes) {
      for (const rule of eligibleRules(scope, ignorePatterns)) {
        applied.push(...removeRedundantDuplicates(rule, scope.label, splitSelectors(rule.selector)));
      }
    }
    for (const atrule of collectDeclOnlyContainers(root)) {
      applied.push(...removeRedundantDuplicates(atrule, describeScope(atrule), [atRuleLabel(atrule)]));
    }
    for (const scope of scopes) foldSameSelectorRules(scope);
    for (const scope of scopes) mergeDuplicateGroups(scope);
  }

  if (aggressive) removeEmptiedConditionBlocks(root, initiallyEmpty);

  const after = Buffer.byteLength(root.toString(), 'utf8');
  return { applied, skipped, bytes: { before, after, saved: before - after } };
}

export function dedup(css, options = {}) {
  const root = postcss.parse(css, { from: options.from });
  const result = dedupRoot(root, options);
  return { css: root.toString(), ...result };
}