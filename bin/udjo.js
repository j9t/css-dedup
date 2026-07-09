#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, styleText } from 'node:util';
import { resolve } from 'node:path';
import { analyze, dedup } from '../src/index.js';

const { values, positionals } = parseArgs({
  options: {
    dedup: { type: 'boolean', short: 'd', default: false },
    'ignore-selector': { type: 'string', short: 'i', multiple: true, default: [] },
    'no-default-ignores': { type: 'boolean', short: 'n', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || !positionals.length) {
  console.log(`Usage: udjo [options] <file>

Find (and optionally consolidate) duplicate CSS declarations—use every
declaration just once (UDJO).

Arguments:
  file  CSS file to analyze

Options:
  -d, --dedup                      Consolidate declarations that are safe to merge automatically, rewriting the file in place
  -i, --ignore-selector <pattern>  Regular expression for selectors to exclude from analysis (repeatable)
  -n, --no-default-ignores         Disable the built-in selector-hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

const file = resolve(positionals[0]);
const options = {
  from: file,
  ignoreSelectors: values['ignore-selector'].map(pattern => new RegExp(pattern, 'i')),
  defaultIgnoreSelectors: !values['no-default-ignores'],
};

function printFindings(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    if (!grouped.has(finding.scope)) grouped.set(finding.scope, []);
    grouped.get(finding.scope).push(finding);
  }

  for (const [scope, items] of grouped) {
    console.log(styleText('bold', scope === 'root' ? '(root)' : scope));

    for (const finding of items) {
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

async function main() {
  const css = await readFile(file, 'utf8');

  if (values.dedup) {
    const { css: output, applied, skipped } = dedup(css, options);
    if (applied.length) await writeFile(file, output);

    console.log(`${styleText('green', `${applied.length} consolidated`)}, ${styleText('yellow', `${skipped.length} skipped`)} (unsafe to auto-merge)`);
    for (const item of skipped) {
      console.log(`  ${styleText('dim', item.scope === 'root' ? '(root)' : item.scope)}  ${item.key} — ${item.reason}`);
    }
    if (applied.length) console.log(`\nWrote ${file}`);

    if (skipped.length) process.exitCode = 1;
    return;
  }

  const { findings } = analyze(css, options);

  if (!findings.length) {
    console.log('No duplicate declarations found.');
    return;
  }

  printFindings(findings);
  console.log(`${styleText('bold', 'Summary:')} ${findings.length} finding${findings.length !== 1 ? 's' : ''}`);
  process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});