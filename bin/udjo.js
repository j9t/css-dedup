#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, styleText } from 'node:util';
import { resolve } from 'node:path';
import { analyze, dedup } from '../src/index.js';

const { values, positionals } = parseArgs({
  options: {
    dedup: { type: 'boolean', short: 'd', default: false },
    'ignore-selector': { type: 'string', short: 'i', multiple: true, default: [] },
    'no-ignore-selectors-defaults': { type: 'boolean', short: 'n', default: false },
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
  -n, --no-ignore-selectors-defaults  Disable the built-in selector-hack ignore list (vendor-prefixed pseudo-elements, IE hacks)
  -h, --help                       Show this help`);
  process.exit(values.help ? 0 : 1);
}

const file = resolve(positionals[0]);
const options = {
  from: file,
  ignoreSelectors: values['ignore-selector'].map(pattern => new RegExp(pattern, 'i')),
  ignoreSelectorsDefaults: !values['no-ignore-selectors-defaults'],
};

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
    const { css: output, applied, skipped, bytes } = dedup(css, options);
    if (applied.length) await writeFile(file, output);

    console.log(`${styleText('green', `${applied.length} consolidated`)}, ${styleText('yellow', `${skipped.length} skipped`)} (unsafe to auto-merge)`);
    for (const item of skipped) {
      console.log(`  ${styleText('dim', item.scope === 'root' ? '(root)' : item.scope)}  ${item.key} — ${item.reason}`);
    }
    if (applied.length) {
      console.log(`\n${formatBytesSummary(bytes)}`);
      if (bytes.saved < 0) {
        console.log(styleText('yellow', `Note: this consolidation makes the file ${formatGrowth(bytes)} bigger, not smaller—the merged selector list costs more than the removed declaration(s) save. Still worth doing for maintainability (using each declaration just once); skip \`--dedup\` here if you care more about transfer size.`));
      }
      console.log(`Wrote ${file}`);
    }

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

  // A dry-run consolidation, purely to report the payoff—same safety rules
  // as `--dedup`, just discarded instead of written
  const { applied, bytes } = dedup(css, options);
  if (applied.length) {
    if (bytes.saved > 0) {
      const percent = bytes.before ? (bytes.saved / bytes.before) * 100 : 0;
      console.log(`Run with \`--dedup\` to save ${bytes.saved.toLocaleString()} bytes (${percent.toFixed(1)}%).`);
    } else if (bytes.saved < 0) {
      console.log(styleText('yellow', `Running \`--dedup\` here would make the file ${formatGrowth(bytes)} bigger, not smaller—worth it for maintainability (using each declaration just once), not for transfer size.`));
    }
  }

  process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});