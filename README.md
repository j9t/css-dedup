# UDJO, the CSS Declaration De-Duplicator (Beta)

UDJO is a CSS performance optimization tool that finds—and, where it’s safe, consolidates—duplicate CSS declarations. It implements the technique of [“using declarations just once”](https://webglossary.info/terms/udjo/) as originally described in [“DRY CSS”](https://meiert.com/blog/dry-css/) (cf. [_CSS Optimization Basics_](https://meiert.com/blog/css-optimization-basics/)): the same normalized property–value pair shouldn’t appear in more than one rule within the same scope. Where it does, UDJO reports it—and can group the affected selectors into a single rule.

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
$ npx udjo styles.css
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
$ npx udjo --dedup styles.css
1 consolidated, 0 skipped (unsafe to auto-merge)

85 → 75 bytes (-10 B, -11.8%)
Wrote styles.css
```

Since duplicate declarations cost bytes wherever they live—in the stylesheet itself, and (uncompressed) over the wire—the byte counts reflect UDJO’s two payoffs at once: less to maintain, and less to transfer.

The two aren’t always aligned, though: folding a declaration into a shared selector list adds that list’s bytes back, so consolidating one that only has a couple of long, otherwise-unrelated selectors in common can end up costing more than it removes. Both modes call this out, so it’s a call you can make consciously—it may be worth it if you value using declarations just once (maintainability), not if you’re optimizing purely for transfer size.

## Usage

### CLI Use

```shell
npx udjo [options] <file>
```

| Option | Short | Description |
|---|---|---|
| `--dedup` | `-d` | Consolidate declarations that are safe to merge automatically, rewriting the file in place |
| `--ignore-selector <pattern>` | `-i` | Regular expression for selectors to exclude from analysis (repeatable) |
| `--no-ignore-selectors-defaults` | `-n` | Disable the built-in selector-hack ignore list |
| `--help` | `-h` | Show usage information |

`--ignore-selector` is singular because it's a repeatable flag—each occurrence (`-i pattern1 -i pattern2`) adds one pattern—rather than one flag taking a comma-separated list, matching the convention ESLint uses for its own `--ignore-pattern`. The corresponding programmatic option, `ignoreSelectors`, is plural because there it's genuinely an array.

Without `--dedup`, UDJO only reports; it never writes to the file. Exit code is `1` if it finds anything to report.

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
  from: 'path/to/file.css',        // used for source-map-style line numbers only
  ignoreSelectors: [/^\.legacy-/], // additional selector patterns to exclude
  ignoreSelectorsDefaults: true,    // set to `false` to disable the built-in hack list
}
```

`analyze()` returns `{ findings }`, an array of objects:

```javascript
{
  scope,        // 'root', or the at-rule chain the rules live in, e.g. '@media (min-width: 768px)'
  key,          // normalized `prop: value` (plus ` !important` if set)
  redundant,    // true if the same declaration repeats within one rule, absent otherwise
  occurrences,  // [{ selector, selectors, prop, value, line }, ...]
}
```

`dedup()` returns `{ css, applied, skipped, bytes }`: `css` is the rewritten stylesheet, `applied` lists the merges it made, `skipped` lists duplicate groups it left untouched along with why, and `bytes` is `{ before, after, saved }`—UTF-8 byte counts of the stylesheet before and after, since that’s what changes over the wire, not the character count. `saved` is `before - after`, so it’s negative on the rare file where the added selector-list text outweighs the removed declarations. `dedupRoot()` (the same function, operating on an already-parsed PostCSS root instead of a CSS string) returns the same shape minus `css`.

### PostCSS Plugin Use

For dropping UDJO into an existing PostCSS pipeline (alongside Autoprefixer, cssnano, etc.) instead of running it as a separate file-based pass, import the plugin from `udjo/plugin`:

```javascript
import postcss from 'postcss';
import udjo from 'udjo/plugin';

// Report mode: duplicate/redundant declarations surface as PostCSS warnings
const result = await postcss([udjo()]).process(css, { from: 'styles.css' });
console.log(result.warnings());

// Dedup mode: rewrites the root in place; skipped merges still surface as warnings
const fixed = await postcss([udjo({ dedup: true })]).process(css, { from: 'styles.css' });
console.log(fixed.css);
```

The plugin takes the same options as `analyze()`/`dedup()`, plus `dedup: true` to switch it into consolidation mode. Since UDJO is a source-hygiene tool—more like `stylelint --fix` than a bundle optimizer—it belongs early in a pipeline, on hand-authored CSS, before Autoprefixer and before minification; running it after either mostly duplicates work those tools already do.

## How It Works

UDJO:

1. …**parses** the CSS with [PostCSS](https://postcss.org/).

2. …**scopes** rules by their DRY boundary—the root stylesheet, or the contents of an `@media`/`@supports`/`@layer`/etc. condition, or one specific nested rule (native CSS nesting). Declarations are only ever compared within the same scope: a rule’s own declarations are never compared against those of rules nested inside it, and rules in different `@layer`s (or different `@media`/`@supports` conditions) can’t share a merged rule. Two blocks with the _same_ condition are the same scope even when written separately in the source (e.g., two `@media (min-width: 768px) {}` blocks in different parts of the file)—matching is whitespace-insensitive but case-sensitive, since `@layer` names and selectors can be case-significant. Statement-form at-rules with no block (`@layer reset, base;`) are skipped, not recursed into.

3. …**excludes** selectors matching a hack pattern (vendor-prefixed pseudo-classes/elements, legacy IE selector hacks) from analysis by default—grouping those into a shared selector list risks the whole rule being dropped by browsers that don’t recognize the selector.

4. …**normalizes** each remaining declaration for comparison (skipping the contents of quoted strings, `url()`, and `var()` throughout—custom property names and references are case-sensitive, so `var(--Foo)`/`var(--foo)` and `--Foo`/`--foo` are never treated as equal): whitespace, value case, zero-value length/percentage units (`0px`/`0svh`/`0cqw` → `0`—angle/time/frequency/resolution units like `0deg`/`0s` are left alone, since unitless zero isn’t valid there), redundant decimal zeros (`.5`/`0.5`/`0.50` → `.5`, `1.0` → `1`), and the `border`/`outline` `none` ↔ `0` equivalence.

5. …**reports** any normalized declaration that occurs in more than one rule within a scope, and separately flags declarations repeated within a single rule.

6. …**consolidates** (with `--dedup`) only when it’s provably safe: a duplicate group is merged by folding its selectors into the last occurrence—one line per selector if that’s already how the file writes multi-selector rules, comma-separated on one line otherwise—keeping whichever of the group’s equivalent raw spellings is shortest (e.g. `.5` over `0.50`—UDJO only picks among spellings already present in the source, so it doesn’t synthesize a shorter one which would be a minifier’s job), and removing the declaration from the others—but only if no other rule between the first and last occurrence, and no other declaration within one of the merged rules itself, also sets that property or a shorthand/longhand overlapping it (`margin` and `margin-left`, `border-color` and `border-top-color`, etc.), for any selector. If something does, the merge is skipped and reported rather than risking a cascade change.

Overall, UDJO is conservative by design and will leave some safe merges for manual review.

`test/fixtures/*.css` contains small example stylesheets that exercise each of these behaviors, including nesting (`nesting.css`) and `@layer` (`layers.css`)—run `node bin/udjo.js test/fixtures/<file>.css` (add `--dedup` for `merge-safety.css`) to see them in action.

***

You might like some of my other work:

* Optimization tools: [hihtml](https://github.com/j9t/hihtml) · [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · UDJO · [Image Guard](https://github.com/j9t/image-guard) · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · [.htaccess Punk](https://github.com/j9t/htaccess-punk)
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)