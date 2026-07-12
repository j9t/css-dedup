import { describe, test } from 'node:test';
import assert from 'node:assert';
import postcss from 'postcss';
import cssdedup from './plugin.js';

describe('Plugin: Analysis', () => {
  test('Warns about a duplicate declaration', async () => {
    const result = await postcss([cssdedup()]).process('.a { color: red; }\n.b { color: red; }\n', { from: undefined });
    const warnings = result.warnings();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].text, /Duplicate declaration `color: #ff0000`/);
  });

  test('Does not touch the CSS in report mode', async () => {
    const input = '.a { color: red; }\n.b { color: red; }\n';
    const result = await postcss([cssdedup()]).process(input, { from: undefined });
    assert.strictEqual(result.css, input);
  });

  test('Warns about a redundant same-rule declaration', async () => {
    const result = await postcss([cssdedup()]).process('.a { color: red; color: red; }', { from: undefined });
    assert.ok(result.warnings().some(w => /Redundant declaration/.test(w.text)));
  });

  test('Warns about a selector written more than once in one scope', async () => {
    const result = await postcss([cssdedup()]).process('.a { color: red; }\n.a { margin: 0; }\n', { from: undefined });
    assert.ok(result.warnings().some(w => /Selector `\.a` written 2 times/.test(w.text)));
  });
});

describe('Plugin: Dedup', () => {
  test('Merges a duplicate declaration in place', async () => {
    const result = await postcss([cssdedup({ fix: true })]).process('.a { color: red; }\n.b { color: red; }\n', { from: undefined });
    assert.match(result.css, /\.a,\s*\.b\s*{\s*color: red;\s*}/);
  });

  test('Warns about a skipped (unsafe) merge', async () => {
    const result = await postcss([cssdedup({ fix: true })]).process('.a { color: red; }\n.b { color: blue; }\n.c { color: red; }\n', { from: undefined });
    assert.strictEqual(result.warnings().length, 1);
    assert.match(result.warnings()[0].text, /left unmerged/);
  });

  test('`savingsOnly: true` leaves the CSS untouched when consolidation would grow it, and warns', async () => {
    const input = '.very-long-selector-name-one { color: red; font-weight: bold; }\n.b { color: red; }\n';
    const result = await postcss([cssdedup({ fix: true, savingsOnly: true })]).process(input, { from: undefined });
    assert.strictEqual(result.css, input);
    assert.ok(result.warnings().some(warning => /Consolidation withheld \(`savingsOnly`\): 1 merge would make the stylesheet \d+ bytes bigger/.test(warning.text)));
  });

  test('`savingsOnly: true` still applies a shrinking consolidation', async () => {
    const result = await postcss([cssdedup({ fix: true, savingsOnly: true })]).process('.a { color: red; }\n.b { color: red; }\n', { from: undefined });
    assert.match(result.css, /\.a,\s*\.b\s*{\s*color: red;\s*}/);
    assert.strictEqual(result.warnings().length, 0);
  });

  test('Applies aggressive merges with `aggressive: true`', async () => {
    const result = await postcss([cssdedup({ fix: true, aggressive: true })]).process('.a { color: hsl(0 0% 100%); }\n.b { color: #fff; }\n', { from: undefined });
    assert.match(result.css, /\.a,\s*\.b\s*{\s*color: #fff;\s*}/);
  });
});