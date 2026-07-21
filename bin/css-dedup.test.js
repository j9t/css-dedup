import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { analyze, dedup } from '../src/index.js';
import { normalizeValue } from '../src/normalization.js';
import { splitSelectors, selectorsAreMutuallyExclusive, selectorsLikelyDisjoint } from '../src/selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'css-dedup.js');
const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');

// A consolidation that grows the file: the long selector list costs more
// than the removed `color` declaration saves
const cssGrowing = '.very-long-selector-name-one { color: red; font-weight: bold; }\n.b { color: red; }\n';

// Only mergeable in aggressive mode (the intervening rule blocks the default
// pass), and the merge grows the file—both rules keep another declaration,
// so the merge adds the long selector list without removing a rule
const cssGrowingAggressive = [
  '.module-header-navigation-primary-link { color: red; font-size: 14px; }',
  '.unrelated-widget:hover { color: blue; }',
  '.module-footer-navigation-secondary-link { color: red; letter-spacing: 1px; }',
  '',
].join('\n');

// Only mergeable in aggressive mode (canonicalizing the `<angle>` values is
// aggressive-only), and—unlike `cssGrowingAggressive`—the merge shrinks the
// file: Each rule holds only the one shared declaration, so folding them
// removes a whole rule instead of just adding to a selector list
const cssShrinkingAggressive = '.a { transform: rotate(90deg); }\n.b { transform: rotate(100grad); }\n';

// Assertion patterns shared across several tests
const RE_WITHHELD_ONE = /1 withheld/;
const RE_MERGED_AB = /\.a,\s*\.b\s*{\s*color: red;\s*}/;
const RE_MERGED_AC = /\.a,\s*\.c\s*{\s*color: red;\s*}/;
const RE_PAYOFF_FIX = /\* \d+ findings?: Reduce duplication and save \d+ bytes \(-\d+\.\d%\) with `--fix`/;
const RE_SYNTAX_ERROR = /Unknown word/;

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

  test('Treats a backslash-escaped character as content, not syntax', () => {
    // The escaped quote must not close the string, or the following comma
    // (still inside the quotes) would be misread as a selector separator
    assert.deepStrictEqual(splitSelectors('[data-x="a\\"b, c"], .d'), ['[data-x="a\\"b, c"]', '.d']);
    assert.deepStrictEqual(splitSelectors('.a\\,b, .c'), ['.a\\,b', '.c']);
  });
});

describe('Selectors—mutually exclusive', () => {
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

  test('Does not fold attribute-name case (attribute names are case-sensitive in XML/SVG)', () => {
    assert.strictEqual(selectorsAreMutuallyExclusive('[Foo=a]', '[foo=b]'), false);
  });

  test('Resolves CSS character escapes in attribute values before comparing', () => {
    // `\61` is `a`—the two spellings name the same value, so they must
    // never be taken as proof of exclusivity
    assert.strictEqual(selectorsAreMutuallyExclusive('[data-x=a]', '[data-x=\\61]'), false);
    assert.strictEqual(selectorsAreMutuallyExclusive('[data-x=\\61]', '[data-x=b]'), true);
  });
});

describe('Selector—likely disjoint', () => {
  test('Assumes disjointness for subject compounds with no class in common', () => {
    assert.strictEqual(selectorsLikelyDisjoint('.card', '.btn:hover'), true);
  });

  test('Does not assume disjointness when the subject compounds share a class', () => {
    assert.strictEqual(selectorsLikelyDisjoint('.a', '.a.on'), false);
    assert.strictEqual(selectorsLikelyDisjoint('.a', '.a:hover'), false);
  });

  test('Recognizes different type selectors as disjoint', () => {
    assert.strictEqual(selectorsLikelyDisjoint('div', '.x span'), true);
  });

  test('Recognizes different IDs as disjoint', () => {
    assert.strictEqual(selectorsLikelyDisjoint('#a', '#b'), true);
  });

  test('Does not compare across identity categories (a class tells nothing about a type)', () => {
    assert.strictEqual(selectorsLikelyDisjoint('.a', 'div'), false);
  });

  test('Only the subject compound counts, not ancestor compounds', () => {
    // Both selectors’ subjects are `p`—the differing ancestors don’t make
    // them disjoint (the same `p` can sit inside both wrappers)
    assert.strictEqual(selectorsLikelyDisjoint('.x p', '.y p'), false);
  });

  test('Bails out on selector-taking pseudo-classes in the subject compound', () => {
    assert.strictEqual(selectorsLikelyDisjoint('.a', ':not(.a)'), false);
    assert.strictEqual(selectorsLikelyDisjoint('.a', ':is(.b)'), false);
  });

  test('Bails out on escapes in the subject compound', () => {
    assert.strictEqual(selectorsLikelyDisjoint('.a\\.b', '.c'), false);
  });

  test('Does not misread `.`/`#` inside attribute values as classes/IDs', () => {
    // `[href$=".pdf"]` carries no class identity, so nothing proves it apart
    // from `.pdf`
    assert.strictEqual(selectorsLikelyDisjoint('[href$=".pdf"]', '.pdf'), false);
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

  test('Treats equivalent `s`/`ms` time values as duplicates, unconditionally', () => {
    assert.strictEqual(analyze('.a { transition-duration: 0.3s; } .b { transition-duration: 300ms; }').findings.length, 1);
    assert.strictEqual(analyze('.a { transition-delay: 0s; } .b { transition-delay: 0ms; }').findings.length, 1);
    // A value that loses precision under naive `parseFloat(x) * 1000`
    // (`1.005 * 1000 === 1004.9999999999999` in IEEE 754) must still compare
    // exactly equal to its millisecond spelling
    assert.strictEqual(analyze('.a { transition-duration: 1.005s; } .b { transition-duration: 1005ms; }').findings.length, 1);
    assert.strictEqual(analyze('.a { animation-duration: 1s; } .b { animation-duration: 2s; }').findings.length, 0);
  });

  test('Normalizes time units inside the `animation`/`transition` shorthand without touching the case-sensitive animation name', () => {
    const { findings } = analyze('.a { animation: Spin 2s linear infinite; } .b { animation: Spin 2000ms linear infinite; }');
    assert.strictEqual(findings.length, 1);
    // A differently-cased animation name must still be treated as distinct
    assert.strictEqual(analyze('.a { animation: Spin 2s linear; } .b { animation: spin 2000ms linear; }').findings.length, 0);
  });

  test('Does not mistake digits inside a case-sensitive custom ident for a time or angle value', () => {
    // `fade2s` is a real, single `@keyframes` name here—without a left
    // boundary on the number match, `2s` inside it would silently rewrite
    // to `2000ms`, corrupting the identifier
    assert.strictEqual(normalizeValue('animation-name', 'fade2s', false), 'fade2s');
    assert.strictEqual(normalizeValue('animation-name', 'spin100grad', true), 'spin100grad');
    assert.strictEqual(normalizeValue('animation-name', 'spin1turn', true), 'spin1turn');
    assert.strictEqual(normalizeValue('animation', 'Spin2s linear infinite', false), 'Spin2s linear infinite');

    // Two rules using genuinely different `@keyframes` names (one of which
    // looks like a corrupted spelling the bug would have produced) must
    // never be treated as duplicates—that would let `--fix` merge them and
    // silently drop one animation
    const { findings } = analyze('.a { animation-name: fade2s; } .b { animation-name: fade2000ms; }');
    assert.strictEqual(findings.length, 0);

    // `--fix` must leave the identifier untouched in the written output, too
    const { css, applied } = dedup('.a { animation-name: fade2s; }\n.b { animation-name: fade2s; }\n');
    assert.strictEqual(applied.length, 1);
    assert.ok(css.includes('fade2s'));
    assert.ok(!css.includes('fade2000ms'));
  });

  test('Sorts `min()`/`max()` arguments, since mathematical min/max is commutative', () => {
    assert.strictEqual(analyze('.a { width: min(100%, 500px); } .b { width: min(500px, 100%); }').findings.length, 1);
    assert.strictEqual(analyze('.a { width: max(1em, 2em); } .b { width: max(2em, 1em); }').findings.length, 1);
    // Different raw spellings of the same argument value still land in the
    // same sort position, since the sort runs after decimal normalization
    assert.strictEqual(analyze('.a { width: min(0.50, 10px); } .b { width: min(10px, .5); }').findings.length, 1);
  });

  test('Does not reorder `clamp()` arguments (positional: minimum, preferred, maximum)', () => {
    const { findings } = analyze('.a { width: clamp(1px, 50%, 500px); } .b { width: clamp(500px, 50%, 1px); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Does not reorder `minmax()` arguments (positional grid track sizing, not the `min()` function)', () => {
    const { findings } = analyze('.a { grid-template-columns: minmax(100px, 1fr); } .b { grid-template-columns: minmax(1fr, 100px); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Sorts arguments of a `min()`/`max()` call nested inside another', () => {
    const { findings } = analyze('.a { width: min(max(1px, 2px), 3px); } .b { width: min(3px, max(2px, 1px)); }');
    assert.strictEqual(findings.length, 1);
  });

  test('Does not treat angle units as equivalent by default (aggressive-only)', () => {
    const { findings } = analyze('.a { transform: rotate(90deg); } .b { transform: rotate(0.25turn); }');
    assert.strictEqual(findings.length, 0);
  });

  test('Treats equivalent angle units as duplicates in aggressive mode', () => {
    assert.strictEqual(analyze('.a { transform: rotate(90deg); } .b { transform: rotate(0.25turn); }', { aggressive: true }).findings.length, 1);
    // `grad`→`deg` is an exact rational conversion (×9/10)
    assert.strictEqual(analyze('.a { transform: rotate(90deg); } .b { transform: rotate(100grad); }', { aggressive: true }).findings.length, 1);
    // `rad`→`deg` involves π, so it's rounded—still expected to land on the
    // same canonical key at the conversion's fixed precision
    assert.strictEqual(analyze('.a { transform: rotate(57.29578deg); } .b { transform: rotate(1rad); }', { aggressive: true }).findings.length, 1);
    assert.strictEqual(analyze('.a { transform: rotate(45deg); } .b { transform: rotate(1rad); }', { aggressive: true }).findings.length, 0);
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

  test('Masks a quoted `url()` containing a closing parenthesis as one segment', () => {
    assert.strictEqual(analyze('.a { background: url("a)b.PNG"); } .b { background: url("a)b.png"); }').findings.length, 0);
    assert.strictEqual(analyze('.a { background: url("a)b.png"); } .b { background: url("a)b.png"); }').findings.length, 1);
  });

  test('Does not fold case for `page` (a named page is a case-sensitive custom ident)', () => {
    assert.strictEqual(analyze('.a { page: Invoice; } .b { page: invoice; }').findings.length, 0);
  });

  test('Does not collapse repeated `place-content` values', () => {
    assert.strictEqual(analyze('.a { place-content: baseline baseline; } .b { place-content: baseline; }').findings.length, 0);
  });

  test('Distinguishes selectors whose quoted attribute values differ only in inner whitespace', () => {
    const { findings } = analyze('[data-x="a  b"] { color: red; }\n[data-x="a b"] { margin: 0; }\n');
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

  test('Ignores selector hack rules by default', () => {
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

describe('Deduplication', () => {
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

describe('savingsOnly', () => {
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

  test('merge-safety.css report mode explains the unsafe group, then closes with the summary and `--fix` payoff', () => {
    const { stdout } = run([path.join(fixturesDir, 'merge-safety.css')]);
    assert.match(stdout, RE_PAYOFF_FIX);
    assert.ok(stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
    assert.match(stdout, /background: #ffffff — intervening `background` declaration in `\.y`/);
    // The unsafe-group detail must print before the summary, so a long
    // skipped list can't push the outcome off-screen and out of scrollback
    const unsafeIndex = stdout.indexOf('unsafe to auto-merge');
    const summaryIndex = stdout.indexOf('Summary:');
    assert.ok(unsafeIndex !== -1 && summaryIndex !== -1);
    assert.ok(unsafeIndex < summaryIndex);
    assert.match(stdout, /\* \d+ findings?: Reduce duplication and save \d+ bytes \(-\d+\.\d%\) with `--fix`\n\* \d+ more findings? in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive`\s*$/);
  });

  test('merge-safety.css --fix consolidates the safe pair and skips the unsafe one', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_merge_safety');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(stdout.includes('1 declaration consolidated'));
      assert.ok(stdout.includes('1 finding skipped (considered unsafe to auto-merge)'));
      assert.match(stdout, /\d+ → \d+ bytes, -\d+\.\d%/);

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, RE_MERGED_AC);
      assert.ok(output.includes('.x {'));
      assert.ok(output.includes('.z {'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` omits the “unsafe to auto-merge” qualifier when nothing was skipped', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_nothing_skipped');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'clean.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.ok(!stdout.includes('unsafe to auto-merge'));
      assert.ok(!/\d+ skipped/.test(stdout));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('basic.css report mode suggests the byte savings from running `--fix`', () => {
    const { stdout } = run([path.join(fixturesDir, 'basic.css')]);
    assert.match(stdout, RE_PAYOFF_FIX);
  });

  test('aggressive.css reports nothing by default, but notes the `--aggressive` potential in parentheses', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'aggressive.css')]);
    assert.strictEqual(status, 0);
    assert.match(stdout, /No duplicate declarations found\. With `--aggressive`: 1 consolidation possible\./);
  });

  test('aggressive.css reports the duplicate with `--aggressive`', () => {
    const { stdout, status } = run(['--aggressive', path.join(fixturesDir, 'aggressive.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stdout.includes('duplicate   color: hsl(0 0% 100%)'));
    assert.match(stdout, RE_PAYOFF_FIX);
  });

  test('aggressive.css --fix --aggressive merges across the blocks, drops the emptied one, and suggests testing', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_aggressive');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'aggressive.css');
    fs.copyFileSync(path.join(fixturesDir, 'aggressive.css'), file);

    try {
      const { stdout } = run(['--fix', '--aggressive', file]);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.match(stdout, /1 of these merges is aggressive-only—probably, but not provably, safe\. Review the diff and test the affected pages\./);

      const output = fs.readFileSync(file, 'utf8');
      assert.strictEqual(output.match(/@media/g).length, 1);
      assert.match(output, /\.a,\s*\.b\s*{\s*color: #fff;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('merge-safety.css --fix without `--aggressive` notes what a re-run with it would add', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_merge_safety_hint');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /intervening `background` declaration in `\.y`.*\(may merge with `--aggressive`\)/);
      assert.match(stdout, /\* 1 more finding in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('merge-safety.css -f consolidates the safe pair (short flag)', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_merge_safety_short');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['-f', file]);
      assert.ok(stdout.includes('1 declaration consolidated'));

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, RE_MERGED_AC);
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
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run([file]);
      assert.match(stdout, /\* 1 finding: Reduce duplication but grow by \d+ bytes \(\+\d+\.\d%\) with `--fix`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns in `--fix` mode when consolidation grows the file rather than shrinks it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_growth_dedup');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /\* 1 declaration consolidated: Reduced duplication and grew by \d+ bytes \(\d+ → \d+ bytes, \+\d+\.\d%\)/);
      assert.match(stdout, /\* Worth it for maintainability \(each declaration used once\); skip `--fix` here if you care more about transfer size\./);
      assert.ok(fs.readFileSync(file, 'utf8').includes('.very-long-selector-name-one, .b'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Rejects `--savings-only` without `--fix`', () => {
    const { stderr, status } = run(['--savings-only', path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes('`--savings-only` only applies together with `--fix`'));
  });

  test('`--fix --savings-only` leaves a file untouched when consolidation would grow it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_savings_only');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowing;
    fs.writeFileSync(file, source);

    try {
      const { stdout, status } = run(['--fix', '--savings-only', file]);
      assert.strictEqual(status, 1);
      assert.match(stdout, /\* 0 declarations consolidated, 1 withheld: `savingsOnly` left this file untouched—consolidating would grow by \d+ bytes \(\+\d+\.\d%\)/);
      assert.ok(!stdout.includes('Wrote'));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only` still writes a file whose consolidation shrinks it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_savings_only_shrink');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'shrink.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, status } = run(['-f', '-s', file]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.ok(stdout.includes('Wrote'));
      assert.ok(fs.readFileSync(file, 'utf8').includes('.a, .b'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --aggressive --savings-only` withholds a growing aggressive merge', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_savings_only_aggressive');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowingAggressive;
    fs.writeFileSync(file, source);

    try {
      const { stdout, status } = run(['-f', '-a', '-s', file]);
      assert.strictEqual(status, 1);
      assert.match(stdout, RE_WITHHELD_ONE);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
      // Nothing was written, so the test-your-pages advice must not appear
      assert.ok(!stdout.includes('aggressive-only'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` prints the skipped-group detail before the counts summary, so the outcome survives at the end of a long list', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_summary_order');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'mixed.css');
    // Combines `cssGrowing` (withheld under `--savings-only`, since the
    // split it needs to preserve declaration order costs more bytes than it
    // saves) with an unsafe `background` pair (skipped), so the run
    // produces both a withheld count and a skipped-group detail block to
    // order against it
    fs.writeFileSync(file, `${cssGrowing}\n.x { background: white; }\n.y { background: black; }\n.z { background: white; }\n`);

    try {
      const { stdout } = run(['--fix', '--savings-only', file]);
      const detailIndex = stdout.indexOf('duplicate group considered unsafe to auto-merge:');
      const countsIndex = stdout.indexOf('0 declarations consolidated, 1 withheld');
      assert.ok(detailIndex !== -1 && countsIndex !== -1);
      assert.ok(detailIndex < countsIndex);
      // The counts line—the run's conclusion—must be among the last things
      // printed, not stranded above the skipped-group detail
      assert.ok(stdout.includes('more findings in aggressive mode'));
      assert.match(stdout, /\* 0 declarations consolidated, 1 withheld:.*\n\* 1 finding skipped \(considered unsafe to auto-merge\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only -` still writes the untouched style sheet to STDOUT when withholding', () => {
    const source = cssGrowing;
    const { stdout, stderr, status } = run(['--fix', '-s', '-'], { input: source });
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout, source);
    assert.match(stderr, RE_WITHHELD_ONE);
  });

  test('Loads `savingsOnly: true` from the config file', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config_savings_only');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { savingsOnly: true };\n');
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowing;
    fs.writeFileSync(file, source);

    try {
      const { stdout } = run(['--fix', file], { cwd: dirTemp });
      assert.match(stdout, RE_WITHHELD_ONE);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Still warns to test when an aggressive cross-block fold nets fewer applied entries than the default pass would', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_aggressive_fewer_entries');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'cross.css');
    // Aggressive merges all four selectors in ONE entry where the default
    // pass would do TWO per-block merges—entry counts can't tell the modes
    // apart here, only the outputs can
    fs.writeFileSync(file, '@media (min-width: 40em) { .a { color: red; } .b { color: red; } }\n@media (min-width: 40em) { .c { color: red; } .d { color: red; } }\n');

    try {
      const { stdout } = run(['-f', '-a', file]);
      assert.match(stdout, /Some of these merges are aggressive-only—probably, but not provably, safe\./);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Still previews `--aggressive` when it would restructure merges into fewer entries', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_aggressive_preview_fewer');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'cross.css');
    fs.writeFileSync(file, '@media (min-width: 40em) { .a { color: red; } .b { color: red; } }\n@media (min-width: 40em) { .c { color: red; } .d { color: red; } }\n');

    try {
      const report = run([file]);
      assert.match(report.stdout, /\* More in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive`/);

      const fix = run(['--fix', file]);
      assert.match(fix.stdout, /\* More in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Does not hint “may merge with `--aggressive`” when the aggressive pass skips the group too', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_no_false_hint');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'hint.css');
    // The blocker `.a.x` shares a class with the group in both modes; only
    // the key’s spelling differs between them (hsl vs. canonicalized hex)
    fs.writeFileSync(file, '.a { color: hsl(120, 50%, 50%); }\n.a.x { color: blue; }\n.c { color: hsl(120, 50%, 50%); }\n');

    try {
      const { stdout } = run([file]);
      assert.match(stdout, /intervening `color` declaration in `\.a\.x`/);
      assert.ok(!stdout.includes('may merge with `--aggressive`'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Suppresses the `--aggressive` re-run hint on a withheld run when aggressive would grow the file too', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_withheld_no_hint');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run(['-f', '-s', file]);
      assert.match(stdout, RE_WITHHELD_ONE);
      // A `--fix --aggressive --savings-only` re-run would withhold as
      // well, so promising it anything—let alone “savings” measured against
      // the never-written output—would be false
      assert.ok(!stdout.includes('in aggressive mode'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Notes when the `--aggressive` extras would grow the file rather than shrink it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_growth_aggressive');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowingAggressive);

    try {
      const report = run([file]);
      assert.match(report.stdout, /\* 1 more finding in aggressive mode: Reduce duplication but grow by \d+ more bytes \(\+\d+\.\d%\) with `--fix --aggressive`/);

      const fix = run(['--fix', file]);
      assert.match(fix.stdout, /\* 1 more finding in aggressive mode: Reduce duplication but grow by \d+ more bytes \(\+\d+\.\d%\) with `--fix --aggressive`/);
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
      assert.ok(stdout.includes(`\n\n${fileB}`));
      assert.ok(!stdout.includes(`\n\n\n${fileB}`));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` consolidates each of multiple files independently', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_dedup');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { margin: 0; }\n.d { margin: 0; }\n');

    try {
      const { stdout } = run(['--fix', fileA, fileB]);
      assert.ok(stdout.includes(fileA));
      assert.ok(stdout.includes(fileB));
      assert.match(fs.readFileSync(fileA, 'utf8'), RE_MERGED_AB);
      assert.match(fs.readFileSync(fileB, 'utf8'), /\.c,\s*\.d\s*{\s*margin: 0;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Labels each file’s own summary with its path, and closes with an overall summary, in report mode', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_report');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { margin: 0; }\n.d { margin: 0; }\n');

    try {
      const { stdout } = run([fileA, fileB]);
      assert.ok(stdout.includes(`Summary for ${fileA}:\n* 1 finding: Reduce duplication and save`));
      assert.ok(stdout.includes(`Summary for ${fileB}:\n* 1 finding: Reduce duplication and save`));
      assert.match(stdout, /Summary for all files:\n\* 2 findings: Reduce duplication and save \d+ bytes \(-\d+\.\d%\) with `--fix`/);
      // A single file’s own summary stays unlabeled—no ambiguity to resolve
      const { stdout: single } = run([fileA]);
      assert.ok(single.includes('Summary:\n* 1 finding: Reduce duplication and save'));
      assert.ok(!single.includes('Summary for'));
      assert.ok(!single.includes('Summary for all files'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Separates shrinking and growing files in the overall summary, and points at `--savings-only`', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_mixed');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run([fileShrink, fileGrow]);
      // The lone growing file (18 bytes) outweighs the shrinking file (15
      // bytes), so the net—the actual bottom line for plain `--fix`—comes
      // out growing, too, not shrinking
      assert.match(stdout, /\* 2 findings: Reduce duplication and shrink 1 file by \d+ bytes \(-\d+\.\d%\) but grow 1 file by \d+ bytes \(\+\d+\.\d%\) with `--fix` \(for overall \+\d+ bytes \/ \+\d+\.\d%\)\n {2}- Skip files that grow in size to save \d+ bytes \(-\d+\.\d%\) in total with `--fix --savings-only`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a net shrink in the overall summary when a shrinking file outweighs a growing one', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_net_shrink');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n.c { color: red; }\n.d { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run([fileShrink, fileGrow]);
      // The shrinking file’s savings now outweigh the one growing file, so
      // the net flips to “shrink” (a “-” sign) instead of the previous
      // test’s “grow” (a “+” sign)
      assert.match(stdout, /\* 2 findings: Reduce duplication and shrink 1 file by \d+ bytes \(-\d+\.\d%\) but grow 1 file by \d+ bytes \(\+\d+\.\d%\) with `--fix` \(for overall -\d+ bytes \/ -\d+\.\d%\)\n {2}- Skip files that grow in size to save \d+ bytes \(-\d+\.\d%\) in total with `--fix --savings-only`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes an unreadable/unparseable file from the overall summary, but counts it', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_error');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileGood = path.join(dirTemp, 'good.css');
    const fileBad = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(fileGood, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileBad, '.broken { color XP_WIN, }\n');

    try {
      const { stdout, stderr, status } = run([fileGood, fileBad]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.ok(stdout.includes('Summary for all files: (1 file could not be processed; see errors above)\n* 1 finding: Reduce duplication and save'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Labels each file’s own summary and closes with an overall summary, in `--fix` mode', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_fix');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run(['--fix', fileShrink, fileGrow]);
      assert.ok(stdout.includes(`Summary for ${fileShrink}:\n* 1 declaration consolidated: Reduced duplication and saved`));
      assert.ok(stdout.includes(`Summary for ${fileGrow}:\n* 1 declaration consolidated: Reduced duplication and grew`));
      assert.ok(stdout.includes('Summary for all files:\n* 2 declarations consolidated:'));
      // The growing file (18 bytes) outweighs the shrinking file (15 bytes),
      // so the net (in parentheses) comes out positive—growing, not shrinking
      assert.match(stdout, /\* 2 declarations consolidated: Reduced duplication, shrinking 1 file by \d+ bytes \(-\d+\.\d%\) and growing 1 file by \d+ bytes \(\+\d+\.\d%\) \(for overall \+\d+ bytes \/ \+\d+\.\d%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only` reports withheld files in the overall summary', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_withheld');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run(['--fix', '--savings-only', fileShrink, fileGrow]);
      assert.match(stdout, /\* 1 declaration consolidated: Reduced duplication and saved \d+ bytes \(-\d+\.\d%\)/);
      assert.match(stdout, /\* 1 file left untouched by `--savings-only`—consolidating would have made it \d+ bytes \(\d+\.\d% overall\) bigger in total/);
      assert.ok(fs.readFileSync(fileGrow, 'utf8') === cssGrowing);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Rolls up the `--aggressive` hint across files in the overall summary, identically under report and `--fix` mode', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_multi_summary_aggressive');
    fs.mkdirSync(dirTemp, { recursive: true });
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, cssShrinkingAggressive);
    fs.writeFileSync(fileGrow, cssGrowingAggressive);

    // One file’s aggressive-only merge would save bytes, the other’s would
    // cost more than it saves—so the aggregate must sum, not just count,
    // both files’ deltas to land on the net direction. The bullet itself is
    // always a preview (never yet applied), so it reads identically whether
    // the base run was report or `--fix` mode—`--savings-only` gates the
    // whole file, not just the aggressive-only merges within it, so the
    // hint names the growing file the same way in both.
    const RE_AGGRESSIVE_ROLLUP = /\* 2 more findings in aggressive mode: Reduce duplication and shrink 1 file by \d+ more bytes \(-\d+\.\d%\) but grow 1 file by \d+ more bytes \(\+\d+\.\d%\) with `--fix --aggressive` \(for overall \+\d+ bytes \/ \+\d+\.\d%\)\n {2}- Skip files that grow in size to save \d+ bytes \(-\d+\.\d%\) in total with `--fix --aggressive --savings-only`/;

    try {
      assert.match(run([fileShrink, fileGrow]).stdout, RE_AGGRESSIVE_ROLLUP);
      assert.match(run(['--fix', fileShrink, fileGrow]).stdout, RE_AGGRESSIVE_ROLLUP);
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
      assert.match(stderr, RE_SYNTAX_ERROR);
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
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.ok(stdout.includes(path.join(dirTemp, 'good.css')));
      assert.ok(stdout.includes('1 finding'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reads from STDIN with `-` in report mode', () => {
    const { stdout } = run(['-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.ok(stdout.includes('1 finding'));
  });

  test('`--fix -` writes the consolidated CSS to stdout, and status to STDERR', () => {
    const { stdout, stderr } = run(['--fix', '-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.match(stdout, /^\.a, \.b \{\s*color: red;\s*\}\s*$/);
    assert.ok(stderr.includes('1 declaration consolidated'));
  });

  test('`--fix -` still writes the full style sheet to STDOUT when nothing is consolidated', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n';
    const { stdout, stderr } = run(['--fix', '-'], { input });
    assert.strictEqual(stdout, input);
    assert.ok(stderr.includes('0 declarations consolidated'));
  });

  test('Rejects combining `-` with other file arguments', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_stdin_mix');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'a.css');
    fs.writeFileSync(file, '.a { color: red; }\n');

    try {
      const { stderr, status } = run([file, '-']);
      assert.ok(stderr.includes('Cannot combine STDIN'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads `ignoreSelectors` from `css-dedup.config.js` in the working directory', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { ignoreSelectors: [/^\\.legacy-/] };\n');
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

  test('An absent `css-dedup.config.js` is silently ignored', () => {
    const { stdout } = run([path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('No duplicate declarations found.'));
  });

  test('`-a` is the short flag for `--aggressive`', () => {
    const { stdout, status } = run(['-a', path.join(fixturesDir, 'aggressive.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stdout.includes('duplicate   color: hsl(0 0% 100%)'));
  });

  test('Loads `aggressive: true` from the config file', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config_aggressive');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { aggressive: true };\n');
    const file = path.join(dirTemp, 'aliases.css');
    fs.writeFileSync(file, '.a { word-wrap: break-word; }\n.b { overflow-wrap: break-word; }\n');

    try {
      const { stdout, status } = run([file], { cwd: dirTemp });
      assert.strictEqual(status, 1);
      assert.ok(stdout.includes('duplicate'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes a file via `--ignore-path`/`-p`, matched against the path relative to the working directory', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_ignore_path');
    fs.mkdirSync(path.join(dirTemp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dirTemp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'dist', 'bundle.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'src', 'main.css'), '.c { color: blue; }\n.d { color: blue; }\n');

    try {
      const excluded = run(['--ignore-path', 'dist/', dirTemp]);
      assert.ok(!excluded.stdout.includes('color: red'));
      assert.ok(excluded.stdout.includes('color: blue'));

      const short = run(['-p', 'dist/', dirTemp]);
      assert.ok(!short.stdout.includes('color: red'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports that files were excluded, not that none were found, when `--ignore-path` removes every discovered file', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_ignore_path_all');
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'one.css'), '.a { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'two.css'), '.b { color: blue; }\n');

    try {
      const { stderr, status } = run(['--ignore-path', '\\.css$', dirTemp]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes('All 2 `.css` files found under'));
      assert.ok(stderr.includes('excluded by `--ignore-path`'));
      assert.ok(!stderr.includes('No `.css` files found'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes a file matching `ignorePaths` from the config file', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_config_ignore_path');
    fs.mkdirSync(path.join(dirTemp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { ignorePaths: [/dist\\//] };\n');
    fs.writeFileSync(path.join(dirTemp, 'dist', 'bundle.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'main.css'), '.c { color: blue; }\n.d { color: blue; }\n');

    try {
      const { stdout } = run(['.'], { cwd: dirTemp });
      assert.ok(!stdout.includes('color: red'));
      assert.ok(stdout.includes('color: blue'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns when `--fix` rewrites a file that references a source map', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_source_map');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'bundle.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n/*# sourceMappingURL=bundle.css.map */\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /references a source map \(`sourceMappingURL`\); `--fix` doesn’t regenerate it, so the map is now stale\./);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Does not warn about a source map when nothing was consolidated', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_source_map_clean');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'clean.css');
    fs.writeFileSync(file, '.a { color: red; }\n/*# sourceMappingURL=clean.css.map */\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(!stdout.includes('sourceMappingURL'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Rejects a single-dash long-option spelling (`-fix`) instead of silently clustering it as `-f -i x`', () => {
    const { stderr, status } = run(['-fix', path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes('Unknown option `-fix`. Did you mean `--fix`?'));
  });

  test('Still allows genuine short-flag clustering (`-fa` for `-f -a`)', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_cluster');
    fs.mkdirSync(dirTemp, { recursive: true });
    const file = path.join(dirTemp, 'basic.css');
    fs.copyFileSync(path.join(fixturesDir, 'basic.css'), file);

    try {
      const { stdout, status } = run(['-fa', file]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes('consolidated'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Processes multiple files correctly when reads are prefetched concurrently', () => {
    const dirTemp = path.join(__dirname, '..', 'test', 'temp_prefetch');
    fs.mkdirSync(dirTemp, { recursive: true });
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(dirTemp, `file-${index}.css`), `.a { color: red${index}; }\n.b { color: red${index}; }\n`);
    }

    try {
      const { stdout, status } = run([dirTemp]);
      assert.strictEqual(status, 1);
      for (let index = 0; index < 12; index++) {
        assert.ok(stdout.includes(path.join(dirTemp, `file-${index}.css`)));
      }
      // Each file’s own report must stay intact and in order, not interleaved
      assert.match(stdout, /file-0\.css[\s\S]*file-1\.css[\s\S]*file-11\.css/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});