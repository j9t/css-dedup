// Splits a selector list on top-level commas only, respecting commas nested
// inside `:is(a, b)`, `[attr="a,b"]`, and similar constructs.
export function splitSelectors(selectorList) {
  const selectors = [];
  let depth = 0;
  let quote = null;
  let current = '';

  for (const char of selectorList) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[') depth++;
    // Clamped at “0” rather than allowed to go negative—an unmatched closing
    // bracket in malformed input would otherwise make depth negative, and a
    // later, genuinely top-level comma would then be misread as nested
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      selectors.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) selectors.push(current.trim());

  return selectors;
}