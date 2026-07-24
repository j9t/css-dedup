#!/usr/bin/env node

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { resolve, relative, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, dedup } from '../src/index.js';
import { declarationKey } from '../src/normalization.js';

// Directories skipped when recursing into a target directory
const DIRS_IGNORED = new Set(['node_modules']);

// Shared between `parseArgs` below and the single-dash guard that runs
// before it—one definition, so an option added here can’t drift out of
// sync with a separately maintained name list
const OPTIONS_CONFIG = {
  fix: { type: 'boolean', short: 'f', default: false },
  aggressive: { type: 'boolean', short: 'a', default: false },
  'savings-only': { type: 'boolean', short: 's', default: false },
  'ignore-selector': { type: 'string', short: 'i', multiple: true, default: [] },
  'ignore-path': { type: 'string', short: 'p', multiple: true, default: [] },
  'no-ignore-selectors-defaults': { type: 'boolean', short: 'n', default: false },
  'exit-zero': { type: 'boolean', short: 'z', default: false },
  'no-exit-zero': { type: 'boolean', short: 'e', default: false },
  config: { type: 'string', short: 'c' },
  help: { type: 'boolean', short: 'h', default: false },
};

// A single-dash spelling of a long option name (`-fix` for `--fix`) isn’t a
// typo `parseArgs` below rejects: With `strict: true`, it only rejects
// letters that don’t resolve to some short flag, so it silently reads
// `-fix` as the boolean `-f` plus `-i` (`--ignore-selector`) with the
// attached value `"x"`—consolidation quietly runs with a bogus selector
// filter instead of failing loudly. Catch the exact-spelling case before
// `parseArgs` gets a chance to cluster it.
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('-') || arg.startsWith('--')) continue;
  const name = arg.slice(1);
  if (Object.hasOwn(OPTIONS_CONFIG, name)) {
    console.error(`Unknown option \`${arg}\`. Did you mean \`--${name}\`? (A single dash groups letters as short flags instead—e.g., \`-i\` takes an attached value—so '${arg}' doesn’t parse as that long option.)`);
    process.exit(1);
  }
}

const { values, positionals } = parseArgs({
  options: OPTIONS_CONFIG,
  allowPositionals: true,
  strict: true,
});

if (values.help || !positionals.length) {
  console.log(`Usage: css-dedup [options] <file…>

Find (and optionally consolidate) duplicate CSS declarations.

Arguments:
  file  One or more CSS files or directories to analyze (directories are searched recursively for .css files, skipping node_modules and dotfolders); pass \`-\` to read from STDIN instead

Options:
  -f, --fix                        Consolidate declarations that are safe to merge automatically, rewriting each file in place (or printing to STDOUT for \`-\`)
  -a, --aggressive                 Also apply merges that are probably—but not provably—safe (test afterwards); only applies together with \`--fix\`
  -s, --savings-only               Leave a file untouched when its consolidation would make it bigger, not smaller (checked per file); only applies together with \`--fix\`
  -i, --ignore-selector <pattern>  Regular expression for selectors to exclude from analysis (repeatable)
  -p, --ignore-path <pattern>      Regular expression tested against each file’s path, relative to the working directory; a match excludes the file (repeatable)
  -n, --no-ignore-selectors-defaults  Disable the built-in selector hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -z, --exit-zero                  Exit with status 0 even when findings are skipped as unsafe to auto-merge or withheld by \`--savings-only\`; a file that fails to read or parse still exits 1
  -e, --no-exit-zero               Override \`exitZero: true\` from a config file for the respective run
  -c, --config <path>              Path to a config file (defaults to \`css-dedup.config.js\` in the working directory, if present)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

if (positionals.includes('-') && positionals.length > 1) {
  console.error('Cannot combine STDIN (`-`) with other file arguments.');
  process.exit(1);
}

// A flag active without `--fix` that couldn’t change anything about report
// mode would only sit inert and mislead—`--savings-only` since report mode
// never writes, `--aggressive` since the summary table always shows the
// default and aggressive variants side-by-side regardless of the flag (see
// the `Findings -f (-a)` column and the four `Savings with:` columns)
function requireFix(active, flag, reason) {
  if (!active || values.fix) return;
  console.error(`\`${flag}\` only applies together with \`--fix\` (${reason})`);
  process.exit(1);
}
requireFix(values['savings-only'], '--savings-only', 'report mode doesn’t write');
requireFix(values.aggressive, '--aggressive', 'report mode already shows both variants');

// Settings file
async function loadConfig(pathConfig) {
  const pathResolved = resolve(pathConfig ?? 'css-dedup.config.js');
  if (!pathConfig && !existsSync(pathResolved)) return {};

  const { default: config = {} } = await import(pathToFileURL(pathResolved).href);
  return config;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Recursively collects `.css` files under a directory, skipping
// `node_modules` and dotfolders—not configurable, since a
// project-specific exclude list belongs in `css-dedup.config.js`’s `ignoreSelectors`
async function collectCssFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || DIRS_IGNORED.has(entry.name)) continue;
    const entryPath = join(dirPath, entry.name);

    if (entry.isDirectory()) files.push(...await collectCssFiles(entryPath));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.css') files.push(entryPath);
  }

  return files;
}

// Expands each positional into one or more file paths: `-` (STDIN) and
// plain files pass through as-is, a directory recurses into its .css
// files (sorted, for stable output across runs); `ignorePathPatterns` then
// filters the combined list, so an explicit file argument is excluded the
// same way a directory-discovered one is, matched against the path relative
// to the working directory (portable across machines, unlike an absolute one).
// Returns `discovered` alongside the filtered `files` so the caller can
// tell “nothing under these targets” apart from “everything under these
// targets got excluded”—two different situations that deserve two
// different error messages.
async function expandTargets(targets, ignorePathPatterns) {
  const expanded = [];

  for (const target of targets) {
    if (target === '-') {
      expanded.push(target);
      continue;
    }

    const pathResolved = resolve(target);
    const stats = await stat(pathResolved);
    if (stats.isDirectory()) expanded.push(...(await collectCssFiles(pathResolved)).sort());
    else expanded.push(pathResolved);
  }

  if (!ignorePathPatterns.length) return { files: expanded, discovered: expanded.length };

  const files = expanded.filter(file => file === '-' || !ignorePathPatterns.some(pattern => pattern.test(toPortablePath(file))));
  return { files, discovered: expanded.length };
}

// A path relative to the working directory with forward slashes, regardless
// of host OS—shared by `--ignore-path` matching above and the all-files
// table’s File-column disambiguation below
function toPortablePath(file) {
  return relative(process.cwd(), file).split(sep).join('/');
}

// A `/*# sourceMappingURL=… */` comment means a build tool generated this
// file alongside a source map; `--fix` rewrites the CSS text without
// touching (or regenerating) that map, so its line/column data goes stale—
// worth a one-line heads-up rather than a silently drifting map
const RE_SOURCE_MAP = /\/\*#\s*sourceMappingURL=/;

// Concurrency cap for `prefetchContents()` below
const CONCURRENCY_READ = 8;

// Reads every non-STDIN target concurrently, ahead of the (sequential)
// per-file processing loop in `main()`—so disk I/O for file N+1 overlaps
// with the parsing/analysis CPU work for file N, instead of each file’s
// read waiting behind the previous file’s full report. Outcomes are
// captured rather than thrown, so a read failure still surfaces through
// `processTarget`’s existing per-file error message, one file at a time,
// in the files' original order.
async function prefetchContents(files) {
  const contents = new Array(files.length);
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (file === '-') continue;
      try {
        contents[index] = { css: await readFile(resolve(file), 'utf8') };
      } catch (err) {
        contents[index] = { err };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY_READ, files.length) }, worker));
  return contents;
}

// A byte magnitude with a signed percentage—“-” for savings, “+” for
// growth—for the bulleted summaries, where the sign carries the direction
// instead of a surrounding sentence. `more: true` marks the amount as
// additional on top of a total already stated elsewhere (the `--aggressive`
// bullets, which quote what aggressive mode adds beyond plain `--fix`).
function formatByteMagnitude(bytesAbs, before, sign, { more = false } = {}) {
  const percent = before ? (bytesAbs / before) * 100 : 0;
  return `${bytesAbs.toLocaleString()} ${more ? 'more bytes' : 'bytes'} (${sign}${percent.toFixed(1)}%)`;
}

// One summary bullet’s outcome clause: “save N bytes (-P%)” or “grow by N
// bytes (+P%)”—always still-hypothetical phrasing (report mode’s base
// bullet, or an `--aggressive` preview under either mode), since the one
// bullet describing an already-applied `--fix` change has its own clause
function formatByteDeltaClause(saved, before, more = false) {
  const sign = saved >= 0 ? '-' : '+';
  const magnitude = formatByteMagnitude(Math.abs(saved), before, sign, { more });
  if (saved >= 0) return `save ${magnitude}`;
  return `grow by ${magnitude}`;
}

// A single-file bullet’s full outcome clause: “Reduce duplication and
// save …” when it pays off, “but grow …” when it doesn’t
function formatReduceClause(saved, before, more = false) {
  const conjunction = saved >= 0 ? 'and' : 'but';
  return `Reduce duplication ${conjunction} ${formatByteDeltaClause(saved, before, more)}`;
}

// The fix-mode consolidated bullet’s clause: The concrete before → after
// byte counts fold into the parenthetical (replacing the separate
// before → after line printed elsewhere), and the conjunction is always
// “and”—“but grew” read as though the growth undercut the “reduced
// duplication” result, when `--fix` applies both changes regardless
function formatAppliedReduceClause(bytes) {
  const sign = bytes.saved >= 0 ? '-' : '+';
  const percent = bytes.before ? (Math.abs(bytes.saved) / bytes.before) * 100 : 0;
  const magnitude = `${Math.abs(bytes.saved).toLocaleString()} bytes (${bytes.before.toLocaleString()} → ${bytes.after.toLocaleString()} bytes, ${sign}${percent.toFixed(1)}%)`;
  const verb = bytes.saved >= 0 ? `saved ${magnitude}` : `grew by ${magnitude}`;
  return `Reduced duplication and ${verb}`;
}

// The mixed-results net—shrinking files’ savings minus growing files’
// growth—against the run’s combined original size, spelled out as the
// literal “total: ±N bytes / ±P%” the summary bullets quote in
// parentheses
function formatOverallNet(net, totalBefore) {
  const percent = totalBefore ? (Math.abs(net) / totalBefore) * 100 : 0;
  const sign = net >= 0 ? '-' : '+';
  return `total: ${sign}${Math.abs(net).toLocaleString()} bytes / ${sign}${percent.toFixed(1)}%`;
}

// Appended to an `--aggressive` bullet: what its own delta adds up to once
// combined with the base bullet printed just above—without this, a reader
// has to add the two bullets themselves to know where they’d land together
function formatAggregateTotalNote(totalSaved, before) {
  return ` (${formatOverallNet(totalSaved, before)})`;
}

// The one outcome bullet the all-files summary prints twice—once for the
// base count, once for what `--aggressive` adds—covering its three possible
// shapes: Every file in the split shrinks, every file grows, or the split
// is mixed. `tense` is `'done'` for `--fix` (already applied, no flag to
// suggest, no “but”—the growth already happened alongside the shrinkage,
// not despite it, so the mixed shape reads as a plain gerund list: “…,
// shrinking … and growing …”) or `'todo'` for report mode or an
// `--aggressive` preview (a recommendation, flag named, “but” contrasts the
// still-open choice). `more` marks the `--aggressive` bullets, whose totals
// are additional on top of the base bullet printed just above.
// `aggregateNote`—passed by the `--aggressive` caller as a pre-formatted
// `formatAggregateTotalNote()` string, against the whole run rather than
// just the files aggressive affects—is appended to every shape, replacing
// the mixed shape’s own “(total: …)” net (just its own two figures) rather
// than sitting alongside it: Two differently-scoped nets both labeled
// “total:” back to back would read as a contradiction.
function formatOutcomeBullet({ countLabel, tense, filesShrinkLen, shrinkTotal, filesGrowLen, growTotal, totalBefore, flag, skipFlag, more = false, aggregateNote = '' }) {
  const s = n => n !== 1 ? 's' : '';
  const reduce = tense === 'done' ? 'Reduced' : 'Reduce';
  const flagClause = tense === 'done' ? '' : ` with \`${flag}\``;

  if (filesShrinkLen && !filesGrowLen) {
    const saved = tense === 'done' ? 'saved' : 'save';
    return [`* ${countLabel}: ${reduce} duplication and ${saved} ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })}${flagClause}${aggregateNote}`];
  }
  if (!filesShrinkLen && filesGrowLen) {
    const grew = tense === 'done' ? 'grew' : 'grow';
    const conjunction = tense === 'done' ? 'and' : 'but';
    return [`* ${countLabel}: ${reduce} duplication ${conjunction} ${grew} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}${flagClause}${aggregateNote}`];
  }
  if (filesShrinkLen && filesGrowLen) {
    const net = shrinkTotal - growTotal;
    const netNote = aggregateNote || ` (${formatOverallNet(net, totalBefore)})`;
    if (tense === 'done') {
      // A gerund list, not “and shrink … but grow …”: `--fix` already
      // applied both changes in the same run, so there’s no contrast left
      // to draw—just what happened, itemized
      const first = `* ${countLabel}: Reduced duplication, shrinking ${filesShrinkLen} file${s(filesShrinkLen)} by ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })} and growing ${filesGrowLen} file${s(filesGrowLen)} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}${netNote}`;
      return [first];
    }
    const first = `* ${countLabel}: Reduce duplication and shrink ${filesShrinkLen} file${s(filesShrinkLen)} by ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })} but grow ${filesGrowLen} file${s(filesGrowLen)} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}${flagClause}${netNote}`;
    const second = `  - Skip files that grow in size to save ${formatByteMagnitude(shrinkTotal, totalBefore, '-')} in total with \`${skipFlag}\``;
    return [first, second];
  }
  return null;
}

// What `--aggressive` would add on top of this run’s real outcome, measured
// against a discarded opposite-mode pass (`potential`)—shared by `--fix`
// and report mode, which differ only in which CSS string and `bytes` they
// compare it against (the written output vs. a discarded dry run)
function computeAggressivePreview(potential, resultCss, applied, bytes) {
  const aggDiffers = Boolean(potential && potential.css !== resultCss);
  if (!aggDiffers) return { aggExtra: 0, aggExtraSaved: 0, aggDiffers: false };
  return {
    aggExtra: potential.applied.length - applied.length,
    aggExtraSaved: potential.bytes.saved - bytes.saved,
    aggDiffers: true,
  };
}

// The “in aggressive mode” preview bullet, shared by `--fix` and report
// mode—always still-hypothetical, so always `formatReduceClause()`’s
// present-tense phrasing even inside a `--fix` run. `baseSaved` is the base
// `--fix` bullet’s own outcome, needed only to spell out the combined total
// in the trailing note—the bullet’s main clause still quotes `aggExtraSaved`
// on its own.
function formatAggressivePreviewLine(aggExtra, aggExtraSaved, before, baseSaved) {
  const label = aggExtra > 0 ? `${aggExtra} more finding${aggExtra !== 1 ? 's' : ''}` : 'Further consolidation';
  return `* ${label} in aggressive mode: ${formatReduceClause(aggExtraSaved, before, true)} with \`--fix --aggressive\`${formatAggregateTotalNote(baseSaved + aggExtraSaved, before)}`;
}

// The per-file stats object the overall summary aggregates across a
// multi-file run—one shape shared by all three of `processCss()`’s return
// sites (the zero-findings shortcut, `--fix` mode, and report mode)
function buildStats({ findings, applied, skipped, bytes, withheld, aggExtra, aggExtraSaved, aggDiffers }) {
  return {
    findings,
    applied: applied.length,
    skipped: skipped.length,
    bytesBefore: bytes.before,
    bytesSaved: bytes.saved,
    withheldCount: withheld ? withheld.count : 0,
    withheldGrowth: withheld ? Math.abs(withheld.bytes.saved) : 0,
    aggExtra,
    aggExtraSaved,
    aggDiffers,
  };
}

function printFindings(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    if (!grouped.has(finding.scope)) grouped.set(finding.scope, []);
    grouped.get(finding.scope).push(finding);
  }

  for (const [scope, items] of grouped) {
    console.log(styleText('bold', scope === 'root' ? '(root)' : scope));

    for (const finding of items) {
      if (finding.repeated) {
        console.log(`  ${styleText('cyan', 'repeated')}    ${finding.key}`);
        for (const occ of finding.occurrences) {
          console.log(`    ${styleText('dim', `line ${occ.line}`)}`);
        }
        continue;
      }

      if (finding.redundant) {
        const [occ] = finding.occurrences;
        console.log(`  ${styleText('yellow', 'redundant')}   ${occ.prop}: ${occ.value}  ${styleText('dim', `${occ.selector} (line ${occ.line})`)}`);
        continue;
      }

      const [{ prop, value }] = finding.occurrences;
      console.log(`  ${styleText('red', 'duplicate')}   ${prop}: ${value}`);
      for (const occ of finding.occurrences) {
        console.log(`    ${styleText('dim', `${occ.selector} (line ${occ.line})`)}`);
      }
    }

    console.log('');
  }
}

// A file that never made it into `stats` (read/parse failure): excluded
// from the overall-summary totals, but counted so the totals can note how
// many files that summary doesn’t speak for
const RESULT_ERRORED = { exitFailure: true, errored: true, stats: null };

// Processes one target (a file path, or `-` for STDIN) and returns
// `{ exitFailure, errored, stats }`: `exitFailure` is whether it should
// count against the process’s exit code, `errored` whether it never
// produced stats (read/parse failure), and `stats` the per-file numbers the
// overall summary aggregates across a multi-file run. In `--fix` mode,
// STDIN is a special case: There is no file to rewrite in place, so the
// consolidated CSS is printed to STDOUT instead—and, so that stream stays
// pipeable, the usual status/summary lines go to STDERR rather than STDOUT.
async function processTarget(file, options, { multi }, preread) {
  const isStdin = file === '-';
  const label = isStdin ? '(stdin)' : resolve(file);

  if (multi) console.log(styleText('bold', label));

  let css;
  if (preread) {
    if (preread.err) {
      console.error(styleText('red', `Could not read ${label}: ${preread.err.message}`));
      return RESULT_ERRORED;
    }
    css = preread.css;
  } else {
    try {
      css = isStdin ? await readStdin() : await readFile(label, 'utf8');
    } catch (err) {
      console.error(styleText('red', `Could not read ${label}: ${err.message}`));
      return RESULT_ERRORED;
    }
  }

  const targetOptions = { ...options, from: isStdin ? undefined : label };

  // A file that fails to parse (invalid CSS, or a non-standard dialect
  // PostCSS doesn’t accept) shouldn’t take the rest of the run down with it
  try {
    return await processCss(css, targetOptions, { isStdin, label, multi });
  } catch (err) {
    if (err.name === 'CssSyntaxError') {
      console.error(styleText('red', err.message));
      console.error(err.showSourceCode());
    } else {
      console.error(styleText('red', `Error processing ${label}: ${err.message}`));
    }
    return RESULT_ERRORED;
  }
}

// The opposite-mode consolidation of the same source—a second, discarded
// pass serving as the aggressive preview on default runs, and as the
// default-mode baseline that measures what rode on the flag on aggressive
// runs
function oppositePass(css, targetOptions) {
  return dedup(css, { ...targetOptions, aggressive: !targetOptions.aggressive });
}

// A skipped group’s key as the aggressive pass would spell it: Aggressive
// normalization can rewrite the default spelling (`hsl()` onto hex,
// `word-wrap` onto `overflow-wrap`), so matching the default spelling alone
// would hint at groups the aggressive pass also skips. Selector-list keys
// (blocked same-selector folds) carry no `prop: value` shape and pass
// through unchanged.
function aggressiveKeySpelling(key) {
  const important = key.endsWith(' !important');
  const base = important ? key.slice(0, -' !important'.length) : key;
  const separator = base.indexOf(': ');
  if (separator === -1) return key;
  return declarationKey(base.slice(0, separator), base.slice(separator + 2), important, true);
}

// The scope + key identities of the groups the aggressive pass still skipped,
// as one Set—so the “may merge” hint check below is a lookup, not a scan of
// the whole skipped list per printed line
function skippedWithAggressive(potential) {
  return potential ? new Set(potential.skipped.map(item => `${item.scope}\0${item.key}`)) : null;
}

// One skipped-group line, for fix and report mode alike—with the “may merge
// with `--aggressive`” hint when the aggressive pass didn’t skip the group,
// matched under both the default and the aggressive spelling of the key, so
// a respelled key never produces a false hint
function formatSkippedLine(item, skippedAggressive) {
  const stillSkipped = !skippedAggressive
    || skippedAggressive.has(`${item.scope}\0${item.key}`)
    || skippedAggressive.has(`${item.scope}\0${aggressiveKeySpelling(item.key)}`);
  const hint = stillSkipped ? '' : ` (may merge with \`--aggressive\`)`;
  return `  ${styleText('dim', item.scope === 'root' ? '(root)' : item.scope)}  ${item.key} — ${item.reason}${hint}`;
}

// The skipped-group detail block, printed before the summary in both
// `--fix` and report mode—`log` is `console.log` in report mode, and in
// `--fix` mode either `console.log` or `console.error` depending on
// whether STDOUT needs to stay clear for piped CSS output
function logSkippedDetail(log, skipped, skippedAggressive) {
  if (!skipped.length) return;
  log(styleText('yellow', `${skipped.length} duplicate group${skipped.length !== 1 ? 's' : ''} considered unsafe to auto-merge:`));
  for (const item of skipped) {
    log(formatSkippedLine(item, skippedAggressive));
  }
  log('');
}

// A byte magnitude for the report table: Decimal KB by default (matching
// how web-perf tooling usually states transfer size), falling back to a
// plain byte count when KB would round to “0.0” (a real, if small, saving
// shouldn’t read as nothing), and up to MB once the value crosses the
// million-byte line
function formatSize(bytesAbs) {
  if (bytesAbs >= 1_000_000) return `${(bytesAbs / 1_000_000).toFixed(1)} MB`;
  const kb = (bytesAbs / 1000).toFixed(1);
  if (kb === '0.0') return `${bytesAbs.toLocaleString()} B`;
  return `${kb} KB`;
}

// One report-table savings cell: Sign on both the magnitude and the
// percentage (unlike the `--fix`-mode bullets’ `formatByteMagnitude()`,
// which only signs the percentage)—“-” for savings, “+” for growth, no sign
// (and no “-0”) for an exact no-op
function formatSavingsCell(saved, before) {
  if (saved === 0) return `${formatSize(0)} (0.0%)`;
  const sign = saved >= 0 ? '-' : '+';
  const percent = before ? (Math.abs(saved) / before) * 100 : 0;
  return `${sign}${formatSize(Math.abs(saved))} (${sign}${percent.toFixed(1)}%)`;
}

// A report-table cell: `n/a` whenever this pass wouldn’t actually write
// anything—no findings under this mode, every finding unsafe to auto-merge
// (findings exist, but none of them safe), or the engine’s `savingsOnly`
// gate declining a real merge for growing the file. All three collapse to
// the same one question—would `--fix` with these flags touch the
// file?—which `pass.unavailable` (see `slimPass()`) already answers
// directly, rather than this needing to re-derive it from `findings` and
// `withheld` separately. The real figure otherwise: a genuine net-zero
// result (bytes wash out, but something *was* applied) still counts as
// touching the file, so that’s not `n/a`.
function reportCell(pass) {
  return pass.unavailable ? 'n/a' : formatSavingsCell(pass.bytes.saved, pass.bytes.before);
}

// Which of a row’s four savings columns (in `reportRowValues()`’s order:
// `-f`, `-f -s`, `-f -a`, `-f -a -s`) to mark as the row’s best outcome—shared
// by the per-file rows and the `Total` row alike. An `n/a` column (see
// `reportCell()`—nothing found, or the `savingsOnly` gate declined it) is
// excluded both from winning and from setting the bar the others are
// compared against—marking (or comparing against) an outcome nothing
// actually produced would misattribute it. A row whose best remaining
// column still grows the file isn’t marked at all, since growth isn’t an
// improvement to point at. Ties all win.
function bestSavingsColumns(passes) {
  const eligible = passes.map((pass, i) => ({ i, pass })).filter(({ pass }) => !pass.unavailable);
  if (!eligible.length) return new Set();
  const best = Math.max(...eligible.map(({ pass }) => pass.saved));
  if (best < 0) return new Set();
  return new Set(eligible.filter(({ pass }) => pass.saved === best).map(({ i }) => i));
}

// `bestSavingsColumns()`’s indices are relative to the four savings
// columns alone—shifted here by however many columns (`Findings` alone in
// the single-file table, `File` and `Findings` in the all-files table)
// precede them in the row actually being rendered
function shiftColumns(columns, offset) {
  return new Set([...columns].map(i => i + offset));
}

// Keeps only what the report table (single-file and all-files alike) needs
// from a `dedup()` result—not the rewritten CSS text itself, which a
// multi-file run would otherwise hold onto for every file for no reason.
// `unavailable` is the one question every `n/a` cell in the table asks:
// would this pass actually write anything? `applied.length === 0` answers
// it directly, covering every way the answer can be “no” in one
// check—nothing found, every finding unsafe to auto-merge, or the
// `savingsOnly` gate declining a real merge for growing the file (each of
// which already leaves `applied` empty, by construction, before this ever
// looks at it)—rather than this needing to separately ask about findings
// counts and the gate.
function slimPass(pass) {
  return { bytes: pass.bytes, unavailable: pass.applied.length === 0 };
}

// Mirrors `dedupRoot()`’s `savingsOnly` gate (`src/index.js`) against an
// already-computed plain pass, instead of running `dedup()` a second time
// with `savingsOnly: true` just to reapply a rule that only ever looks at
// the first pass’s own `bytes.saved`: a non-negative result is kept as-is
// (the engine grafts its clone’s changes onto the real root unchanged),
// a negative one is replaced with the untouched-file outcome, `applied`
// emptied to match what actually happened (nothing)
function applySavingsOnlyGate(pass) {
  if (pass.bytes.saved >= 0) return pass;
  return {
    bytes: { before: pass.bytes.before, after: pass.bytes.before, saved: 0 },
    applied: [],
  };
}

// The four passes the report table compares side-by-side, regardless of
// which flags this run was actually invoked with—`--aggressive` and
// `--savings-only` describe table columns here, not run modes. Only two
// actually run `dedup()`; the `-s` variants are derived from those in JS
// (see `applySavingsOnlyGate()`), since a second full consolidation pass
// would just reproduce the first one’s `bytes` before the gate looks at them.
function computeReportPasses(css, targetOptions) {
  const passDefault = dedup(css, { ...targetOptions, aggressive: false, savingsOnly: false });
  const passAgg = dedup(css, { ...targetOptions, aggressive: true, savingsOnly: false });
  return {
    passDefault,
    passDefaultS: applySavingsOnlyGate(passDefault),
    passAgg,
    passAggS: applySavingsOnlyGate(passAgg),
  };
}

function buildReportStats({ label, findingsDefault, findingsAgg, passDefault, passDefaultS, passAgg, passAggS }) {
  return {
    label,
    findingsDefault,
    findingsAgg,
    passDefault: slimPass(passDefault),
    passDefaultS: slimPass(passDefaultS),
    passAgg: slimPass(passAgg),
    passAggS: slimPass(passAggS),
  };
}

// A row’s four savings passes as `{ saved, unavailable }`, the shape
// `bestSavingsColumns()` compares—in `reportRowValues()`’s column order
function reportSavingsPasses(stats) {
  return [stats.passDefault, stats.passDefaultS, stats.passAgg, stats.passAggS]
    .map(pass => ({ saved: pass.bytes.saved, unavailable: pass.unavailable }));
}

// One report table row’s data cells (everything but the leading `File`
// cell, which only the all-files table has)
function reportRowValues(stats) {
  return [
    `${stats.findingsDefault} (${stats.findingsAgg})`,
    reportCell(stats.passDefault),
    reportCell(stats.passDefaultS),
    reportCell(stats.passAgg),
    reportCell(stats.passAggS),
  ];
}

// The `Total` row’s four savings passes, in the same `{ saved, unavailable }`
// shape `reportSavingsPasses()` gives a single file’s row: `unavailable`
// only when every file’s own pass was—one file’s real, applied merge
// (even a net-zero one, bytes washing out but the file still gets
// rewritten) means something happens somewhere in the run, so the total
// isn’t `n/a` just because it happens to net to zero
function totalSavingsPasses(statsList) {
  const columns = [
    statsList.map(s => s.passDefault),
    statsList.map(s => s.passDefaultS),
    statsList.map(s => s.passAgg),
    statsList.map(s => s.passAggS),
  ];
  return columns.map(passes => ({
    saved: sumBy(passes, pass => pass.bytes.saved),
    unavailable: passes.every(pass => pass.unavailable),
  }));
}

// The all-files table’s closing `Total` row
function reportTotalRowValues(statsList) {
  const totalBefore = sumBy(statsList, s => s.passDefault.bytes.before);
  const findingsDefaultTotal = sumBy(statsList, s => s.findingsDefault);
  const findingsAggTotal = sumBy(statsList, s => s.findingsAgg);
  const [f, fs, fa, fas] = totalSavingsPasses(statsList);

  return [
    `${findingsDefaultTotal} (${findingsAggTotal})`,
    f.unavailable ? 'n/a' : formatSavingsCell(f.saved, totalBefore),
    fs.unavailable ? 'n/a' : formatSavingsCell(fs.saved, totalBefore),
    fa.unavailable ? 'n/a' : formatSavingsCell(fa.saved, totalBefore),
    fas.unavailable ? 'n/a' : formatSavingsCell(fas.saved, totalBefore),
  ];
}

// The all-files table’s `File` labels: The basename alone, unless two (or
// more) files share one—then, and only for those, one more path segment is
// added at a time until every label in the run is unique. A file that’s
// already unique at its current depth never grows further, so one long
// outlier path doesn’t drag every other row’s label out with it.
function disambiguateLabels(labels) {
  const segments = labels.map(label => (label === '(stdin)' ? [label] : toPortablePath(label).split('/')));
  const depth = segments.map(() => 1);
  const candidate = i => {
    const segs = segments[i];
    const d = Math.min(depth[i], segs.length);
    return segs.slice(segs.length - d).join('/');
  };

  for (let changed = true; changed;) {
    changed = false;
    const current = labels.map((_, i) => candidate(i));
    const counts = new Map();
    for (const label of current) counts.set(label, (counts.get(label) ?? 0) + 1);
    for (let i = 0; i < labels.length; i++) {
      if (counts.get(current[i]) > 1 && depth[i] < segments[i].length) {
        depth[i]++;
        changed = true;
      }
    }
  }

  return labels.map((label, i) => candidate(i));
}

const TABLE_GUTTER = '  ';

// `highlight`—a `Set` of column indices—colors the row’s best savings
// column(s) (see `bestSavingsColumns()`). Padding happens on the plain text
// first, and the color wraps the already-padded (fixed-width) result
// after—coloring first would fold the invisible escape-code bytes into
// `padEnd()`’s width, under-padding the cell and dragging every column
// after it out of line with the rest of the table. The final trailing
// trim moves to the last cell alone, ahead of that cell’s own color
// wrapping, since trimming the whole joined line afterward wouldn’t reach
// past a trailing reset code to the padding it’s meant to strip.
function padRow(cells, widths, highlight = new Set()) {
  const padded = cells.map((cell, i) => cell.padEnd(widths[i]));
  padded[padded.length - 1] = padded[padded.length - 1].trimEnd();
  return padded.map((cell, i) => (highlight.has(i) ? styleText(['bold', 'green'], cell) : cell)).join(TABLE_GUTTER);
}

// Finds the last `/` at or before `ceiling`, the rightmost (and so
// shortest-tail) split that still keeps the head within budget—or `null`
// when nothing splits that early, in which case the cell is left whole
// rather than cut mid-segment. The one seam both the width-floor pre-pass
// below and the actual render call through, sharing the same `ceiling`
// argument each time, so the two can never disagree on where a cell splits.
function splitCellForWrap(cell, ceiling) {
  const splitAt = cell.lastIndexOf('/', ceiling);
  if (splitAt <= 0) return null;
  return { head: cell.slice(0, splitAt + 1), tail: cell.slice(splitAt + 1) };
}

// One rendered table row, wrapping the `wrapColumn` cell at the last `/`
// that still fits within `budget`—so one very long path doesn’t widen every
// row’s `File` column past the terminal, and doesn’t break mid-segment either.
// A path with no slash short enough to fit is left to overflow that one line
// rather than get cut mid-word.
function renderTableRow(row, widths, wrapColumn, budget, highlight) {
  if (wrapColumn < 0 || row[wrapColumn].length <= widths[wrapColumn]) return [padRow(row, widths, highlight)];

  const split = splitCellForWrap(row[wrapColumn], budget);
  if (!split) return [padRow(row, widths, highlight)];

  const tailRow = [...row];
  tailRow[wrapColumn] = split.tail;
  return [split.head, padRow(tailRow, widths, highlight)];
}

// Renders `header` + `rows` as a flush, 2-space-gutter, left-aligned table—
// every column’s width is computed from its header and every row’s actual
// content, so columns can’t drift the way hand-aligned output would.
// `wrapColumn`, when given, is the column (the all-files table’s `File`)
// that gets capped to the terminal’s width and wrapped instead of widening
// the whole table to fit its longest value—but never below what a row
// actually needs post-wrap: the whole cell when it has no `/` to split on
// (a bare basename can’t be broken onto a second line), or otherwise just
// the tail `splitCellForWrap()` would leave at that same budget. Skipping
// this and clamping to the budget outright would leave a too-long tail
// unpadded, dragging every column after it out of line with the rest of the
// table—which is exactly why the render call below is passed this same
// `budget`, rather than the (possibly since-widened) final column width.
// `rowHighlights[i]`, when given, is the `Set` of column indices to color
// in `rows[i]` (see `padRow()`)—parallel to `rows`, one entry per row.
function renderReportTable(header, rows, { wrapColumn = -1, rowHighlights } = {}) {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => row[i].length)));
  let budget = -1;

  if (wrapColumn >= 0) {
    const width = process.stdout.columns || 80;
    const fixedWidth = widths.reduce((sum, w, i) => (i === wrapColumn ? sum : sum + w), 0) + TABLE_GUTTER.length * (widths.length - 1);
    budget = Math.max(width - fixedWidth, 8);
    let minRequired = header[wrapColumn].length;
    for (const row of rows) {
      const split = splitCellForWrap(row[wrapColumn], budget);
      minRequired = Math.max(minRequired, split ? split.tail.length : row[wrapColumn].length);
    }
    widths[wrapColumn] = Math.max(minRequired, Math.min(widths[wrapColumn], budget));
  }

  const lines = [padRow(header, widths)];
  rows.forEach((row, i) => lines.push(...renderTableRow(row, widths, wrapColumn, budget, rowHighlights?.[i])));
  return lines;
}

const REPORT_LEGEND = 'Legend: -f: --fix, -s: --savings-only, -a: --aggressive';

async function processCss(css, targetOptions, { isStdin, label, multi }) {
  if (values.fix) {
    const potential = targetOptions.aggressive ? null : oppositePass(css, targetOptions);
    const skippedAggressive = skippedWithAggressive(potential);

    // `savingsOnly` is the engine’s gate (see `dedupRoot()`): A withheld
    // result arrives as the untouched style sheet, with `applied` empty and
    // the declined outcome under `withheld`
    const { css: output, applied, skipped, bytes, withheld } = dedup(css, targetOptions);
    const log = isStdin ? console.error : console.log;
    // A multi-file run’s overall summary needs each file’s label restated on
    // its own summary line—by the time the run ends, the header this file
    // printed at the top of its report may already be out of scrollback
    const summaryLabel = multi ? `Summary for ${label}: ` : '';

    // Whether anything actually rode on the flag—measured by comparing
    // output against a discarded default-mode pass, never by entry counts:
    // One aggressive cross-block or alias fold can absorb what the default
    // pass would have done in more, separate merges, so a count delta can be
    // zero or negative on a run whose merges were entirely aggressive-only.
    // The count survives only as the message’s detail, where it’s positive.
    let aggressiveDiffers = false;
    let aggressiveOnly = 0;
    if (targetOptions.aggressive && applied.length) {
      const baseline = oppositePass(css, targetOptions);
      aggressiveDiffers = output !== baseline.css;
      aggressiveOnly = Math.max(applied.length - baseline.applied.length, 0);
    }

    // STDOUT must always carry the complete style sheet for STDIN input—
    // even with nothing consolidated (or everything withheld), a pipeline
    // consuming it would otherwise receive nothing and lose the CSS entirely
    if (isStdin) {
      process.stdout.write(output);
    } else if (applied.length) {
      await writeFile(label, output);
    }

    // Detail (what was skipped, and why) prints before the counts—so a long
    // skipped list can't push the outcome off-screen and out of scrollback,
    // the same order report mode already uses for its own skipped list
    logSkippedDetail(log, skipped, skippedAggressive);

    log(multi ? styleText('bold', summaryLabel.trim()) : 'Summary:');
    // Every remaining line is its own bullet, in the order a reader wants
    // them: the outcome first, then the run’s own footnotes on it (growth
    // caveat, aggressive-only warning, where it was written), then the two
    // forward-looking items (what was skipped, what `--aggressive` adds)
    if (withheld) {
      log(`* 0 declarations consolidated, ${withheld.count} withheld: \`savingsOnly\` left this file untouched—consolidating would ${formatByteDeltaClause(withheld.bytes.saved, withheld.bytes.before)}`);
    } else {
      log(`* ${applied.length} declaration${applied.length !== 1 ? 's' : ''} consolidated${applied.length ? `: ${formatAppliedReduceClause(bytes)}` : ''}`);
    }
    if (applied.length) {
      if (bytes.saved < 0) {
        log('* Worth it for maintainability (each declaration used once); skip `--fix` here if you care more about transfer size.');
      }
      if (aggressiveDiffers) {
        const share = aggressiveOnly > 0
          ? `${aggressiveOnly} of these merges ${aggressiveOnly !== 1 ? 'are' : 'is'}`
          : 'Some of these merges are';
        log(styleText('yellow', `* ${share} aggressive-only—probably, but not provably, safe. Review the diff and test the affected pages.`));
      }
      if (!isStdin) log(`* Wrote ${label}`);
      if (RE_SOURCE_MAP.test(css)) {
        log(styleText('yellow', `* ${isStdin ? 'This style sheet' : label} references a source map (\`sourceMappingURL\`); \`--fix\` doesn’t regenerate it, so the map is now stale.`));
      }
    }
    if (skipped.length) {
      log(styleText('yellow', `* ${skipped.length} finding${skipped.length !== 1 ? 's' : ''} skipped (considered unsafe to auto-merge)`));
    }
    // What `--aggressive` would actually change on disk, measured against
    // this run’s real outcome: `potential` went through the same
    // `savingsOnly` gate as this run, so an aggressive result the re-run
    // would withhold compares equal to the untouched style sheet and earns
    // no hint
    const { aggExtra, aggExtraSaved, aggDiffers } = computeAggressivePreview(potential, output, applied, bytes);
    if (aggDiffers) log(formatAggressivePreviewLine(aggExtra, aggExtraSaved, bytes.before, bytes.saved));

    return {
      exitFailure: skipped.length > 0 || Boolean(withheld),
      errored: false,
      stats: buildStats({ findings: null, applied, skipped, bytes, withheld, aggExtra, aggExtraSaved, aggDiffers }),
    };
  }

  // Report mode always compares the default and aggressive variants side by
  // side (see the summary table below)—`--aggressive`/`--savings-only` name
  // table columns here, not a mode to switch into (bare `--aggressive`
  // without `--fix` is rejected above, before this point, for exactly that
  // reason). The four `dedup()` combinations this needs are deferred past
  // the all-clean shortcut just below, though: For the common case of
  // scanning a directory of already-clean files, there’s nothing for them
  // to find, so running them at all would just be four wasted consolidation
  // passes over a style sheet already known to have no duplicates.
  const findingsDefault = analyze(css, { ...targetOptions, aggressive: false }).findings;
  const findingsAgg = analyze(css, { ...targetOptions, aggressive: true }).findings;

  if (!findingsDefault.length && !findingsAgg.length) {
    console.log('No duplicate declarations found.');
    const before = Buffer.byteLength(css, 'utf8');
    const zeroPass = { bytes: { before, after: before, saved: 0 }, applied: [] };
    return {
      exitFailure: false,
      errored: false,
      stats: buildReportStats({ label, findingsDefault: 0, findingsAgg: 0, passDefault: zeroPass, passDefaultS: zeroPass, passAgg: zeroPass, passAggS: zeroPass }),
    };
  }

  const { passDefault, passDefaultS, passAgg, passAggS } = computeReportPasses(css, targetOptions);

  // A style sheet clean under default rules but with something aggressive
  // mode would additionally catch (the table’s `Findings -f (-a)` column
  // showing e.g. `0 (1)`) still gets its one duplicate group listed in
  // detail—otherwise the table’s aggressive columns would quote a byte
  // figure for a finding the reader can’t actually see anywhere
  if (findingsDefault.length) printFindings(findingsDefault);
  else if (findingsAgg.length) printFindings(findingsAgg);

  // Findings above don't distinguish safe from unsafe—without this, a
  // duplicate group that `--fix` would just skip (see its own safety
  // checks) reads as if nothing follows from it at all, when there’s a
  // concrete, explainable reason it wasn't offered as a `--fix` win
  logSkippedDetail(console.log, passDefault.skipped, skippedWithAggressive(passAgg));

  // Summary and `--fix` payoff close each style sheet’s report. The label is
  // always restated here (even for a single file): by the time a long run
  // ends, the per-file header printed above may already be out of scrollback.
  console.log(styleText('bold', `Summary for ${label}:`));
  const stats = buildReportStats({ label, findingsDefault: findingsDefault.length, findingsAgg: findingsAgg.length, passDefault, passDefaultS, passAgg, passAggS });
  const header = ['Findings -f (-a)', 'Savings with: -f', '-f -s', '-f -a', '-f -a -s'];
  const rowHighlights = [shiftColumns(bestSavingsColumns(reportSavingsPasses(stats)), 1)];
  for (const line of renderReportTable(header, [reportRowValues(stats)], { rowHighlights })) console.log(line);
  console.log(REPORT_LEGEND);

  return {
    exitFailure: findingsDefault.length > 0,
    errored: false,
    stats,
  };
}

function sumBy(list, fn) {
  return list.reduce((total, item) => total + fn(item), 0);
}

// A byte magnitude against the overall summary’s own total original size
// rather than one file’s—there’s no single “this file” to express a
// percentage of once several files’ byte deltas are combined. The explicit
// “overall” avoids a mismatch reading as an error: A file’s own summary a
// few lines up already showed this same byte count against a different
// (smaller) denominator—its own size, not the whole run’s.
function formatBytesShareOfTotal(bytesAbs, totalBefore) {
  const percent = totalBefore ? (bytesAbs / totalBefore) * 100 : 0;
  return `${bytesAbs.toLocaleString()} bytes (${percent.toFixed(1)}% overall)`;
}

// Rolls up every file’s `stats` into one closing report, so a terminal that
// only shows the last N lines of a multi-file run doesn’t leave the final
// file’s own summary looking like it spoke for the whole run
function printOverallSummary(results, { fix }) {
  const ok = results.filter(result => result.stats);
  const errored = results.length - ok.length;
  const erroredNote = errored ? ` (${errored} file${errored !== 1 ? 's' : ''} could not be processed; see errors above)` : '';

  console.log('');
  console.log(styleText('bold', `Summary for all files:${erroredNote}`));

  if (!fix) {
    // Report mode’s all-files table is the per-file summary table again,
    // with one row per file plus a closing `Total` row—no separate
    // “further with `--aggressive`” bullet needed, since aggressive is
    // already its own pair of columns rather than a mode to switch into
    const labels = disambiguateLabels(ok.map(result => result.stats.label));
    const header = ['File', 'Findings -f (-a)', 'Savings with: -f', '-f -s', '-f -a', '-f -a -s'];
    const rows = ok.map((result, i) => [labels[i], ...reportRowValues(result.stats)]);
    const rowHighlights = ok.map(result => shiftColumns(bestSavingsColumns(reportSavingsPasses(result.stats)), 2));
    if (ok.length) {
      const statsList = ok.map(result => result.stats);
      rows.push(['Total', ...reportTotalRowValues(statsList)]);
      rowHighlights.push(shiftColumns(bestSavingsColumns(totalSavingsPasses(statsList)), 2));
    }
    for (const line of renderReportTable(header, rows, { wrapColumn: 0, rowHighlights })) console.log(line);
    console.log(REPORT_LEGEND);
    return;
  }

  // Every percentage below is against this—the combined original size of
  // every successfully processed file—since there’s no single file left to
  // relate a byte count to once the run’s totals are combined
  const totalBeforeAll = sumBy(ok, result => result.stats.bytesBefore);

  const filesShrink = ok.filter(result => result.stats.bytesSaved > 0);
  const filesGrow = ok.filter(result => result.stats.bytesSaved < 0);
  const shrinkTotal = sumBy(filesShrink, result => result.stats.bytesSaved);
  const growTotal = Math.abs(sumBy(filesGrow, result => result.stats.bytesSaved));
  const withheldFiles = ok.filter(result => result.stats.withheldCount > 0);
  const withheldGrowthTotal = sumBy(withheldFiles, result => result.stats.withheldGrowth);
  const aggFiles = ok.filter(result => result.stats.aggDiffers);
  const aggFilesShrink = aggFiles.filter(result => result.stats.aggExtraSaved > 0);
  const aggFilesGrow = aggFiles.filter(result => result.stats.aggExtraSaved < 0);
  const aggShrinkTotal = sumBy(aggFilesShrink, result => result.stats.aggExtraSaved);
  const aggGrowTotal = Math.abs(sumBy(aggFilesGrow, result => result.stats.aggExtraSaved));
  // What every file’s outcome adds up to if `--fix --aggressive` ran across
  // the whole set, for the aggressive bullet’s trailing total note—the
  // base run’s own net plus what aggressive adds on top, each already
  // computed above (`aggExtraSaved` is 0 for a file aggressive doesn’t
  // affect, so `aggShrinkTotal - aggGrowTotal` already nets to 0 there)
  const aggNetAll = (shrinkTotal - growTotal) + (aggShrinkTotal - aggGrowTotal);

  const totalApplied = sumBy(ok, result => result.stats.applied);
  const totalSkipped = sumBy(ok, result => result.stats.skipped);

  const outcome = formatOutcomeBullet({
    countLabel: `${totalApplied} declaration${totalApplied !== 1 ? 's' : ''} consolidated`,
    tense: 'done',
    filesShrinkLen: filesShrink.length,
    shrinkTotal,
    filesGrowLen: filesGrow.length,
    growTotal,
    totalBefore: totalBeforeAll,
    skipFlag: '--fix --savings-only',
  });
  if (outcome) {
    for (const line of outcome) console.log(line);
  }
  if (totalSkipped) {
    console.log(styleText('yellow', `* ${totalSkipped} finding${totalSkipped !== 1 ? 's' : ''} skipped (considered unsafe to auto-merge)`));
  }
  if (withheldFiles.length) {
    console.log(`* ${withheldFiles.length} file${withheldFiles.length !== 1 ? 's' : ''} left untouched by \`--savings-only\`—consolidating would have made ${withheldFiles.length !== 1 ? 'them' : 'it'} ${formatBytesShareOfTotal(withheldGrowthTotal, totalBeforeAll)} bigger in total`);
  }

  // Always a preview (never yet applied) of what `--fix --aggressive` would
  // add on top of the `--fix` run that just happened
  if (aggFiles.length) {
    const extra = sumBy(aggFiles, result => result.stats.aggExtra);
    const aggOutcome = formatOutcomeBullet({
      countLabel: `${extra > 0 ? `${extra} more finding${extra !== 1 ? 's' : ''}` : 'Further consolidation'} in aggressive mode`,
      tense: 'todo',
      filesShrinkLen: aggFilesShrink.length,
      shrinkTotal: aggShrinkTotal,
      filesGrowLen: aggFilesGrow.length,
      growTotal: aggGrowTotal,
      totalBefore: totalBeforeAll,
      flag: '--fix --aggressive',
      skipFlag: '--fix --aggressive --savings-only',
      more: true,
      aggregateNote: formatAggregateTotalNote(aggNetAll, totalBeforeAll),
    });
    if (aggOutcome) {
      for (const line of aggOutcome) console.log(line);
    }
  }
}

async function main() {
  const config = await loadConfig(values.config);
  const options = {
    ignoreSelectors: [
      ...(config.ignoreSelectors ?? []),
      ...values['ignore-selector'].map(pattern => new RegExp(pattern, 'i')),
    ],
    ignoreSelectorsDefaults: values['no-ignore-selectors-defaults'] ? false : (config.ignoreSelectorsDefaults ?? true),
    aggressive: values.aggressive || (config.aggressive ?? false),
    savingsOnly: values['savings-only'] || (config.savingsOnly ?? false),
  };
  const ignorePathPatterns = [
    ...(config.ignorePaths ?? []),
    ...values['ignore-path'].map(pattern => new RegExp(pattern, 'i')),
  ];
  // `--no-exit-zero` wins over a project’s own `exitZero: true`, the same
  // way `--no-ignore-selectors-defaults` wins over that config default—both
  // exist to force a config-set default back off for one run
  const exitZero = values['no-exit-zero'] ? false : values['exit-zero'] || (config.exitZero ?? false);

  // `stat()`/`readdir()` inside `expandTargets` aren’t wrapped there, so a
  // missing path or an unreadable directory would otherwise surface as a
  // raw stack trace via the top-level `catch` below instead of the same
  // clean, styled message every other resolution error on this page gets
  let files, discovered;
  try {
    ({ files, discovered } = await expandTargets(positionals, ignorePathPatterns));
  } catch (err) {
    console.error(styleText('red', `Could not resolve ${positionals.join(', ')}: ${err.message}`));
    process.exit(1);
  }
  if (!files.length) {
    if (discovered > 0) {
      console.error(`All ${discovered} \`.css\` file${discovered !== 1 ? 's' : ''} found under ${positionals.join(', ')} ${discovered !== 1 ? 'were' : 'was'} excluded by \`--ignore-path\`.`);
    } else {
      console.error(`No \`.css\` files found under ${positionals.join(', ')}.`);
    }
    process.exit(1);
  }

  const multi = files.length > 1;
  const prefetched = await prefetchContents(files);
  let failed = false;
  const results = [];

  for (const [index, file] of files.entries()) {
    // A blank line between per-file reports, so each file’s closing summary
    // is visually separated from the next file’s header
    if (multi && index > 0) console.log('');
    const result = await processTarget(file, options, { multi }, prefetched[index]);
    // `--exit-zero` only forgives findings that still need a human look
    // (skipped as unsafe, or withheld by `--savings-only`)—a file that
    // couldn't be read or parsed in the first place is a real failure, and
    // stays one regardless of the flag
    if (result.exitFailure && !(exitZero && !result.errored)) failed = true;
    results.push(result);
  }

  if (multi) printOverallSummary(results, { fix: values.fix });

  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});