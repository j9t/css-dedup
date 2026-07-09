const ZERO_UNIT_RE = /\b0(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|fr|%)\b/gi;

// Shorthand properties where a bare `0` and `none` render identically, because
// the initial value of e.g. `border-style` is `none`—so `border: 0` implies
// `border-style: none` just as `border: none` does.
const ZERO_IS_NONE_PROPS = new Set([
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'outline',
]);

export function normalizeProp(prop) {
  return prop.trim().toLowerCase();
}

export function normalizeValue(prop, rawValue) {
  let value = rawValue.trim().replace(/\s+/g, ' ');

  // Case-fold values, but leave string literals and `url()` contents alone—
  // those can be case-sensitive (paths, `content` strings, custom idents).
  const hasLiteral = /["']|url\(/i.test(value);
  if (!hasLiteral) value = value.toLowerCase();

  value = value.replace(ZERO_UNIT_RE, '0');

  if (ZERO_IS_NONE_PROPS.has(normalizeProp(prop)) && (value === '0' || value === 'none')) {
    value = 'none';
  }

  return value;
}

export function declarationKey(prop, value, important) {
  return `${normalizeProp(prop)}: ${normalizeValue(prop, value)}${important ? ' !important' : ''}`;
}