// Benchmarks the engine’s two entry points against real (or generated) style
// sheets: `npm run bench`, optionally with file or directory arguments.
//
// Consolidation is superlinear in a scope’s rule count—the merge-safety scan
// looks at every rule between a duplicate group’s first and last
// occurrence—so timings from a small fixture say very little about a large
// style sheet. The generated sheet below therefore has a deliberately big
// root scope, and passing a real sheet of your own is better still.
//
// Alongside each timing it prints what the pass actually did (declarations
// applied, groups skipped, bytes saved). Those numbers are the guard rail: a
// speedup that changes any of them isn’t a speedup, it’s a behavior change.

import { readFile, readdir, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join, extname } from 'node:path';
import postcss from 'postcss';
import { analyze, dedup } from '../src/index.js';

const RUNS = 5;
const RUNS_WARMUP = 2;

// A deterministic pseudo-random generator, so the generated sheet—and so
// every timing taken against it—is the same from run to run and machine to
// machine (`Math.random()` would make two runs incomparable)
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// Stands in for a real style sheet when none is given: one large root scope
// (where the merge-safety scan’s cost lives), declarations repeated across
// rules often enough to form duplicate groups, shorthand/longhand pairs to
// exercise the overlap check, and a few at-rule scopes
function generateCss(ruleCount = 1500) {
  const random = makeRandom(42);
  const props = [
    ['color', ['#333', 'red', '#ff0000', 'rgb(0, 0, 0)']],
    ['margin', ['0', '0 0', '0 auto', '1rem']],
    ['margin-left', ['0', '1rem', '2rem']],
    ['padding', ['0', '.5rem', '0.50rem']],
    ['font-weight', ['bold', '700', 'normal']],
    ['display', ['block', 'flex', 'none']],
    ['border', ['0', 'none', '1px solid #ccc']],
    ['transition', ['all .3s ease', 'all 300ms ease']],
  ];

  const lines = [];
  for (let i = 0; i < ruleCount; i++) {
    const declCount = 1 + Math.floor(random() * 4);
    const decls = [];
    for (let d = 0; d < declCount; d++) {
      const [prop, values] = props[Math.floor(random() * props.length)];
      decls.push(`\t${prop}: ${values[Math.floor(random() * values.length)]};`);
    }
    // A bounded class-name pool, so selectors repeat and same-selector folds
    // have something to find
    lines.push(`.c${i % 900} .e${i % 40} {\n${decls.join('\n')}\n}`);
  }

  for (const query of ['(min-width: 768px)', '(min-width: 1024px)', 'print']) {
    for (let i = 0; i < 60; i++) {
      lines.push(`@media ${query} {\n\t.m${i % 30} {\n\t\tcolor: #333;\n\t\tmargin: 0;\n\t}\n}`);
    }
  }

  return lines.join('\n\n');
}

// The median, not the mean: One descheduled run (GC, another process waking
// up) skews an average badly at these sample sizes, and the median just
// ignores it
function measure(fn) {
  for (let i = 0; i < RUNS_WARMUP; i++) fn();

  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

async function collectCssFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...await collectCssFiles(entryPath));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.css') files.push(entryPath);
  }

  return files.sort();
}

async function loadTargets(args) {
  if (!args.length) return [{ label: 'generated (1,500 rules)', css: generateCss() }];

  const targets = [];
  for (const arg of args) {
    const stats = await stat(arg);
    const files = stats.isDirectory() ? await collectCssFiles(arg) : [arg];
    for (const file of files) {
      targets.push({ label: file.split('/').pop(), css: await readFile(file, 'utf8') });
    }
  }
  return targets;
}

function formatRow(cells, widths) {
  return cells.map((cell, i) => (i ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ');
}

function report(rows) {
  const header = ['Pass', 'Median', 'Applied', 'Skipped', 'Saved'];
  const table = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...table.map(row => row[i].length)));
  for (const row of table) console.log(formatRow(row, widths));
}

const targets = await loadTargets(process.argv.slice(2));
let totalMs = 0;

for (const { label, css } of targets) {
  const kb = (Buffer.byteLength(css, 'utf8') / 1024).toFixed(0);
  console.log(`\n${label} — ${kb} KB`);

  let rows;
  try {
    const passes = [
      ['parse', () => postcss.parse(css), null],
      ['analyze', () => analyze(css, { aggressive: false }), null],
      ['analyze -a', () => analyze(css, { aggressive: true }), null],
      ['dedup', () => dedup(css, { aggressive: false }), true],
      ['dedup -a', () => dedup(css, { aggressive: true }), true],
    ];

    rows = passes.map(([name, fn, detailed]) => {
      const ms = measure(fn);
      totalMs += ms;
      if (!detailed) return [name, `${ms.toFixed(1)} ms`, '', '', ''];
      const result = fn();
      return [name, `${ms.toFixed(1)} ms`, `${result.applied.length}`, `${result.skipped.length}`, `${result.bytes.saved}`];
    });
  } catch (err) {
    console.log(`  skipped: ${err.message}`);
    continue;
  }

  report(rows);
}

if (targets.length > 1) console.log(`\nAll passes, all files: ${totalMs.toFixed(0)} ms`);