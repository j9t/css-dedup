// Snapshot and rollback around one speculative merge, for the `savingsOnly`
// gate. The gate measures a merge by performing it and undoing it again when
// it turns out to cost bytes, rather than by predicting its cost up front—so
// no merge strategy has to carry a second, parallel implementation of itself
// in byte arithmetic, and the figure the gate decides on is the real one.

// Every container whose child list a merge can touch: the rules’ own parents,
// plus their ancestors up to the root—an aggressive cross-block merge can
// drain a conditional block, whose removal changes *its* parent’s child list.
function affectedContainers(rules) {
  const containers = new Set();
  for (const rule of rules) {
    for (let node = rule.parent; node; node = node.parent) containers.add(node);
  }
  return [...containers];
}

export function byteLength(root) {
  return Buffer.byteLength(root.toString(), 'utf8');
}

/**
 * Everything needed to put a scope back exactly as it stands right now.
 * Cheap enough to take per cluster—the node clones are shallow copies of one
 * cluster’s rules, not of the style sheet.
 */
export function snapshot(scope, rules) {
  return {
    // Residual rules are appended here as merges create them, so the array
    // itself is state a rollback has to restore
    scopeRules: scope.rules.slice(),
    containers: affectedContainers(rules).map(container => ({ container, nodes: container.nodes.slice() })),
    rules: rules.map(rule => ({ rule, clone: rule.clone(), parent: rule.parent })),
  };
}

// Restores the child lists first (which un-removes emptied rules and drops
// inserted residuals), then each rule’s own contents. The rule objects are the
// same identities throughout, so references held elsewhere—`scope.rules`, a
// cluster’s `distinctRules`—stay live across a rollback.
export function rollback(snap, scope) {
  for (const { container, nodes } of snap.containers) {
    container.nodes = nodes;
    for (const node of nodes) node.parent = container;
  }

  for (const { rule, clone, parent } of snap.rules) {
    rule.selector = clone.selector;
    rule.raws = { ...clone.raws };
    rule.removeAll();
    rule.append(clone.nodes.map(node => node.clone()));
    rule.parent = parent;
  }

  scope.rules.length = 0;
  scope.rules.push(...snap.scopeRules);
}