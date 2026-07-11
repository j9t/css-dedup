#!/usr/bin/env node

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze, dedup } from '../src/index.js';

// Directories skipped when recursing into a target directory
const DIRS_IGNORED = new Set(['node_modules']);

const { values, positionals } = parseArgs({
  options: {
    dedup: { type: 'boolean', short: 'd', default: false },
    'ignore-selector': { type: 'string', short: 'i', multiple: true, default: [] },
    'no-ignore-selectors-defaults': { type: 'boolean', short: 'n', default: false },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || !positionals.length) {
  console.log(`Usage: css-dedup [options] <file…>

Find (and optionally consolidate) duplicate CSS declarations.

Arguments:
  file  One or more CSS files or directories to analyze (directories are searched recursively for .css files, skipping node_modules and dotfolders); pass \`-\` to read from STDIN instead

Options:
  -d, --dedup                      Consolidate declarations that are safe to merge automatically, rewriting each file in place (or printing to STDOUT for \`-\`)
  -i, --ignore-selector <pattern>  Regular expression for selectors to exclude from analysis (repeatable)
  -n, --no-ignore-selectors-defaults  Disable the built-in selector-hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -c, --config <path>              Path to a config file (defaults to \`.css-dedup.js\` in the working directory, if present)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

if (positionals.includes('-') && positionals.length > 1) {
  console.error('Cannot combine stdin (`-`) with other file arguments.');
  process.exit(1);
}

// Settings file
async function loadConfig(pathConfig) {
  const pathResolved = resolve(pathConfig ?? '.css-dedup.js');
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
// project-specific exclude list belongs in `.css-dedup.js`’s `ignoreSelectors`
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
// files (sorted, for stable output across runs)
async function expandTargets(targets) {
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

  return expanded;
}

function formatBytesSummary({ before, after, saved }) {
  const percent = before ? (saved / before) * 100 : 0;
  const sign = saved >= 0 ? '-' : '+';
  return `${before.toLocaleString()} → ${after.toLocaleString()} bytes (${sign}${Math.abs(saved).toLocaleString()} B, ${sign}${Math.abs(percent).toFixed(1)}%)`;
}

// A merged selector list can cost more bytes than the declaration it removes
// saves (e.g., two long, single-use selectors sharing one short declaration),
// so consolidation isn’t always a net win for transfer size—only ever for
// maintainability (using the declaration just once). Surface that plainly
// rather than silently reporting negative “savings.”
function formatGrowth(bytes) {
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
// it should count against the process’s exit code. In `--dedup` mode, STDIN
// is a special case: There is no file to rewrite in place, so the
// consolidated CSS is printed to STDOUT instead—and, so that stream stays
// pipeable, the usual status/summary lines go to STDERR rather than STDOUT.
async function processTarget(file, options, { multi }) {
  const isStdin = file === '-';
  const label = isStdin ? '(stdin)' : resolve(file);

  if (multi) console.log(styleText('bold', label));

  let css;
  try {
    css = isStdin ? await readStdin() : await readFile(label, 'utf8');
  } catch (err) {
    console.error(styleText('red', `Could not read ${label}: ${err.message}`));
    return true;
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

async function processCss(css, targetOptions, { isStdin, label }) {
  if (values.dedup) {
    const { css: output, applied, skipped, bytes } = dedup(css, targetOptions);
    const log = isStdin ? console.error : console.log;

    // STDOUT must always carry the complete stylesheet for STDIN input—
    // even with nothing consolidated, a pipeline consuming it would
    // otherwise receive nothing and lose the CSS entirely
    if (isStdin) {
      process.stdout.write(output);
    } else if (applied.length) {
      await writeFile(label, output);
    }

    const skippedNote = skipped.length ? ' (considered unsafe to auto-merge)' : '';
    log(`${styleText('green', `${applied.length} consolidated`)}, ${styleText('yellow', `${skipped.length} skipped`)}${skippedNote}`);
    for (const item of skipped) {
      log(`  ${styleText('dim', item.scope === 'root' ? '(root)' : item.scope)}  ${item.key} — ${item.reason}`);
    }
    if (applied.length) {
      log(`\n${formatBytesSummary(bytes)}`);
      if (bytes.saved < 0) {
        log(styleText('yellow', `Note: this consolidation makes the file ${formatGrowth(bytes)} bigger, not smaller—the merged selector list costs more than the removed declaration(s) save. Still worth doing for maintainability (using each declaration just once); skip \`--dedup\` here if you care more about transfer size.`));
      }
      if (!isStdin) log(`Wrote ${label}`);
    }

    return skipped.length > 0;
  }

  const { findings } = analyze(css, targetOptions);

  if (!findings.length) {
    console.log('No duplicate declarations found.');
    return false;
  }

  printFindings(findings);

  // A dry-run consolidation, purely to report the payoff—same safety rules
  // as `--dedup`, just discarded instead of written
  const { applied, skipped, bytes } = dedup(css, targetOptions);

  // Findings above don't distinguish safe from unsafe—without this, a
  // duplicate group that `--dedup` would just skip (see its own safety
  // checks) reads as if nothing follows from it at all, when there’s a
  // concrete, explainable reason it wasn't offered as a `--dedup` win
  if (skipped.length) {
    console.log(styleText('yellow', `${skipped.length} duplicate group${skipped.length !== 1 ? 's' : ''} considered unsafe to auto-merge:`));
    for (const item of skipped) {
      console.log(`  ${styleText('dim', item.scope === 'root' ? '(root)' : item.scope)}  ${item.key} — ${item.reason}`);
    }
    console.log('');
  }

  // Summary and `--dedup` payoff close each stylesheet’s report, so with
  // several files it’s unambiguous which file they refer to
  console.log(`${styleText('bold', 'Summary:')} ${findings.length} finding${findings.length !== 1 ? 's' : ''}`);
  if (applied.length) {
    if (bytes.saved > 0) {
      const percent = bytes.before ? (bytes.saved / bytes.before) * 100 : 0;
      console.log(`Run with \`--dedup\` to save ${bytes.saved.toLocaleString()} bytes (${percent.toFixed(1)}%).`);
    } else if (bytes.saved < 0) {
      console.log(styleText('yellow', `Running \`--dedup\` here would make the file ${formatGrowth(bytes)} bigger, not smaller (worth it for maintainability but not for transfer size).`));
    }
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
  };

  const files = await expandTargets(positionals);
  if (!files.length) {
    console.error(`No \`.css\` files found under ${positionals.join(', ')}.`);
    process.exit(1);
  }

  const multi = files.length > 1;
  let failed = false;

  for (const [index, file] of files.entries()) {
    // Two blank lines between per-file reports, so each file’s closing
    // summary is visually separated from the next file’s header
    if (multi && index > 0) console.log('\n');
    if (await processTarget(file, options, { multi })) failed = true;
  }

  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});