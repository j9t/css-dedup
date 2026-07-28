#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { resolve, relative, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeFilePass, describePassError, aggressiveKeySpelling } from './file-pass.js';
import { runPool, shouldParallelize } from './pool.js';

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
  quiet: { type: 'boolean', short: 'q', default: false },
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
  -q, --quiet                      Suppress the per-file findings/skipped-group detail listing (and its file-path header); summaries still print
  -c, --config <path>              Path to a config file (defaults to \`css-dedup.config.js\` in the working directory, if present)
  -h, --help                       Show this help

Environment:
  CSS_DEDUP_WORKERS  Number of worker threads for multi-file runs (\`0\` or \`1\` to process files one at a time); defaults to one per core, minus one for the main thread`);
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

// The “in aggressive mode” preview bullet, shared by `--fix` and report
// mode—always still-hypothetical, so always `formatReduceClause()`’s
// present-tense phrasing even inside a `--fix` run. `baseSaved` is the base
// `--fix` bullet’s own outcome, needed only to spell out the combined total
// in the trailing note—the bullet’s main clause still quotes `aggExtraSaved`
// on its own.
function formatAggressivePreviewLine(aggExtra, aggExtraSaved, before, baseSaved) {
  const label = aggExtra > 0 ? `${aggExtra} more declaration${aggExtra !== 1 ? 's' : ''}` : 'Further consolidation';
  return `* ${label} in aggressive mode: ${formatReduceClause(aggExtraSaved, before, true)} with \`--fix --aggressive\`${formatAggregateTotalNote(baseSaved + aggExtraSaved, before)}`;
}

// The per-file stats object the overall summary aggregates across a
// multi-file run—one shape shared by all three of `processCss()`’s return
// sites (the zero-findings shortcut, `--fix` mode, and report mode)
function buildStats({ findings, applied, skipped, bytes, withheld, aggExtra, aggExtraSaved, aggDiffers }) {
  return {
    findings,
    applied,
    skipped,
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

// The label a target is reported under: its resolved path, or `(stdin)`
function targetLabel(file) {
  return file === '-' ? '(stdin)' : resolve(file);
}

// Reads one target, returning the same `{ css }` / `{ err }` shape
// `prefetchContents()` produces—so a target that was prefetched and one that
// wasn’t (STDIN) reach `renderTarget()` looking identical
async function readTarget(file, preread) {
  if (preread) return preread;
  try {
    return { css: file === '-' ? await readStdin() : await readFile(resolve(file), 'utf8') };
  } catch (err) {
    return { err };
  }
}

// Prints one target’s report from an already-computed pass (or from whatever
// replaced it), and returns `{ exitFailure, errored, stats }`: `exitFailure`
// is whether it should count against the process’s exit code, `errored`
// whether it never produced stats (read/parse failure), and `stats` the
// per-file numbers the overall summary aggregates across a multi-file run.
//
// Every line of a run’s output goes through here, on the main thread, in file
// order—whether the pass itself ran here or on a worker.
function renderTarget(file, { multi }, outcome) {
  const isStdin = file === '-';
  const label = targetLabel(file);

  if (multi && !values.quiet) console.log(styleText('bold', label));

  if (outcome.readError) {
    console.error(styleText('red', `Could not read ${label}: ${outcome.readError.message}`));
    return RESULT_ERRORED;
  }
  // A file that fails to parse (invalid CSS, or a non-standard dialect
  // PostCSS doesn’t accept) shouldn’t take the rest of the run down with it
  if (outcome.error) {
    if (outcome.error.syntax) {
      console.error(styleText('red', outcome.error.message));
      console.error(outcome.error.sourceCode);
    } else {
      console.error(styleText('red', `Error processing ${label}: ${outcome.error.message}`));
    }
    return RESULT_ERRORED;
  }

  return renderFilePass(outcome.payload, { isStdin, label, multi });
}

// Computes one target’s pass on this thread, in the same `{ payload }` /
// `{ error }` shape a worker sends back
async function runFilePass(css, options, { isStdin, label }) {
  try {
    return { payload: await computeFilePass(css, options, { fix: values.fix, quiet: values.quiet, isStdin, label }) };
  } catch (err) {
    return { error: describePassError(err) };
  }
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
  if (saved === 0) return `${formatSize(0)} (0%)`;
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

// The report table’s per-row data: the four already-slimmed passes
// `computeFilePass()` produced (see `slimPass()` there), under the label this
// thread knows the file by
function buildReportStats(label, { findingsDefault, findingsAgg, passes }) {
  return { label, findingsDefault, findingsAgg, ...passes };
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

const REPORT_LEGEND = 'Legend: -f: --fix, -a: --aggressive, -s: --savings-only';

// Prints one file’s report from the payload `computeFilePass()` produced,
// wherever it ran. Everything here is formatting and terminal state—no
// consolidation, no file I/O beyond STDIN’s pass-through below.
function renderFilePass(payload, { isStdin, label, multi }) {
  if (payload.mode === 'fix') {
    const { applied, skipped, skippedAggressive, bytes, withheld, sourceMapStale, aggressiveDiffers, aggressiveOnly, aggExtra, aggExtraSaved, aggDiffers } = payload;
    const log = isStdin ? console.error : console.log;
    // A multi-file run’s overall summary needs each file’s label restated on
    // its own summary line—by the time the run ends, the header this file
    // printed at the top of its report may already be out of scrollback
    const summaryLabel = multi ? `Summary for ${label}: ` : '';

    // The consolidated style sheet for STDIN input, which has no file to be
    // rewritten in place (see `computeFixPass()`). It goes out before any of
    // the status lines below, which is also why those go to STDERR here: so
    // STDOUT stays a clean, pipeable style sheet.
    if (payload.stdout !== null) process.stdout.write(payload.stdout);

    // Detail (what was skipped, and why) prints before the counts—so a long
    // skipped list can’t push the outcome off-screen and out of scrollback,
    // the same order report mode already uses for its own skipped list.
    // `--quiet` drops it: The summary bullets below already restate the
    // skipped count on their own.
    if (!values.quiet) logSkippedDetail(log, skipped, skippedAggressive);

    log(multi ? styleText('bold', summaryLabel.trim()) : 'Summary:');
    // Every remaining line is its own bullet, in the order a reader wants
    // them: the outcome first, then the run’s own footnotes on it (growth
    // caveat, aggressive-only warning, where it was written), then the two
    // forward-looking items (what was skipped, what `--aggressive` adds)
    if (withheld) {
      log(`* 0 declarations consolidated, ${withheld.count} withheld: \`savingsOnly\` left this file untouched—consolidating would ${formatByteDeltaClause(withheld.bytes.saved, withheld.bytes.before)}`);
    } else {
      log(`* ${applied} declaration${applied !== 1 ? 's' : ''} consolidated${applied ? `: ${formatAppliedReduceClause(bytes)}` : ''}`);
    }
    if (applied) {
      if (bytes.saved < 0) {
        log('* Worth it for maintainability (each declaration used once); skip `--fix` here if you care more about transfer size.');
      }
      if (aggressiveDiffers) {
        const share = aggressiveOnly > 0
          ? `${aggressiveOnly} of these merges ${aggressiveOnly !== 1 ? 'are' : 'is'}`
          : 'Some of these merges are';
        log(styleText('yellow', `* ${share} aggressive-only—probably, but not provably, safe. Review the diff and test the affected pages.`));
      }
      if (payload.wrote) log(`* Wrote ${label}`);
      if (sourceMapStale) {
        log(styleText('yellow', `* ${isStdin ? 'This style sheet' : label} references a source map (\`sourceMappingURL\`); \`--fix\` doesn’t regenerate it, so the map no longer describes this file and should be rebuilt. To keep maps intact, run CSS Dedup before your minifier, or in-pipeline via \`css-dedup/plugin\`.`));
      }
    }
    if (skipped.length) {
      log(styleText('yellow', `* ${skipped.length} finding${skipped.length !== 1 ? 's' : ''} skipped (considered unsafe to auto-merge)`));
    }
    // What `--aggressive` would actually change on disk, measured against
    // this run’s real outcome: the discarded opposite-mode pass it was
    // compared against went through the same `savingsOnly` gate as this run,
    // so an aggressive result the re-run would withhold compares equal to the
    // untouched style sheet and earns no hint
    if (aggDiffers) log(formatAggressivePreviewLine(aggExtra, aggExtraSaved, bytes.before, bytes.saved));

    return {
      exitFailure: skipped.length > 0 || Boolean(withheld),
      errored: false,
      stats: buildStats({ findings: null, applied, skipped: skipped.length, bytes, withheld, aggExtra, aggExtraSaved, aggDiffers }),
    };
  }

  if (payload.clean) {
    console.log('No duplicate declarations found.');
    return { exitFailure: false, errored: false, stats: buildReportStats(label, payload) };
  }

  // `--quiet` drops both detail blocks below: The report table that follows
  // already gives the finding/savings counts on their own—which is why
  // `computeReportPass()` leaves them out of the payload entirely then
  if (payload.findings) {
    printFindings(payload.findings);

    // Findings above don’t distinguish safe from unsafe—without this, a
    // duplicate group that `--fix` would just skip (see its own safety
    // checks) reads as if nothing follows from it at all, when there’s a
    // concrete, explainable reason it wasn’t offered as a `--fix` win
    logSkippedDetail(console.log, payload.skipped, payload.skippedAggressive);
  }

  // Summary and `--fix` payoff close each style sheet’s report. The label is
  // always restated here (even for a single file): by the time a long run
  // ends, the per-file header printed above may already be out of scrollback.
  console.log(styleText('bold', `Summary for ${label}:`));
  const stats = buildReportStats(label, payload);
  const header = ['Findings -f (-a)', 'Savings with: -f', '-f -s', '-f -a', '-f -a -s'];
  const rowHighlights = [shiftColumns(bestSavingsColumns(reportSavingsPasses(stats)), 1)];
  for (const line of renderReportTable(header, [reportRowValues(stats)], { rowHighlights })) console.log(line);
  console.log(REPORT_LEGEND);

  return {
    exitFailure: payload.findingsDefault > 0,
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
      countLabel: `${extra > 0 ? `${extra} more declaration${extra !== 1 ? 's' : ''}` : 'Further consolidation'} in aggressive mode`,
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
  const results = [];

  // One target’s rendering, in file order—the single place a result reaches
  // the terminal, whether its pass ran here or on a worker
  const render = (index, outcome) => {
    // A blank line between per-file reports, so each file’s closing summary
    // is visually separated from the next file’s header
    if (multi && index > 0) console.log('');
    results.push(renderTarget(files[index], { multi }, outcome));
  };

  // A run big enough to pay for a pool computes its files across worker
  // threads; anything smaller (and STDIN, which never reaches here alongside
  // other targets) stays on this one. Both paths run the same
  // `computeFilePass()` over the same input and hand the same payload to the
  // same renderer, so the two differ in timing only.
  const totalSize = sumBy(prefetched, entry => entry?.css?.length ?? 0);
  const parallel = !files.includes('-') && shouldParallelize(files.length, totalSize);

  if (parallel) {
    const slots = files.map((file, index) => {
      const preread = prefetched[index];
      if (preread.err) return { outcome: { readError: preread.err } };
      return { css: preread.css, label: targetLabel(file) };
    });
    const settings = { options, fix: values.fix, quiet: values.quiet };
    // Nothing has been printed at this point, so a pool that can’t start at
    // all (see `runPool()`) can still fall through to the sequential path
    // without having produced half a run’s output first
    try {
      await runPool(slots, settings, render);
    } catch (err) {
      if (results.length) throw err;
      await runSequentially(files, options, prefetched, render);
    }
  } else {
    await runSequentially(files, options, prefetched, render);
  }

  if (multi) printOverallSummary(results, { fix: values.fix });

  // `--exit-zero` never changes what got merged—only what a finding
  // (skipped as unsafe, or withheld by `--savings-only`) does to the exit
  // code. A file that couldn’t be read or parsed is a real failure, and
  // stays one regardless of the flag.
  if (results.some(result => result.exitFailure && !(exitZero && !result.errored))) process.exitCode = 1;
}

// One file at a time on this thread: compute, then render, then move on—so a
// long run’s output appears as it goes rather than all at the end
async function runSequentially(files, options, prefetched, render) {
  for (const [index, file] of files.entries()) {
    const isStdin = file === '-';
    const read = await readTarget(file, prefetched[index]);
    if (read.err) {
      render(index, { readError: read.err });
      continue;
    }
    render(index, await runFilePass(read.css, options, { isStdin, label: targetLabel(file) }));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});