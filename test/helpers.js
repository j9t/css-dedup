// Shared fixtures, assertion patterns, and the CLI spawn helpers the test
// files below use.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This directory—where the scratch dirs below are created
export const dirTest = __dirname;

// A scratch directory under `test/`, created fresh. Callers remove it in a
// `finally` block—the CLI writes real files into these.
export function makeTempDir(name) {
  const dir = path.join(dirTest, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const scriptPath = path.join(__dirname, '..', 'bin', 'css-dedup.js');
export const fixturesDir = path.join(__dirname, 'fixtures');

// A consolidation that grows the file: the long selector list costs more
// than the removed `color` declaration saves
export const cssGrowing = '.very-long-selector-name-one { color: red; font-weight: bold; }\n.b { color: red; }\n';

// Only mergeable in aggressive mode (the intervening rule blocks the default
// pass), and the merge grows the file—both rules keep another declaration,
// so the merge adds the long selector list without removing a rule
export const cssGrowingAggressive = [
  '.module-header-navigation-primary-link { color: red; font-size: 14px; }',
  '.unrelated-widget:hover { color: blue; }',
  '.module-footer-navigation-secondary-link { color: red; letter-spacing: 1px; }',
  '',
].join('\n');

// Only mergeable in aggressive mode (canonicalizing the `<angle>` values is
// aggressive-only), and—unlike `cssGrowingAggressive`—the merge shrinks the
// file: Each rule holds only the one shared declaration, so folding them
// removes a whole rule instead of just adding to a selector list
export const cssShrinkingAggressive = '.a { transform: rotate(90deg); }\n.b { transform: rotate(100grad); }\n';

// Assertion patterns shared across several tests
export const RE_WITHHELD_ONE = /1 withheld/;
export const RE_MERGED_AB = /\.a,\s*\.b\s*{\s*color: red;\s*}/;
export const RE_MERGED_AC = /\.a,\s*\.c\s*{\s*color: red;\s*}/;
// The report table’s header row, followed by a data row whose `-f` column
// (the second cell) shows a save (a leading `-`)—the report-mode analogue
// of the old `* N findings: Reduce duplication and save …` bullet. Not
// anchored to exact column spacing (that’s computed per run), just that a
// `Findings -f (-a)` row saves something under plain `-f`.
export const RE_PAYOFF_FIX = /Findings -f \(-a\).*\n\d+ \(\d+\) {2,}-[\d.]+ (?:B|KB|MB) \(-\d+\.\d%\)/;
// A report-table row whose Findings cell is `N (…)`, for asserting the
// default-mode finding count without caring what the table’s other columns say
export const findingsRow = n => new RegExp(`\\n${n} \\(\\d+\\) `);
export const RE_SYNTAX_ERROR = /Unknown word/;
export const RE_SYNTAX_ERROR_UNCLOSED = /Unclosed block/;

// The one spawn both helpers below go through. A failed spawn (or a timeout)
// leaves `stdout`/`stderr` null and reports the cause on `result.error`—
// defaulted to empty strings here so a caller doesn’t get a confusing throw
// from string handling instead of the actual failure.
function spawnCli(args, { env, ...spawnOptions } = {}) {
  const result = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    ...(env ? { env } : {}),
    ...spawnOptions,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    error: result.error,
  };
}

export function run(args, spawnOptions = {}) {
  const { stdout, stderr, status, error } = spawnCli(args, spawnOptions);
  return {
    stdout: stripVTControlCharacters(stdout),
    stderr: stripVTControlCharacters(stderr),
    status,
    error,
  };
}

// `run()` strips color codes—`node:util`’s `styleText` skips them itself
// once STDOUT isn’t a TTY, which `spawnSync` never gives it—so highlighting
// tests force color on and read the raw (unstripped) output instead
export function runColor(args, spawnOptions = {}) {
  const { stdout, status, error } = spawnCli(args, {
    ...spawnOptions,
    env: { ...process.env, FORCE_COLOR: '1', ...spawnOptions.env },
  });
  return { stdout, status, error };
}
// Built from a computed character code, not a literal control character
// (which `no-control-regex` flags even inside a `new RegExp()` string), to
// match the bold/green/reset ANSI codes a highlighted cell is wrapped in
const ESC = String.fromCharCode(27);
export const BEST_CELL = new RegExp(`${ESC}\\[1m${ESC}\\[32m([^${ESC}]*)${ESC}\\[39m${ESC}\\[22m`, 'g');
