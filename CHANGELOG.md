# Changelog

All notable changes to CSS Dedup are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.1] - 2026-07-31

### Fixed

* Removed a dead fallback in the exact decimal scaling used for `<time>`/`<angle>` canonicalization (`|| '0'` could never apply)

### Added

* Added additional tests for improved CLI coverage

### Changed

* Split the engine and the CLI into focused modules
* Moved everything but the executable out of `bin/`
* Replaced the merge strategies’ shared closures with an explicit run context, so each strategy can be read (and tested) on its own
* Consolidated repeated logic
* Collected the test suite in `test/`
* Trimmed source comments to what each piece needs
* Added a “Working on CSS Dedup” section to the README covering tests, benchmarks, and module layout

## [1.10.0] - 2026-07-28

### Added

* Added `CSS_DEDUP_WORKERS` to override the thread count for a run (`0` or `1` processes files one at a time)

### Changed

* Sped up multi-file runs by spreading consolidation across worker threads (one per core, minus one for the main thread); output is byte-identical to a single-threaded run, since every file is still rendered from the main thread in file order, and runs too small to pay for a pool stay on one thread

## [1.9.0] - 2026-07-28

### Fixed

* Adjusted source map warning to no longer fire for a `sourceMappingURL` string that merely appears in a declaration value (`content: "/*# sourceMappingURL=… */"`), since detection now inspects parsed comments rather than the raw style sheet text

### Added

* Updated `dedup()` to return `sourceMapStale: true` when it rewrites a style sheet carrying a `sourceMappingURL` comment, so programmatic users get the caveat the CLI already printed

### Changed

* Reworded the source map warning: The map should be treated as invalid rather than stale-but-usable (especially for minified style sheets, where every mapping is keyed by column), and both it and the README now point at running CSS Dedup before the minifier, or in-pipeline via `css-dedup/plugin`, to keep maps intact

## [1.8.1] - 2026-07-25

### Changed

* Renamed the aggressive-mode preview bullet’s count from “findings” to “declarations,” to make wording correct and consistent

## [1.8.0] - 2026-07-25

### Added

* Added `npm run benchmark` to time both entry points against a generated style sheet (or files/directories passed as arguments), reporting declarations applied, groups skipped, and bytes saved alongside each timing

### Changed

* Sped up consolidation by roughly 3–5× on large style sheets, by bounding the merge-safety scan to the span it actually examines and memoizing property normalization, selector splitting, and shorthand/longhand overlap per run

## [1.7.0] - 2026-07-25

### Added

* Added `--quiet`/`-q` to suppress the per-file findings/skipped-group detail listing (and its file-path header); summaries still print

## [1.6.1] - 2026-07-24

### Changed

* Tweaked some messages (and comments)

## [1.6.0] - 2026-07-24

### Fixed

* A missing target path, or a directory `readdir` can’t access, now reports a clean error instead of a raw stack trace

### Added

* Added `--exit-zero`/`-z` (and the `exitZero` config option) to exit “0” even when findings are skipped as unsafe to auto-merge or withheld by `--savings-only`, so a build pipeline doesn’t gate on them
  - A file that fails to read or parse still exits “1” regardless of the flag.
* Added `--no-exit-zero`/`-e` to override `exitZero: true` from a config file for a run

## [1.5.0] - 2026-07-22

### Fixed

* Corrected `--aggressive` to require `--fix` (similar to `--savings-only`)

### Changed

* Optimized report mode’s bulleted summary with a compact table (`Summary for <file>:`) comparing all four `--fix`/`--savings-only`/`--aggressive` combinations at once

## [1.4.1] - 2026-07-21

### Changed

* Optimized summaries further, especially for aggressive mode

## [1.4.0] - 2026-07-21

### Added

* Added an overall summary (`Summary for all files: …`) at the end of a multi-file run

### Changed

* Optimized individual summaries

## [1.3.3] - 2026-07-16

### Fixed

* `--fix` no longer de-minifies an already-minified style sheet: A merged selector list now follows the source’s comma-spacing convention (`.a,.b` vs. `.a, .b`) instead of inserting a space

## [1.3.2] - 2026-07-16

### Fixed

* Fixed a merged rule inserted directly after a comment-adjacent (or otherwise tightly-spaced) source rule inheriting that rule’s spacing

## [1.3.1] - 2026-07-14

### Changed

* Tightened README and CLI info wording

## [1.3.0] - 2026-07-12

### Fixed

* A single-dash spelling of a long option name (e.g., `-fix` for `--fix`) is now rejected with a suggestion, instead of silently parsing as a cluster of short flags (`-f` plus `-i` with an unintended attached value)

### Added

* Added license (MIT)
* Added `--ignore-path`/`-p` (`ignorePaths` in the config file) to exclude files by path—matched against each file’s path relative to the working directory
* `--fix` now warns when it rewrites a file that references a source map (`sourceMappingURL`), since the map itself isn’t regenerated and goes stale
* Duplicate detection now canonicalizes `<time>` values (`s`/`ms`) unconditionally
* Duplicate detection now sorts `min()`/`max()` arguments, since mathematical min/max is commutative
* Aggressive mode: Duplicate detection now canonicalizes `<angle>` values (`deg`/`grad`/`rad`/`turn`)

### Changed

* File reads are now prefetched concurrently ahead of the (still sequential and deterministically ordered) per-file processing loop, overlapping I/O latency across a multi-file run

## [1.2.1] - 2026-07-12

### Fixed

* `--fix` now prints the skipped-group detail before the consolidated/withheld/skipped counts summary, so the summary isn’t stranded above a long skipped-group list

## [1.2.0] - 2026-07-12

### Added

* Added TypeScript declaration files (`src/index.d.ts`, `src/plugin.d.ts`) for the programmatic API and the PostCSS plugin

## [1.1.0] - 2026-07-12

### Added

* Added aggressive mode (`--aggressive`/`-a` on the CLI, `aggressive: true` programmatically and in the config file) for merges that are probably—but not provably—safe
  - Without the flag, reports and `--fix` runs now note in parentheses what `--aggressive` would additionally consolidate; after an aggressive `--fix`, the CLI counts the merges that rode on the flag and suggests reviewing and testing
* Added `--savings-only`/`-s` parameter (`savingsOnly: true` programmatically, in the plugin, and in the config file) that complements `--fix`/`-f`, leaving files whose consolidation would make it bigger untouched—checked per file, so a multi-file run still writes the files that shrink; a withheld result is reported (CLI) or warned about (plugin), and `dedup()` returns it under `withheld`

## [1.0.0] - 2026-07-11

### Added

* Released initial version