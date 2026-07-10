import postcss from 'postcss';
import { normalizeProp, declarationKey } from './normalization.js';
import { isIgnoredSelector, resolveIgnorePatterns } from './hacks.js';
import { splitSelectors, selectorsAreMutuallyExclusive } from './selectors.js';
import { propertiesOverlap } from './shorthands.js';

function normalizeScopeSegment(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// A "scope" is a DRY boundary: the root stylesheet, or the direct contents of
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
      // Recurse into at-rules (`@media`, `@layer`, ...) and into rules
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

      // Only compare a rule's own direct declarations—not those of any
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

    for (const [key, occurrences] of byKey) {
      const distinctRules = [...new Set(occurrences.map(occ => occ.rule))];
      if (distinctRules.length < 2) continue;

      const propNormalized = normalizeProp(occurrences[0].decl.prop);
      const first = distinctRules[0];
      const last = distinctRules[distinctRules.length - 1];
      const firstIndex = scope.rules.indexOf(first);
      const lastIndex = scope.rules.indexOf(last);

      // Conservative safety check: Refuse to merge if any other rule sitting
      // between the first and last occurrence also touches this property, or
      // a shorthand/longhand overlapping it (e.g. `margin-left` overlaps
      // `margin`)—for any selector. Moving the declaration past such a rule
      // could change which value wins for whatever that rule matches. This
      // is over-cautious by design: it will leave some genuinely safe merges
      // for manual review rather than risk breaking the cascade.
      //
      // One narrow exception: if every one of the intervening rule’s
      // selectors is provably mutually exclusive with every one of the
      // group’s own selectors (see `selectorsAreMutuallyExclusive()`—e.g.
      // `html[lang="da"] a` vs. `html[lang="de"] a`), it can never match an
      // element the group’s rules do, so it isn’t actually a threat to this
      // particular merge and scanning continues past it for a real blocker.
      const groupSelectors = distinctRules.flatMap(rule => splitSelectors(rule.selector));
      let blockingRule = null;
      let blockingProp = null;
      for (const [index, rule] of scope.rules.entries()) {
        if (index <= firstIndex || index >= lastIndex || distinctRules.includes(rule)) continue;
        const conflict = rule.nodes.find(node => node.type === 'decl' && propertiesOverlap(normalizeProp(node.prop), propNormalized));
        if (!conflict) continue;

        const candidateSelectors = splitSelectors(rule.selector);
        const provablyDisjoint = candidateSelectors.every(candidateSelector => (
          groupSelectors.every(groupSelector => selectorsAreMutuallyExclusive(candidateSelector, groupSelector))
        ));
        if (provablyDisjoint) continue;

        blockingRule = rule;
        blockingProp = normalizeProp(conflict.prop);
        break;
      }

      if (blockingRule) {
        const propDescription = blockingProp === propNormalized ? `\`${propNormalized}\`` : `overlapping \`${blockingProp}\``;
        skipped.push({
          scope: scope.label,
          key,
          reason: `intervening ${propDescription} declaration in \`${blockingRule.selector}\` (line ${blockingRule.source?.start?.line})`,
        });
        continue;
      }

      // Same safety concern, but for a declaration that sits in one of the
      // rules being merged itself rather than in between them: merging always
      // relocates the matched declaration to the last occurrence’s position,
      // so if one of the earlier rules also sets an overlapping property
      // alongside it, splitting them apart can flip their relative order for
      // elements the rule matches.
      const selfConflict = distinctRules
        .filter(rule => rule !== last)
        .flatMap(rule => rule.nodes
          .filter(node => (
            node.type === 'decl'
            && declarationKey(node.prop, node.value, node.important) !== key
            && propertiesOverlap(normalizeProp(node.prop), propNormalized)
          ))
          .map(decl => ({ rule, decl })))[0];

      if (selfConflict) {
        skipped.push({
          scope: scope.label,
          key,
          reason: `\`${selfConflict.rule.selector}\` (line ${selfConflict.rule.source?.start?.line}) also sets an overlapping \`${normalizeProp(selfConflict.decl.prop)}\` declaration`,
        });
        continue;
      }

      const mergedSelectors = [];
      for (const rule of distinctRules) {
        for (const selector of splitSelectors(rule.selector)) {
          if (!mergedSelectors.includes(selector)) mergedSelectors.push(selector);
        }
      }

      const target = last;
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
        if (rule.nodes.length === 0) rule.remove();
      }

      applied.push({ scope: scope.label, key, selectors: mergedSelectors, value: shortestValue });
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
