import postcss from 'postcss';
import { normalizeProp, declarationKey } from './normalize.js';
import { isIgnoredSelector, resolveIgnorePatterns } from './hacks.js';
import { splitSelectors } from './selectors.js';

// A "scope" is a DRY boundary: the root stylesheet, or the direct contents of
// one specific `@media`/`@supports`/`@layer`/etc. block, or one specific
// nested rule (native CSS nesting). Declarations are only ever compared for
// duplication within the same scope—never across scopes, since rules in
// different at-rule blocks or different nested rules can't share a merged
// rule.
function describeScope(container) {
  if (container.type === 'root') return 'root';
  if (container.type === 'rule') return container.selector;

  const chain = [];
  let node = container;
  while (node && node.type !== 'root') {
    chain.unshift(node.type === 'rule' ? node.selector : `@${node.name} ${node.params}`.trim());
    node = node.parent;
  }
  return chain.join(' > ');
}

function collectScopes(root) {
  const scopes = [];

  function walk(container) {
    // Statement-form at-rules (`@layer reset, base;`, `@import url(x.css);`)
    // have no block, so there's nothing to scope or recurse into.
    if (!container.nodes) return;

    const rules = container.nodes.filter(node => node.type === 'rule');
    if (rules.length) scopes.push({ container, rules, label: describeScope(container) });

    for (const node of container.nodes) {
      // Recurse into at-rules (`@media`, `@layer`, ...) and into rules
      // themselves, since native CSS nesting puts rules inside rules.
      if (node.type === 'atrule' || node.type === 'rule') walk(node);
    }
  }

  walk(root);
  return scopes;
}

function eligibleRules(scope, ignorePatterns) {
  return scope.rules.filter(rule => {
    const selectors = splitSelectors(rule.selector);
    return !selectors.every(selector => isIgnoredSelector(selector, ignorePatterns));
  });
}

export function analyzeRoot(root, options = {}) {
  const ignorePatterns = resolveIgnorePatterns(options);
  const scopes = collectScopes(root);
  const findings = [];

  for (const scope of scopes) {
    const byKey = new Map();

    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const seenInRule = new Set();

      // Only compare a rule's own direct declarations—not those of any
      // nested rules inside it, which belong to their own scope.
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
  };
}

export function dedupRoot(root, options = {}) {
  const ignorePatterns = resolveIgnorePatterns(options);
  const scopes = collectScopes(root);
  const applied = [];
  const skipped = [];

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

      // Conservative safety check: refuse to merge if any other rule sitting
      // between the first and last occurrence also touches this property—
      // for any selector. Moving the declaration past such a rule could
      // change which value wins for whatever that rule matches. This is
      // over-cautious by design: it will leave some genuinely safe merges
      // for manual review rather than risk breaking the cascade.
      const blockingRule = scope.rules.find((rule, index) => {
        if (index <= firstIndex || index >= lastIndex) return false;
        if (distinctRules.includes(rule)) return false;
        return rule.nodes.some(node => node.type === 'decl' && normalizeProp(node.prop) === propNormalized);
      });

      if (blockingRule) {
        skipped.push({
          scope: scope.label,
          key,
          reason: `intervening declaration for \`${propNormalized}\` in \`${blockingRule.selector}\` (line ${blockingRule.source?.start?.line})`,
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
      target.selector = mergedSelectors.join(', ');

      for (const rule of distinctRules) {
        if (rule === target) continue;
        for (const decl of rule.nodes.filter(node => node.type === 'decl')) {
          if (declarationKey(decl.prop, decl.value, decl.important) === key) decl.remove();
        }
        if (rule.nodes.length === 0) rule.remove();
      }

      applied.push({ scope: scope.label, key, selectors: mergedSelectors });
    }
  }

  return { applied, skipped };
}

export function dedup(css, options = {}) {
  const root = postcss.parse(css, { from: options.from });
  const { applied, skipped } = dedupRoot(root, options);
  return { css: root.toString(), applied, skipped };
}
