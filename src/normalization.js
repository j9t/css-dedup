// Length/percentage/fr units only—unitless zero isn’t valid for angle, time,
// frequency, or resolution units (`0deg`, `0s`, …), so those are left alone;
// `%` isn’t a word character, so it needs its own trailing boundary instead
// of `\b`—otherwise `0%` at the end of a value (or before another symbol)
// never matches, since `\b` requires a word/non-word transition
const ZERO_UNIT_RE = /\b0(?:px|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|vw|svw|lvw|dvw|vh|svh|lvh|dvh|vi|svi|lvi|dvi|vb|svb|lvb|dvb|vmin|svmin|lvmin|dvmin|vmax|svmax|lvmax|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|in|pt|pc|q|fr)\b|\b0%(?!\w)/gi;

// Collapses a decimal number’s redundant leading/trailing zeros, so `0.5`,
// `.5`, and `0.50` compare equal, as do `1.0` and `1`
const DECIMAL_RE = /(-?)(\d*)\.(\d+)/g;

function normalizeDecimals(value) {
  return value.replace(DECIMAL_RE, (_match, sign, intPart, fracPart) => {
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
// parsing the value. Not exhaustive—extend as needed.
const CASE_SENSITIVE_VALUE_PROPS = new Set([
  'animation', 'animation-name',
  'counter-reset', 'counter-increment', 'counter-set',
  'container', 'container-name',
  'view-transition-name',
  'timeline-scope', 'scroll-timeline-name', 'view-timeline-name',
  'anchor-name', 'position-anchor', 'position-try', 'position-try-fallbacks',
  'list-style-type',
]);

export function normalizeProp(prop) {
  const trimmed = prop.trim();
  // Custom property names are case-sensitive (`--Foo` !== `--foo`); every
  // other CSS property name is ASCII-case-insensitive
  return trimmed.startsWith('--') ? trimmed : trimmed.toLowerCase();
}

export function normalizeValue(prop, rawValue) {
  let value = rawValue.trim();
  const propNormalized = normalizeProp(prop);

  // Leave string literals, `url()` contents, and `var()` references alone for
  // every step below—those can be case-sensitive (paths, `content` strings,
  // custom idents, and custom property names inside `var()`), and a stray
  // `0.5`-looking substring in a URL isn’t a number to collapse; custom
  // property values are opaque too—they’re substituted verbatim by `var()`,
  // so casing in a `--*` declaration is significant and can’t be folded;
  // whitespace is significant there, too (e.g. `content: "a  b"`), so it’s
  // only collapsed in the non-opaque branch below, not on the raw value
  const hasOpaqueValue = propNormalized.startsWith('--') || /["']|url\(|var\(/i.test(value);
  if (!hasOpaqueValue) {
    value = value.replace(/\s+/g, ' ');
    if (!CASE_SENSITIVE_VALUE_PROPS.has(propNormalized)) value = value.toLowerCase();
    value = value.replace(ZERO_UNIT_RE, '0');
    value = normalizeDecimals(value);
  }

  if (ZERO_IS_NONE_PROPS.has(propNormalized) && (value === '0' || value === 'none')) {
    value = 'none';
  }

  return value;
}

export function declarationKey(prop, value, important) {
  return `${normalizeProp(prop)}: ${normalizeValue(prop, value)}${important ? ' !important' : ''}`;
}