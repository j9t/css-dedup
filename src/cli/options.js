// Command-line and config-file handling: what the flags are, how they’re
// validated, and how the two sources combine into one run’s settings.

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Shared between `parseArgs()` and the single-dash guard below—one definition,
// so an option added here can’t drift out of sync with a separate name list
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

const HELP = `Usage: css-dedup [options] <file…>

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
  CSS_DEDUP_WORKERS  Number of worker threads for multi-file runs (\`0\` or \`1\` to process files one at a time); defaults to one per core, minus one for the main thread`;

// A single-dash spelling of a long option (`-fix` for `--fix`) isn’t a typo
// `parseArgs()` rejects: with `strict: true` it only rejects letters that
// resolve to no short flag, so it silently reads `-fix` as boolean `-f` plus
// `-i` with the attached value `"x"`—consolidation would quietly run with a
// bogus selector filter instead of failing loudly.
function findMisspelledLongOption(argv) {
  for (const arg of argv) {
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    const name = arg.slice(1);
    if (Object.hasOwn(OPTIONS_CONFIG, name)) return { arg, name };
  }
  return null;
}

// A flag active without `--fix` that couldn’t change anything about report
// mode would only sit inert and mislead—`--savings-only` since report mode
// never writes, `--aggressive` since the summary table always shows both
// variants side by side regardless of the flag
const FIX_ONLY_FLAGS = [
  { key: 'savings-only', flag: '--savings-only', reason: 'report mode doesn’t write' },
  { key: 'aggressive', flag: '--aggressive', reason: 'report mode already shows both variants' },
];

// Parses `argv`, reporting anything wrong through `fail(message, exitCode)`
// and the help text through `showHelp(text)`. Both are expected not to return.
export function parseCliArgs(argv, { fail, showHelp }) {
  const misspelled = findMisspelledLongOption(argv);
  if (misspelled) {
    fail(`Unknown option \`${misspelled.arg}\`. Did you mean \`--${misspelled.name}\`? (A single dash groups letters as short flags instead—e.g., \`-i\` takes an attached value—so '${misspelled.arg}' doesn’t parse as that long option.)`);
  }

  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS_CONFIG, allowPositionals: true, strict: true });

  if (values.help || !positionals.length) showHelp(HELP, values.help ? 0 : 1);
  if (positionals.includes('-') && positionals.length > 1) {
    fail('Cannot combine STDIN (`-`) with other file arguments.');
  }

  for (const { key, flag, reason } of FIX_ONLY_FLAGS) {
    if (values[key] && !values.fix) fail(`\`${flag}\` only applies together with \`--fix\` (${reason})`);
  }

  return { values, positionals };
}

export async function loadConfig(pathConfig) {
  const pathResolved = resolve(pathConfig ?? 'css-dedup.config.js');
  if (!pathConfig && !existsSync(pathResolved)) return {};

  const { default: config = {} } = await import(pathToFileURL(pathResolved).href);
  return config;
}

// Combines flags and config into the settings the run needs. A `--no-…` flag
// wins over a config-set default—both exist to force one back off for a single
// run.
export function buildRunSettings(values, config) {
  return {
    options: {
      ignoreSelectors: [
        ...(config.ignoreSelectors ?? []),
        ...values['ignore-selector'].map(pattern => new RegExp(pattern, 'i')),
      ],
      ignoreSelectorsDefaults: values['no-ignore-selectors-defaults'] ? false : (config.ignoreSelectorsDefaults ?? true),
      aggressive: values.aggressive || (config.aggressive ?? false),
      savingsOnly: values['savings-only'] || (config.savingsOnly ?? false),
    },
    ignorePathPatterns: [
      ...(config.ignorePaths ?? []),
      ...values['ignore-path'].map(pattern => new RegExp(pattern, 'i')),
    ],
    exitZero: values['no-exit-zero'] ? false : values['exit-zero'] || (config.exitZero ?? false),
    flags: { fix: values.fix, quiet: values.quiet },
  };
}
