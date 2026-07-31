import { describe, test } from 'node:test';
import assert from 'node:assert';
import { analyze, dedup } from '../src/index.js';
import { normalizeValue } from '../src/lib/normalization.js';
import { selectorsAreMutuallyExclusive, selectorsLikelyDisjoint, splitSelectors } from '../src/lib/selectors.js';

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
    // `rad`→`deg` involves π, so it’s rounded—still expected to land on the
    // same canonical key at the conversion’s fixed precision
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
