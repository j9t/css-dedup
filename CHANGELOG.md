# Changelog

All notable changes to CSS Dedup are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-12

### Added

* Added aggressive mode (`--aggressive`/`-a` on the CLI, `aggressive: true` programmatically and in the config file) for merges that are probably—but not provably—safe
  - Without the flag, reports and `--fix` runs now note in parentheses what `--aggressive` would additionally consolidate; after an aggressive `--fix`, the CLI counts the merges that rode on the flag and suggests reviewing and testing
* Added `--savings-only`/`-s` parameter (config: `savingsOnly: true`) that complements `--fix`/`-f`, leaving files whose consolidation would make it bigger untouched—checked per file, so a multi-file run still writes the files that shrink

## [1.0.0] - 2026-07-11

### Added

* Released initial version