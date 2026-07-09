import { describe, test } from 'node:test';
import assert from 'node:assert';
import postcss from 'postcss';
import udjo from './plugin.js';

describe('Plugin: Analysis', () => {
  test('Warns about a duplicate declaration', async () => {
    const result = await postcss([udjo()]).process('.a { color: red; }\n.b { color: red; }\n', { from: undefined });
    const warnings = result.warnings();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].text, /Duplicate declaration `color: red`/);
  });

  test('Does not touch the CSS in report mode', async () => {
    const input = '.a { color: red; }\n.b { color: red; }\n';
    const result = await postcss([udjo()]).process(input, { from: undefined });
    assert.strictEqual(result.css, input);
  });

  test('Warns about a redundant same-rule declaration', async () => {
    const result = await postcss([udjo()]).process('.a { color: red; color: red; }', { from: undefined });
    assert.ok(result.warnings().some(w => /Redundant declaration/.test(w.text)));
  });
});

describe('Plugin: Dedup', () => {
  test('Merges a duplicate declaration in place', async () => {
    const result = await postcss([udjo({ dedup: true })]).process('.a { color: red; }\n.b { color: red; }\n', { from: undefined });
    assert.match(result.css, /\.a,\s*\.b\s*{\s*color: red;\s*}/);
  });

  test('Warns about a skipped (unsafe) merge', async () => {
    const result = await postcss([udjo({ dedup: true })]).process('.a { color: red; }\n.b { color: blue; }\n.c { color: red; }\n', { from: undefined });
    assert.strictEqual(result.warnings().length, 1);
    assert.match(result.warnings()[0].text, /left unmerged/);
  });
});