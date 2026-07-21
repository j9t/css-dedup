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
  -a, --aggressive                 Also allow merges that are probably—but not provably—safe; on its own this widens the report, with \`--fix\` it applies the merges (test afterwards)
  -s, --savings-only               With \`--fix\`: Leave a file untouched when its consolidation would make it bigger, not smaller (checked per file)
  -i, --ignore-selector <pattern>  Regular expression for selectors to exclude from analysis (repeatable)
  -p, --ignore-path <pattern>      Regular expression tested against each file’s path, relative to the working directory; a match excludes the file (repeatable)
  -n, --no-ignore-selectors-defaults  Disable the built-in selector hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -c, --config <path>              Path to a config file (defaults to \`css-dedup.config.js\` in the working directory, if present)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

if (positionals.includes('-') && positionals.length > 1) {
  console.error('Cannot combine STDIN (`-`) with other file arguments.');
  process.exit(1);
}

// A write policy needs a write mode: Report mode never touches a file, so a
// bare `--savings-only` could only sit inert and mislead
if (values['savings-only'] && !values.fix) {
  console.error('`--savings-only` only applies together with `--fix` (report mode doesn’t write).');
  process.exit(1);
}

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

  // Normalize to `/` before testing, regardless of host OS
  const files = expanded.filter(file => file === '-' || !ignorePathPatterns.some(pattern => pattern.test(relative(process.cwd(), file).split(sep).join('/'))));
  return { files, discovered: expanded.length };
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
  const percent = before ? (Math.abs(totalSaved) / before) * 100 : 0;
  const sign = totalSaved >= 0 ? '-' : '+';
  return ` (total: ${sign}${Math.abs(totalSaved).toLocaleString()} bytes / ${sign}${percent.toFixed(1)}%)`;
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
// are additional on top of the base bullet printed just above. `showNet`
// suppresses the mixed shape’s own “(total: …)” net of just its two
// figures—the `--aggressive` caller passes `false` there and appends its
// own, more useful net (against the whole run, not just the files
// aggressive affects) via `formatAggregateTotalNote()` instead; two
// differently-scoped nets both labeled “total:” back to back would read as
// a contradiction.
function formatOutcomeBullet({ countLabel, tense, filesShrinkLen, shrinkTotal, filesGrowLen, growTotal, totalBefore, flag, skipFlag, more = false, showNet = true }) {
  const s = n => n !== 1 ? 's' : '';
  const reduce = tense === 'done' ? 'Reduced' : 'Reduce';
  const flagClause = tense === 'done' ? '' : ` with \`${flag}\``;

  if (filesShrinkLen && !filesGrowLen) {
    const saved = tense === 'done' ? 'saved' : 'save';
    return [`* ${countLabel}: ${reduce} duplication and ${saved} ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })}${flagClause}`];
  }
  if (!filesShrinkLen && filesGrowLen) {
    const grew = tense === 'done' ? 'grew' : 'grow';
    const conjunction = tense === 'done' ? 'and' : 'but';
    return [`* ${countLabel}: ${reduce} duplication ${conjunction} ${grew} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}${flagClause}`];
  }
  if (filesShrinkLen && filesGrowLen) {
    const net = shrinkTotal - growTotal;
    const netNote = showNet ? ` (${formatOverallNet(net, totalBefore)})` : '';
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

async function processCss(css, targetOptions, { isStdin, label, multi }) {
  const potential = targetOptions.aggressive ? null : oppositePass(css, targetOptions);
  const skippedAggressive = skippedWithAggressive(potential);

  if (values.fix) {
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

  const { findings } = analyze(css, targetOptions);

  if (!findings.length) {
    const note = potential?.applied.length
      ? ` With \`--aggressive\`: ${potential.applied.length} consolidation${potential.applied.length !== 1 ? 's' : ''} possible.`
      : '';
    console.log(`No duplicate declarations found.${note}`);
    return {
      exitFailure: false,
      errored: false,
      stats: buildStats({
        findings: 0,
        applied: [],
        skipped: [],
        bytes: { before: Buffer.byteLength(css, 'utf8'), saved: 0 },
        withheld: null,
        aggExtra: potential?.applied.length ?? 0,
        aggExtraSaved: potential?.bytes.saved ?? 0,
        aggDiffers: Boolean(potential?.applied.length),
      }),
    };
  }

  printFindings(findings);

  // A dry-run consolidation, purely to report the payoff—same safety rules
  // as `--fix`, just discarded instead of written
  const { css: cssDryRun, applied, skipped, bytes, withheld } = dedup(css, targetOptions);

  // Findings above don't distinguish safe from unsafe—without this, a
  // duplicate group that `--fix` would just skip (see its own safety
  // checks) reads as if nothing follows from it at all, when there’s a
  // concrete, explainable reason it wasn't offered as a `--fix` win
  logSkippedDetail(console.log, skipped, skippedAggressive);

  // Summary and `--fix` payoff close each style sheet’s report. With a
  // single file that’s unambiguous on its own; with several, the filename
  // is restated here, too—by the time a long multi-file run ends, the
  // per-file header above may already be out of scrollback.
  console.log(styleText('bold', multi ? `Summary for ${label}:` : 'Summary:'));
  if (withheld) {
    // The dry run went through the engine’s `savingsOnly` gate (set via the
    // config file—the CLI flag itself requires `--fix`), so `--fix` here
    // would decline to write; say so instead of promising a change
    console.log(`* ${findings.length} finding${findings.length !== 1 ? 's' : ''}: \`savingsOnly\` leaves this file untouched—consolidating would ${formatByteDeltaClause(withheld.bytes.saved, withheld.bytes.before)} with \`--fix\``);
  } else if (applied.length) {
    console.log(`* ${findings.length} finding${findings.length !== 1 ? 's' : ''}: ${formatReduceClause(bytes.saved, bytes.before)} with \`--fix\``);
    if (bytes.saved < 0) {
      console.log(styleText('dim', '  (worth it for maintainability, not for transfer size)'));
    }
  }
  // Gated on the outputs differing, never on entry counts: One aggressive
  // cross-block or alias fold can absorb what the default pass would have
  // done in more, separate merges, so a count delta can be zero or negative
  // on exactly the files where `--aggressive` changes (and saves) the most
  const { aggExtra, aggExtraSaved, aggDiffers } = computeAggressivePreview(potential, cssDryRun, applied, bytes);
  if (aggDiffers) console.log(formatAggressivePreviewLine(aggExtra, aggExtraSaved, bytes.before, bytes.saved));

  return {
    exitFailure: true,
    errored: false,
    stats: buildStats({ findings: findings.length, applied, skipped, bytes, withheld, aggExtra, aggExtraSaved, aggDiffers }),
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
  // the whole set—unaffected files keep their base `bytesSaved`, since
  // `aggExtraSaved` is 0 where aggressive doesn’t differ—for the aggressive
  // bullet’s trailing total note, so a reader isn’t left to add it to the
  // base bullet above themselves
  const aggNetAll = sumBy(ok, result => result.stats.bytesSaved + result.stats.aggExtraSaved);

  console.log(styleText('bold', `Summary for all files:${erroredNote}`));

  if (fix) {
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
  } else {
    if (withheldFiles.length) {
      console.log(`\`--fix\` would leave ${withheldFiles.length} file${withheldFiles.length !== 1 ? 's' : ''} untouched—\`savingsOnly\` is set, and consolidating would make ${withheldFiles.length !== 1 ? 'them' : 'it'} ${formatBytesShareOfTotal(withheldGrowthTotal, totalBeforeAll)} bigger.`);
    }
    const totalFindings = sumBy(ok, result => result.stats.findings);
    const outcome = formatOutcomeBullet({
      countLabel: `${totalFindings} finding${totalFindings !== 1 ? 's' : ''}`,
      tense: 'todo',
      filesShrinkLen: filesShrink.length,
      shrinkTotal,
      filesGrowLen: filesGrow.length,
      growTotal,
      totalBefore: totalBeforeAll,
      flag: '--fix',
      skipFlag: '--fix --savings-only',
    });
    if (outcome) {
      for (const line of outcome) console.log(line);
    }
  }

  // Always a preview (never yet applied), regardless of whether the base
  // run above was `--fix` or report mode—so this block, unlike the two
  // above, doesn’t vary by `fix` and only needs to run once
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
      showNet: false,
    });
    if (aggOutcome) {
      aggOutcome[0] += formatAggregateTotalNote(aggNetAll, totalBeforeAll);
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

  const { files, discovered } = await expandTargets(positionals, ignorePathPatterns);
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
    if (result.exitFailure) failed = true;
    results.push(result);
  }

  if (multi) printOverallSummary(results, { fix: values.fix });

  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});