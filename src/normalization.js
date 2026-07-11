// Length/fr units only—unitless zero isn’t valid for angle, time, frequency,
// or resolution units (`0deg`, `0s`, …), so those are left alone. Percentage
// zero is handled separately below, via `RE_ZERO_PERCENT`: unlike these units,
// `0%` isn’t always interchangeable with unitless `0`.
const RE_ZERO_LENGTH_UNIT = /\b0(?:px|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|vw|svw|lvw|dvw|vh|svh|lvh|dvh|vi|svi|lvi|dvi|vb|svb|lvb|dvb|vmin|svmin|lvmin|dvmin|vmax|svmax|lvmax|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|in|pt|pc|q|fr)\b/gi;

// `%` isn’t a word character, so it needs its own trailing boundary instead
// of `\b`—otherwise `0%` at the end of a value (or before another symbol)
// never matches, since `\b` requires a word/non-word transition
const RE_ZERO_PERCENT = /\b0%(?!\w)/g;

// Properties whose percentage value resolves against a reference size that
// can be indefinite (e.g., a block-level box whose height depends on its own
// content, or a flex container with an indefinite main size)—for these, the
// spec’s fallback for an indefinite reference isn’t `0`, so `0%` and
// unitless `0` genuinely differ
const ZERO_PERCENT_SENSITIVE_PROPS = new Set([
  'height', 'block-size',
  'max-height', 'max-block-size',
  'flex-basis',
]);

// Collapses a decimal number’s redundant leading/trailing zeros, so `0.5`,
// `.5`, and `0.50` compare equal, as do `1.0` and `1`
const RE_DECIMAL = /(-?)(\d*)\.(\d+)/g;

function normalizeDecimals(value) {
  return value.replace(RE_DECIMAL, (_match, sign, intPart, fracPart) => {
    const trimmedFrac = fracPart.replace(/0+$/, '');
    const int = intPart === '' ? '0' : intPart;
    if (trimmedFrac === '') return `${sign}${int}`;
    return `${sign}${int === '0' ? '' : int}.${trimmedFrac}`;
  });
}

// Shorthand properties where a bare `0` and `none` render identically, because
// the initial value of e.g. `border-style` is `none`—so `border: 0` implies
// `border-style: none` just as `border: none` does
const ZERO_IS_NONE_PROPS = new Set([
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'outline',
]);

// Properties whose value can contain one or more author-defined custom
// idents—`@keyframes`/counter/container/etc. names—which are ASCII
// case-sensitive per the CSS custom-ident grammar, unlike the predefined
// keywords everywhere else in CSS (which fold safely). `animation-name: Foo`
// and `animation-name: foo` can reference two entirely different
// `@keyframes` blocks, so lowercasing them could turn a real distinction
// into a false duplicate—and, in `--dedup` mode, an unsafe merge that changes
// which animation plays. Shorthands that mix such an ident with ordinary
// case-insensitive keywords (`animation`, `container`) are included whole,
// since there’s no reliable way to fold just the keyword part without
// parsing the value; likewise `content` (a `counter()` argument names a
// case-sensitive counter) and the grid properties (line names are custom
// idents, too). Not exhaustive—extend as needed.
const CASE_SENSITIVE_VALUE_PROPS = new Set([
  'animation', 'animation-name',
  'counter-reset', 'counter-increment', 'counter-set',
  'content',
  'container', 'container-name',
  'view-transition-name',
  'timeline-scope', 'scroll-timeline-name', 'view-timeline-name',
  'anchor-name', 'position-anchor', 'position-try', 'position-try-fallbacks',
  'list-style-type',
  'grid', 'grid-template', 'grid-template-rows', 'grid-template-columns', 'grid-template-areas',
  'grid-row', 'grid-column', 'grid-area',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
]);

export function normalizeProp(prop) {
  const trimmed = prop.trim();
  // Custom property names are case-sensitive (`--Foo` !== `--foo`); every
  // other CSS property name is ASCII-case-insensitive
  return trimmed.startsWith('--') ? trimmed : trimmed.toLowerCase();
}

// Value segments that must survive normalization untouched: Quoted strings
// (`content` text, quoted font/path names), `url()` (paths are
// case-sensitive, and a `2.0`-looking substring in a file name isn’t a
// number to collapse), and custom property names (`--Foo` !== `--foo`, both
// inside `var()` and standalone, as in `transition-property: --fade`); these
// are masked behind placeholders before the steps in `normalizeValue()`
// below run, and restored afterwards—so everything *around* them (the
// `var(`/`VAR(` function name, a fallback value, the rest of the value)
// still normalizes like any other value text
const RE_OPAQUE_SEGMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\((?:\\.|[^)\\])*\)|--[^\s,)]+/gi;

// U+E000 (private use) brackets the placeholder indices—a character with no
// meaning in CSS, so it can’t collide with real value text (and, unlike a
// control character, doesn’t trip `no-control-regex`)
const RE_OPAQUE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

export function normalizeValue(prop, rawValue) {
  let value = rawValue.trim();
  const propNormalized = normalizeProp(prop);

  // Custom property values are opaque end to end: They substitute verbatim
  // wherever `var()` references them—possibly somewhere case-sensitive—and,
  // unlike regular properties, their raw spelling survives into
  // `getComputedStyle(…).getPropertyValue('--x')`, where scripts can
  // legitimately compare strings. Even `--x: 0px` vs. `--x: 0` can differ
  // (only one is a valid `z-index: var(--x)`), so only byte-identical
  // custom property values ever compare equal.
  if (propNormalized.startsWith('--')) return value;

  const opaques = [];
  value = value.replace(RE_OPAQUE_SEGMENT, segment => `\uE000${opaques.push(segment) - 1}\uE000`);

  value = value.replace(/\s+/g, ' ');
  if (!CASE_SENSITIVE_VALUE_PROPS.has(propNormalized)) value = value.toLowerCase();
  // Whitespace just inside parentheses and around commas is never
  // significant in a value, so `var( --brand, red )` compares equal to
  // `var(--brand,red)`; space before an opening parenthesis is left
  // alone—in `calc(1px + (2px))`, the space after `+` is load-bearing
  value = value.replace(/([(,]) /g, '$1').replace(/ ([),])/g, '$1');
  value = value.replace(RE_ZERO_LENGTH_UNIT, '0');
  if (!ZERO_PERCENT_SENSITIVE_PROPS.has(propNormalized)) value = value.replace(RE_ZERO_PERCENT, '0');
  value = normalizeDecimals(value);

  value = value.replace(RE_OPAQUE_PLACEHOLDER, (_match, index) => opaques[index]);

  if (ZERO_IS_NONE_PROPS.has(propNormalized) && (value === '0' || value === 'none')) {
    value = 'none';
  }

  return value;
}

export function declarationKey(prop, value, important) {
  return `${normalizeProp(prop)}: ${normalizeValue(prop, value)}${important ? ' !important' : ''}`;
}