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
    if (char === ')' || char === ']') depth--;

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