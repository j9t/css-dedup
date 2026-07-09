// Length/percentage/fr units only—unitless zero isn’t valid for angle, time,
// frequency, or resolution units (`0deg`, `0s`, …), so those are left alone
const ZERO_UNIT_RE = /\b0(?:px|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|vw|svw|lvw|dvw|vh|svh|lvh|dvh|vi|svi|lvi|dvi|vb|svb|lvb|dvb|vmin|svmin|lvmin|dvmin|vmax|svmax|lvmax|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|in|pt|pc|q|fr|%)\b/gi;

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

export function normalizeProp(prop) {
  return prop.trim().toLowerCase();
}

export function normalizeValue(prop, rawValue) {
  let value = rawValue.trim().replace(/\s+/g, ' ');

  // Leave string literals and `url()` contents alone for every step below—
  // those can be case-sensitive (paths, `content` strings, custom idents),
  // and a stray `0.5`-looking substring in a URL isn’t a number to collapse
  const hasLiteral = /["']|url\(/i.test(value);
  if (!hasLiteral) {
    value = value.toLowerCase();
    value = value.replace(ZERO_UNIT_RE, '0');
    value = normalizeDecimals(value);
  }

  if (ZERO_IS_NONE_PROPS.has(normalizeProp(prop)) && (value === '0' || value === 'none')) {
    value = 'none';
  }

  return value;
}

export function declarationKey(prop, value, important) {
  return `${normalizeProp(prop)}: ${normalizeValue(prop, value)}${important ? ' !important' : ''}`;
}