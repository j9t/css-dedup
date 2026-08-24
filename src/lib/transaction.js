// Snapshot and rollback around one speculative merge, for the `savingsOnly`
// gate. The gate measures a merge by performing it and undoing it again when
// it turns out to cost bytes, rather than by predicting its cost up front—so
// no merge strategy has to carry a second, parallel implementation of itself
// in byte arithmetic, and the figure the gate decides on is the real one.

import { forgetSeparator } from './style.js';

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

// A merge is priced from the few rules it actually rewrites,
// and everything around them cancels out untouched
let byteCache = new WeakMap();
// Nodes already in the tree when the pass began, so a rule a merge inserts can
// be told from one that was always there
let knownNodes = new WeakSet();
// Where the merge strategies report the rules they insert. Finding those any
// other way means scanning a container, which is the cost this exists to
// avoid—but the accounting below still reconciles against the container’s
// child count, so a strategy that forgets to report is slow, never wrong.
let insertions = null;

export function resetByteCache(root) {
  byteCache = new WeakMap();
  knownNodes = new WeakSet();
  root.walk(node => knownNodes.add(node));
}

export function recordInsertion(node) {
  if (insertions) insertions.push(node);
}

// How much text the gate has serialized to price merges;
// exported for the scaling test
let measuredBytes = 0;

export function measuredByteTotal() {
  return measuredBytes;
}

function textBytes(text) {
  return text ? Buffer.byteLength(text, 'utf8') : 0;
}

// `toString()` does not include a node’s own leading whitespace, so it counts
// separately—the two together are exactly what the node adds to the output
function measureNode(node) {
  const bytes = textBytes(node.raws.before) + Buffer.byteLength(node.toString(), 'utf8');
  measuredBytes += bytes;
  return bytes;
}

function cachedBytes(node) {
  let bytes = byteCache.get(node);
  if (bytes === undefined) {
    bytes = measureNode(node);
    byteCache.set(node, bytes);
  }
  return bytes;
}

function remeasure(node) {
  const bytes = measureNode(node);
  byteCache.set(node, bytes);
  return bytes;
}

// The root-level subtrees this merge could remove: its rules, or the blocks
// holding them, which `settle()` clears away once drained
function removableAtRoot(root, rules) {
  const removable = new Set();
  for (const rule of rules) {
    let node = rule;
    while (node.parent && node.parent !== root) node = node.parent;
    if (node.parent === root) removable.add(node);
  }
  return removable;
}

// The leading root children whose spacing a removal can rewrite. PostCSS hands
// each removed first child’s `raws.before` down the line, so a run of removals
// at the front reaches the first child that outlives them—no further.
function captureFront(root, removable) {
  const front = new Map();
  for (const node of root.nodes) {
    front.set(node, node.raws.before);
    if (!removable.has(node)) break;
  }
  return front;
}

// A node’s own mutable state plus its child list, recorded by identity rather
// than by cloning. Identity is the whole point: `runPass()` collects every
// scope up front, so a rule nested inside one this rollback touches is already
// spoken for by a later scope in the same pass. Hand that scope a clone and it
// would go on merging a subtree detached from the style sheet.
function captureNode(node) {
  return {
    node,
    raws: { ...node.raws },
    selector: node.selector,
    prop: node.prop,
    value: node.value,
    important: node.important,
    name: node.name,
    params: node.params,
    children: node.nodes ? node.nodes.map(captureNode) : null,
  };
}

function restoreNode(entry) {
  const { node } = entry;

  // Scalars before `raws`: PostCSS drops a value’s raw spelling when the value
  // itself is assigned, so restoring `raws` last is what puts it back
  if (entry.selector !== undefined) node.selector = entry.selector;
  if (entry.prop !== undefined) node.prop = entry.prop;
  if (entry.value !== undefined) node.value = entry.value;
  if (entry.important !== undefined) node.important = entry.important;
  if (entry.name !== undefined) node.name = entry.name;
  if (entry.params !== undefined) node.params = entry.params;
  node.raws = { ...entry.raws };

  if (!entry.children) return;
  node.nodes = entry.children.map(child => child.node);
  for (const child of node.nodes) child.parent = node;
  for (const child of entry.children) restoreNode(child);
}

/**
 * Everything needed to put a scope back exactly as it stands right now, and to
 * price what happens in between. Cheap enough to take per cluster—it walks one
 * cluster’s rules, not the style sheet.
 */
export function snapshot(root, scope, rules) {
  // Per rule, not just the sum: a rollback has to put these back into the
  // cache, or the speculative measurement would outlive the tree it described
  const ruleBefore = new Map();
  let ruleBytes = 0;
  for (const rule of rules) {
    const bytes = cachedBytes(rule);
    ruleBefore.set(rule, bytes);
    ruleBytes += bytes;
  }

  // Where each rule started, and the child counts of those containers, so the
  // reconciliation below can tell a genuine gap from an expected one
  const ruleParent = new Map();
  const counts = new Map();
  for (const rule of rules) {
    if (!rule.parent) continue;
    ruleParent.set(rule, rule.parent);
    counts.set(rule.parent, rule.parent.nodes.length);
  }

  insertions = [];

  return {
    root,
    ruleBefore,
    ruleBytes,
    ruleParent,
    counts,
    // PostCSS hands a removed first child’s `raws.before` to its successor, so
    // a node this merge never touched can still change size. That override
    // lives on `Root` alone—a nested container just splices—so only the root’s
    // own leading children need recording.
    frontBefores: captureFront(root, removableAtRoot(root, rules)),
    // Residual rules are appended here as merges create them, so the array
    // itself is state a rollback has to restore
    scopeRules: scope.rules.slice(),
    containers: affectedContainers(rules).map(container => ({ container, nodes: container.nodes.slice() })),
    rules: rules.map(rule => ({ entry: captureNode(rule), parent: rule.parent })),
  };
}

// Rules the merge reported inserting, plus—only where a container’s child
// count disagrees with what those reports account for—whatever else turned up
// in it. The scan is the safety net: It makes an unreported insertion cost a
// container walk rather than a wrong answer.
function insertedNodes(snap) {
  const found = new Set();
  const perContainer = new Map();

  for (const node of insertions) {
    if (!node.parent || knownNodes.has(node) || found.has(node)) continue;
    found.add(node);
    perContainer.set(node.parent, (perContainer.get(node.parent) ?? 0) + 1);
  }

  for (const [container, before] of snap.counts) {
    // A container the merge removed outright is priced as a whole, not by its
    // children
    if (!container.parent && container !== snap.root) continue;

    let gone = 0;
    for (const [rule, parent] of snap.ruleParent) {
      if (parent === container && rule.parent !== container) gone++;
    }
    if (container.nodes.length === before - gone + (perContainer.get(container) ?? 0)) continue;

    for (const node of container.nodes) {
      if (!knownNodes.has(node)) found.add(node);
    }
  }

  return [...found];
}

/**
 * What the merge just performed cost, in bytes of the whole style sheet.
 * Negative means it paid for itself.
 */
export function costSince(snap, removedContainers) {
  const { root, ruleBefore, frontBefores } = snap;
  let after = 0;

  // A rule the merge removed contributes nothing, and its old size stays
  // counted in `ruleBytes`
  for (const rule of ruleBefore.keys()) {
    if (rule.parent) after += remeasure(rule);
  }

  snap.inserted = insertedNodes(snap);
  for (const node of snap.inserted) {
    after += remeasure(node);
    knownNodes.add(node);
  }
  insertions = null;

  // A conditional block `settle()` cleared away. Its rules are already
  // accounted for above; what goes with it is the block’s own wrapper, which
  // is all that is left to measure now that it stands empty.
  let wrappers = 0;
  for (const container of removedContainers) wrappers += measureNode(container);

  // A node whose leading whitespace PostCSS rewrote when it promoted a new
  // first child, and that nothing above has re-measured
  let respaced = 0;
  for (const [node, before] of frontBefores) {
    if (ruleBefore.has(node) || node.parent !== root || before === node.raws.before) continue;
    respaced += textBytes(node.raws.before) - textBytes(before);
    byteCache.delete(node);
  }

  return after - snap.ruleBytes - wrappers + respaced;
}

// Restores the child lists first (which un-removes emptied rules and drops
// inserted residuals), then each rule’s own contents. Every node object is the
// one that was there before, so references held elsewhere—`scope.rules`, a
// cluster’s `distinctRules`, a nested scope collected earlier this pass—stay
// live across a rollback.
export function rollback(snap, scope) {
  // The speculative pass remeasured these; put the real figures back
  for (const [node, bytes] of snap.ruleBefore) byteCache.set(node, bytes);
  // Residuals it inserted are about to be dropped—they were never really here
  if (snap.inserted) for (const node of snap.inserted) knownNodes.delete(node);

  // …and undo any re-spacing PostCSS did when it promoted a new first child
  for (const [node, before] of snap.frontBefores) {
    if (node.raws.before !== before) {
      node.raws.before = before;
      byteCache.delete(node);
    }
  }

  for (const { container, nodes } of snap.containers) {
    container.nodes = nodes;
    for (const node of nodes) node.parent = container;
    forgetSeparator(container);
  }

  for (const { entry, parent } of snap.rules) {
    restoreNode(entry);
    entry.node.parent = parent;
  }

  scope.rules.length = 0;
  scope.rules.push(...snap.scopeRules);
}