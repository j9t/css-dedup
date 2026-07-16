import { normalizeColors } from './colors.js';

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

// Properties whose value can contain an author-defined custom ident—
// `@keyframes`/counter/container names, etc.—which are ASCII case-sensitive
// per the CSS custom-ident grammar, unlike ordinary keywords elsewhere
// (which fold safely). `animation-name: Foo` and `animation-name: foo` can
// name two different `@keyframes` blocks, so lowercasing them risks a false
// duplicate—or, in `--fix` mode, an unsafe merge that changes which
// animation plays. Shorthands mixing such an ident with case-insensitive
// keywords (`animation`, `container`) are included whole, since there’s no
// reliable way to fold just the keyword part without parsing the value;
// likewise `content` (a `counter()` argument names a case-sensitive counter)
// and the grid properties (line names are idents too). Not exhaustive—
// extend as needed.
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

// Shorthands whose 2/3/4-value forms repeat earlier values when trailing
// ones are omitted—`margin: 0 0` says exactly what `margin: 0` says. The
// quad set follows the top/right/bottom/left expansion; the pair set covers
// two-value properties whose second value defaults to the first (`gap`,
// `overflow`, `place-items`, …). `border-radius` is handled separately,
// since its horizontal and vertical radii sit on either side of a `/`.
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

// Splits a value on top-level spaces only—a space inside `calc(1px + 2px)`
// separates operands, not value components
function splitValueTokens(value) {
  const tokens = [];
  let depth = 0;
  let current = '';

  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);

    if (char === ' ' && depth === 0) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);

  return tokens;
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

// Multiplies a decimal string by `numerator / 10**denominatorPow10`,
// exactly—used below for unit conversions whose ratio is rational (time:
// ×1000/1; angle `turn`: ×360/1; angle `grad`: ×9/10). `Number(text) * ratio`
// can’t be trusted here: `1.005 * 1000` is `1004.9999999999999` in IEEE 754,
// which would make two textually exact-equal times compare unequal. Doing
// the multiplication on the digit string via `BigInt`, then relocating the
// decimal point, is exact for any finite decimal—`denominatorPow10` only
// ever divides by a power of ten, so that step is point relocation, not
// true division. Matches a result of all zeros (`0`, `0.0`, …)—used below to
// drop a negative sign `scaleDecimalExact` would otherwise carry over from a
// negative-zero input (`-0`, `-0.0`).
const RE_ALL_ZERO = /^0\.?0*$/;

function scaleDecimalExact(text, numerator, denominatorPow10 = 0) {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const scaled = (BigInt((intPart || '0') + fracPart || '0') * BigInt(numerator)).toString();
  const decimalPlaces = fracPart.length + denominatorPow10;
  const padded = scaled.padStart(decimalPlaces + 1, '0');
  const pointIndex = padded.length - decimalPlaces;
  const result = decimalPlaces > 0 ? `${padded.slice(0, pointIndex)}.${padded.slice(pointIndex)}` : padded;
  return (negative && !RE_ALL_ZERO.test(result) ? '-' : '') + result;
}

// A number token must not be preceded by an identifier character, either—
// without this, `RE_TIME`/`RE_ANGLE` below would match `2s` inside a
// case-sensitive custom ident like `animation-name: fade2s` (a real
// `@keyframes` name) and silently rewrite it to `fade2000ms`, corrupting
// the identifier and risking a false duplicate (or, in `--fix`, an unsafe
// merge) against an unrelated animation that happens to share the
// resulting spelling
const RE_NUMBER = '(?<![\\w-])(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))';

// Canonicalizes time values to milliseconds for comparison: `1s` and
// `1000ms` are exactly interchangeable per the CSS `<time>` grammar, and
// converting `s` to `ms` is only ever a decimal-point shift—never lossy—so
// this runs unconditionally, the same way zero-value units do. Matches
// regardless of surrounding property (including inside the `transition`/
// `animation` shorthand, alongside a case-sensitive `animation-name`)—see
// `RE_NUMBER`’s left-boundary check for why this can’t collide with an
// actual identifier.
const RE_TIME = new RegExp(`${RE_NUMBER}(ms|s)\\b`, 'gi');

function normalizeTimeUnits(value) {
  return value.replace(RE_TIME, (match, number, unit) => {
    if (unit.toLowerCase() === 'ms') return match;
    return `${scaleDecimalExact(number, 1000)}ms`;
  });
}

// Canonicalizes angle values to degrees for comparison—`aggressive` mode
// only. `grad` → `deg` (×9/10) and `turn` → `deg` (×360) are exact rational
// conversions, but `rad` → `deg` (×180/π) involves an irrational factor: Any
// non-zero `rad` value becomes a non-terminating decimal in degrees, so
// that one conversion is rounded. Rather than split the feature by
// per-unit exactness, the whole thing is gated behind `aggressive`, the
// same “probably, not provably, safe” treatment the `hsl()` color
// equivalence elsewhere gets.
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

// Splits a value on top-level commas only—reused below by the `min()`/
// `max()` argument sorter; a comma inside a nested call used as an
// argument (`min(calc(1px, 2px), 3px)`) doesn’t separate top-level ones
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';

  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts;
}

// A character CSS identifiers (including function names) can continue
// with—used below to require a real token boundary before `min(`/`max(`,
// so a hypothetical custom ident merely ending in those letters is never
// mistaken for the function (a plain `\b` wouldn’t reject a hyphenated one)
const RE_IDENT_CHAR = /[\w-]/;

// Tested once per scanned character in `sortMinMaxArguments()` below—hoisted
// so the loop doesn’t recompile the same literal on every iteration
const RE_MIN_MAX_START = /^(min|max)\(/i;

// Sorts a top-level `min()`/`max()` call’s comma-separated arguments
// canonically—mathematical min/max is commutative, so argument order
// carries no meaning (`min(100%, 500px)` ≡ `min(500px, 100%)`). `clamp()`
// is deliberately left alone: its three arguments are positional (minimum,
// preferred, maximum), and reordering them changes what it computes.
// `minmax()` (grid track sizing—also positional) is never matched, since
// the scan looks for the function name immediately followed by `(`,
// and “minmax(” doesn’t contain “min(” or “max(” as a prefix.
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

// Property aliases—legacy names current browsers treat as pure synonyms of
// their standardized successors. Only folded in aggressive mode: The two
// spellings are interchangeable today, but merging them changes the
// legacy-support surface (a browser old enough to know only `word-wrap`
// loses the declaration when the `overflow-wrap` spelling is the one kept).
const PROPERTY_ALIASES = {
  'word-wrap': 'overflow-wrap',
  'grid-gap': 'gap',
  'grid-row-gap': 'row-gap',
  'grid-column-gap': 'column-gap',
};

export function normalizeProp(prop, aggressive = false) {
  const trimmed = prop.trim();
  // Custom property names are case-sensitive (`--Foo` !== `--foo`); every
  // other CSS property name is ASCII-case-insensitive
  if (trimmed.startsWith('--')) return trimmed;
  const lower = trimmed.toLowerCase();
  return aggressive ? PROPERTY_ALIASES[lower] ?? lower : lower;
}

// Value segments that must survive normalization untouched: Quoted strings
// (`content` text, quoted font/path names), `url()` (paths are
// case-sensitive, and a `2.0`-looking substring in a file name isn’t a
// number to collapse), and custom property names (`--Foo` !== `--foo`, both
// inside `var()` and standalone, as in `transition-property: --fade`).
// These are masked behind placeholders before `normalizeValue()` runs, and
// restored afterwards—so everything *around* them (the `var(`/`VAR(`
// function name, a fallback value, the rest of the value) still normalizes
// like any other value text. The `url()` branch tries the quoted forms
// first, since a quoted path may legitimately contain a closing parenthesis
// (`url("a)b.png")`)—the generic form would otherwise stop at that `)` and
// leave the path’s tail exposed to normalization.
const RE_OPAQUE_SEGMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^)\\])*)\s*\)|--[^\s,)]+/gi;

// U+E000 (private use) brackets the placeholder indices—a character with no
// meaning in CSS, so it can’t collide with real value text (and, unlike a
// control character, doesn’t trip `no-control-regex`)
const RE_OPAQUE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

export function normalizeValue(prop, rawValue, aggressive = false) {
  let value = rawValue.trim();
  const propNormalized = normalizeProp(prop, aggressive);

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
  // Both unit conversions above produce their own freshly-scaled decimal
  // text (e.g., `0.3s` → `300.0ms`), so the general decimal cleanup runs
  // after them, not before—and the `min()`/`max()` sort runs after that,
  // so two arguments that are the same value in different raw spellings
  // (`.5`/`0.50`) already compare equal as sort keys
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