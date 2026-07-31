import { normalizeColors } from './colors.js';
import { memoized } from './util.js';

// Length/fr units only—unitless zero isn’t valid for angle, time, frequency,
// or resolution units (`0deg`, `0s`, …). Percentage zero is separate, below.
const RE_ZERO_LENGTH_UNIT = /\b0(?:px|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|vw|svw|lvw|dvw|vh|svh|lvh|dvh|vi|svi|lvi|dvi|vb|svb|lvb|dvb|vmin|svmin|lvmin|dvmin|vmax|svmax|lvmax|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|in|pt|pc|q|fr)\b/gi;

// `%` isn’t a word character, so it needs its own trailing boundary instead
// of `\b`—otherwise `0%` at the end of a value (or before another symbol)
// never matches, since `\b` requires a word/non-word transition
const RE_ZERO_PERCENT = /\b0%(?!\w)/g;

// Properties whose percentage resolves against a possibly-indefinite
// reference size, where the spec’s fallback isn’t `0`—so `0%` and unitless
// `0` genuinely differ
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

// Properties whose value can contain an author-defined custom ident, which is
// ASCII case-sensitive unlike ordinary keywords: `animation-name: Foo` and
// `foo` can name two different `@keyframes` blocks. Shorthands mixing such an
// ident with case-insensitive keywords are included whole, since folding just
// the keyword part would mean parsing the value. Not exhaustive—extend as
// needed.
const CASE_SENSITIVE_VALUE_PROPS = new Set([
  'animation', 'animation-name',
  'counter-reset', 'counter-increment', 'counter-set',
  'content',
  'container', 'container-name',
  'view-transition-name',
  'timeline-scope', 'scroll-timeline-name', 'view-timeline-name',
  'anchor-name', 'position-anchor', 'position-try', 'position-try-fallbacks',
  'list-style-type',
  'page',
  'grid', 'grid-template', 'grid-template-rows', 'grid-template-columns', 'grid-template-areas',
  'grid-row', 'grid-column', 'grid-area',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
]);

// Shorthands whose 2/3/4-value forms repeat earlier values when trailing ones
// are omitted—`margin: 0 0` says exactly what `margin: 0` says. The quad set
// follows the top/right/bottom/left expansion; the pair set covers two-value
// properties whose second defaults to the first. `border-radius` is separate,
// its radii sitting on either side of a `/`.
const REPETITION_QUAD_PROPS = new Set([
  'margin', 'padding', 'inset',
  'border-width', 'border-style', 'border-color',
  'scroll-margin', 'scroll-padding',
]);

// `place-content` is deliberately absent: Its `justify-content` half has a
// different grammar than its `align-content` half (no baseline values), so
// whether `X X` and `X` are interchangeable there isn’t a pure repetition
// question the way it is for these
const REPETITION_PAIR_PROPS = new Set([
  'margin-block', 'margin-inline', 'padding-block', 'padding-inline',
  'inset-block', 'inset-inline',
  'gap', 'grid-gap', 'border-spacing',
  'overflow', 'overscroll-behavior',
  'place-items', 'place-self',
]);

// Splits `text` on `separator`, but only outside parentheses—a space inside
// `calc(1px + 2px)` separates operands, not value components, and a comma
// inside `min(calc(1px, 2px), 3px)` isn’t the argument list’s own. `keepEmpty`
// distinguishes the two callers: an argument list preserves empty parts (so
// `f(a,,b)` stays three arguments), a space-separated token list drops them
// (runs of spaces are one separator).
function splitTopLevel(text, separator, keepEmpty) {
  const parts = [];
  let depth = 0;
  let comment = false;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // A separator inside a comment is text: `min(2px/*,*/,1px)` has two
    // arguments, not three, and sorting across the comment would mangle it
    if (comment) {
      current += char;
      if (char === '/' && text[i - 1] === '*') comment = false;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      comment = true;
      current += char;
      continue;
    }

    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);

    if (char === separator && depth === 0) {
      if (keepEmpty || current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (keepEmpty || current) parts.push(current);

  return parts;
}

function splitValueTokens(value) {
  return splitTopLevel(value, ' ', false);
}

// `1px 2px 1px 2px` → `1px 2px` → (if both equal) `1px`, following the
// top/right/bottom/left omission rules in reverse
function reduceRepetition(tokens) {
  const reduced = [...tokens];
  if (reduced.length === 4 && reduced[3] === reduced[1]) reduced.pop();
  if (reduced.length === 3 && reduced[2] === reduced[0]) reduced.pop();
  if (reduced.length === 2 && reduced[1] === reduced[0]) reduced.pop();
  return reduced;
}

function reduceShorthandRepetition(propNormalized, value) {
  if (propNormalized === 'border-radius') {
    const sides = value.split('/').map(side => reduceRepetition(splitValueTokens(side.trim())).join(' '));
    if (sides.length === 2 && sides[0] === sides[1]) return sides[0];
    return sides.join('/');
  }

  if (REPETITION_QUAD_PROPS.has(propNormalized)) {
    const tokens = splitValueTokens(value);
    if (tokens.length >= 2 && tokens.length <= 4) return reduceRepetition(tokens).join(' ');
    return value;
  }

  if (REPETITION_PAIR_PROPS.has(propNormalized)) {
    const tokens = splitValueTokens(value);
    if (tokens.length === 2 && tokens[0] === tokens[1]) return tokens[0];
  }

  return value;
}

// An all-zero result (`0`, `0.0`, …), for dropping the sign
// `scaleDecimalExact()` would otherwise carry over from `-0`
const RE_ALL_ZERO = /^0\.?0*$/;

// Multiplies a decimal string by `numerator / 10**denominatorPow10`, exactly.
// `Number(text) * ratio` can’t be trusted: `1.005 * 1000` is
// `1004.9999999999999` in IEEE 754, which would make two textually equal times
// compare unequal. Doing the multiplication on the digit string via `BigInt`
// and then relocating the decimal point is exact for any finite decimal.
function scaleDecimalExact(text, numerator, denominatorPow10 = 0) {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const scaled = (BigInt((intPart || '0') + fracPart) * BigInt(numerator)).toString();
  const decimalPlaces = fracPart.length + denominatorPow10;
  const padded = scaled.padStart(decimalPlaces + 1, '0');
  const pointIndex = padded.length - decimalPlaces;
  const result = decimalPlaces > 0 ? `${padded.slice(0, pointIndex)}.${padded.slice(pointIndex)}` : padded;
  return (negative && !RE_ALL_ZERO.test(result) ? '-' : '') + result;
}

// A number token must not be preceded by an identifier character: without
// this, the unit regexes below would match `2s` inside a custom ident like
// `animation-name: fade2s` and rewrite it to `fade2000ms`
const RE_NUMBER = '(?<![\\w-])(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))';

// `1s` and `1000ms` are exactly interchangeable per the CSS `<time>` grammar,
// and the conversion is only ever a decimal-point shift—so this runs
// unconditionally, in any property
const RE_TIME = new RegExp(`${RE_NUMBER}(ms|s)\\b`, 'gi');

function normalizeTimeUnits(value) {
  return value.replace(RE_TIME, (match, number, unit) => {
    if (unit.toLowerCase() === 'ms') return match;
    return `${scaleDecimalExact(number, 1000)}ms`;
  });
}

// Angles onto degrees—aggressive mode only. `grad` and `turn` convert
// exactly, but `rad` → `deg` (×180/π) is irrational and so rounded; rather
// than split the feature by per-unit exactness, the whole thing is gated.
const RE_ANGLE = new RegExp(`${RE_NUMBER}(deg|grad|rad|turn)\\b`, 'gi');
const ANGLE_ROUND_DECIMALS = 6;

function normalizeAngleUnits(value) {
  return value.replace(RE_ANGLE, (match, number, rawUnit) => {
    const unit = rawUnit.toLowerCase();
    if (unit === 'deg') return match;
    if (unit === 'grad') return `${scaleDecimalExact(number, 9, 1)}deg`;
    if (unit === 'turn') return `${scaleDecimalExact(number, 360)}deg`;
    return `${(Number(number) * (180 / Math.PI)).toFixed(ANGLE_ROUND_DECIMALS)}deg`;
  });
}

function splitTopLevelCommas(text) {
  return splitTopLevel(text, ',', true);
}

// A character a CSS identifier can continue with—requires a real token
// boundary before `min(`/`max(`, which a plain `\b` wouldn’t give for a
// hyphenated ident
const RE_IDENT_CHAR = /[\w-]/;

// Hoisted: tested once per scanned character below
const RE_MIN_MAX_START = /^(min|max)\(/i;

// Sorts a `min()`/`max()` call’s arguments canonically—min/max is
// commutative, so their order carries no meaning. `clamp()` is left alone (its
// three arguments are positional), and `minmax()` never matches, since the
// scan requires the name immediately followed by `(`.
function sortMinMaxArguments(value) {
  let result = '';
  let index = 0;

  while (index < value.length) {
    const boundaryOk = index === 0 || !RE_IDENT_CHAR.test(value[index - 1]);
    const match = boundaryOk ? RE_MIN_MAX_START.exec(value.slice(index)) : null;
    if (!match) {
      result += value[index];
      index++;
      continue;
    }

    const name = match[1];
    const argsStart = index + match[0].length;
    let depth = 1;
    let cursor = argsStart;
    while (cursor < value.length && depth > 0) {
      if (value[cursor] === '(') depth++;
      else if (value[cursor] === ')') depth--;
      cursor++;
    }
    // Unbalanced parentheses: Leave the rest of the value untouched rather
    // than guessing where the call would have ended
    if (depth > 0) {
      result += value.slice(index);
      break;
    }

    const inner = value.slice(argsStart, cursor - 1);
    const args = splitTopLevelCommas(inner).map(sortMinMaxArguments);
    args.sort();
    result += `${name}(${args.join(',')})`;
    index = cursor;
  }

  return result;
}

// Legacy names current browsers treat as pure synonyms. Aggressive mode only:
// merging them changes the legacy-support surface.
const PROPERTY_ALIASES = {
  'word-wrap': 'overflow-wrap',
  'grid-gap': 'gap',
  'grid-row-gap': 'row-gap',
  'grid-column-gap': 'column-gap',
};

// Per run (see `src/caches.js`). One cache per mode rather than one keyed by
// mode plus name: building that composite key would allocate per lookup.
const propCacheDefault = new Map();
const propCacheAggressive = new Map();

export function resetPropertyCache() {
  propCacheDefault.clear();
  propCacheAggressive.clear();
}

export function normalizeProp(prop, aggressive = false) {
  const cache = aggressive ? propCacheAggressive : propCacheDefault;
  return memoized(cache, prop, computeNormalizeProp, aggressive);
}

function computeNormalizeProp(prop, aggressive) {
  const trimmed = prop.trim();
  // Custom property names are case-sensitive (`--Foo` !== `--foo`); every
  // other CSS property name is ASCII-case-insensitive
  if (trimmed.startsWith('--')) return trimmed;
  const lower = trimmed.toLowerCase();
  return aggressive ? PROPERTY_ALIASES[lower] ?? lower : lower;
}

// Value segments that must survive normalization untouched: quoted strings,
// `url()` paths, and custom property names. Masked behind placeholders before
// normalization and restored afterwards, so everything *around* them still
// normalizes like any other value text. The `url()` branch tries the quoted
// forms first—a quoted path may contain a `)` (`url("a)b.png")`) that the
// generic form would stop at, leaving the tail exposed.
const RE_OPAQUE_SEGMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^)\\])*)\s*\)|--[^\s,)]+/gi;

// U+E000 (private use) brackets the placeholder indices—a character with no
// meaning in CSS, so it can’t collide with real value text (and, unlike a
// control character, doesn’t trip `no-control-regex`)
const RE_OPAQUE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

export function normalizeValue(prop, rawValue, aggressive = false) {
  let value = rawValue.trim();
  const propNormalized = normalizeProp(prop, aggressive);

  // Custom property values are opaque end to end: they substitute verbatim
  // wherever `var()` references them, and their raw spelling survives into
  // `getComputedStyle().getPropertyValue()`. Even `--x: 0px` and `--x: 0`
  // differ—only one is a valid `z-index: var(--x)`—so only byte-identical
  // custom property values ever compare equal.
  if (propNormalized.startsWith('--')) return value;

  const opaques = [];
  value = value.replace(RE_OPAQUE_SEGMENT, segment => `\uE000${opaques.push(segment) - 1}\uE000`);

  value = value.replace(/\s+/g, ' ');
  if (!CASE_SENSITIVE_VALUE_PROPS.has(propNormalized)) value = value.toLowerCase();
  // Whitespace just inside parentheses and around commas is never
  // significant; space *before* an opening parenthesis is—in
  // `calc(1px + (2px))` the space after `+` is load-bearing
  value = value.replace(/([(,]) /g, '$1').replace(/ ([),])/g, '$1');
  // `/` is a pure separator wherever it appears in a value (`font`, `grid`
  // shorthands, `border-radius`, `aspect-ratio`), so spacing around it is
  // insignificant; a leading `+` sign on a number is a no-op
  value = value.replace(/ ?\/ ?/g, '/');
  value = value.replace(/(^|[\s(,])\+(?=[\d.])/g, '$1');
  if (!CASE_SENSITIVE_VALUE_PROPS.has(propNormalized)) value = normalizeColors(value, aggressive);
  // `bold`/`700` and `normal`/`400` are defined equal—only for the
  // longhand, though; picking the weight out of the `font` shorthand would
  // require parsing the value
  if (propNormalized === 'font-weight') {
    if (value === 'bold') value = '700';
    else if (value === 'normal') value = '400';
  }
  value = value.replace(RE_ZERO_LENGTH_UNIT, '0');
  if (!ZERO_PERCENT_SENSITIVE_PROPS.has(propNormalized)) value = value.replace(RE_ZERO_PERCENT, '0');
  value = normalizeTimeUnits(value);
  if (aggressive) value = normalizeAngleUnits(value);
  // Both unit conversions above emit freshly-scaled decimals (`0.3s` →
  // `300.0ms`), so the decimal cleanup runs after them—and the `min()`/`max()`
  // sort after that, so differently-spelled equal arguments sort alike
  value = normalizeDecimals(value);
  value = sortMinMaxArguments(value);
  value = reduceShorthandRepetition(propNormalized, value);

  value = value.replace(RE_OPAQUE_PLACEHOLDER, (_match, index) => opaques[index]);

  if (ZERO_IS_NONE_PROPS.has(propNormalized) && (value === '0' || value === 'none')) {
    value = 'none';
  }

  return value;
}

export function declarationKey(prop, value, important, aggressive = false) {
  return `${normalizeProp(prop, aggressive)}: ${normalizeValue(prop, value, aggressive)}${important ? ' !important' : ''}`;
}