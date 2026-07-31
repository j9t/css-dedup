import { describe, test } from 'node:test';
import assert from 'node:assert';
import { analyze, dedup } from '../src/index.js';
import { normalizeValue } from '../src/lib/normalization.js';
import { selectorsLikelyDisjoint } from '../src/lib/selectors.js';
import { RE_MERGED_AB, RE_MERGED_AC, cssGrowing, cssGrowingAggressive } from './helpers.js';

describe('Deduplication', () => {
  test('Treats a comma inside a `/* … */` comment as text when sorting `min()` arguments', () => {
    // Without comment tracking the sort reorders across the comment and
    // produces a mangled `min(*/,1px,2px/*)` key
    assert.strictEqual(normalizeValue('width', 'min(2px/*,*/,1px)'), 'min(1px,2px/*,*/)');
    assert.strictEqual(normalizeValue('width', 'min(2px,1px)'), 'min(1px,2px)');
  });

  test('Merges a duplicate declaration into the selector list of the last rule', () => {
    const { css, applied, skipped } = dedup('.a { color: red; }\n.b { color: red; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.match(css, RE_MERGED_AB);
  });

  test('Keeps the shortest equivalent value, regardless of which occurrence it came from', () => {
    const { css, applied } = dedup('.a { opacity: 0.50; }\n.b { opacity: .5; }\n');
    assert.strictEqual(applied[0].value, '.5');
    assert.match(css, /\.a,\s*\.b\s*{\s*opacity: \.5;\s*}/);
  });

  test('Prefers the shortest value even when the target rule’s own text is longer', () => {
    const { css } = dedup('.a { line-height: 1; }\n.b { line-height: 1.0; }\n');
    assert.match(css, /\.a,\s*\.b\s*{\s*line-height: 1;\s*}/);
  });

  test('Does not merge across a `var()` case difference', () => {
    const { applied } = dedup('.a { color: var(--MyBrandColor); }\n.b { color: var(--mybrandcolor); }\n');
    assert.strictEqual(applied.length, 0);
  });

  test('Merges equivalent `var()` spellings, keeping the shortest', () => {
    const { css, applied } = dedup('.a { color: var( --brand ); }\n.b { color: var(--brand); }\n');
    assert.strictEqual(applied.length, 1);
    assert.match(css, /\.a, \.b \{\s*color: var\(--brand\);\s*\}/);
  });

  test('Removes a rule left empty after consolidation', () => {
    const { css } = dedup('.a { color: red; }\n.b { color: red; }\n');
    assert.ok(!css.includes('.a {'));
  });

  test('Preserves other declarations on the merged-from rule', () => {
    const { css } = dedup('.a { color: red; font-weight: bold; }\n.b { color: red; }\n');
    assert.match(css, /\.a\s*{\s*font-weight: bold;\s*}/);
  });

  test('Skips merging when an intervening rule sets the same property', () => {
    const { applied, skipped } = dedup('.a { color: red; }\n.b { color: blue; }\n.c { color: red; }\n');
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
  });

  test('Consolidates to a fixed point (a merge that creates a twin gets folded in the same run)', () => {
    // The `color` merge turns `.b` into an `.a, .b` rule—which then
    // repeats the existing `.a, .b` selector, so a second pass folds the
    // two rules into one
    const { css, applied, skipped } = dedup('.a { color: red; }\n.b { color: red; }\n.a, .b { margin: 0; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { color: red; margin: 0; }\n');
  });

  test('Merges the safe sub-runs of a group an intervening rule splits, still reporting the split', () => {
    const input = '.a { color: red; }\n.b { color: red; }\n.mid { color: blue; }\n.c { color: red; }\n.d { color: red; }\n';
    const { css, applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /intervening `color` declaration in `\.mid`/);
    assert.strictEqual(css, '.a, .b { color: red; }\n.mid { color: blue; }\n.c, .d { color: red; }\n');
  });

  test('Merges a safe sub-run even when another occurrence stays alone on the blocker’s far side', () => {
    const input = '.a { color: red; }\n.mid { color: blue; }\n.b { color: red; }\n.c { color: red; }\n';
    const { css, applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(css, '.a { color: red; }\n.mid { color: blue; }\n.b, .c { color: red; }\n');
  });

  test('Merges past an intervening rule whose selector is provably mutually exclusive with the group’s', () => {
    const input = 'html[lang=\'da\'] p { content: \'A\'; }\nhtml[lang=\'de\'] p { content: \'B\'; }\nhtml[lang=\'id\'] p { content: \'A\'; }\n';
    const { css, applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.match(css, /html\[lang='da'\] p, html\[lang='id'\] p\s*{\s*content: 'A';\s*}/);
    assert.ok(css.includes('html[lang=\'de\'] p { content: \'B\'; }'));
  });

  test('Still skips when the intervening rule’s selector is not provably exclusive from the group’s', () => {
    const input = '.a[lang=\'da\'] { content: \'A\'; }\n.mid { content: \'B\'; }\n.a[lang=\'id\'] { content: \'A\'; }\n';
    const { applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
  });

  test('Still skips when the differing attribute sits across a descendant combinator on a repeatable element', () => {
    // `.x[data-v="1"] p` and `.x[data-v="2"] p` can match the same `p`
    // (nested `.x` wrappers), so relocating the duplicate past the
    // intervening rule could change which color wins for it
    const input = '.x[data-v="1"] p { color: red; }\n.x[data-v="2"] p { color: blue; }\n.x[data-v="3"] p { color: red; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(css, input);
  });

  test('Still skips a multi-selector intervening rule if any one of its selectors isn’t provably exclusive', () => {
    const input = 'html[lang=\'da\'] p { content: \'A\'; }\nhtml[lang=\'de\'] p, .generic { content: \'B\'; }\nhtml[lang=\'id\'] p { content: \'A\'; }\n';
    const { applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
  });

  test('Leaves the file untouched when nothing is applied', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n.c { color: red; }\n';
    const { css } = dedup(input);
    assert.strictEqual(css, input);
  });

  test('Never merges selector hack rules', () => {
    const { applied, css } = dedup('.a { color: red; }\n* html .b { color: red; }\n');
    assert.strictEqual(applied.length, 0);
    assert.match(css, /\*\s*html \.b/);
  });

  test('Never merges a rule with a mixed hack/normal selector list, and never drops its hack selector', () => {
    const input = '.a, * html .b { color: red; }\n.c { color: red; }\n';
    const { applied, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(css, input);
  });

  test('Merges duplicate declarations between nested rules', () => {
    const { css, applied } = dedup('.a { color: blue; &:hover { color: red; } &:focus { color: red; } }');
    assert.strictEqual(applied.length, 1);
    assert.match(css, /&:hover,\s*&:focus\s*{\s*color: red;\s*}/);
  });

  test('Does not merge across different `@layer` blocks', () => {
    const input = '@layer reset { .a { margin: 0; } }\n@layer base { .b { margin: 0; } }\n';
    const { applied, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(css, input);
  });

  test('Does not merge duplicates split across two separately-written blocks with the same condition', () => {
    // `analyze()` reports this (see the “Analysis” suite)—merging across two
    // physically separate blocks isn’t safe, since a rule sitting between
    // them (in a different scope entirely) can matter for the merge without
    // the intervening-rule check ever seeing it
    const input = '@media (min-width: 768px) { .a { color: red; } }\n@media (min-width: 768px) { .b { color: red; } }\n';
    const { css, applied } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(css, input);
  });

  test('Does not merge duplicates split across two separately-written nesting hosts with the same selector', () => {
    const input = '.a { &:hover { color: red; } }\n.a:hover { color: green; }\n.a { &:focus { color: red; } }\n';
    const { css, applied } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(css, input);
  });

  test('Skips merging when an intervening rule sets an overlapping shorthand/longhand property', () => {
    const { applied, skipped } = dedup('.a { margin: 0; }\n.mid { margin-left: 10px; }\n.b { margin: 0; }\n');
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /margin-left/);
  });

  test('Splits a non-target occurrence’s overlapping extra into its own residual rule after the merge', () => {
    const { applied, skipped, css } = dedup('.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; }\n.a { margin-left: 5px; }\n');
  });

  test('Skips merging when an intervening rule sets a property overlapping only via a shared longhand (`border-top`/`border-color`)', () => {
    const input = '.a { border-top: 1px solid red; }\n.mid { border-color: blue; }\n.b { border-top: 1px solid red; }\n';
    const { applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /border-color/);
  });

  test('Splits the target (last) occurrence’s own overlapping extra into its own residual rule after the merge', () => {
    const { applied, skipped, css } = dedup('.a { margin: 0; }\n.b { margin: 0; margin-left: 5px; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; }\n.b { margin-left: 5px; }\n');
  });

  test('Splits overlapping extras from multiple group members into residual rules, in their original relative order', () => {
    const input = '.a { margin: 0; margin-left: 3px; }\n.b { margin: 0; margin-right: 7px; }\n.c { margin: 0; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b, .c { margin: 0; }\n.a { margin-left: 3px; }\n.b { margin-right: 7px; }\n');
  });

  test('Coordinates a merge across two entangled groups sharing a single hub rule', () => {
    // `.a` holds both the `margin` and `margin-left` duplicate groups’ own
    // shared declarations, entangling them—merging either independently
    // would mutate `.a`’s selector out from under the other. The hub gets
    // split into one rule per key, in the same order those declarations
    // had within `.a`’s own original rule.
    const input = '.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; }\n.c { margin-left: 5px; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; }\n.a, .c { margin-left: 5px; }\n');
  });

  test('Coordinates a merge across two entangled groups with unrelated (non-overlapping) properties', () => {
    // `.c` holds both the `font-weight` and `text-align` duplicate groups’
    // own shared declarations. The properties don’t overlap each other, so
    // there’s no cascade-order constraint between the two resulting
    // rules—but `.c` still can’t independently become two different
    // selector lists, so this still needs the coordinated hub merge, not
    // two independent ones.
    const input = '.a { font-weight: bold; }\n.b { text-align: center; }\n.c { font-weight: bold; text-align: center; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .c { font-weight: bold; }\n.b, .c { text-align: center; }\n');
  });

  test('Keeps a hub declaration sitting between two anchors, as its own residual rule in the same slot', () => {
    // `padding` participates in neither duplicate group, but sits between
    // the two anchors within the hub’s own rule—it has to survive the
    // hub’s split, in its original relative position, under the hub’s
    // own original selector
    const input = '.hub { color: red; padding: 1px; background: blue; }\n.a { color: red; }\n.b { background: blue; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.hub, .a { color: red; }\n.hub { padding: 1px; }\n.hub, .b { background: blue; }\n');
  });

  test('Keeps the file’s blank-line convention for a hub’s split-off piece, even when the hub itself sits last with an anomalous gap', () => {
    // `.hub` is both the last rule in the file (so there’s no next sibling
    // to sample a separator from) and directly preceded by a comment with
    // no blank line (unlike every other gap here, which uses one). The
    // `top` piece split off from the hub must still pick up the file’s
    // normal blank-line separator, not `.hub`’s own anomalous one.
    const input = '.z {\n\tcolor: blue;\n}\n\n.a {\n\tposition: absolute;\n}\n\n.b {\n\ttop: .5rem;\n}\n\n/* comment */\n.hub {\n\tposition: absolute;\n\ttop: .5rem;\n}\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.z {\n\tcolor: blue;\n}\n\n/* comment */\n.a, .hub {\n\tposition: absolute;\n}\n\n.b, .hub {\n\ttop: .5rem;\n}\n');
  });

  test('Folds identical twin rules into one rule with the combined selector list', () => {
    const { css, applied, skipped } = dedup('.a { margin: 0; color: red; }\n.b { margin: 0; color: red; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; color: red; }\n');
  });

  test('Folds three identical twin rules at once', () => {
    const { css, applied } = dedup('.a { margin: 0; color: red; }\n.b { margin: 0; color: red; }\n.c { margin: 0; color: red; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(css, '.a, .b, .c { margin: 0; color: red; }\n');
  });

  test('Folds twin rules with overlapping properties when their declaration order agrees', () => {
    const { css, applied, skipped } = dedup('.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; margin-left: 5px; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; margin-left: 5px; }\n');
  });

  test('Folds twin rules with non-overlapping properties even when their declaration order differs', () => {
    const { css, applied } = dedup('.a { color: red; font-weight: bold; }\n.b { font-weight: bold; color: red; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(css, '.a, .b { font-weight: bold; color: red; }\n');
  });

  test('Merges entangled rules whose extra declaration overlaps no shared property, leaving the extra behind', () => {
    // The two per-group merged rules repeat the same `.a, .b` selector, so
    // a later fixed-point pass folds them into one rule
    const { css, applied, skipped } = dedup('.a { margin: 0; color: red; padding: 1px; }\n.b { margin: 0; color: red; }\n');
    assert.strictEqual(applied.length, 3);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a { padding: 1px; }\n.a, .b { color: red; margin: 0; }\n');
  });

  test('Resolves an entangled group fenced by an overlapping extra across fixed-point passes', () => {
    // Pass one merges `color` (crossing no color-family declaration);
    // that disentangles `margin`, whose solo merge then splits `.a`’s
    // trailing `margin-left` into a residual that keeps winning for `.a`
    const { css, applied, skipped } = dedup('.a { margin: 0; color: red; margin-left: 1px; }\n.b { margin: 0; color: red; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /same selector written again/);
    assert.strictEqual(css, '.a, .b { margin: 0; }\n.a { margin-left: 1px; }\n.a, .b { color: red; }\n');
  });

  test('Keeps the file’s blank-line convention for a per-group merged rule created after a blocked cluster falls back to sub-run merges', () => {
    // `.blocker`’s own `top` sits between the `top` group’s two occurrences,
    // blocking that group—which downgrades the whole `position`/`top`
    // cluster to independent per-group merges (`mergeClusterGroupRuns`).
    // `.b` (last in the `position` run) is directly preceded by a comment
    // with no blank line, unlike every other gap in this file; the merged
    // rule inserted after `.b` must still use the file’s normal separator.
    const input = '.z {\n\tcolor: blue;\n}\n\n.a {\n\tposition: absolute;\n}\n\n/* comment */\n.b {\n\tposition: absolute;\n\ttop: .5rem;\n}\n\n.blocker {\n\ttop: 1px;\n}\n\n.c {\n\ttop: .5rem;\n}\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /intervening `top` declaration in `\.blocker`/);
    assert.strictEqual(css, '.z {\n\tcolor: blue;\n}\n\n/* comment */\n.b {\n\ttop: .5rem;\n}\n\n.a, .b {\n\tposition: absolute;\n}\n\n.blocker {\n\ttop: 1px;\n}\n\n.c {\n\ttop: .5rem;\n}\n');
  });

  test('Skips a cluster with two candidate hubs (two rules holding every group’s shared declaration)', () => {
    // Both rules hold both groups’ shared declarations, in opposite
    // order—splitting around either hub would reorder the overlapping
    // `margin`/`margin-left` pair for whichever rule isn’t the hub,
    // changing which value wins for its elements
    const input = '.h1 { margin: 0; margin-left: 5px; }\n.h2 { margin-left: 5px; margin: 0; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 2);
    assert.ok(skipped.every(item => /entangled/.test(item.reason)));
    assert.strictEqual(css, input);
  });

  test('Merges a chain of entangled groups whose properties don’t overlap, one merged rule per group', () => {
    // `.a` entangles the `color` and `margin` groups; `.c` entangles the
    // `margin` and `border` groups. No single hub connects all three—but
    // since no two of the properties overlap, there are no ordering
    // constraints, and each group gets its own merged rule at its last
    // occurrence.
    const input = '.a { color: red; margin: 0; }\n.b { color: red; }\n.c { margin: 0; border: none; }\n.d { border: none; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 3);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { color: red; }\n.a, .c { margin: 0; }\n.c, .d { border: none; }\n');
  });

  test('Resolves an overlap-constrained entangled chain across fixed-point passes', () => {
    // Pass one can only merge `margin-top` (the others are fenced by
    // overlaps)—but that turns `.a` into the cluster’s single hub, so the
    // next pass splits it per key, preserving `.a`’s own declaration order
    const input = '.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; }\n.c { margin-left: 5px; margin-top: 1px; }\n.d { margin-top: 1px; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 3);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a, .b { margin: 0; }\n.a, .c { margin-left: 5px; }\n.c, .d { margin-top: 1px; }\n');
  });

  test('Places a target’s pre-shared extra in a residual before the merge, preserving its original within-rule order', () => {
    // Within `.a`’s own original rule, `margin-left` (declared after `margin`)
    // already won—so after the split, the residual carrying `margin` must
    // stay before the merged `margin-left` rule, not after, or `.a` would
    // end up with `margin-left: 0` instead of `5px`
    const { applied, skipped, css } = dedup('.a { margin: 0; margin-left: 5px; }\n.b { margin-left: 5px; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a { margin: 0; }\n.a, .b { margin-left: 5px; }\n');
  });

  test('Keeps the file’s blank-line convention before a target’s post-shared extra residual', () => {
    // `.b` (the target) is directly preceded by a comment, with no blank
    // line between them—unlike every other rule gap in this file, which
    // uses one. The residual holding `.b`’s own `extra` declaration is a
    // new rule inserted after the merged one, and must pick up the file’s
    // normal blank-line separator, not `.b`’s own original (tight, comment-
    // adjacent) leading whitespace just because it was cloned from `.b`
    const input = '.a {\n\tposition: absolute;\n}\n\n/* comment */\n.b {\n\tposition: absolute;\n\textra: 1;\n}\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '/* comment */\n.a, .b {\n\tposition: absolute;\n}\n\n.b {\n\textra: 1;\n}\n');
  });

  test('Keeps the file’s blank-line convention before the merged rule, when a target’s pre-shared extra shifts it down into a residual’s old slot', () => {
    // `.b` (the target) is directly preceded by a comment, with no blank
    // line between them—unlike every other rule gap in this file, which
    // uses one. `.b`’s own `extra` declaration sits before the shared one,
    // so it’s split into a residual that takes over `.b`’s original slot
    // (and its tight, comment-adjacent spacing); `.b` itself shifts down to
    // sit after that residual instead, and must pick up the file’s normal
    // blank-line separator there, not the anomalous one it originally had.
    const input = '.a {\n\tposition: absolute;\n}\n\n/* comment */\n.b {\n\textra: 1;\n\tposition: absolute;\n}\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '/* comment */\n.b {\n\textra: 1;\n}\n\n.a, .b {\n\tposition: absolute;\n}\n');
  });

  test('Ignores comment-to-rule gaps when voting on the file’s normal separator, even when several outnumber it', () => {
    // Three rules are each preceded by their own tight (no-blank-line)
    // comment, and one further rule sits tight against its own neighbor—
    // five tight gaps in total, versus four blank-line gaps between
    // genuine content. A naive majority vote over every gap, comments
    // included, would call “tight” the file’s normal separator; it should
    // instead recognize a comment-to-rule gap as attachment spacing (not a
    // real rule separator) and skip it, correctly landing on blank-line as
    // the file’s actual convention
    const input = [
      '.a {', '\tposition: absolute;', '}', '',
      '/* c1 */', '.p1 {', '\tcolor: red;', '}', '',
      '/* c2 */', '.p2 {', '\tcolor: green;', '}', '',
      '/* c3 */', '.p3 {', '\tcolor: blue;', '}',
      '.p4 {', '\tcolor: yellow;', '}', '',
      '/* VG WORT */', '.b {', '\textra: 1;', '\tposition: absolute;', '}', '',
    ].join('\n');
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, [
      '/* c1 */', '.p1 {', '\tcolor: red;', '}', '',
      '/* c2 */', '.p2 {', '\tcolor: green;', '}', '',
      '/* c3 */', '.p3 {', '\tcolor: blue;', '}',
      '.p4 {', '\tcolor: yellow;', '}', '',
      '/* VG WORT */', '.b {', '\textra: 1;', '}', '',
      '.a, .b {', '\tposition: absolute;', '}', '',
    ].join('\n'));
  });

  test('Joins merged selectors on one line by default', () => {
    const { css } = dedup('.a { color: red; }\n.b { color: red; }\n');
    assert.match(css, /\.a, \.b \{/);
  });

  test('Joins merged selectors one per line when that’s the file’s existing convention', () => {
    const input = '.a,\n.x {\n  color: blue;\n}\n\n.a {\n  color: red;\n}\n\n.b {\n  color: red;\n}\n';
    const { css } = dedup(input);
    assert.match(css, /\.a,\n\.b \{/);
  });

  test('Matches the merged rule’s own indentation when joining selectors one per line', () => {
    const input = '.a,\n.x {\n  color: blue;\n}\n\n@media (min-width: 768px) {\n  .a {\n    color: red;\n  }\n\n  .b {\n    color: red;\n  }\n}\n';
    const { css } = dedup(input);
    assert.match(css, /\.a,\n {2}\.b \{/);
  });

  test('Reports byte counts before and after consolidation', () => {
    const input = '.a { color: red; }\n.b { color: red; }\n';
    const { css, bytes } = dedup(input);
    assert.strictEqual(bytes.before, Buffer.byteLength(input, 'utf8'));
    assert.strictEqual(bytes.after, Buffer.byteLength(css, 'utf8'));
    assert.strictEqual(bytes.saved, bytes.before - bytes.after);
    assert.ok(bytes.saved > 0);
  });

  test('Reports zero bytes saved when nothing is applied', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n';
    const { bytes } = dedup(input);
    assert.strictEqual(bytes.saved, 0);
    assert.strictEqual(bytes.before, bytes.after);
  });

  test('Folds a rule repeating the same selector into the last one, earlier declarations first', () => {
    const { css, applied, skipped } = dedup('.a { color: red; }\n.b { margin: 0; }\n.a { padding: 1px; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.b { margin: 0; }\n.a { color: red; padding: 1px; }\n');
  });

  test('Folds three same-selector rules into one', () => {
    const { css, applied } = dedup('.a { color: red; }\n.a { margin: 0; }\n.a { padding: 1px; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(css, '.a { color: red; margin: 0; padding: 1px; }\n');
  });

  test('Preserves the same-selector cascade when folding (conflicting values keep their order)', () => {
    const { css } = dedup('.a { color: red; }\n.b { margin: 0; }\n.a { color: blue; }\n');
    assert.strictEqual(css, '.b { margin: 0; }\n.a { color: red; color: blue; }\n');
  });

  test('Collapses a duplicate declaration the same-selector fold brings into one rule', () => {
    const { css, applied } = dedup('.a { color: red; }\n.b { margin: 0; }\n.a { color: red; }\n');
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(css, '.b { margin: 0; }\n.a { color: red; }\n');
  });

  test('Skips a same-selector fold when an intervening rule touches a moved property', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n.a { margin: 0; }\n';
    const { css, applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /same selector written again/);
    assert.strictEqual(css, input);
  });

  test('Leaves a same-selector rule holding nested rules where it is', () => {
    const input = '.a { &:hover { color: red; } }\n.a { margin: 0; }\n';
    const { css, applied } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(css, input);
  });

  test('Merges equivalent color spellings, keeping the shortest', () => {
    const { css, applied } = dedup('.a { color: #ffffff; }\n.b { color: #fff; }\n');
    assert.strictEqual(applied.length, 1);
    assert.match(css, /\.a, \.b \{\s*color: #fff;\s*\}/);
  });

  test('Removes an exact duplicate declaration repeated within one rule', () => {
    const { css, applied } = dedup('.a { color: red; color: red; }');
    assert.strictEqual(css, '.a { color: red; }');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].redundant, true);
    assert.strictEqual(applied[0].key, 'color: #ff0000');
  });

  test('Catches a same-rule duplicate after normalizing case and equivalent zero values', () => {
    assert.strictEqual(dedup('.a { color: RED; color: red; }').applied.length, 1);
    assert.strictEqual(dedup('.a { margin: 0; margin: 0px; }').applied.length, 1);
  });

  test('Removes a declaration repeated within a selector-less at-rule block (`@font-face`)', () => {
    const { css, applied } = dedup('@font-face { font-family: Foo; src: url(a.woff); font-family: Foo; }');
    assert.strictEqual(css, '@font-face { src: url(a.woff); font-family: Foo; }');
    assert.strictEqual(applied[0].scope, '@font-face');
    assert.deepStrictEqual(applied[0].selectors, ['@font-face']);
  });

  test('Keeps the shortest equivalent value among same-rule duplicates', () => {
    const { css } = dedup('.a { opacity: 0.50; opacity: .5; }');
    assert.strictEqual(css, '.a { opacity: .5; }');
  });

  test('Collapses more than two duplicate occurrences within one rule down to one', () => {
    const { css, applied } = dedup('.a { color: red; color: red; color: red; }');
    assert.strictEqual(css, '.a { color: red; }');
    assert.strictEqual(applied.length, 1);
  });

  test('Never touches a same-rule duplicate on a selector hack rule', () => {
    const input = '* html .a { color: red; color: red; }\n';
    const { css, applied } = dedup(input);
    assert.strictEqual(css, input);
    assert.strictEqual(applied.length, 0);
  });

  test('Cleans up a same-rule duplicate before also merging that rule across the scope', () => {
    const { css, applied } = dedup('.a { color: red; color: red; }\n.b { color: red; }\n');
    assert.match(css, RE_MERGED_AB);
    assert.strictEqual(applied.length, 2);
    assert.ok(applied.some(item => item.redundant));
    assert.ok(applied.some(item => !item.redundant));
  });
});

// https://github.com/j9t/css-dedup/issues/11

describe('Minified style sheets', () => {
  test('Does not introduce a space after the comma when joining selectors in an otherwise minified rule', () => {
    const { css } = dedup('.a{color:red}.b{color:red}\n');
    assert.strictEqual(css, '.a,.b{color:red}\n');
  });

  test('Does not introduce spaces', () => {
    const input = 'body{margin:0}header{margin:0}details p:first-of-type{margin:0}header :is(h1,ul){margin:0}footer :is(p,ul){margin:0}\n';
    const { css } = dedup(input);
    assert.strictEqual(css, 'body,header,details p:first-of-type,header :is(h1,ul),footer :is(p,ul){margin:0}\n');
  });

  test('Preserves the spaced-comma convention when the source already writes selector lists that way', () => {
    const { css } = dedup('.a, .b { color: red; }\n.c { color: red; }\n');
    assert.strictEqual(css, '.a, .b, .c { color: red; }\n');
  });

  test('Falls back to spaced commas for singleton-selector rules that already space their braces', () => {
    const { css } = dedup('.a { color: red; }\n.b { color: red; }\n');
    assert.strictEqual(css, '.a, .b { color: red; }\n');
  });
});

describe('Aggressive mode', () => {
  test('Treats `hsl()` and hex as equivalent (rounding-based)', () => {
    const css = '.a { color: hsl(0 0% 100%); } .b { color: #fff; }';
    assert.strictEqual(analyze(css).findings.length, 0);
    const { findings } = analyze(css, { aggressive: true });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].key, 'color: #ffffff');
  });

  test('Handles legacy comma `hsla()` and hue units', () => {
    const { findings } = analyze('.a { color: hsla(0, 0%, 100%, 1); } .b { color: hsl(0deg 0% 100%); } .c { color: white; }', { aggressive: true });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].occurrences.length, 3);
  });

  test('Treats percentage `rgb()` channels as equivalent (rounding-based)', () => {
    const css = '.a { color: rgb(100%, 0%, 0%); } .b { color: #f00; }';
    assert.strictEqual(analyze(css).findings.length, 0);
    assert.strictEqual(analyze(css, { aggressive: true }).findings.length, 1);
    // 50% of 255 is 127.5—rounds to 128 (`#80`), matching browser behavior
    assert.strictEqual(analyze('.a { color: rgb(50% 50% 50%); } .b { color: #808080; }', { aggressive: true }).findings.length, 1);
  });

  test('Treats property aliases as equivalent (`word-wrap`/`overflow-wrap`, `grid-gap`/`gap`)', () => {
    const css = '.a { word-wrap: break-word; } .b { overflow-wrap: break-word; }';
    assert.strictEqual(analyze(css).findings.length, 0);
    assert.strictEqual(analyze(css, { aggressive: true }).findings.length, 1);
    assert.strictEqual(analyze('.a { grid-gap: 1rem; } .b { gap: 1rem; }', { aggressive: true }).findings.length, 1);
  });

  test('Merges a property-alias duplicate, keeping the last occurrence’s spelling', () => {
    const { css: output } = dedup('.a { word-wrap: break-word; } .b { overflow-wrap: break-word; }', { aggressive: true });
    assert.match(output, /\.a,\s*\.b\s*{\s*overflow-wrap: break-word;\s*}/);
  });

  test('Merges across two separately-written same-condition blocks, removing the emptied one', () => {
    const css = '@media (min-width: 768px) { .a { color: red; } }\n@media (min-width: 768px) { .b { color: red; } }';
    const { css: output, applied, skipped } = dedup(css, { aggressive: true });
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(output.match(/@media/g).length, 1);
    assert.match(output, RE_MERGED_AB);
  });

  test('Still honors an intervening rule inside the merged scope when merging across blocks', () => {
    const css = '@media (min-width: 768px) { .a { color: red; } .btn { color: blue; } }\n@media (min-width: 768px) { .btn-primary { color: red; } }';
    // `.btn` intervenes between the two occurrences after the blocks fold
    // into one scope—and shares no class with `.a`/`.btn-primary`, so the
    // likely-disjoint heuristic lets the merge through; make it share one
    // and it must block
    const merged = dedup(css, { aggressive: true });
    assert.strictEqual(merged.skipped.length, 0);

    const blocked = dedup(css.replace('.btn {', '.a.on {'), { aggressive: true });
    assert.strictEqual(blocked.skipped.length, 1);
  });

  test('Keeps an emptied `@layer` shell (its first appearance sets layer order)', () => {
    const css = '@layer a { .x { color: red; } }\n@layer b { .other { margin: 0; } }\n@layer a { .y { color: red; } }';
    const { css: output, applied } = dedup(css, { aggressive: true });
    assert.strictEqual(applied.length, 1);
    // The first `@layer a` block drained, but its shell must survive
    assert.strictEqual(output.match(/@layer a/g).length, 2);
    assert.match(output, /\.x,\s*\.y\s*{\s*color: red;\s*}/);
  });

  test('Keeps a block that was already empty in the source', () => {
    const css = '@media print {}\n.a { color: red; }';
    const { css: output } = dedup(css, { aggressive: true });
    assert.ok(output.includes('@media print {}'));
  });

  test('Merges past an intervening rule whose subject compound shares no class with the group’s', () => {
    const css = '.a { color: red; } .b:hover { color: blue; } .c { color: red; }';
    assert.strictEqual(dedup(css).skipped.length, 1);
    const { css: output, skipped } = dedup(css, { aggressive: true });
    assert.strictEqual(skipped.length, 0);
    assert.match(output, RE_MERGED_AC);
  });

  test('Still blocks on an intervening rule sharing a class with the group', () => {
    const { skipped } = dedup('.a { color: red; } .a.on { color: blue; } .c { color: red; }', { aggressive: true });
    assert.strictEqual(skipped.length, 1);
  });

  test('Does not merge across blocks with different conditions', () => {
    const css = '@media (min-width: 768px) { .a { color: red; } }\n@media (min-width: 1024px) { .b { color: red; } }';
    const { applied } = dedup(css, { aggressive: true });
    assert.strictEqual(applied.length, 0);
  });

  test('Does not merge same-selector nesting hosts under different ancestors', () => {
    // A `.card` host at the root and one inside `@media print` are different
    // DRY boundaries—only the bare selector matches, not the context
    const f1 = dedup('.card { .title { color: red; } }\n@media print { .card { .title { color: red; } } }', { aggressive: true });
    assert.strictEqual(f1.applied.length, 0);
    assert.ok(f1.css.includes('.card { .title { color: red; } }\n@media print'));

    const f2 = dedup('#a { .card { color: red; } }\n#b { .card { color: red; } }', { aggressive: true });
    assert.strictEqual(f2.applied.length, 0);
  });

  test('Never merges across anonymous `@layer` blocks (each is its own layer)', () => {
    const css = '@layer { .a { color: red; } }\n@layer { .c { color: blue; } }\n@layer { .a2 { color: red; } }';
    assert.strictEqual(dedup(css, { aggressive: true }).applied.length, 0);
    // Named layers with the same name are one layer, so those still merge
    const named = dedup('@layer x { .a { color: red; } }\n@layer x { .b { color: red; } }', { aggressive: true });
    assert.strictEqual(named.applied.length, 1);
  });

  test('A namespaced type or attribute selector never counts as likely disjoint', () => {
    assert.strictEqual(selectorsLikelyDisjoint('rect', 'svg|rect'), false);
    assert.strictEqual(selectorsLikelyDisjoint('.card', '[xlink|href="a.zzz"]'), false);

    // And so the intervening rules keep blocking the merge
    const attribute = dedup('.card { color: red; }\n[xlink|href="a.zzz"] { color: green; }\n.other { color: red; }', { aggressive: true });
    assert.strictEqual(attribute.applied.length, 0);
    const type = dedup('rect { fill: red; }\nsvg|rect { fill: blue; }\n.r2 { fill: red; }', { aggressive: true });
    assert.strictEqual(type.applied.length, 0);
  });

  test('Does not treat invalid legacy color syntax as equivalent to a valid color', () => {
    // Legacy comma syntax requires percentage saturation/lightness and
    // homogeneous rgb channel types—browsers drop these spellings, so a
    // merge could otherwise keep the broken spelling as the survivor
    assert.strictEqual(analyze('.a { color: rgb(64 191 64); } .b { color: hsl(120,50,50); }', { aggressive: true }).findings.length, 0);
    assert.strictEqual(analyze('.a { color: rgb(128 100 20); } .b { color: rgb(50%, 100, 20); }', { aggressive: true }).findings.length, 0);
    // The modern space syntax allows bare numbers, so that stays equivalent
    assert.strictEqual(analyze('.a { color: rgb(64 191 64); } .b { color: hsl(120 50 50); }', { aggressive: true }).findings.length, 1);
  });

  test('Clamps out-of-range `rgb()` channels consistently (`300` like `1000`)', () => {
    assert.strictEqual(analyze('.a { color: rgb(300 0 0); } .b { color: #f00; }', { aggressive: true }).findings.length, 1);
    assert.strictEqual(analyze('.a { color: rgb(1000 0 0); } .b { color: #f00; }', { aggressive: true }).findings.length, 1);
    // Safe mode still leaves out-of-range channels alone
    assert.strictEqual(analyze('.a { color: rgb(300 0 0); } .b { color: #f00; }').findings.length, 0);
  });
});

describe('Savings only', () => {
  test('Withholds a growing consolidation, returning the style sheet untouched', () => {
    const css = cssGrowing;
    const { css: output, applied, skipped, bytes, withheld } = dedup(css, { savingsOnly: true });
    assert.strictEqual(output, css);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(bytes.saved, 0);
    assert.strictEqual(bytes.after, bytes.before);
    assert.strictEqual(withheld.count, 1);
    assert.ok(withheld.bytes.saved < 0);
  });

  test('Applies a shrinking consolidation identically to an ungated run', () => {
    const css = '.a { color: red; }\n.b { color: red; }\n';
    const gated = dedup(css, { savingsOnly: true });
    const ungated = dedup(css);
    assert.strictEqual(gated.css, ungated.css);
    assert.strictEqual(gated.withheld, undefined);
    assert.strictEqual(gated.applied.length, ungated.applied.length);
    assert.deepStrictEqual(gated.bytes, ungated.bytes);
  });

  test('Composes with aggressive mode (a growing aggressive result is withheld)', () => {
    const css = cssGrowingAggressive;
    const { css: output, withheld } = dedup(css, { aggressive: true, savingsOnly: true });
    assert.strictEqual(output, css);
    assert.strictEqual(withheld.count, 1);
  });
});
