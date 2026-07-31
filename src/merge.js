// The merge strategies. Each takes the run context `ctx` built by
// `consolidate.js`—the normalization mode bound once (`keyOf`/`propOf`), the
// file’s own formatting conventions, and the `applied`/`skipped` lists results
// accumulate into.
//
// The safety model these all share is described under “How It Works” in the
// README; each function below notes the part that constrains it.

import { eligibleRules, groupBySelectorKey, ownSelectors } from './lib/scopes.js';
import { splitSelectors, selectorsAreMutuallyExclusive, selectorsLikelyDisjoint } from './lib/selectors.js';
import { propertiesOverlap } from './lib/shorthands.js';
import { insertAfter, joinSelectors, typicalSeparator } from './lib/style.js';
import { declsOf, pushTo } from './lib/util.js';

// All occurrences of a key are equivalent by our own normalization rules, so
// the merge keeps whichever raw spelling is shortest rather than whatever the
// target happened to have. Only ever selects among text already in the
// source—synthesizing a shorter spelling is a minifier’s job.
function shortestValue(decls) {
  return decls.reduce((shortest, decl) => (
    decl.value.length < shortest.length ? decl.value : shortest
  ), decls[0].value);
}

function occurrenceDecls(occurrences) {
  return occurrences.map(occ => occ.decl);
}

function declFor(occurrences, rule) {
  return occurrences.find(occ => occ.rule === rule).decl;
}

// The union of every rule’s selectors, in first-seen order. `selectorOf` lets
// a caller substitute a rule’s original selector for its current one, which
// `mergeCluster()` needs after it has begun rewriting the hub.
function unionSelectors(rules, selectorOf = rule => rule.selector) {
  const merged = [];
  for (const rule of rules) {
    for (const selector of splitSelectors(selectorOf(rule))) {
      if (!merged.includes(selector)) merged.push(selector);
    }
  }
  return merged;
}

// A fresh rule cloned from `source`, carrying `decls` out of wherever they sit
// now. Used to split declarations that can’t travel with a merge out into
// their own rule.
function makeResidual(source, selector, decls) {
  const residual = source.clone({ nodes: [] });
  residual.selector = selector;
  for (const decl of decls) {
    decl.remove();
    residual.append(decl);
  }
  return residual;
}

// A declaration repeated verbatim (after normalization) within one container
// is always safe to collapse: nothing relocates across a rule boundary, and
// later wins regardless of what’s earlier, so dropping every occurrence but
// the last never changes which value applies. Runs before the cross-container
// passes, so those only ever see one occurrence per container per key.
export function removeRedundantDuplicates(ctx, container, scopeLabel, selectors) {
  const collapsed = [];
  const byKey = new Map();

  for (const decl of declsOf(container)) pushTo(byKey, ctx.keyOf(decl), decl);

  for (const [key, decls] of byKey) {
    if (decls.length < 2) continue;

    const last = decls.at(-1);
    const value = shortestValue(decls);
    if (last.value !== value) last.value = value;

    for (const decl of decls) {
      if (decl !== last) decl.remove();
    }

    collapsed.push({ scope: scopeLabel, key, redundant: true, selectors, value });
  }

  return collapsed;
}

// A declaration that doesn’t participate in the merge but sits close enough to
// it, within the same rule, to affect the outcome
function isOverlappingExtra(ctx, node, propNormalized, excludeKey) {
  return node.type === 'decl'
    && ctx.keyOf(node) !== excludeKey
    && propertiesOverlap(ctx.propOf(node.prop), propNormalized);
}

// Refuses a merge when a rule between the group’s first and last occurrence
// also touches this property family, for any selector—moving the declaration
// past it could change which value wins. Over-cautious by design.
//
// Exception: a rule whose every selector is provably mutually exclusive with
// every one of the group’s own can never match an element the group’s rules
// do, so the scan continues past it. Aggressive mode widens this to selectors
// that are merely likely disjoint.
//
// `exemptRules` covers the group’s whole entangled cluster—a fellow member is
// being absorbed into the same coordinated merge, not staying behind.
export function findBlockingRule(ctx, scope, distinctRules, exemptRules, firstIndex, lastIndex, propNormalized) {
  // Only rules actually inside the span can block; walking the whole scope to
  // skip everything outside it made this quadratic in the scope’s rule count.
  // The group’s own selector list is likewise only needed once something in
  // that span conflicts, which is the rare case.
  let groupSelectors = null;

  for (let index = firstIndex + 1; index < lastIndex; index++) {
    const rule = scope.rules[index];
    if (exemptRules.has(rule)) continue;

    const conflict = rule.nodes.find(node => (
      node.type === 'decl' && propertiesOverlap(ctx.propOf(node.prop), propNormalized)
    ));
    if (!conflict) continue;

    groupSelectors ??= distinctRules.flatMap(groupRule => splitSelectors(groupRule.selector));
    // The memoized heuristic goes first: in aggressive mode it clears most
    // pairs, saving the exclusivity proof’s full selector parse
    const disjoint = splitSelectors(rule.selector).every(candidate => (
      groupSelectors.every(groupSelector => (
        (ctx.aggressive && selectorsLikelyDisjoint(candidate, groupSelector))
        || selectorsAreMutuallyExclusive(candidate, groupSelector)
      ))
    ));
    if (disjoint) continue;

    return { rule, prop: ctx.propOf(conflict.prop) };
  }

  return null;
}

// Folds rules repeating the same selector list within one scope into the last
// of them. Earlier rules’ declarations move to the top of the target, in
// source order, which preserves every same-selector cascade outcome. Sources
// are processed nearest the target first, so an earlier rule’s span check
// always sees any same-selector rule that could not be folded still sitting in
// the way. Only rules holding nothing but declarations participate as sources.
export function foldSameSelectorRules(ctx, scope) {
  for (const rules of groupBySelectorKey(eligibleRules(scope, ctx.ignorePatterns)).values()) {
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
        blocking = findBlockingRule(ctx, scope, [rule, target], exempt, ruleIndex, targetIndex, ctx.propOf(decl.prop));
        if (blocking) break;
      }

      if (blocking) {
        ctx.skipped.push({
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
      ctx.applied.push({
        scope: scope.label,
        key: splitSelectors(target.selector).join(', '),
        selectors: ownSelectors(target.selector),
        folded: true,
      });
      merged = true;
    }

    // A duplicate the fold brought into one rule is collapsed right here,
    // rather than ever forming a cross-rule group
    if (merged) {
      ctx.applied.push(...removeRedundantDuplicates(ctx, target, scope.label, ownSelectors(target.selector)));
    }
  }
}

// A duplicate-key group with no entanglement: fold every rule’s selector onto
// the last occurrence and drop the declaration from the others.
//
// Two concerns, both handled by splitting an extra declaration out into its
// own residual rule, for different reasons: the target’s own other
// declarations always need to move, overlapping or not, while a non-target
// occurrence’s extra only needs to move if it overlaps the shared property and
// was declared after it.
export function mergeSoloGroup(ctx, scope, group) {
  const { key, occurrences, distinctRules, propNormalized } = group;
  const target = distinctRules.at(-1);

  // A residual cloned from `target` inherits whatever separated target from
  // what preceded it—correct only for one taking over target’s own original
  // slot. Any other needs the file’s normal between-rules separator.
  const interPieceSeparator = typicalSeparator(target.parent);

  const beforeExtrasByRule = new Map();
  const afterExtrasByRule = new Map();
  for (const rule of distinctRules) {
    const sharedIndex = rule.nodes.indexOf(declFor(occurrences, rule));

    if (rule === target) {
      const isExtra = node => node.type === 'decl' && ctx.keyOf(node) !== key;
      const afterExtras = rule.nodes.filter((node, index) => index > sharedIndex && isExtra(node));
      const beforeExtras = rule.nodes.filter((node, index) => index < sharedIndex && isExtra(node));
      if (afterExtras.length) afterExtrasByRule.set(rule, afterExtras);
      if (beforeExtras.length) beforeExtrasByRule.set(rule, beforeExtras);
    } else {
      const afterExtras = rule.nodes.filter((node, index) => (
        index > sharedIndex && isOverlappingExtra(ctx, node, propNormalized, key)
      ));
      if (afterExtras.length) afterExtrasByRule.set(rule, afterExtras);
    }
  }

  const mergedSelectors = unionSelectors(distinctRules);
  const targetOriginalSelector = target.selector;
  target.selector = joinSelectors(mergedSelectors, target, ctx.multilineSelectors, ctx.spacedCommas);

  const value = shortestValue(occurrenceDecls(occurrences));
  const targetDecl = declFor(occurrences, target);
  if (targetDecl.value !== value) targetDecl.value = value;

  for (const rule of distinctRules) {
    if (rule === target) continue;
    for (const decl of declsOf(rule)) {
      if (ctx.keyOf(decl) === key) decl.remove();
    }
  }

  let beforeResidual = null;
  const targetBeforeExtras = beforeExtrasByRule.get(target);
  if (targetBeforeExtras) {
    beforeResidual = makeResidual(target, targetOriginalSelector, targetBeforeExtras);
    target.before(beforeResidual);
    target.raws.before = interPieceSeparator;
  }

  const afterResiduals = [];
  let insertPoint = target;
  for (const rule of distinctRules) {
    const extras = afterExtrasByRule.get(rule);
    if (!extras) continue;

    const residual = makeResidual(target, rule === target ? targetOriginalSelector : rule.selector, extras);
    insertAfter(insertPoint, residual, interPieceSeparator);
    insertPoint = residual;
    afterResiduals.push(residual);
  }

  for (const rule of distinctRules) {
    if (rule === target || rule.nodes.length > 0) continue;
    rule.remove();
  }

  // Later groups in this scope also scan `scope.rules` for intervening
  // conflicts, and need to see these new residuals to stay accurate
  let spliceIndex = scope.rules.indexOf(target);
  if (beforeResidual) {
    scope.rules.splice(spliceIndex, 0, beforeResidual);
    spliceIndex += 1;
  }
  if (afterResiduals.length) scope.rules.splice(spliceIndex + 1, 0, ...afterResiduals);

  ctx.applied.push({ scope: scope.label, key, selectors: mergedSelectors, value });
}

// A blocker fences a group, it doesn’t forbid it: occurrences on one side of
// the blocking rule can still merge among themselves. Each maximal run of
// consecutive occurrences with clean spans between neighbors merges as a small
// group in its own right. The group as a whole is still reported skipped,
// since the duplicate keeps existing across the blocker.
//
// Solo groups only—in a multi-group cluster a partial merge could relocate a
// shared rule’s selector out from under the other groups.
export function mergePartialGroup(ctx, scope, group, reason) {
  const { key, occurrences, distinctRules, propNormalized } = group;
  const exempt = new Set(distinctRules);

  const runs = [[distinctRules[0]]];
  for (let i = 1; i < distinctRules.length; i++) {
    const previousIndex = scope.rules.indexOf(distinctRules[i - 1]);
    const nextIndex = scope.rules.indexOf(distinctRules[i]);
    if (findBlockingRule(ctx, scope, distinctRules, exempt, previousIndex, nextIndex, propNormalized)) {
      runs.push([]);
    }
    runs.at(-1).push(distinctRules[i]);
  }

  for (const runRules of runs) {
    if (runRules.length < 2) continue;
    const runSet = new Set(runRules);
    mergeSoloGroup(ctx, scope, {
      key,
      occurrences: occurrences.filter(occ => runSet.has(occ.rule)),
      distinctRules: runRules,
      propNormalized,
    });
  }

  // Whatever merged above resurfaces as a smaller group on the next
  // fixed-point pass; this entry only survives from the final, quiescent pass,
  // where it describes exactly what remains split and why
  ctx.skipped.push({ scope: scope.label, key, reason });
}

// The copy-paste pattern: two or more rules all carrying exactly the same set
// of shared declarations. They can be folded whole into the last one when
// that’s provably safe—every rule must consist of nothing but the cluster’s
// own shared declarations, and the keys must either appear in the same order
// in every rule or be pairwise non-overlapping. Returns `false` (leaving the
// cluster to be skipped) when the shape doesn’t match.
function mergeTwinRules(ctx, scope, cluster, ruleKeyCounts) {
  const clusterSize = cluster.length;
  if (![...ruleKeyCounts.values()].every(keysHere => keysHere.size === clusterSize)) return false;

  const clusterKeys = new Set(cluster.map(group => group.key));
  const rules = [...ruleKeyCounts.keys()].sort((a, b) => scope.rules.indexOf(a) - scope.rules.indexOf(b));

  for (const rule of rules) {
    const allShared = rule.nodes.every(node => node.type === 'decl' && clusterKeys.has(ctx.keyOf(node)));
    if (!allShared) return false;
  }

  const sequences = rules.map(rule => rule.nodes.map(node => ctx.keyOf(node)).join('\n'));
  if (!sequences.every(sequence => sequence === sequences[0])) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        if (propertiesOverlap(cluster[i].propNormalized, cluster[j].propNormalized)) return false;
      }
    }
  }

  const target = rules.at(-1);
  const mergedSelectors = unionSelectors(rules);
  target.selector = joinSelectors(mergedSelectors, target, ctx.multilineSelectors, ctx.spacedCommas);

  for (const decl of target.nodes) {
    const key = ctx.keyOf(decl);
    const group = cluster.find(candidate => candidate.key === key);
    const value = shortestValue(occurrenceDecls(group.occurrences));
    if (decl.value !== value) decl.value = value;

    ctx.applied.push({ scope: scope.label, key, selectors: mergedSelectors, value });
  }

  for (const rule of rules) {
    if (rule === target) continue;
    rule.remove();
    scope.rules.splice(scope.rules.indexOf(rule), 1);
  }

  return true;
}

// For a group inside a cluster that can’t merge as a whole, safe sub-runs can
// still consolidate under a stricter recipe than a solo group’s, since fellow
// cluster rules must stay intact:
//
//   - The merged rule is a fresh one, inserted right after the run’s last
//     member, so no member’s selector is ever mutated and entanglement can’t
//     leak one group’s selectors into another’s.
//   - Runs are fenced by any rule carrying an overlapping declaration,
//     including fellow cluster members, which stay behind.
//   - A member whose own trailing declarations overlap the key is refused
//     outright—relocating the key past its own tail would flip which wins.
//     Skipping it still fences the runs around it.
function mergeClusterGroupRuns(ctx, scope, group) {
  const { key, occurrences, distinctRules, propNormalized } = group;

  const viable = rule => {
    const declIndex = rule.nodes.indexOf(declFor(occurrences, rule));
    return !rule.nodes.some((node, index) => (
      index > declIndex && node.type === 'decl' && propertiesOverlap(ctx.propOf(node.prop), propNormalized)
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
      // Replacing these scans with a rule → position `Map` is twice as slow:
      // `indexOf()` stops at the hit, building the map is always a full pass,
      // and each rebuild covers only a handful of lookups (`scope.rules`
      // changes as merges land)
      const previousIndex = scope.rules.indexOf(run.at(-1));
      const nextIndex = scope.rules.indexOf(rule);
      if (findBlockingRule(ctx, scope, distinctRules, new Set(), previousIndex, nextIndex, propNormalized)) {
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
    const mergedSelectors = unionSelectors(runRules);
    const value = shortestValue(occurrenceDecls(runOccurrences));

    const mergedRule = lastRule.clone({ nodes: [] });
    mergedRule.selector = joinSelectors(mergedSelectors, lastRule, ctx.multilineSelectors, ctx.spacedCommas);
    const lastDecl = declFor(runOccurrences, lastRule);
    lastDecl.remove();
    if (lastDecl.value !== value) lastDecl.value = value;
    mergedRule.append(lastDecl);
    lastRule.after(mergedRule);
    scope.rules.splice(scope.rules.indexOf(lastRule) + 1, 0, mergedRule);

    // The clone inherited `lastRule`’s own `raws.before`—right if `lastRule`
    // ends up empty and removed below (`mergedRule` then takes over its slot),
    // wrong otherwise, where it’s a fresh insertion after a rule that keeps
    // standing. Reassigned after `.after()` for the reason `insertAfter()`
    // documents.
    if (lastRule.nodes.length > 0) mergedRule.raws.before = typicalSeparator(lastRule.parent);

    for (const rule of runRules) {
      if (rule === lastRule) continue;
      declFor(runOccurrences, rule).remove();
      if (rule.nodes.length === 0) rule.remove();
    }
    if (lastRule.nodes.length === 0) lastRule.remove();

    ctx.applied.push({ scope: scope.label, key, selectors: mergedSelectors, value });
  }
}

// Splits the hub of a “star” cluster into one rule per cluster key, in the
// order those keys’ declarations already had within the hub—always a valid
// order, read straight off one rule’s own declaration sequence. Anything else
// in the hub travels along as its own residual, in the same relative slot.
function splitStarHub(ctx, scope, cluster, hub) {
  const hubOriginalSelector = hub.selector;
  const hubIndex = scope.rules.indexOf(hub);

  // Every piece cloned from the hub inherits the hub’s own `raws.before`—
  // appropriate for the first piece only; later ones need the file’s normal
  // between-rules separator
  const interPieceSeparator = typicalSeparator(hub.parent);

  // Snapshot each key’s shared declaration and its position within the hub
  // before any mutation, then order the keys by that position
  const anchors = cluster
    .map(group => {
      const decl = declFor(group.occurrences, hub);
      return { group, decl, index: hub.nodes.indexOf(decl) };
    })
    .sort((a, b) => a.index - b.index);

  // The anchors’ indices are positions in the hub as it originally stood, but
  // the loop below removes declarations as it goes—so gap lookups filter a
  // snapshot, or a declaration between two anchors would be missed (and then
  // silently dropped with the hub itself)
  const hubOriginalNodes = [...hub.nodes];
  const gapDecls = (fromIndex, toIndex) => hubOriginalNodes.filter((node, index) => (
    node.type === 'decl' && index > fromIndex && index < toIndex
  ));

  const finalRules = [];
  for (let i = 0; i < anchors.length; i++) {
    const gap = gapDecls(i === 0 ? -1 : anchors[i - 1].index, anchors[i].index);
    if (gap.length) finalRules.push(makeResidual(hub, hubOriginalSelector, gap));

    const { group, decl: sharedDecl } = anchors[i];
    const { key, occurrences, distinctRules, propNormalized } = group;

    const mergedSelectors = unionSelectors(distinctRules, rule => (
      rule === hub ? hubOriginalSelector : rule.selector
    ));

    const value = shortestValue(occurrenceDecls(occurrences));
    if (sharedDecl.value !== value) sharedDecl.value = value;

    const anchorRule = hub.clone({ nodes: [] });
    anchorRule.selector = joinSelectors(mergedSelectors, hub, ctx.multilineSelectors, ctx.spacedCommas);
    sharedDecl.remove();
    anchorRule.append(sharedDecl);

    // The hub’s new position for this key is the hub’s original slot, which
    // may sit either before or after a given member—so which side an extra
    // ends up on depends on that direction too, unlike a solo merge’s
    // non-target, which is always “after”
    const beforeExtras = [];
    const afterExtras = [];
    for (const rule of distinctRules) {
      if (rule === hub) continue;

      const memberSharedDecl = declFor(occurrences, rule);
      const memberSharedIndex = rule.nodes.indexOf(memberSharedDecl);
      const memberIsAfterHub = scope.rules.indexOf(rule) > hubIndex;
      const target = memberIsAfterHub ? beforeExtras : afterExtras;

      target.push(...rule.nodes.filter((node, index) => (
        (memberIsAfterHub ? index < memberSharedIndex : index > memberSharedIndex)
        && isOverlappingExtra(ctx, node, propNormalized, key)
      )));

      memberSharedDecl.remove();
    }

    if (beforeExtras.length) finalRules.push(makeResidual(hub, hubOriginalSelector, beforeExtras));
    finalRules.push(anchorRule);
    if (afterExtras.length) finalRules.push(makeResidual(hub, hubOriginalSelector, afterExtras));

    ctx.applied.push({ scope: scope.label, key, selectors: mergedSelectors, value });
  }

  const trailingGap = gapDecls(anchors.at(-1).index, hubOriginalNodes.length);
  if (trailingGap.length) finalRules.push(makeResidual(hub, hubOriginalSelector, trailingGap));

  hub.before(finalRules[0]);
  for (let i = 1; i < finalRules.length; i++) {
    insertAfter(finalRules[i - 1], finalRules[i], interPieceSeparator);
  }
  hub.remove();

  for (const group of cluster) {
    for (const rule of group.distinctRules) {
      if (rule !== hub && rule.nodes.length === 0) rule.remove();
    }
  }

  scope.rules.splice(hubIndex, 1, ...finalRules);
}

// A cluster is two or more duplicate-key groups sharing a rule, which is
// unsafe to merge key by key: whichever merge runs first mutates that rule’s
// selector, and the next would fold in the already-expanded list, leaking its
// declaration to selectors never meant to have it.
//
// Only the “star” topology splits cleanly—one hub rule belonging to every
// group, with no other rule shared between any two. Anything else has no
// single anchor position satisfying every pairwise ordering constraint at
// once, so it falls back to `mergeTwinRules()` or per-group sub-runs.
function mergeCluster(ctx, scope, cluster) {
  const ruleKeyCounts = new Map();
  for (const group of cluster) {
    for (const rule of group.distinctRules) {
      if (!ruleKeyCounts.has(rule)) ruleKeyCounts.set(rule, new Set());
      ruleKeyCounts.get(rule).add(group.key);
    }
  }

  // Exactly one full-membership rule: with two candidate hubs, each holds
  // every cluster key in its own order, and splitting around either would
  // reorder the other’s declarations
  const clusterSize = cluster.length;
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

  if (isStar) {
    splitStarHub(ctx, scope, cluster, hub);
    return;
  }

  if (mergeTwinRules(ctx, scope, cluster, ruleKeyCounts)) return;

  for (const group of cluster) {
    mergeClusterGroupRuns(ctx, scope, group);
    ctx.skipped.push({
      scope: scope.label,
      key: group.key,
      reason: 'entangled with another duplicate group through more than one shared rule, with no single rule connecting them all',
    });
  }
}

// Clusters the candidate groups by shared rule membership (union-find): two
// groups land in the same cluster iff some rule belongs to both. Runs before
// the intervening-rule check, since a rule that looks like an outside blocker
// for one group can turn out to be a fellow cluster member instead.
function clusterGroups(groups) {
  const parent = new Map(groups.map(group => [group.key, group.key]));
  const find = key => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const keysByRule = new Map();
  for (const group of groups) {
    for (const rule of group.distinctRules) pushTo(keysByRule, rule, group.key);
  }
  for (const keysHere of keysByRule.values()) {
    for (let i = 1; i < keysHere.length; i++) union(keysHere[0], keysHere[i]);
  }

  const clusters = new Map();
  for (const group of groups) pushTo(clusters, find(group.key), group);
  return [...clusters.values()];
}

export function mergeDuplicateGroups(ctx, scope) {
  const byKey = new Map();
  for (const rule of eligibleRules(scope, ctx.ignorePatterns)) {
    for (const decl of declsOf(rule)) pushTo(byKey, ctx.keyOf(decl), { rule, decl });
  }

  // Every 2+-occurrence key is a merge candidate
  const groups = [];
  for (const [key, occurrences] of byKey) {
    const distinctRules = [...new Set(occurrences.map(occ => occ.rule))];
    if (distinctRules.length < 2) continue;
    groups.push({ key, occurrences, distinctRules, propNormalized: ctx.propOf(occurrences[0].decl.prop) });
  }

  // The intervening-rule check runs per cluster, against the file as it stood
  // before any of this scope’s merges start—but exempts every rule in the
  // cluster, not just one group’s own members
  for (const cluster of clusterGroups(groups)) {
    const clusterRules = new Set(cluster.flatMap(group => group.distinctRules));
    let outsideBlocker = null;

    for (const group of cluster) {
      const firstIndex = scope.rules.indexOf(group.distinctRules[0]);
      const lastIndex = scope.rules.indexOf(group.distinctRules.at(-1));
      const blocking = findBlockingRule(ctx, scope, group.distinctRules, clusterRules, firstIndex, lastIndex, group.propNormalized);
      if (blocking) { outsideBlocker = { group, blocking }; break; }
    }

    if (!outsideBlocker) {
      if (cluster.length === 1) mergeSoloGroup(ctx, scope, cluster[0]);
      else mergeCluster(ctx, scope, cluster);
      continue;
    }

    const { group, blocking } = outsideBlocker;
    const propDescription = blocking.prop === group.propNormalized ? `\`${group.propNormalized}\`` : `overlapping \`${blocking.prop}\``;
    const reason = `intervening ${propDescription} declaration in \`${blocking.rule.selector}\` (line ${blocking.rule.source?.start?.line})`;

    if (cluster.length === 1) {
      mergePartialGroup(ctx, scope, group, reason);
      continue;
    }

    for (const member of cluster) {
      mergeClusterGroupRuns(ctx, scope, member);
      ctx.skipped.push({
        scope: scope.label,
        key: member.key,
        reason: member === group ? reason : `part of a duplicate group entangled with \`${group.key}\`, which is blocked: ${reason}`,
      });
    }
  }
}
