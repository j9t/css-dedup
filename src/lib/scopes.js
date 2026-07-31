// Scope collection: what counts as one DRY boundary, and which rules inside it
// are eligible for comparison.

import { isIgnoredSelector } from './hacks.js';
import { splitSelectors } from './selectors.js';
import { pushTo } from './util.js';

function normalizeScopeSegment(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// A rule’s own `splitSelectors()` result is a shared, cached array, so
// anything handed to the outside world gets a copy first
export function ownSelectors(selector) {
  return [...splitSelectors(selector)];
}

// An anonymous `@layer {}` block is its own cascade layer—unlike two
// same-name `@layer x {}` blocks, which share one—so each gets a unique label
// and never matches another scope
const layersAnonymous = new WeakMap();
let layersAnonymousCount = 0;

function atRuleScopeSegment(node) {
  if (node.name.toLowerCase() === 'layer' && !node.params.trim()) {
    if (!layersAnonymous.has(node)) layersAnonymous.set(node, ++layersAnonymousCount);
    return `@layer (anonymous ${layersAnonymous.get(node)})`;
  }
  return normalizeScopeSegment(`@${node.name} ${node.params}`);
}

// The label identifying one DRY boundary—always the full ancestor chain, so a
// `.card` nesting host at the root and one inside `@media print` stay
// distinct. Whitespace is normalized, case is not (`@layer` names and
// selectors can be case-sensitive).
export function describeScope(container) {
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

// Walks every container that can hold rules or declarations, parents before
// children—at-rules and (native CSS nesting) rules alike. Statement-form
// at-rules (`@import url(x.css);`) have no block, so nothing to visit.
function walkContainers(container, visit) {
  if (!container.nodes) return;
  visit(container);

  for (const node of container.nodes) {
    if (node.type === 'atrule' || node.type === 'rule') walkContainers(node, visit);
  }
}

export function collectScopes(root) {
  const scopes = [];
  walkContainers(root, container => {
    const rules = container.nodes.filter(node => node.type === 'rule');
    if (rules.length) scopes.push({ rules, label: describeScope(container) });
  });
  return scopes;
}

// Two blocks with the same condition are the same DRY boundary even when
// written separately in the source: a declaration duplicated across them is
// exactly as redundant as one repeated within a single block.
//
// Safe for reporting, not for merging. A merge keeps the last occurrence’s
// rule in its own container, so within one container nothing’s position
// relative to the outside changes—the container is a firewall the
// intervening-rule check can reason about using only its own rules. Fold two
// containers into one scope and a rule sitting between them, in some other
// scope entirely, can matter for the merge without that check ever seeing it.
// Hence `analyzeRoot()` uses this and `consolidateRoot()` doesn’t, except in
// aggressive mode, which accepts the risk.
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

export function collectMergedScopes(root) {
  return mergeScopesByLabel(collectScopes(root));
}

// At-rules holding declarations directly, with no selector (`@font-face`,
// `@page`, `@property`). Never compared against each other—repeating a
// declaration across two `@font-face` blocks usually isn’t a mistake—so this
// only supports the within-one-block redundancy check.
export function collectDeclOnlyContainers(root) {
  const containers = [];
  walkContainers(root, container => {
    if (container.type === 'atrule' && container.nodes.some(node => node.type === 'decl')) {
      containers.push(container);
    }
  });
  return containers;
}

// Stands in for the selector `@font-face` and friends don’t have, in scope
// labels and in occurrence/applied output alike
export function atRuleLabel(atrule) {
  return `@${atrule.name}${atrule.params ? ` ${atrule.params}` : ''}`;
}

// Canonical identity of a rule’s selector list, order- and
// whitespace-insensitive—`.b, .a` matches the same elements with the same
// specificities as `.a, .b`. Whitespace is only collapsed outside quotes:
// `[data-x="a  b"]` and `[data-x="a b"]` are different selectors.
export function selectorSetKey(rule) {
  return splitSelectors(rule.selector)
    .map(selector => selector.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\s+/g, (match, quoted) => quoted ?? ' '))
    .sort()
    .join(',');
}

// A rule is only eligible if none of its selectors are ignored—a mixed list
// like `.foo, *html .bar` can neither drop just the hack part (orphaning its
// declarations) nor merge as-is (contaminating the merged rule)
export function eligibleRules(scope, ignorePatterns) {
  return scope.rules.filter(rule => (
    !splitSelectors(rule.selector).some(selector => isIgnoredSelector(selector, ignorePatterns))
  ));
}

// Groups a scope’s eligible rules by selector-list identity, for the repeated
// selector finding and the same-selector fold alike
export function groupBySelectorKey(rules) {
  const bySelector = new Map();
  for (const rule of rules) pushTo(bySelector, selectorSetKey(rule), rule);
  return bySelector;
}
