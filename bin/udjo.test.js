import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { analyze, dedup } from '../src/index.js';
import { splitSelectors } from '../src/selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'udjo.js');
const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');

function run(args) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000 });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

describe('Selectors', () => {
  test('Splits top-level commas, ignoring ones nested in `:is()`/`[]`', () => {
    assert.deepStrictEqual(splitSelectors(':is(a, b) .c, .d'), [':is(a, b) .c', '.d']);
  });

  test('Does not let an unmatched closing bracket misclassify a later top-level comma as nested', () => {
    assert.deepStrictEqual(splitSelectors(':is(a, b)) , .c'), [':is(a, b))', '.c']);
  });
});

describe('Analysis', () => {
  test('Flags declarations that are duplicated across rules in the same scope', () => {
    const { findings } = analyze('.a { color: red; } .b { color: red; }');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].key, 'color: red');
    assert.deepStrictEqual(findings[0].occurrences.map(o => o.selector), ['.a', '.b']);
  });

  test('Normalizes case for duplicate detection', () => {
    const { findings } = analyze('.a { color: red; } .b { color: RED; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Normalizes zero-value units for duplicate detection', () => {
    const { findings } = analyze('.a { margin: 0; } .b { margin: 0px; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Normalizes modern viewport/container zero-value units', () => {
    const { findings } = analyze('.a { width: 0; } .b { width: 0svh; } .c { width: 0cqw; }');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].occurrences.length, 3);
  });

  test('Does not collapse unitless and unit-bearing zero for angle/time units', () => {
    const { findings } = analyze('.a { transition-delay: 0; } .b { transition-delay: 0s; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Treats `border: none` and `border: 0` as equivalent', () => {
    const { findings } = analyze('.a { border: none; } .b { border: 0; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Normalizes leading zero in decimals (`0.5` and `.5`)', () => {
    const { findings } = analyze('.a { opacity: 0.5; } .b { opacity: .5; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Normalizes trailing zero in decimals (`1.0` and `1`)', () => {
    const { findings } = analyze('.a { line-height: 1.0; } .b { line-height: 1; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Normalizes redundant trailing zeros (`1.50` and `1.5`)', () => {
    const { findings } = analyze('.a { line-height: 1.50; } .b { line-height: 1.5; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Does not touch decimal-looking substrings inside `url()`', () => {
    const { findings } = analyze('.a { background: url(icon-2.0.png); } .b { background: url(icon-2.png); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not treat different-case `var()` references as duplicates', () => {
    const { findings } = analyze('.a { color: var(--MyBrandColor); } .b { color: var(--mybrandcolor); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not treat different-case custom property names as duplicates', () => {
    const { findings } = analyze('.a { --MyColor: red; } .b { --mycolor: red; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Treats same-case `var()` references as duplicates', () => {
    const { findings } = analyze('.a { color: var(--brand); } .b { color: var(--brand); }');
    assert.strictEqual(findings.length, 1);
  });

  test('Does not treat different-case `animation-name` as duplicates (custom ident, case-sensitive)', () => {
    const { findings } = analyze('.a { animation-name: Foo; } .b { animation-name: foo; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Still treats same-case `animation-name` as duplicates', () => {
    const { findings } = analyze('.a { animation-name: Foo; } .b { animation-name: Foo; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Does not treat different-case `counter-reset` as duplicates (custom ident, case-sensitive)', () => {
    const { findings } = analyze('.a { counter-reset: Section; } .b { counter-reset: section; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Still normalizes case for ordinary keyword values', () => {
    const { findings } = analyze('.a { color: RED; } .b { color: red; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Does not flag a declaration that only occurs once', () => {
    const { findings } = analyze('.a { color: red; } .b { color: blue; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not flag duplicates across different `@media` scopes', () => {
    const { findings } = analyze(`
      @media (min-width: 768px) { .a { color: red; } }
      @media (min-width: 1024px) { .b { color: red; } }
    `);
    assert.strictEqual(findings.length, 0);
  });

  test('Flags duplicates within the same `@media` scope', () => {
    const { findings } = analyze(`
      @media (min-width: 768px) {
        .a { color: red; }
        .b { color: red; }
      }
    `);
    assert.strictEqual(findings.length, 1);
  });

  test('Flags duplicates split across two separately-written blocks with the same condition', () => {
    const { findings } = analyze(`
      @media (min-width: 768px) { .a { color: red; } }
      @media (min-width: 768px) { .b { color: red; } }
    `);
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].occurrences.map(o => o.selector), ['.a', '.b']);
  });

  test('Matches scopes regardless of whitespace formatting in the condition', () => {
    const { findings } = analyze(`
      @media (min-width: 768px) { .a { color: red; } }
      @media   (min-width:   768px)   { .b { color: red; } }
    `);
    assert.strictEqual(findings.length, 1);
  });

  test('Flags a redundant declaration repeated within one rule', () => {
    const { findings } = analyze('.a { color: red; color: red; }');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].redundant, true);
  });

  test('Ignores selector-hack rules by default', () => {
    const { findings } = analyze('.a { color: red; } * html .b { color: red; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Honors custom `ignoreSelectors` patterns', () => {
    const { findings } = analyze('.a { color: red; } .legacy-b { color: red; }', {
      ignoreSelectors: [/^\.legacy-/],
    });
    assert.strictEqual(findings.length, 0);
  });

  test('`ignoreSelectorsDefaults: false` disables the built-in hack list', () => {
    const { findings } = analyze('.a { color: red; } * html .b { color: red; }', {
      ignoreSelectorsDefaults: false,
    });
    assert.strictEqual(findings.length, 1);
  });

  test('Ignores a rule with a mixed hack/normal selector list', () => {
    const { findings } = analyze('.a, * html .b { color: red; } .c { color: red; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not treat differing values for the same property as duplicates', () => {
    const { findings } = analyze('.a { color: red; } .b { color: blue; } .c { color: red; }');
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].occurrences.map(o => o.selector), ['.a', '.c']);
  });

  test('Flags duplicates between nested rules, as their own scope', () => {
    const { findings } = analyze('.a { color: blue; &:hover { color: red; } &:focus { color: red; } }');
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].occurrences.map(o => o.selector), ['&:hover', '&:focus']);
  });

  test('Does not compare a rule’s own declarations against its nested rules’', () => {
    const { findings } = analyze('.a { color: red; &:hover { color: red; } }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not flag duplicates across different `@layer` blocks', () => {
    const { findings } = analyze(`
      @layer reset { .a { margin: 0; } }
      @layer base { .b { margin: 0; } }
    `);
    assert.strictEqual(findings.length, 0);
  });

  test('Flags duplicates within the same `@layer` block', () => {
    const { findings } = analyze(`
      @layer reset {
        .a { margin: 0; }
        .b { margin: 0; }
      }
    `);
    assert.strictEqual(findings.length, 1);
  });

  test('Does not crash on a statement-form at-rule with no block', () => {
    assert.doesNotThrow(() => analyze('@layer reset, base;\n.a { color: red; }\n.b { color: red; }'));
    const { findings } = analyze('@layer reset, base;\n.a { color: red; }\n.b { color: red; }');
    assert.strictEqual(findings.length, 1);
  });
});

describe('Dedup', () => {
  test('Merges a duplicate declaration into the selector list of the last rule', () => {
    const { css, applied, skipped } = dedup('.a { color: red; }\n.b { color: red; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.match(css, /\.a,\s*\.b\s*{\s*color: red;\s*}/);
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

  test('Leaves the file untouched when nothing is applied', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n.c { color: red; }\n';
    const { css } = dedup(input);
    assert.strictEqual(css, input);
  });

  test('Never merges selector-hack rules', () => {
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

  test('Skips merging when a merged-from rule itself also sets an overlapping shorthand/longhand property', () => {
    const { applied, skipped, css } = dedup('.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; }\n');
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.match(skipped[0].reason, /margin-left/);
    assert.strictEqual(css, '.a { margin: 0; margin-left: 5px; }\n.b { margin: 0; }\n');
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
});

describe('Fixtures', () => {
  test('basic.css reports the expected duplicate count', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stdout.includes('3 findings'));
  });

  test('media-queries.css only flags the duplicate inside the shared `@media` scope', () => {
    const { stdout } = run([path.join(fixturesDir, 'media-queries.css')]);
    assert.ok(stdout.includes('1 finding'));
    assert.ok(stdout.includes('min-width: 768px'));
  });

  test('nesting.css flags the duplicate between nested rules, not against the parent’s own declaration', () => {
    const { stdout } = run([path.join(fixturesDir, 'nesting.css')]);
    assert.ok(stdout.includes('1 finding'));
    assert.ok(stdout.includes('&:hover'));
    assert.ok(stdout.includes('&:focus'));
  });

  test('layers.css flags the duplicate inside the shared `@layer` block and doesn’t crash on the statement form', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'layers.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stdout.includes('1 finding'));
    assert.ok(stdout.includes('@layer reset'));
  });

  test('hacks.css reports no findings once hack selectors are excluded', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('No duplicate declarations found.'));
    assert.strictEqual(status, 0);
  });

  test('hacks.css reports a finding with `--no-ignore-selectors-defaults`', () => {
    const { stdout } = run(['--no-ignore-selectors-defaults', path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('1 finding'));
  });

  test('hacks.css reports a finding with `-n`', () => {
    const { stdout } = run(['-n', path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('1 finding'));
  });

  test('merge-safety.css --dedup consolidates the safe pair and skips the unsafe one', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_merge_safety');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--dedup', file]);
      assert.ok(stdout.includes('1 consolidated'));
      assert.ok(stdout.includes('1 skipped'));
      assert.match(stdout, /\d+ → \d+ bytes \(-\d+ B, -\d+\.\d%\)/);

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, /\.a,\s*\.c\s*{\s*color: red;\s*}/);
      assert.ok(output.includes('.x {'));
      assert.ok(output.includes('.z {'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('basic.css report mode suggests the byte savings from running `--dedup`', () => {
    const { stdout } = run([path.join(fixturesDir, 'basic.css')]);
    assert.match(stdout, /Run with `--dedup` to save \d+ bytes \(\d+\.\d%\)\./);
  });

  test('merge-safety.css -d consolidates the safe pair (short flag)', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_merge_safety_short');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['-d', file]);
      assert.ok(stdout.includes('1 consolidated'));

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, /\.a,\s*\.c\s*{\s*color: red;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});

describe('CLI', () => {
  test('Shows help with `--help`', () => {
    const { stdout, status } = run(['--help']);
    assert.ok(stdout.includes('Usage:'));
    assert.strictEqual(status, 0);
  });

  test('Shows help and exits non-zero when no file is given', () => {
    const { stdout, status } = run([]);
    assert.ok(stdout.includes('Usage:'));
    assert.strictEqual(status, 1);
  });

  test('Excludes a selector via `-i` (short for `--ignore-selector`)', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_ignore_selector');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run(['-i', '^\\.legacy-', file]);
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns in report mode when merging would grow the file rather than shrink it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_growth_report');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, '.very-long-selector-name-one { color: red; font-weight: bold; }\n.b { color: red; }\n');

    try {
      const { stdout } = run([file]);
      assert.match(stdout, /Running `--dedup` here would make the file \d+ bytes \(\d+\.\d%\) bigger, not smaller/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns in `--dedup` mode when consolidation grows the file rather than shrinks it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_growth_dedup');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, '.very-long-selector-name-one { color: red; font-weight: bold; }\n.b { color: red; }\n');

    try {
      const { stdout } = run(['--dedup', file]);
      assert.match(stdout, /\+\d+ B, \+\d+\.\d%/);
      assert.match(stdout, /Note: this consolidation makes the file \d+ bytes \(\d+\.\d%\) bigger, not smaller/);
      assert.ok(fs.readFileSync(file, 'utf8').includes('.very-long-selector-name-one, .b'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});