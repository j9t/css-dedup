// Read-only duplicate detection. Never moves anything, so unlike
// `consolidate.js` it can use the merged view of same-condition blocks.

import postcss from 'postcss';
import { resetCaches } from './lib/caches.js';
import { resolveIgnorePatterns } from './lib/hacks.js';
import { declarationKey } from './lib/normalization.js';
import {
  atRuleLabel,
  collectDeclOnlyContainers,
  collectMergedScopes,
  collectScopes,
  describeScope,
  eligibleRules,
  groupBySelectorKey,
  ownSelectors,
} from './lib/scopes.js';
import { splitSelectors } from './lib/selectors.js';
import { declsOf, pushTo } from './lib/util.js';

function describeOccurrence({ rule, decl }) {
  return {
    selector: rule.selector,
    selectors: ownSelectors(rule.selector),
    prop: decl.prop,
    value: decl.value,
    line: decl.source?.start?.line,
    decl,
  };
}

// Mirrors `describeOccurrence()` for an at-rule with no selector of its own—
// its `@name params` stands in, for CLI/plugin output and for callers reading
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

// Declarations repeated within one rule, and the same key shared across two or
// more rules in one scope
function findDeclarationDuplicates(root, { keyOf, ignorePatterns }) {
  const findings = [];

  for (const scope of collectMergedScopes(root)) {
    const byKey = new Map();

    for (const rule of eligibleRules(scope, ignorePatterns)) {
      const seenInRule = new Set();

      for (const decl of declsOf(rule)) {
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
        pushTo(byKey, key, occurrence);
      }
    }

    for (const [key, occurrences] of byKey) {
      const distinctRules = new Set(occurrences.map(occ => occ.rule));
      if (distinctRules.size < 2) continue;

      findings.push({
        scope: scope.label,
        key,
        occurrences: [...distinctRules].map(rule => (
          describeOccurrence({ rule, decl: occurrences.find(occ => occ.rule === rule).decl })
        )),
      });
    }
  }

  return findings;
}

// A selector list written more than once in one scope is the same
// maintainability smell one level up from a repeated declaration. Detected on
// physical containers, since two same-condition `@media` blocks legitimately
// repeat their selectors by construction.
function findRepeatedSelectors(root, { ignorePatterns }) {
  const findings = [];

  for (const scope of collectScopes(root)) {
    for (const rules of groupBySelectorKey(eligibleRules(scope, ignorePatterns)).values()) {
      if (rules.length < 2) continue;

      findings.push({
        scope: scope.label,
        key: splitSelectors(rules[0].selector).join(', '),
        repeated: true,
        occurrences: rules.map(rule => ({
          selector: rule.selector,
          selectors: ownSelectors(rule.selector),
          line: rule.source?.start?.line,
        })),
      });
    }
  }

  return findings;
}

// Declarations repeated inside one selector-less at-rule block
function findAtRuleDuplicates(root, { keyOf }) {
  const findings = [];

  for (const atrule of collectDeclOnlyContainers(root)) {
    const seen = new Set();

    for (const decl of declsOf(atrule)) {
      const key = keyOf(decl);
      if (seen.has(key)) {
        findings.push({
          scope: describeScope(atrule),
          key,
          redundant: true,
          occurrences: [describeAtRuleOccurrence(atrule, decl)],
        });
      }
      seen.add(key);
    }
  }

  return findings;
}

export function analyzeRoot(root, options = {}) {
  resetCaches();

  const aggressive = options.aggressive ?? false;
  const context = {
    ignorePatterns: resolveIgnorePatterns(options),
    // The normalization mode is bound once per run, so no call site can fall
    // back to default-mode normalization by forgetting a flag
    keyOf: decl => declarationKey(decl.prop, decl.value, decl.important, aggressive),
  };

  return {
    findings: [
      ...findDeclarationDuplicates(root, context),
      ...findRepeatedSelectors(root, context),
      ...findAtRuleDuplicates(root, context),
    ],
  };
}

export function analyze(css, options = {}) {
  return analyzeRoot(postcss.parse(css, { from: options.from }), options);
}
