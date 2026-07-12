// Splits a selector list on top-level commas only, respecting commas nested
// inside `:is(a, b)`, `[attr="a,b"]`, and similar constructs
export function splitSelectors(selectorList) {
  const selectors = [];
  let depth = 0;
  let quote = null;
  let escaped = false;
  let current = '';

  for (const char of selectorList) {
    // A backslash-escaped character is content, never syntax—`\"` doesn’t
    // close a quote, `\,` doesn’t separate selectors
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

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

// Matches one `[attr]`, `[attr=value]`, `[attr~=value]`, `[attr|=value]`,
// `[attr^=value]`, `[attr$=value]`, or `[attr*=value]`, quoted or not, with
// an optional `i`/`s` case-sensitivity flag—used to find every
// attribute-selector component in a selector string, wherever it appears
// (including nested inside `:is()`/`:not()`)
const RE_ATTRIBUTE_SELECTOR = /\[\s*([a-zA-Z_-][\w-]*)\s*(?:([~|^$*]?=)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^\s\]\\])+))\s*([iIsS])?\s*)?\]/g;

// Resolves CSS character escapes (`\61` → `a`, `\"` → `"`; one whitespace
// character after a hex escape is part of the escape) so two spellings of
// the same attribute value compare equal—and, more importantly, are never
// treated as different values, which would wrongly prove two selectors
// mutually exclusive
const RE_CSS_ESCAPE = /\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\(.)/gi;

function unescapeCssValue(value) {
  return value.replace(RE_CSS_ESCAPE, (_match, hex, char) => {
    if (char !== undefined) return char;
    const codePoint = parseInt(hex, 16);
    return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
  });
}

// Replaces every attribute selector in `selector` with a placeholder (so two
// selectors that are otherwise identical compare equal as “skeletons”), and
// separately returns each one’s parts in order
function parseAttributeSelectors(selector) {
  const matches = [];
  let skeleton = '';
  let sliceStart = 0;

  for (const match of selector.matchAll(RE_ATTRIBUTE_SELECTOR)) {
    skeleton += selector.slice(sliceStart, match.index) + ' ';
    sliceStart = match.index + match[0].length;

    const [, attr, operator = null, doubleQuoted, singleQuoted, unquoted, flag = null] = match;
    const rawValue = doubleQuoted ?? singleQuoted ?? unquoted ?? null;
    matches.push({
      // Kept verbatim—attribute names are case-sensitive in XML/SVG
      // documents, so `[Foo]` and `[foo]` can be two different attributes
      attr,
      operator,
      value: rawValue === null ? null : unescapeCssValue(rawValue),
      flag: flag ? flag.toLowerCase() : null,
      index: match.index,
      length: match[0].length,
    });
  }
  skeleton += selector.slice(sliceStart);

  return { skeleton, matches };
}

// Walks a selector once, recording the parenthesis depth at each index and
// every top-level combinator run—whitespace, `>`, `+`, or `~` outside
// brackets, parentheses, and quotes. A run mixing whitespace with a symbol
// (` > `) is one combinator of that symbol’s type.
function scanSelector(selector) {
  const combinatorRuns = [];
  const parenDepths = [];
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;
  let escaped = false;
  let run = null;

  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    parenDepths[index] = depthParen;

    // An escaped character is content, never syntax (see `splitSelectors()`)
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; run = null; continue; }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'') { quote = char; run = null; continue; }
    if (char === '(') { depthParen++; run = null; continue; }
    if (char === ')') { depthParen = Math.max(0, depthParen - 1); run = null; continue; }
    if (char === '[') { depthBracket++; run = null; continue; }
    if (char === ']') { depthBracket = Math.max(0, depthBracket - 1); run = null; continue; }

    if (depthParen === 0 && depthBracket === 0 && /[\s>+~]/.test(char)) {
      if (!run) {
        run = { start: index, end: index, type: ' ' };
        combinatorRuns.push(run);
      }
      run.end = index + 1;
      if (!/\s/.test(char)) run.type = char;
      continue;
    }

    run = null;
  }

  return { combinatorRuns, parenDepths };
}

// A type selector at the start of a compound (`div`, `input`—never `*`)
const RE_TYPE_SELECTOR = /^[a-zA-Z][\w-]*/;

// The identity tokens—type, IDs, classes—of a selector’s subject compound
// (its rightmost one). Returns “null” when the compound can’t be read
// confidently: An escape could hide a `.`/`#` behind content, and a
// selector-taking pseudo-class (`:is()`, `:not()`, `:where()`, …) can smuggle
// in arbitrary further identity—both fall back to “can’t tell” rather than
// risk a wrong disjointness call.
//
// Memoized, and scoped to one consolidation run (see
// `resetSubjectIdentities()`): The merge-safety scan asks about the same
// selectors over and over within a run, but a long-lived process (a PostCSS
// watch build, say) must not accumulate every selector—think generated or
// hashed class names—it has ever seen.
const subjectIdentities = new Map();

// Called at the start of each top-level `dedupRoot()` run—the only flow that
// reaches `subjectIdentity()`
export function resetSubjectIdentities() {
  subjectIdentities.clear();
}

function subjectIdentity(selector) {
  if (subjectIdentities.has(selector)) return subjectIdentities.get(selector);

  const identity = computeSubjectIdentity(selector);
  subjectIdentities.set(selector, identity);
  return identity;
}

function computeSubjectIdentity(selector) {
  const scan = scanSelector(selector);
  const lastRun = scan.combinatorRuns.at(-1);
  const compound = selector.slice(lastRun ? lastRun.end : 0);

  // `|` marks a namespace (`svg|rect`, `[xlink|href=…]`)—neither the type
  // regex nor the attribute-selector regex understands those, so reading on
  // would fabricate identity (`svg|rect` as type `svg`, an attribute value’s
  // `.zzz` as a class); like escapes and parens, that’s a “can’t tell”
  if (compound.includes('\\') || compound.includes('(') || compound.includes('|')) return null;

  // Attribute selectors go first—their values can contain `.`/`#` characters
  // that would otherwise read as classes/IDs
  const stripped = compound.replace(RE_ATTRIBUTE_SELECTOR, ' ');
  const type = RE_TYPE_SELECTOR.exec(compound)?.[0].toLowerCase() ?? null;
  const classes = new Set(Array.from(stripped.matchAll(/\.([\w-]+)/g), match => match[1]));
  const ids = new Set(Array.from(stripped.matchAll(/#([\w-]+)/g), match => match[1]));

  return { type, classes, ids };
}

// No allocation—this runs per selector pair on the aggressive merge-safety
// hot path; iterating the smaller set keeps the lookups on the cheap side
function setsDisjoint(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const member of small) {
    if (large.has(member)) return false;
  }
  return true;
}

// “True” if the two selectors’ subject compounds carry conflicting identity:
// different type selectors, different IDs, or non-empty class sets with no
// class in common. The type and ID cases are close to provable (one element
// has one tag and one ID); The class case is the aggressive-mode heuristic—
// `.card` and `.btn:hover` are assumed to target different elements, which
// BEM-style naming makes almost always true in practice, but which nothing
// stops a `class="card btn"` element from violating. Not consulted outside
// aggressive mode.
export function selectorsLikelyDisjoint(a, b) {
  const identityA = subjectIdentity(a.trim());
  const identityB = subjectIdentity(b.trim());
  if (!identityA || !identityB) return false;

  if (identityA.type && identityB.type && identityA.type !== identityB.type) return true;
  if (identityA.ids.size && identityB.ids.size && setsDisjoint(identityA.ids, identityB.ids)) return true;
  if (identityA.classes.size && identityB.classes.size && setsDisjoint(identityA.classes, identityB.classes)) return true;

  return false;
}

// The “an attribute can only hold one value” argument requires the two
// differing attribute selectors to be evaluated against the same element in
// any hypothetical joint match. That’s only guaranteed when the attribute’s
// compound binds deterministically relative to the subject—the compound is
// the subject, or every combinator between it and the subject is `>` (one
// parent) or `+` (one preceding sibling)—or when the compound can only ever
// match one element per document (`html`, `:root`). A descendant or `~`
// combinator to its right binds existentially instead: In
// `.x[data-v="1"] p` vs. `.x[data-v="2"] p`, a `p` nested inside two `.x`
// wrappers with different values matches both selectors, so those aren’t
// exclusive, however different the attribute values are.
function attributeBindsSameElement(selector, scan, match) {
  // Inside `:is()`/`:not()`/etc., none of the reasoning below applies
  if (scan.parenDepths[match.index] > 0) return false;

  const matchEnd = match.index + match.length;
  const runsAfter = scan.combinatorRuns.filter(run => run.start >= matchEnd);
  if (runsAfter.every(run => run.type === '>' || run.type === '+')) return true;

  const runsBefore = scan.combinatorRuns.filter(run => run.end <= match.index);
  const compoundStart = runsBefore.length ? runsBefore.at(-1).end : 0;
  const compoundPrefix = selector.slice(compoundStart, match.index);
  return /^(?:html|:root)(?![\w-])/i.test(compoundPrefix);
}

// “True” if no element can ever match both selectors—checked narrowly, for
// exactly one shape: The two selectors are identical except that at least
// one exact-match attribute selector (`[attr=value]`, never `~=`/`|=`/`^=`/
// `$=`/`*=`, since those allow overlap—`class="da de"` matches both
// `[class~="da"]` and `[class~="de"]`) constrains the same attribute to two
// different values on what is provably the same element (see
// `attributeBindsSameElement()` above). An attribute can only ever hold one
// value, so `html[lang="da"] a` and `html[lang="de"] a` can never match the
// same element—`html` is unique per document. Without that same-element
// guarantee, the value difference proves nothing: `.x[data-v="1"] p` and
// `.x[data-v="2"] p` both match a `p` nested inside two differently-valued
// `.x` wrappers.
//
// Deliberately narrow: every other difference between the two selectors—a
// different attribute name, operator, case-sensitivity flag, or values that
// differ only in case—falls back to “can’t prove it,” not “assume
// exclusive.” A false negative here just leaves a safe merge for manual
// review, same as the rest of CSS Dedup’s merge-safety checks; a false positive
// would let a merge change the cascade.
export function selectorsAreMutuallyExclusive(a, b) {
  const selectorA = a.trim();
  const selectorB = b.trim();
  const parsedA = parseAttributeSelectors(selectorA);
  const parsedB = parseAttributeSelectors(selectorB);

  if (parsedA.skeleton !== parsedB.skeleton) return false;
  if (parsedA.matches.length !== parsedB.matches.length) return false;

  const scanA = scanSelector(selectorA);
  const scanB = scanSelector(selectorB);
  let foundDifference = false;

  for (const [index, matchA] of parsedA.matches.entries()) {
    const matchB = parsedB.matches[index];

    if (matchA.attr !== matchB.attr) return false;
    if (matchA.operator !== matchB.operator) return false;
    if (matchA.flag !== matchB.flag) return false;
    if (matchA.value === matchB.value) continue;

    if (matchA.operator !== '=' || matchA.value === null || matchB.value === null) return false;
    if (matchA.value.toLowerCase() === matchB.value.toLowerCase()) return false;
    // The differing values only prove anything if both selectors would have
    // to find them on the same element (see `attributeBindsSameElement()`)
    if (!attributeBindsSameElement(selectorA, scanA, matchA)) return false;
    if (!attributeBindsSameElement(selectorB, scanB, matchB)) return false;

    foundDifference = true;
  }

  return foundDifference;
}