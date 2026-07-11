import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { analyze, dedup } from '../src/index.js';
import { splitSelectors, selectorsAreMutuallyExclusive } from '../src/selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'udjo.js');
const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');

function run(args, spawnOptions = {}) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000, ...spawnOptions });
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

describe('selectorsAreMutuallyExclusive', () => {
  test('Recognizes an exact-match attribute value difference as mutually exclusive', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('html[lang=\'da\'] a', 'html[lang=\'de\'] a'), true);
  });

  test('Works with unquoted attribute values', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da]', '[lang=de]'), true);
  });

  test('Recognizes exclusivity from any one of several differing attributes', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da][dir=ltr]', '[lang=de][dir=ltr]'), true);
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da][region=eu]', '[lang=de][region=us]'), true);
  });

  test('Ignores an identical presence-only attribute alongside a differing one', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da][hidden]', '[lang=de][hidden]'), true);
  });

  test('Does not assume exclusivity for a different attribute name', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da]', '[region=de]'), false);
  });

  test('Does not treat identical selectors as mutually exclusive', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da]', '[lang=da]'), false);
  });

  test('Does not assume exclusivity for `~=` (multi-value) attribute selectors', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[class~=da]', '[class~=de]'), false);
  });

  test('Does not assume exclusivity for `^=`/`$=`/`*=`/`|=` attribute selectors', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[class^=da]', '[class^=de]'), false);
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang|=en]', '[lang|=en-US]'), false);
  });

  test('Does not assume exclusivity for values differing only in case', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=DA]', '[lang=da]'), false);
  });

  test('Does not assume exclusivity when anything else about the selectors differs', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('.a[lang=da]', '.b[lang=de]'), false);
    assert.strictEqual(selectorsAreMutuallyExclusive('[lang=da][hidden]', '[lang=de]'), false);
  });

  test('Does not assume exclusivity across a descendant or `~` combinator (the compounds can bind to different elements)', () => {
    // A `p` nested inside two differently-valued `.x` wrappers matches both
    assert.strictEqual(selectorsAreMutuallyExclusive('.x[data-v="1"] p', '.x[data-v="2"] p'), false);
    assert.strictEqual(selectorsAreMutuallyExclusive('.x[data-v="1"] ~ p', '.x[data-v="2"] ~ p'), false);
    assert.strictEqual(selectorsAreMutuallyExclusive('.x[data-v="1"] > div p', '.x[data-v="2"] > div p'), false);
  });

  test('Recognizes exclusivity across `>`/`+` combinators (one parent, one preceding sibling)', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('.x[data-v="1"] > p', '.x[data-v="2"] > p'), true);
    assert.strictEqual(selectorsAreMutuallyExclusive('.x[data-v="1"] + p', '.x[data-v="2"] + p'), true);
  });

  test('Recognizes exclusivity on the subject compound, past any combinator', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('p .x[data-v="1"]', 'p .x[data-v="2"]'), true);
  });

  test('Recognizes exclusivity past a descendant combinator when the compound is `html`/`:root` (unique per document)', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive(':root[data-theme=a] p', ':root[data-theme=b] p'), true);
    assert.strictEqual(selectorsAreMutuallyExclusive('html[lang=da] a b', 'html[lang=de] a b'), true);
  });

  test('Does not let an `html`-prefixed class name pass as the unique `html` element', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('.html-embed[data-v=1] p', '.html-embed[data-v=2] p'), false);
  });
});

describe('Analysis', () => {
  test('Flags declarations that are duplicated across rules in the same scope', () => {
    const { findings } = analyze('.a { color: red; } .b { color: red; }');
    assert.strictEqual(findings.length, 1);
    // The key is the normalized pair—`red` canonicalizes to `#ff0000`
    assert.strictEqual(findings[0].key, 'color: #ff0000');
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

  test('Does not collapse `0%` and unitless `0` for `flex-basis`', () => {
    const { findings } = analyze('.a { flex-basis: 0; } .b { flex-basis: 0%; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not collapse `0%` and unitless `0` for `height`', () => {
    const { findings } = analyze('.a { height: 0; } .b { height: 0%; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Still collapses `0%` and unitless `0` for properties not in the percentage-sensitive set', () => {
    const { findings } = analyze('.a { border-radius: 0; } .b { border-radius: 0%; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Treats equivalent color spellings as duplicates (hex, named, `rgb()`)', () => {
    assert.strictEqual(analyze('.a { color: #fff; } .b { color: #ffffff; }').findings.length, 1);
    assert.strictEqual(analyze('.a { color: white; } .b { color: #fff; }').findings.length, 1);
    assert.strictEqual(analyze('.a { color: rgb(255, 0, 0); } .b { color: rgb(255 0 0); }').findings.length, 1);
    assert.strictEqual(analyze('.a { color: rgba(255, 0, 0, 1); } .b { color: red; }').findings.length, 1);
    assert.strictEqual(analyze('.a { color: #ffffffff; } .b { color: white; }').findings.length, 1);
  });

  test('Treats `transparent` and `rgba(0, 0, 0, 0)` as equivalent', () => {
    assert.strictEqual(analyze('.a { color: transparent; } .b { color: rgba(0, 0, 0, 0); }').findings.length, 1);
  });

  test('Leaves `hsl()` and percentage `rgb()` channels alone (rounding is the browser’s business)', () => {
    assert.strictEqual(analyze('.a { color: hsl(0 0% 100%); } .b { color: #fff; }').findings.length, 0);
    assert.strictEqual(analyze('.a { color: rgb(50%, 0%, 0%); } .b { color: #800000; }').findings.length, 0);
  });

  test('Treats `font-weight: bold`/`700` and `normal`/`400` as equivalent', () => {
    assert.strictEqual(analyze('.a { font-weight: bold; } .b { font-weight: 700; }').findings.length, 1);
    assert.strictEqual(analyze('.a { font-weight: normal; } .b { font-weight: 400; }').findings.length, 1);
    assert.strictEqual(analyze('.a { font-weight: bolder; } .b { font-weight: 700; }').findings.length, 0);
  });

  test('Ignores a redundant leading `+` sign', () => {
    assert.strictEqual(analyze('.a { margin: +2px; } .b { margin: 2px; }').findings.length, 1);
  });

  test('Ignores whitespace around `/` separators', () => {
    assert.strictEqual(analyze('.a { font: 12px/1.5 serif; } .b { font: 12px / 1.5 serif; }').findings.length, 1);
  });

  test('Collapses repeated shorthand values (`margin: 0 0` ≡ `margin: 0`)', () => {
    assert.strictEqual(analyze('.a { margin: 0 0; } .b { margin: 0; }').findings.length, 1);
    assert.strictEqual(analyze('.a { padding: 1px 2px 1px 2px; } .b { padding: 1px 2px; }').findings.length, 1);
    assert.strictEqual(analyze('.a { margin: 0 auto 0 auto; } .b { margin: 0 auto; }').findings.length, 1);
    assert.strictEqual(analyze('.a { overflow: hidden hidden; } .b { overflow: hidden; }').findings.length, 1);
    assert.strictEqual(analyze('.a { border-radius: 1px / 1px; } .b { border-radius: 1px; }').findings.length, 1);
  });

  test('Does not collapse shorthand values that aren’t repetitions', () => {
    assert.strictEqual(analyze('.a { margin: 1px 2px; } .b { margin: 1px; }').findings.length, 0);
    assert.strictEqual(analyze('.a { border-radius: 50% / 100%; } .b { border-radius: 50%; }').findings.length, 0);
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

  test('Normalizes whitespace and function-name case around a `var()` reference', () => {
    assert.strictEqual(analyze('.a { color: var( --brand ); } .b { color: var(--brand); }').findings.length, 1);
    assert.strictEqual(analyze('.a { color: VAR(--brand); } .b { color: var(--brand); }').findings.length, 1);
  });

  test('Normalizes spacing around a `var()` fallback', () => {
    const { findings } = analyze('.a { color: var(--brand, red); } .b { color: var(--brand,red); }');
    assert.strictEqual(findings.length, 1);
  });

  test('Still normalizes the value parts outside a `var()` reference', () => {
    const { findings } = analyze('.a { margin: var(--space) 0px; } .b { margin: var(--space) 0; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Ignores whitespace just inside parentheses and around commas', () => {
    const { findings } = analyze('.a { color: rgb( 255, 0, 0 ); } .b { color: rgb(255,0,0); }');
    assert.strictEqual(findings.length, 1);
  });

  test('Preserves whitespace inside quoted strings', () => {
    const { findings } = analyze('.a { content: "a  b"; } .b { content: "a b"; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Treats identical custom property declarations as duplicates', () => {
    const { findings } = analyze('.a { --brand: #fff; } .b { --brand: #fff; }');
    assert.strictEqual(findings.length, 1);
  });

  test('Compares custom property values verbatim (no case folding, no zero collapsing)', () => {
    assert.strictEqual(analyze('.a { --brand: #FFF; } .b { --brand: #fff; }').findings.length, 0);
    assert.strictEqual(analyze('.a { --space: 0px; } .b { --space: 0; }').findings.length, 0);
  });

  test('Does not fold case for `content` (a `counter()` argument names a case-sensitive counter)', () => {
    const { findings } = analyze('.a { content: "-" counter(Section); } .b { content: "-" counter(section); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not fold case for grid line names (custom idents)', () => {
    const { findings } = analyze('.a { grid-column: Main-Start; } .b { grid-column: main-start; }');
    assert.strictEqual(findings.length, 0);
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

  test('Flags a selector written more than once within one scope', () => {
    const { findings } = analyze('.a { color: red; }\n.b { color: blue; }\n.a { margin: 0; }\n');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].repeated, true);
    assert.strictEqual(findings[0].key, '.a');
    assert.deepStrictEqual(findings[0].occurrences.map(occ => occ.line), [1, 3]);
  });

  test('Recognizes a repeated selector list regardless of order (`.a, .b` vs. `.b, .a`)', () => {
    const { findings } = analyze('.a, .b { color: red; }\n.b, .a { margin: 0; }\n');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].repeated, true);
  });

  test('Does not flag a selector repeated across two separately-written same-condition blocks', () => {
    // The merged reporting view treats the two blocks as one scope for
    // declaration duplicates, but repeating a selector across two physical
    // blocks is by construction, not a smell within one of them
    const { findings } = analyze('@media (min-width: 768px) { .a { color: red; } }\n@media (min-width: 768px) { .a { margin: 0; } }');
    assert.strictEqual(findings.length, 0);
  });

  test('Flags a declaration repeated within a selector-less at-rule block (`@font-face`)', () => {
    const { findings } = analyze('@font-face { font-family: Foo; src: url(a.woff); font-family: Foo; }');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].redundant, true);
    assert.strictEqual(findings[0].scope, '@font-face');
    assert.strictEqual(findings[0].occurrences[0].selector, '@font-face');
  });

  test('Does not flag two independent `@font-face` blocks repeating the same declaration', () => {
    const { findings } = analyze('@font-face { font-family: Foo; font-weight: 400; }\n@font-face { font-family: Foo; font-weight: 700; }');
    assert.strictEqual(findings.length, 0);
  });

  test('Flags a declaration repeated within `@page`', () => {
    const { findings } = analyze('@page { margin: 1in; margin: 1in; }');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].scope, '@page');
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
    // own original selector.
    const input = '.hub { color: red; padding: 1px; background: blue; }\n.a { color: red; }\n.b { background: blue; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.hub, .a { color: red; }\n.hub { padding: 1px; }\n.hub, .b { background: blue; }\n');
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

  test('Skips twin rules when one carries an extra declaration (it would leak to the other’s selector)', () => {
    const input = '.a { margin: 0; color: red; padding: 1px; }\n.b { margin: 0; color: red; }\n';
    const { css, applied, skipped } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 2);
    assert.strictEqual(css, input);
  });

  test('Skips a cluster with two candidate hubs (two rules holding every group’s shared declaration)', () => {
    // Both rules hold both groups’ shared declarations, in opposite
    // order—splitting around either hub would reorder the overlapping
    // `margin`/`margin-left` pair for whichever rule isn’t the hub,
    // changing which value wins for its elements.
    const input = '.h1 { margin: 0; margin-left: 5px; }\n.h2 { margin-left: 5px; margin: 0; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 2);
    assert.ok(skipped.every(item => /entangled/.test(item.reason)));
    assert.strictEqual(css, input);
  });

  test('Falls back to skipping every group in a cluster with no single rule connecting them all', () => {
    // `.a` entangles the `color` and `margin` groups; `.c` entangles the
    // `margin` and `border` groups—but no single rule is a member of all
    // three groups, so there’s no one hub position that could satisfy
    // every pairwise ordering constraint at once.
    const input = '.a { color: red; margin: 0; }\n.b { color: red; }\n.c { margin: 0; border: none; }\n.d { border: none; }\n';
    const { applied, skipped, css } = dedup(input);
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(skipped.length, 3);
    assert.ok(skipped.every(item => /entangled/.test(item.reason)));
    assert.strictEqual(css, input);
  });

  test('Places a target’s pre-shared extra in a residual before the merge, preserving its original within-rule order', () => {
    // Within `.a`’s own original rule, `margin-left` (declared after `margin`)
    // already won—so after the split, the residual carrying `margin` must
    // stay before the merged `margin-left` rule, not after, or `.a` would
    // end up with `margin-left: 0` instead of `5px`.
    const { applied, skipped, css } = dedup('.a { margin: 0; margin-left: 5px; }\n.b { margin-left: 5px; }\n');
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(skipped.length, 0);
    assert.strictEqual(css, '.a { margin: 0; }\n.a, .b { margin-left: 5px; }\n');
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

  test('Never touches a same-rule duplicate on a selector-hack rule', () => {
    const input = '* html .a { color: red; color: red; }\n';
    const { css, applied } = dedup(input);
    assert.strictEqual(css, input);
    assert.strictEqual(applied.length, 0);
  });

  test('Cleans up a same-rule duplicate before also merging that rule across the scope', () => {
    const { css, applied } = dedup('.a { color: red; color: red; }\n.b { color: red; }\n');
    assert.match(css, /\.a,\s*\.b\s*{\s*color: red;\s*}/);
    assert.strictEqual(applied.length, 2);
    assert.ok(applied.some(item => item.redundant));
    assert.ok(applied.some(item => !item.redundant));
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

  test('merge-safety.css report mode explains the unsafe group alongside the safe one’s savings estimate', () => {
    const { stdout } = run([path.join(fixturesDir, 'merge-safety.css')]);
    assert.match(stdout, /Run with `--dedup` to save \d+ bytes \(\d+\.\d%\)\./);
    assert.ok(stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
    assert.match(stdout, /background: #ffffff — intervening `background` declaration in `\.y`/);
  });

  test('merge-safety.css report mode closes with the summary and `--dedup` payoff, after the unsafe-group details', () => {
    const { stdout } = run([path.join(fixturesDir, 'merge-safety.css')]);
    const unsafeIndex = stdout.indexOf('unsafe to auto-merge');
    const summaryIndex = stdout.indexOf('Summary:');
    assert.ok(unsafeIndex !== -1 && summaryIndex !== -1);
    assert.ok(unsafeIndex < summaryIndex);
    assert.match(stdout, /Run with `--dedup` to save \d+ bytes \(\d+\.\d%\)\.\s*$/);
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
      assert.ok(stdout.includes('1 skipped (considered unsafe to auto-merge)'));
      assert.match(stdout, /\d+ → \d+ bytes \(-\d+ B, -\d+\.\d%\)/);

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, /\.a,\s*\.c\s*{\s*color: red;\s*}/);
      assert.ok(output.includes('.x {'));
      assert.ok(output.includes('.z {'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--dedup` omits the “unsafe to auto-merge” qualifier when nothing was skipped', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_nothing_skipped');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'clean.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout } = run(['--dedup', file]);
      assert.ok(stdout.includes('1 consolidated, 0 skipped'));
      assert.ok(!stdout.includes('unsafe to auto-merge'));
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

  test('Processes multiple files in one invocation, with a header per file', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { color: blue; }\n');

    try {
      const { stdout, status } = run([fileA, fileB]);
      assert.ok(stdout.includes(fileA));
      assert.ok(stdout.includes(fileB));
      assert.ok(stdout.includes('No duplicate declarations found.'));
      // Two blank lines separate one file’s report from the next header
      assert.ok(stdout.includes(`\n\n\n${fileB}`));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--dedup` consolidates each of multiple files independently', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_dedup');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { margin: 0; }\n.d { margin: 0; }\n');

    try {
      const { stdout } = run(['--dedup', fileA, fileB]);
      assert.ok(stdout.includes(fileA));
      assert.ok(stdout.includes(fileB));
      assert.match(fs.readFileSync(fileA, 'utf8'), /\.a,\s*\.b\s*{\s*color: red;\s*}/);
      assert.match(fs.readFileSync(fileB, 'utf8'), /\.c,\s*\.d\s*{\s*margin: 0;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Recursively finds `.css` files under a directory, skipping `node_modules` and dotfolders', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_dir_scan');
    fs.mkdirSync(path.join(dirTemp, 'sub', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dirTemp, 'sub', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'one.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', 'two.css'), '.c { color: blue; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', 'node_modules', 'ignored.css'), '.z { color: red; }\n.y { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', '.hidden', 'ignored.css'), '.x { color: red; }\n.w { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'readme.txt'), 'not css');

    try {
      const { stdout, status } = run([dirTemp]);
      assert.ok(stdout.includes(path.join(dirTemp, 'one.css')));
      assert.ok(stdout.includes(path.join(dirTemp, 'sub', 'two.css')));
      assert.ok(!stdout.includes('node_modules'));
      assert.ok(!stdout.includes('.hidden'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a clean error for a directory with no `.css` files', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_dir_empty');
    fs.mkdirSync(dirTemp, { recursive: true });

    try {
      const { stderr, status } = run([dirTemp]);
      assert.ok(stderr.includes('No `.css` files found'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a concise, zoomed-in error for a CSS syntax error, not the whole source', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_syntax_error');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(file, '.a { color XP_WIN, }\n');

    try {
      const { stderr, stdout, status } = run([file]);
      assert.match(stderr, /Unknown word/);
      assert.match(stderr, /\^/);
      assert.ok(!stderr.includes('CssSyntaxError\n    at'));
      assert.strictEqual(stdout, '');
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('A syntax error in one file does not stop the others from being processed', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_syntax_error_multi');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'bad.css'), '.a { color XP_WIN, }\n');
    fs.writeFileSync(path.join(dirTemp, 'good.css'), '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, stderr, status } = run([dirTemp]);
      assert.match(stderr, /Unknown word/);
      assert.ok(stdout.includes(path.join(dirTemp, 'good.css')));
      assert.ok(stdout.includes('1 finding'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reads from stdin with `-` in report mode', () => {
    const { stdout } = run(['-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.ok(stdout.includes('1 finding'));
  });

  test('`--dedup -` writes the consolidated CSS to stdout, and status to stderr', () => {
    const { stdout, stderr } = run(['--dedup', '-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.match(stdout, /^\.a, \.b \{\s*color: red;\s*\}\s*$/);
    assert.ok(stderr.includes('1 consolidated'));
  });

  test('`--dedup -` still writes the full stylesheet to stdout when nothing is consolidated', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n';
    const { stdout, stderr } = run(['--dedup', '-'], { input });
    assert.strictEqual(stdout, input);
    assert.ok(stderr.includes('0 consolidated'));
  });

  test('Rejects combining `-` with other file arguments', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_stdin_mix');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'a.css');
    fs.writeFileSync(file, '.a { color: red; }\n');

    try {
      const { stderr, status } = run([file, '-']);
      assert.ok(stderr.includes('Cannot combine stdin'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads `ignoreSelectors` from `.udjo.js` in the working directory', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, '.udjo.js'), 'export default { ignoreSelectors: [/^\\.legacy-/] };\n');
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run([file], { cwd: dirTemp });
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads a config file from an explicit `--config` path', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config_explicit');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileConfig = path.join(dirTemp, 'custom.config.js');
    fs.writeFileSync(fileConfig, 'export default { ignoreSelectors: [/^\\.legacy-/] };\n');
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run(['--config', fileConfig, file]);
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('An absent `.udjo.js` is silently ignored', () => {
    const { stdout } = run([path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('No duplicate declarations found.'));
  });
});