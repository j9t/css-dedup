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
  -n, --no-ignore-selectors-defaults  Disable the built-in selector-hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -c, --config <path>              Path to a config file (defaults to \`css-dedup.config.js\` in the working directory, if present)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

if (positionals.includes('-') && positionals.length > 1) {
  console.error('Cannot combine stdin (`-`) with other file arguments.');
  process.exit(1);
}

// A write policy needs a write mode: Report mode never touches a file, so a
// bare `--savings-only` could only sit inert and mislead
if (values['savings-only'] && !values.fix) {
  console.error('`--savings-only` only applies together with `--fix` (report mode never writes).');
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

function formatBytesSummary({ before, after, saved }) {
  const percent = before ? (saved / before) * 100 : 0;
  const sign = saved >= 0 ? '-' : '+';
  return `${before.toLocaleString()} → ${after.toLocaleString()} bytes (${sign}${Math.abs(saved).toLocaleString()} B, ${sign}${Math.abs(percent).toFixed(1)}%)`;
}

// The magnitude of a byte delta as “N bytes (P%)”, sign-blind—used for
// savings and growth alike, with the direction spelled out in the
// surrounding sentence. (Growth is real: A merged selector list can cost
// more bytes than the declaration it removes saves, so consolidation isn’t
// always a net win for transfer size—only ever for maintainability. Surface
// that plainly rather than silently reporting negative “savings.”)
function formatBytesShare(bytes) {
  const percent = bytes.before ? (Math.abs(bytes.saved) / bytes.before) * 100 : 0;
  return `${Math.abs(bytes.saved).toLocaleString()} bytes (${percent.toFixed(1)}%)`;
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

// Processes one target (a file path, or `-` for STDIN) and returns whether
// it should count against the process’s exit code. In `--fix` mode, STDIN
// is a special case: There is no file to rewrite in place, so the
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
      return true;
    }
    css = preread.css;
  } else {
    try {
      css = isStdin ? await readStdin() : await readFile(label, 'utf8');
    } catch (err) {
      console.error(styleText('red', `Could not read ${label}: ${err.message}`));
      return true;
    }
  }

  const targetOptions = { ...options, from: isStdin ? undefined : label };

  // A file that fails to parse (invalid CSS, or a non-standard dialect
  // PostCSS doesn’t accept) shouldn’t take the rest of the run down with it
  try {
    return await processCss(css, targetOptions, { isStdin, label });
  } catch (err) {
    if (err.name === 'CssSyntaxError') {
      console.error(styleText('red', err.message));
      console.error(err.showSourceCode());
    } else {
      console.error(styleText('red', `Error processing ${label}: ${err.message}`));
    }
    return true;
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

async function processCss(css, targetOptions, { isStdin, label }) {
  const potential = targetOptions.aggressive ? null : oppositePass(css, targetOptions);
  const skippedAggressive = skippedWithAggressive(potential);

  if (values.fix) {
    // `savingsOnly` is the engine’s gate (see `dedupRoot()`): A withheld
    // result arrives as the untouched style sheet, with `applied` empty and
    // the declined outcome under `withheld`
    const { css: output, applied, skipped, bytes, withheld } = dedup(css, targetOptions);
    const log = isStdin ? console.error : console.log;

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
    if (skipped.length) {
      log(styleText('yellow', `${skipped.length} duplicate group${skipped.length !== 1 ? 's' : ''} considered unsafe to auto-merge:`));
      for (const item of skipped) {
        log(formatSkippedLine(item, skippedAggressive));
      }
      log('');
    }

    const skippedNote = skipped.length ? ' (considered unsafe to auto-merge)' : '';
    if (withheld) {
      log(`${styleText('green', '0 consolidated')}, ${styleText('yellow', `${withheld.count} withheld`)} (consolidating would make the file ${formatBytesShare(withheld.bytes)} bigger—\`--savings-only\`), ${styleText('yellow', `${skipped.length} skipped`)}${skippedNote}`);
    } else {
      log(`${styleText('green', `${applied.length} consolidated`)}, ${styleText('yellow', `${skipped.length} skipped`)}${skippedNote}`);
    }
    if (applied.length) {
      log(`\n${formatBytesSummary(bytes)}`);
      if (bytes.saved < 0) {
        log(styleText('yellow', `Note: This consolidation makes the file ${formatBytesShare(bytes)} bigger, not smaller—the merged selector list costs more than the removed declaration(s) save. Still worth doing for maintainability (using each declaration just once); skip \`--fix\` here if you care more about transfer size.`));
      }
      if (!isStdin) log(`Wrote ${label}`);
      if (RE_SOURCE_MAP.test(css)) {
        log(styleText('yellow', `Note: ${isStdin ? 'this style sheet' : label} references a source map (\`sourceMappingURL\`); \`--fix\` doesn’t regenerate it, so the map is now stale.`));
      }
    }
    // What `--aggressive` would actually change on disk, measured against
    // this run’s real outcome: `potential` went through the same
    // `savingsOnly` gate as this run, so an aggressive result the re-run
    // would withhold compares equal to the untouched style sheet and earns
    // no hint
    if (potential && potential.css !== output) {
      const extra = potential.applied.length - applied.length;
      const extraSaved = bytes.after - potential.bytes.after;
      const savings = extraSaved > 0 ? `, saving another ${extraSaved.toLocaleString()} bytes`
        : extraSaved < 0 ? `, though growing the file by ${Math.abs(extraSaved).toLocaleString()} bytes` : '';
      log(`(Re-running with \`--aggressive\` would consolidate ${extra > 0 ? `${extra} more` : 'further'}${savings}.)`);
    }
    if (aggressiveDiffers) {
      const share = aggressiveOnly > 0
        ? `${aggressiveOnly} of these merges ${aggressiveOnly !== 1 ? 'are' : 'is'}`
        : 'Some of these merges are';
      log(styleText('yellow', `${share} aggressive-only—probably, but not provably, safe. Review the diff and test the affected pages.`));
    }

    return skipped.length > 0 || Boolean(withheld);
  }

  const { findings } = analyze(css, targetOptions);

  if (!findings.length) {
    const note = potential?.applied.length
      ? ` With \`--aggressive\`: ${potential.applied.length} consolidation${potential.applied.length !== 1 ? 's' : ''} possible.`
      : '';
    console.log(`No duplicate declarations found.${note}`);
    return false;
  }

  printFindings(findings);

  // A dry-run consolidation, purely to report the payoff—same safety rules
  // as `--fix`, just discarded instead of written
  const { css: cssDryRun, applied, skipped, bytes, withheld } = dedup(css, targetOptions);

  // Findings above don't distinguish safe from unsafe—without this, a
  // duplicate group that `--fix` would just skip (see its own safety
  // checks) reads as if nothing follows from it at all, when there’s a
  // concrete, explainable reason it wasn't offered as a `--fix` win
  if (skipped.length) {
    console.log(styleText('yellow', `${skipped.length} duplicate group${skipped.length !== 1 ? 's' : ''} considered unsafe to auto-merge:`));
    for (const item of skipped) {
      console.log(formatSkippedLine(item, skippedAggressive));
    }
    console.log('');
  }

  // Summary and `--fix` payoff close each style sheet’s report, so with
  // several files it’s unambiguous which file they refer to
  console.log(`${styleText('bold', 'Summary:')} ${findings.length} finding${findings.length !== 1 ? 's' : ''}`);
  if (withheld) {
    // The dry run went through the engine’s `savingsOnly` gate (set via the
    // config file—the CLI flag itself requires `--fix`), so `--fix` here
    // would decline to write; say so instead of promising a change
    console.log(styleText('yellow', `\`--fix\` would leave this file untouched—\`savingsOnly\` is set, and consolidating would make it ${formatBytesShare(withheld.bytes)} bigger.`));
  } else if (applied.length) {
    if (bytes.saved > 0) {
      console.log(`Run with \`--fix\` to save ${formatBytesShare(bytes)}.`);
    } else if (bytes.saved < 0) {
      console.log(styleText('yellow', `Running \`--fix\` here would make the file ${formatBytesShare(bytes)} bigger, not smaller (worth it for maintainability but not for transfer size).`));
    }
  }
  // Gated on the outputs differing, never on entry counts: One aggressive
  // cross-block or alias fold can absorb what the default pass would have
  // done in more, separate merges, so a count delta can be zero or negative
  // on exactly the files where `--aggressive` changes (and saves) the most
  if (potential && potential.css !== cssDryRun) {
    const extra = potential.applied.length - applied.length;
    const totals = potential.bytes.saved > 0
      ? `, saving ${formatBytesShare(potential.bytes)} in total`
      : potential.bytes.saved < 0
        ? `, though growing the file by ${formatBytesShare(potential.bytes)} in total`
        : '';
    console.log(`With \`--fix --aggressive\`: ${extra > 0 ? `${extra} more consolidation${extra !== 1 ? 's' : ''}` : 'further consolidation'}${totals}.`);
  }

  return true;
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

  for (const [index, file] of files.entries()) {
    // Two blank lines between per-file reports, so each file’s closing
    // summary is visually separated from the next file’s header
    if (multi && index > 0) console.log('\n');
    if (await processTarget(file, options, { multi }, prefetched[index])) failed = true;
  }

  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});