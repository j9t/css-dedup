import postcss from 'postcss';
import { normalizeProp, declarationKey } from './normalization.js';
import { isIgnoredSelector, resolveIgnorePatterns } from './hacks.js';
import { splitSelectors, selectorsAreMutuallyExclusive } from './selectors.js';
import { propertiesOverlap } from './shorthands.js';

function normalizeScopeSegment(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// A “scope” is a DRY boundary: the root stylesheet, or the direct contents of
// one specific `@media`/`@supports`/`@layer`/etc. condition, or one specific
// selector used as a nesting host (native CSS nesting). This computes the
// label identifying that boundary—used both to keep unrelated scopes apart,
// and (see `mergeScopesByLabel()` below) to recognize the same boundary
// when it’s written as two separate physical blocks. Whitespace is
// normalized here (not case—`@layer` names and selectors can be
// case-sensitive) so `@media (min-width: 768px)` and
// `@media (min-width:768px)` produce the same label regardless of
// formatting.
function describeScope(container) {
  if (container.type === 'root') return 'root';
  if (container.type === 'rule') return normalizeScopeSegment(container.selector);

  const chain = [];
  let node = container;
  while (node && node.type !== 'root') {
    chain.unshift(node.type === 'rule'
      ? normalizeScopeSegment(node.selector)
      : normalizeScopeSegment(`@${node.name} ${node.params}`));
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
// they’re written separately in the source—e.g., two
// `@media (min-width: 768px) {}` blocks in different parts of a stylesheet
// apply under the exact same runtime condition, so a declaration duplicated
// across them is exactly as redundant as one repeated within a single block.
// Scopes sharing a label are combined here, with their rules re-sorted into
// true document order.
//
// This is only safe for reporting a duplicate, not for merging one:
// Merging always keeps the last occurrence’s rule in its own original
// container and deletes the others, so within a single, already-contiguous
// container that never changes any rule’s position relative to anything
// outside it—the container is a firewall the merge-safety “intervening rule”
// check can reason about using just that container’s own rules. Once two
// separate containers are folded into one scope, that firewall is gone: A
// rule sitting between the two containers in the raw document (in some other
// scope entirely, e.g. a plain root-level rule between two `@media` blocks)
// can matter for the merge without the intervening-rule check ever seeing
// it, since that check only looks within the merged scope. So `dedupRoot`
// uses `collectScopes()` directly (one scope per physical container, never
// merged) and only `analyzeRoot`—which never moves anything—uses the merged
// view via `collectMergedScopes()`.
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
// (read-only reporting), not for `dedupRoot()` (which mutates).
function collectMergedScopes(root) {
  return mergeScopesByLabel(collectScopes(root));
}

// At-rules like `@font-face`, `@page`, and `@property` can hold declarations
// directly, with no selector wrapping them—`collectScopes()` above only ever
// looks at `rule`-type nodes, so those declarations are otherwise invisible
// to any duplicate check. Unlike a scope’s rules, these blocks are never
// compared against each other (there’s no selector list to fold two
// `@font-face` blocks into, and two such blocks repeating the same
// declaration usually isn’t a mistake—each still describes its own,
// independent face). So this only ever looks for a declaration repeated
// within the same block.
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
// specificities as `.a, .b`
function selectorSetKey(rule) {
  return splitSelectors(rule.selector)
    .map(selector => selector.replace(/\s+/g, ' '))
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
  const scopes = collectMergedScopes(root);
  const findings = [];

  for (const scope of scopes) {
    const byKey = new Map();

    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const seenInRule = new Set();

      // Only compare a rule’s own direct declarations—not those of any
      // nested rules inside it, which belong to their own scope
      for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
        const key = declarationKey(decl.prop, decl.value, decl.important);
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
  // physical containers (like `--dedup`’s fold, not the merged reporting
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
        repeatedSelector: true,
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
      const key = declarationKey(decl.prop, decl.value, decl.important);

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

// Detects whether this stylesheet predominantly writes multi-selector rules
// one selector per line (`.a,\n.b {}`) or comma-separated on one line
// (`.a, .b {}`), by tallying the existing multi-selector rules already in
// the source. A merged selector list follows whichever style is prevalent,
// defaulting to one-line when the file has no existing multi-selector rules
// to go by (or is tied).
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

// A declaration repeated verbatim (after normalization, so `RED`/`red` or
// `.50`/`.5` count too) within the same rule or the same selector-less
// at-rule block—`.a { color: red; color: red; }`—is always safe to collapse
// on its own, unlike the cross-container merge below: Nothing relocates
// across a rule boundary, so there’s no “intervening rule” risk to check
// for. Within one container, later wins regardless of what’s earlier, so
// dropping every occurrence but the last never changes which value applies.
// Runs first, so the cross-container merge pass below only ever sees one
// occurrence per container per key.
function removeRedundantDuplicates(container, scopeLabel, selectors) {
  const applied = [];
  const byKey = new Map();

  for (const decl of container.nodes.filter(node => node.type === 'decl')) {
    const key = declarationKey(decl.prop, decl.value, decl.important);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(decl);
  }

  for (const [key, decls] of byKey) {
    if (decls.length < 2) continue;

    const last = decls.at(-1);
    // Same “keep whichever raw spelling is shortest” rule as the
    // cross-container merge below
    const shortestValue = decls.reduce((shortest, decl) => (
      decl.value.length < shortest.length ? decl.value : shortest
    ), decls[0].value);
    if (last.value !== shortestValue) last.value = shortestValue;

    for (const decl of decls) {
      if (decl !== last) decl.remove();
    }

    applied.push({ scope: scopeLabel, key, redundant: true, selectors, value: shortestValue });
  }

  return applied;
}

// “True” if a declaration overlapping `propNormalized` (and not itself the
// declaration matching `excludeKey`) is a candidate “extra”—one that
// doesn’t participate in the merge but sits close enough to it, within the
// same rule, to affect the outcome.
function isOverlappingExtra(node, propNormalized, excludeKey) {
  return node.type === 'decl'
    && declarationKey(node.prop, node.value, node.important) !== excludeKey
    && propertiesOverlap(normalizeProp(node.prop), propNormalized);
}

// Refuse to merge if any other rule sitting between the group’s first and
// last occurrence also touches this property, or a shorthand/longhand
// overlapping it (e.g. `margin-left` overlaps `margin`)—for any selector.
// Moving the declaration past such a rule could change which value wins
// for whatever that rule matches. This is over-cautious by design: It will
// leave some genuinely safe merges for manual review rather than risk
// breaking the cascade.
//
// One narrow exception: If every one of the intervening rule’s selectors
// is provably mutually exclusive with every one of the group’s own
// selectors (see `selectorsAreMutuallyExclusive()`—e.g. `html[lang="da"]
// a` vs. `html[lang="de"] a`), it can never match an element the group’s
// rules do, so it isn’t actually a threat to this particular merge and
// scanning continues past it for a real blocker.
//
// `exemptRules` widens the “is this rule part of the merge” exclusion
// beyond this one group’s own members, to every rule in its entangled
// cluster (see `mergeCluster()`): A fellow cluster member isn’t a real
// intervening threat, since it’s being absorbed into the same coordinated
// merge rather than staying behind in its original position.
function findBlockingRule(scope, distinctRules, exemptRules, firstIndex, lastIndex, propNormalized) {
  const groupSelectors = distinctRules.flatMap(rule => splitSelectors(rule.selector));
  for (const [index, rule] of scope.rules.entries()) {
    if (index <= firstIndex || index >= lastIndex || exemptRules.has(rule)) continue;
    const conflict = rule.nodes.find(node => node.type === 'decl' && propertiesOverlap(normalizeProp(node.prop), propNormalized));
    if (!conflict) continue;

    const candidateSelectors = splitSelectors(rule.selector);
    const provablyDisjoint = candidateSelectors.every(candidateSelector => (
      groupSelectors.every(groupSelector => selectorsAreMutuallyExclusive(candidateSelector, groupSelector))
    ));
    if (provablyDisjoint) continue;

    return { rule, prop: normalizeProp(conflict.prop) };
  }
  return null;
}

export function dedupRoot(root, options = {}) {
  // Taken before any mutation, so it reflects the file as it stood on disk—
  // byte counts, not character counts, since the effectiveness this measures
  // (fewer bytes over the wire) is a transfer-size concern
  const before = Buffer.byteLength(root.toString(), 'utf8');

  const ignorePatterns = resolveIgnorePatterns(options);
  const scopes = collectScopes(root);
  const multilineSelectors = usesMultilineSelectors(root);
  const applied = [];
  const skipped = [];

  for (const scope of scopes) {
    for (const rule of eligibleRules(scope, ignorePatterns)) {
      applied.push(...removeRedundantDuplicates(rule, scope.label, splitSelectors(rule.selector)));
    }
  }

  for (const atrule of collectDeclOnlyContainers(root)) {
    applied.push(...removeRedundantDuplicates(atrule, describeScope(atrule), [atRuleLabel(atrule)]));
  }

  // Folds rules repeating the same selector (list) within one scope into
  // the last of them—`.a { color: red; } … .a { margin: 0; }` becomes one
  // `.a` rule. Earlier rules’ declarations move to the top of the last
  // rule, in source order, which preserves every same-selector cascade
  // outcome; each move only happens if no intervening rule (with a selector
  // that isn’t provably disjoint) touches any of the moved properties—the
  // same check declaration merges use. Sources are processed nearest to the
  // target first, so an earlier rule’s span check always sees any
  // same-selector rule that could *not* be folded still sitting in the way
  // (and correctly refuses), never one that has already moved. Only rules
  // holding nothing but declarations participate as sources—nested rules
  // and comments stay put; the target itself may hold anything, since its
  // own content doesn’t move. Runs before the declaration merges below, so
  // a duplicate declaration the fold brings into one rule is collapsed
  // right here (same-rule duplicates are unconditionally safe) rather than
  // ever forming a cross-rule group.
  for (const scope of scopes) {
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
          blocking = findBlockingRule(scope, [rule, target], exempt, ruleIndex, targetIndex, normalizeProp(decl.prop));
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
          foldedRule: true,
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
  // Two distinct concerns, both handled the same way—splitting an extra
  // declaration out into its own residual rule—but for different reasons:
  //
  //   - The target’s own other declarations, overlapping or not, always
  //     need to move.
  //   - A non-target occurrence’s own extra only needs to move if it
  //     overlaps the shared property and was declared after it.
  //
  // The caller’s intervening-rule check already confirmed nothing between
  // the group’s first and last occurrence (with a non-disjoint selector)
  // touches this property family, so relocating a residual to either side
  // of the target crosses no boundary that check didn’t already clear.
  function mergeSoloGroup(scope, group) {
    const { key, occurrences, distinctRules, propNormalized } = group;
    const target = distinctRules.at(-1);

    const beforeExtrasByRule = new Map();
    const afterExtrasByRule = new Map();
    for (const rule of distinctRules) {
      const sharedDecl = occurrences.find(occ => occ.rule === rule).decl;
      const sharedIndex = rule.nodes.indexOf(sharedDecl);

      if (rule === target) {
        const isExtra = node => node.type === 'decl' && declarationKey(node.prop, node.value, node.important) !== key;
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
        if (declarationKey(decl.prop, decl.value, decl.important) === key) decl.remove();
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

  // Twin rules are the copy-paste pattern: Two or more rules that all carry
  // exactly the same set of shared declarations (`.a { margin: 0; color:
  // red; } .b { margin: 0; color: red; }`). As a cluster they have several
  // full-membership rules, so no hub split applies—but no split is needed:
  // The rules can be folded whole into the last one, keeping its declaration
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
        node.type === 'decl' && clusterKeys.has(declarationKey(node.prop, node.value, node.important))
      ));
      if (!allShared) return false;
    }

    const sequences = rules.map(rule => (
      rule.nodes.map(node => declarationKey(node.prop, node.value, node.important)).join('\n')
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
      const key = declarationKey(decl.prop, decl.value, decl.important);
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

  // A cluster is two or more duplicate-key groups that share a rule—one
  // rule holding declarations for more than one of the group’s keys.
  // That’s unsafe to merge independently, key by key: Whichever key’s
  // merge runs first mutates that rule’s selector, and the next key’s
  // merge would then naively fold in that already-expanded selector list,
  // leaking its own declaration to selectors that were never meant to
  // have it.
  //
  // This only handles the “star” case: A single rule (the hub) is a
  // member of every group in the cluster, and no other rule is shared
  // between any two of them. The hub is split into one rule per cluster
  // key, in the same order those keys’ declarations already had within
  // the hub’s own rule—always a valid order, since it’s read straight off
  // one rule’s own declaration sequence, the same way a solo merge’s
  // before/after placement is. Anything else in the hub (declarations
  // that aren’t any cluster key’s own shared value) travels along as its
  // own small residual, in the same relative slot, using the hub’s own
  // original selector.
  //
  // Any other topology—a chain with no single shared rule, multiple
  // candidate hubs—has no single anchor position that could satisfy every
  // pairwise ordering constraint at once, so every group in the cluster is
  // left untouched instead.
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
    // between-rules separator instead, sampled from the hub’s next sibling
    // where available.
    const interPieceSeparator = hub.next()?.raws.before || hub.raws.before || '\n';

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
      // “after,” the way a solo merge’s non-target always is.
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

    for (let i = 1; i < finalRules.length; i++) finalRules[i].raws.before = interPieceSeparator;

    hub.before(finalRules[0]);
    for (let i = 1; i < finalRules.length; i++) finalRules[i - 1].after(finalRules[i]);
    hub.remove();

    for (const group of cluster) {
      for (const rule of group.distinctRules) {
        if (rule !== hub && rule.nodes.length === 0) rule.remove();
      }
    }

    scope.rules.splice(hubIndex, 1, ...finalRules);
  }

  for (const scope of scopes) {
    const rules = eligibleRules(scope, ignorePatterns);
    const byKey = new Map();

    for (const rule of rules) {
      for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
        const key = declarationKey(decl.prop, decl.value, decl.important);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ rule, decl });
      }
    }

    // Every 2+-occurrence key is a merge candidate
    const groups = [];
    for (const [key, occurrences] of byKey) {
      const distinctRules = [...new Set(occurrences.map(occ => occ.rule))];
      if (distinctRules.length < 2) continue;
      groups.push({ key, occurrences, distinctRules, propNormalized: normalizeProp(occurrences[0].decl.prop) });
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
    // stood before any of this scope’s merges start (blocking is purely
    // about what originally sat between a group’s own first and last
    // occurrence)—but exempts every rule in the cluster, not just this one
    // group’s own two members, since a fellow cluster member is being
    // absorbed into the same coordinated merge rather than staying behind.
    // If a genuine outsider blocks any one group in a multi-group cluster,
    // the whole cluster is left untouched, rather than trying to salvage a
    // partial coordinated merge around the blocked piece.
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
        for (const member of cluster) {
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

  const after = Buffer.byteLength(root.toString(), 'utf8');
  return { applied, skipped, bytes: { before, after, saved: before - after } };
}

export function dedup(css, options = {}) {
  const root = postcss.parse(css, { from: options.from });
  const { applied, skipped, bytes } = dedupRoot(root, options);
  return { css: root.toString(), applied, skipped, bytes };
}
