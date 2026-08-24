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

export function byteLength(root) {
  return Buffer.byteLength(root.toString(), 'utf8');
}

// Measuring a merge by re-serializing the whole style sheet costs the file’s
// size per cluster, which on a sheet made of many small duplicate groups turns
// the gate quadratic. A merge only ever changes the top-level subtrees its own
// rules sit in, though, so only those need measuring—everything else cancels
// between the before and after sums.
//
// Byte counts are cached per node and invalidated by re-measuring exactly the
// subtrees a merge touched. `raws.before` belongs to the node, so a sibling
// moving never changes a neighbor’s contribution.
let byteCache = new WeakMap();
// Which nodes were already root children when the pass began, so a residual a
// merge inserts can be told apart from a rule that was always there
let knownRootChildren = new WeakSet();

export function resetByteCache(root) {
  byteCache = new WeakMap();
  knownRootChildren = new WeakSet();
  for (const node of root.nodes) knownRootChildren.add(node);
}

function textBytes(text) {
  return text ? Buffer.byteLength(text, 'utf8') : 0;
}

function measureNode(node) {
  return Buffer.byteLength((node.raws.before ?? '') + node.toString(), 'utf8');
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

// The root-level ancestors of the rules a merge touches—the subtrees whose
// serialization it can change
function topLevelRegion(root, rules) {
  const region = new Set();
  for (const rule of rules) {
    let node = rule;
    while (node.parent && node.parent !== root) node = node.parent;
    if (node.parent === root) region.add(node);
  }
  return region;
}

// The leading run of root children this merge could remove, plus the first one
// it could not—the only nodes whose leading whitespace PostCSS can rewrite
function captureFront(root, region) {
  const front = new Map();
  if (!root.nodes.length || !region.has(root.nodes[0])) return front;
  for (const node of root.nodes) {
    front.set(node, node.raws.before);
    if (!region.has(node)) break;
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
 * Everything needed to put a scope back exactly as it stands right now.
 * Cheap enough to take per cluster—it walks one cluster’s rules, not the
 * style sheet.
 */
export function snapshot(root, scope, rules) {
  const region = topLevelRegion(root, rules);
  // Per node, not just the sum: A rollback has to put these back into the
  // cache, or the speculative measurement would outlive the tree it described
  const regionBefore = new Map();
  let regionBytes = 0;
  for (const node of region) {
    const bytes = cachedBytes(node);
    regionBefore.set(node, bytes);
    regionBytes += bytes;
  }

  return {
    root,
    region,
    regionBefore,
    regionBytes,
    rootLength: root.nodes.length,
    // PostCSS hands a removed first child's `raws.before` to its successor, so
    // a node this merge never touched can still change size. Only a removal at
    // the very front can do that, and only region subtrees are ever removed—so
    // recording the leading run of them, plus the one node that could be
    // promoted past it, is enough to measure and undo.
    frontBefores: captureFront(root, region),
    // Residual rules are appended here as merges create them, so the array
    // itself is state a rollback has to restore
    scopeRules: scope.rules.slice(),
    containers: affectedContainers(rules).map(container => ({ container, nodes: container.nodes.slice() })),
    rules: rules.map(rule => ({ entry: captureNode(rule), parent: rule.parent })),
  };
}

/**
 * What the merge just performed cost, in bytes of the whole style sheet.
 * Negative means it paid for itself.
 */
export function costSince(snap) {
  const { root, region, frontBefores } = snap;
  let after = 0;
  let detached = 0;

  // Only region subtrees can have changed, so they are the only ones worth
  // re-measuring; a removed one contributes nothing and its old size stays
  // counted in `regionBytes`
  for (const node of region) {
    if (node.parent === root) after += remeasure(node);
    else detached++;
  }

  // Anything else at root level is a residual this merge created. Counting
  // gives that away without a scan: only when the arithmetic doesn’t add up is
  // there something new to look for.
  snap.inserted = null;
  if (root.nodes.length !== snap.rootLength - detached) {
    snap.inserted = [];
    for (const node of root.nodes) {
      if (region.has(node) || knownRootChildren.has(node)) continue;
      after += remeasure(node);
      knownRootChildren.add(node);
      snap.inserted.push(node);
    }
  }

  // A node whose leading whitespace PostCSS rewrote when it promoted a new
  // first child. Region nodes are excluded: their re-measurement above already
  // reflects the new spacing.
  let respaced = 0;
  for (const [node, before] of frontBefores) {
    if (region.has(node) || node.parent !== root || before === node.raws.before) continue;
    respaced += textBytes(node.raws.before) - textBytes(before);
    byteCache.delete(node);
  }

  return after - snap.regionBytes + respaced;
}

// Restores the child lists first (which un-removes emptied rules and drops
// inserted residuals), then each rule’s own contents. Every node object is the
// one that was there before, so references held elsewhere—`scope.rules`, a
// cluster’s `distinctRules`, a nested scope collected earlier this pass—stay
// live across a rollback.
export function rollback(snap, scope) {
  // The speculative pass remeasured these; put the real figures back
  for (const [node, bytes] of snap.regionBefore) byteCache.set(node, bytes);
  // Residuals it inserted are about to be dropped—they were never really here
  if (snap.inserted) for (const node of snap.inserted) knownRootChildren.delete(node);

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