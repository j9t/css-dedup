# UDJO, the CSS Declaration De-Duplicator (Beta)

UDJO is a CSS performance optimization tool that finds—and, where it’s safe, consolidates—duplicate CSS declarations. It implements [“using declaration just once,”](https://webglossary.info/terms/udjo/) as originally described in [DRY CSS](https://meiert.com/blog/dry-css/): the same normalized property-value pair shouldn’t appear in more than one rule within the same scope. Where it does, UDJO reports it—and can group the affected selectors into a single rule.

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

`dedup()` returns `{ css, applied, skipped }`: `css` is the rewritten stylesheet, `applied` lists the merges it made, and `skipped` lists duplicate groups it left untouched along with why.

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

1. **parses** the CSS with [PostCSS](https://postcss.org/)
2. **scopes** rules by their DRY boundary—the root stylesheet, or the direct contents of one specific `@media`/`@supports`/etc. block. Declarations are only ever compared within the same scope, since rules in different at-rule blocks can’t share a merged rule
3. **excludes** selectors matching a hack pattern (vendor-prefixed pseudo-classes/elements, legacy IE selector hacks) from analysis by default—grouping those into a shared selector list risks the whole rule being dropped by browsers that don’t recognize the selector
4. **normalizes** each remaining declaration for comparison: whitespace, value case (except inside quoted strings and `url()`), zero-value units (`0px` → `0`), and the `border`/`outline` `none` ↔ `0` equivalence
5. **reports** any normalized declaration that occurs in more than one rule within a scope, and separately flags declarations repeated within a single rule
6. **consolidates** (with `--dedup`) only when it’s provably safe: a duplicate group is merged by folding its selectors into the last occurrence and removing the declaration from the others, but only if no other rule between the first and last occurrence also sets that property, for any selector. If something does, the merge is skipped and reported rather than risking a cascade change—the DRY CSS post is explicit that this kind of refactoring “isn’t automation-friendly due to cascade complexity,” so UDJO is conservative by design and will leave some genuinely safe merges for manual review

`test/fixtures/*.css` contains small example stylesheets that exercise each of these behaviors—run `node bin/udjo.js test/fixtures/<file>.css` (add `--dedup` for `merge-safety.css`) to see them in action.

***

You might like some of my other work:

* Optimization tools: [hihtml](https://github.com/j9t/hihtml) · [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · UDJO · [Image Guard](https://github.com/j9t/image-guard) · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · [.htaccess Punk](https://github.com/j9t/htaccess-punk)
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)