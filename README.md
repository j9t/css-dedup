# UDJO, the CSS Declaration De-Duplicator

[![npm version](https://img.shields.io/npm/v/udjo.svg)](https://www.npmjs.com/package/udjo) [![Build status](https://github.com/j9t/udjo/workflows/Tests/badge.svg)](https://github.com/j9t/udjo/actions) [![Socket](https://badge.socket.dev/npm/package/udjo)](https://socket.dev/npm/package/udjo) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/j9t/udjo?sponsor=1)

UDJO is a CSS maintainability and performance optimization tool that finds—and, when requested and where safe, consolidates—duplicate CSS declarations. It implements the technique of [“using declarations just once”](https://webglossary.info/terms/udjo/) as originally described in [“DRY CSS”](https://meiert.com/blog/dry-css/) (cf. [_CSS Optimization Basics_](https://meiert.com/blog/css-optimization-basics/)): the same normalized property–value pair shouldn’t appear in more than one rule within the same scope. Where it does, UDJO reports it—and can group the affected selectors into a single rule.

## Example Optimization

Given:

```css
.a {
  color: red;
  font-weight: bold;
}

.b {
  margin: 0;
}

.c {
  color: red;
}
```

```shell
$ npx udjo default.css
(root)
  duplicate   color: red
    .a (line 2)
    .c (line 11)

Summary: 1 finding
Run with `--dedup` to save 10 bytes (11.8%).
```

Running with `--dedup` folds `.a` and `.c` into a single rule for the shared declaration, and leaves everything else untouched:

```css
.a {
  font-weight: bold;
}

.b {
  margin: 0;
}

.a, .c {
  color: red;
}
```

```shell
$ npx udjo --dedup default.css
1 consolidated, 0 skipped

85 → 75 bytes (-10 B, -11.8%)
Wrote default.css
```

Since duplicate declarations cost bytes wherever they live—in the stylesheet itself, and (uncompressed) over the wire—the byte counts reflect two payoffs at once: less to maintain, and less to transfer.

The two aren’t always aligned, though: Folding a declaration into a shared selector list adds that list’s bytes back, so consolidating one that only has a couple of long, otherwise-unrelated selectors in common can end up costing more than it removes. UDJO’s two modes call this out, so it’s a call you can make consciously—it may be worth it if you value using declarations just once (maintainability), not if you’re optimizing purely for transfer size.

## Usage

### CLI Use

```shell
npx udjo [options] <file…>
```

Pass one or more files—each is analyzed (and, with `--dedup`, rewritten) independently; with more than one file, output is grouped under a header per file. A directory is searched recursively for .css files (skipping node_modules and dotfolders); the result is unrolled into that same per-file list, so mixing files and directories works too. Pass `-` instead of a file to read CSS from STDIN (can’t be combined with other file arguments); in `--dedup` mode this prints the consolidated CSS to STDOUT, rather than writing a file, so it composes in a pipeline—status/summary output moves to STDERR in that case, keeping STDOUT pure CSS.

| Option | Description |
| --- | --- |
| `--dedup`, `-d` | Consolidate declarations that are safe to merge automatically, rewriting each file in place (or printing to STDOUT for `-`) |
| `--ignore-selector <pattern>`, `-i` | Regular expression for selectors to exclude from analysis (repeatable) |
| `--no-ignore-selectors-defaults`, `-n` | Disable the built-in selector-hack ignore list |
| `--config <path>`, `-c <path>` | Path to a config file (defaults to `.udjo.js` in the working directory, if present) |
| `--help`, `-h` | Show usage information |

`--ignore-selector` is singular because it’s a repeatable flag—each occurrence (`-i pattern1 -i pattern2`) adds one pattern. The corresponding programmatic option, `ignoreSelectors`, takes an array.

Without `--dedup`, UDJO only reports. Report mode still runs the same safety checks `--dedup` would, though, so a finding that is considered unsafe to auto-merge (an intervening declaration on some other selector, say) is called out right there, alongside the byte estimate for whatever is safe—rather than the estimate silently going missing for that group. Exit code is `1` if it finds anything to report (or, with `--dedup`, anything skipped as unsafe) in any of the given files.

A file that fails to parse—invalid CSS, or a non-standard dialect PostCSS doesn’t accept—doesn’t stop the run: Its error is reported and UDJO moves on to the rest.

### Config File

For settings that should apply on every run—typically a project’s own `ignoreSelectors`—drop a `.udjo.js` in the working directory (or point `--config` at one elsewhere, under any name):

```javascript
// .udjo.js
export default {
  ignoreSelectors: [/^\.legacy-/],
  ignoreSelectorsDefaults: true
};
```

CLI flags layer on top of the config file rather than replacing it: `--ignore-selector` patterns are added to `ignoreSelectors` from the config, and `--no-ignore-selectors-defaults` always wins over `ignoreSelectorsDefaults: true` in the config.

### Programmatic Use

Install UDJO in your project, e.g., via `npm i -D udjo`, then import and use what you need:

```javascript
import { analyze, dedup } from 'udjo';

const { findings } = analyze(css);
const { css: output, applied, skipped } = dedup(css);
```

Both functions accept an options object:

```javascript
{
  from: 'path/to/file.css',         // used for source-map-style line numbers only
  ignoreSelectors: [/^\.legacy-/],  // additional selector patterns to exclude
  ignoreSelectorsDefaults: true,    // set to `false` to disable the built-in hack list
}
```

`analyze()` returns `{ findings }`, an array of objects:

```javascript
{
  scope,        // `root`, or the at-rule chain the rules live in, e.g. `@media (min-width: 768px)`
  key,          // normalized `prop: value` (plus ` !important` if set)
  redundant,    // “true” if the same declaration repeats within one rule, absent otherwise
  repeated,     // “true” if this flags a selector (list) written more than once in one scope;
                // `key` is then the selector list, and occurrences carry no `prop`/`value`
  occurrences,  // [{ selector, selectors, prop, value, line }, …]
}
```

`dedup()` returns `{ css, applied, skipped, bytes }`: `css` is the rewritten stylesheet; `applied` lists what it did—each entry has `redundant: true` if it just dropped a same-rule (or same-at-rule-block) duplicate, `folded: true` if it folded a rule repeating the same selector into a later one, absent if it folded selectors from separate rules into one; `skipped` lists duplicate groups (and blocked same-selector folds) it left untouched along with why; and `bytes` is `{ before, after, saved }`—UTF-8 byte counts of the stylesheet before and after, since that’s what changes over the wire, not the character count, covering everything `--dedup` did as one net figure. `saved` is `before - after`, so it’s negative on the rare file where the added selector-list text outweighs the removed declarations—dropping a same-rule duplicate never costs bytes, only folding selectors from separate rules can. `dedupRoot()` (the same function, operating on an already-parsed PostCSS root instead of a CSS string) returns the same shape minus `css`.

### PostCSS Plugin Use

For dropping UDJO into an existing PostCSS pipeline (alongside Autoprefixer, cssnano, etc.) instead of running it as a separate file-based pass, import the plugin from `udjo/plugin`:

```javascript
import postcss from 'postcss';
import udjo from 'udjo/plugin';

// Report mode: Duplicate/redundant declarations surface as PostCSS warnings
const result = await postcss([udjo()]).process(css, { from: 'default.css' });
console.log(result.warnings());

// Dedup mode: Rewrites the root in place; skipped merges still surface as warnings
const fixed = await postcss([udjo({ dedup: true })]).process(css, { from: 'default.css' });
console.log(fixed.css);
```

The plugin takes the same options as `analyze()`/`dedup()`, plus `dedup: true` to switch it into consolidation mode. Since UDJO is a source-hygiene tool—more like `stylelint --fix` than a bundle optimizer—it belongs early in a pipeline, on hand-authored CSS, before Autoprefixer and before minification; running it after either may duplicate work those tools do.

## How It Works

UDJO:

1. …**parses** the CSS with [PostCSS](https://postcss.org/).

2. …**scopes** rules by their DRY boundary—the root stylesheet, the contents of an `@media`/`@supports`/`@layer` condition, or one specific nested rule (native CSS nesting).
   - Declarations are only ever compared within the same scope: A rule’s own declarations are never compared against those of rules nested inside it, and rules in different `@layer`s (or different `@media`/`@supports` conditions) can’t share a merged rule.
   - For _reporting_, two blocks with the _same_ condition are the same scope even when written separately in the source (e.g., two `@media (min-width: 768px) {}` blocks in different parts of the file)—matching is whitespace-insensitive but case-sensitive, since `@layer` names and selectors can be case-significant.
   - `--dedup` is more conservative here: It only ever folds rules that already live in the same physical block, since merging across two separate blocks would relocate a declaration past whatever sits between those blocks in the source—including rules in an entirely different scope, which the merge-safety check (step 6) has no visibility into. A duplicate split across two same-condition blocks is therefore reported, not auto-merged.
   - Statement-form at-rules with no block (`@layer reset, base;`) are skipped.

3. …**excludes** selectors matching a hack pattern (vendor-prefixed pseudo-classes/elements, legacy IE selector hacks) from analysis by default—grouping those into a shared selector list risks the whole rule being dropped by browsers that don’t recognize the selector.

4. …**normalizes** each remaining declaration for comparison.
   - Skips the contents of quoted strings, `url()`, and custom property _names_ throughout—those are case-sensitive, so `var(--Foo)`/`var(--foo)` and `--Foo`/`--foo` are never treated as equal. Everything around such a protected segment still normalizes, though: `VAR( --brand )` matches `var(--brand)`, and `var(--m, 0px)` matches `var(--m,0)`.
   - Compares custom property *values* verbatim (`--brand: #FFF` and `--brand: #fff` don’t match)—they’re substituted as-is wherever `var()` references them—possibly somewhere case-sensitive—and scripts can read them back via `getPropertyValue()`, so no two spellings are provably interchangeable (even `--x: 0px` and `--x: 0` differ—only one is a valid `z-index: var(--x)`).
   - Collapses whitespace, including just inside parentheses and around commas (`rgb( 255, 0, 0 )` matches `rgb(255,0,0)`), and folds value case—except for properties whose value is (or can contain) an author-defined custom ident (`animation-name`, `counter-reset`, `container-name`, and similar), since those are case-*sensitive* per CSS, unlike the predefined keywords everywhere else; `animation-name: Foo` and `animation-name: foo` can name two different `@keyframes` blocks, so folding them would risk a false duplicate.
   - Collapses zero-value length units (`0px`/`0svh`/`0cqw` → `0`)—angle/time/frequency/resolution units like `0deg`/`0s` are left alone, since unitless zero isn’t valid there. Zero percentages (`0%`) are collapsed to `0`, too, except for a short list of properties where a percentage can resolve against an indefinite reference size.
   - Collapses redundant decimal zeros (`.5`/`0.5`/`0.50` → `.5`, `1.0` → `1`), drops a redundant leading `+` sign (`+2px` → `2px`), and ignores whitespace around `/` separators (`12px/1.5` matches `12px / 1.5`).
   - Canonicalizes equivalent color spellings: `white`, `#fff`, `#ffffff`, `#ffffffff`, `rgb(255, 255, 255)`, and `rgb(255 255 255)` all compare equal, as do `transparent` and `rgba(0, 0, 0, 0)`. Only lossless textual equivalences count—`hsl()` and percentage channels involve rounding, so they’re left alone.
   - Treats `font-weight: bold`/`700` and `normal`/`400` as equivalent (the longhand only—picking the weight out of the `font` shorthand would require parsing the value).
   - Collapses repeated shorthand values, following the omission rules in reverse: `margin: 0 0` matches `margin: 0`, `padding: 1px 2px 1px 2px` matches `1px 2px`, `border-radius: 1px/1px` matches `1px`, and two-value pairs like `gap`/`overflow`/`place-items` collapse the same way.
   - Treats the `border`/`outline` `none` and `0` values as equivalent.

5. …**reports** any normalized declaration that occurs in more than one rule within a scope, and separately flags declarations repeated within a single rule—including within a selector-less at-rule block like `@font-face` or `@page`, which have declarations of their own but, unlike two rules, are never compared against each other (there’s no selector list to fold two `@font-face` blocks into). It also reports a selector (list) written more than once within one scope—the same smell one level up from a repeated declaration—matched as a set, so `.a, .b` and `.b, .a` count as the same selector list; only within one physical block, though, since two same-condition `@media` blocks repeat their selectors by construction.

6. …**consolidates** (with `--dedup`) only when it’s provably safe.
   - First, a declaration repeated within the same rule (or the same selector-less at-rule block) is collapsed to its last occurrence—unconditionally safe, since nothing moves across a rule boundary, so none of the checks below apply to it.
   - Rules repeating the same selector (list) within one scope are folded into the last of them, earlier declarations first—which preserves every same-selector cascade outcome—but only if nothing in between touches any of the moved properties (the same intervening-rule check the declaration merges below use). Rules holding anything but declarations (nested rules, say) stay put.
   - Identical rules—two or more rules whose declarations are exactly the same set of shared declarations—are folded into one rule with the combined selector list, rather than being split per declaration, provided their declaration order agrees wherever the properties overlap (and the usual intervening-rule check clears).
   - Entangled duplicate groups (groups sharing rules) that fit no coordinated shape aren’t simply abandoned: Each group’s safe stretches of occurrences still consolidate individually, into a fresh rule placed at the stretch’s end. No shared rule’s selector is ever rewritten, so nothing leaks between the groups, and a member whose own later declarations overlap the shared property sits the merge out (relocating the declaration past its own tail would flip which one wins).
   - Then, a duplicate group spread across separate rules is merged by folding its selectors into the last occurrence—one line per selector if that’s already how the file writes multi-selector rules, comma-separated on one line otherwise.
   - Keeps whichever of the group’s equivalent raw spellings is shortest (e.g. `.5` over `0.50`)—UDJO only picks among spellings already present in the source, so it doesn’t synthesize a shorter one, which would be a minifier’s job.
   - Removes the declaration from the other occurrences—but only if no other rule between the first and last occurrence also sets that property or a shorthand/longhand overlapping it (`margin` and `margin-left`, `border-color` and `border-top-color`, etc.), for any selector.
   - One narrow exception to “any other rule”: If that rule’s selector is provably mutually exclusive with the group’s—right now, that only covers an exact-match attribute value on the same attribute, on what is provably the same element (`html[lang="da"] a` vs. `html[lang="de"] a`, since an attribute can only ever hold one value and `html` is unique per document)—it can’t actually match the same element, so it’s not a threat to this particular merge and doesn’t block it. “Provably the same element” means the differing attribute sits on the selector’s subject, is connected to it purely through `>`/`+` combinators, or sits on `html`/`:root`; across a descendant or `~` combinator, `.x[data-v="1"] p` and `.x[data-v="2"] p` can match the very same `p` (nested `.x` wrappers), so those don’t count as exclusive.
   - If a merged rule (including the last occurrence itself) also carries a declaration for an overlapping property, that declaration is split out into its own small rule—keeping that occurrence’s own, original selector—placed right after the merged rule, rather than blocking the merge outright: Folding every selector onto one shared declaration block would otherwise hand that overlapping extra to selectors that never had it. Exception: If that extra is itself duplicated elsewhere in the same scope, it’s left alone and the whole merge is skipped instead, since splitting it here would orphan that other duplicate’s own merge.
   - If something does block it, the merge is skipped and reported rather than risking a cascade change. A blocker fences, though—it doesn’t forbid: Occurrences on the same side of it still consolidate among themselves (their own spans are clean, so the same safety argument applies), and the group is reported as skipped either way, since the duplicate keeps existing across the blocker.
   - Consolidation runs to a fixed point: One merge can unblock or create another (a fresh merged rule may repeat an existing rule’s selector list, an emptied rule stops fencing a span), so the passes repeat until nothing changes.

Overall, UDJO is conservative by design and will leave some safe merges for manual review.

`test/fixtures/*.css` contains small example stylesheets that exercise each of these behaviors, including nesting (`nesting.css`) and `@layer` (`layers.css`)—run `node bin/udjo.js test/fixtures/<file>.css` (add `--dedup` for `merge-safety.css`) to see them in action.

***

You might like some of my other work:

* Optimization tools: [hihtml](https://github.com/j9t/hihtml) · [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · UDJO · [Image Guard](https://github.com/j9t/image-guard) · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · [.htaccess Punk](https://github.com/j9t/htaccess-punk)
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)