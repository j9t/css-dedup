# Changelog

All notable changes to CSS Dedup are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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