// Benchmarks the engine’s two entry points against real (or generated) style
// sheets: `npm run benchmark`, optionally with file or directory arguments.
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
//
// Only compare figures taken against the same input. That’s obvious for a
// real style sheet, less so for the generated one: Editing the generator
// moves its timings and its applied/skipped/saved counts alike, so numbers
// from either side of such an edit aren’t a before/after pair.

import { readFile, readdir, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join, extname } from 'node:path';
import postcss from 'postcss';
import { analyze, dedup } from '../src/index.js';

const RUNS = 5;
const RUNS_WARMUP = 2;

// How often a generated root selector comes back around. Must divide the
// generated rule count, or the repetition lands outside the fixture and
// same-selector folding never gets exercised; at 500 against the default
// 1,500 rules, each selector is written three times.
const SELECTOR_PERIOD = 500;

// The descendant half of the selector—a divisor of `SELECTOR_PERIOD`, so it
// varies the names without lengthening the pair’s repetition period
const SELECTOR_POOL_DESCENDANT = 25;

// How often a rule restates the selector of the rule just before it. A
// recurring selector isn’t enough on its own to exercise same-selector
// folding: Folding merges into the last occurrence, so two occurrences
// `SELECTOR_PERIOD` rules apart are nearly always blocked by an intervening
// declaration on an overlapping property. Adjacent restatements—the
// copy-paste shape folding exists for—are what actually reach it.
const SELECTOR_RESTATE_INTERVAL = 25;

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
// exercise the overlap check, restated selectors for same-selector folding,
// and a few at-rule scopes
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
    // have something to find. The combined selector comes back around every
    // `SELECTOR_PERIOD` rules—the descendant pool divides that period, so the
    // pair’s own period is that same number rather than the two pools’ least
    // common multiple, which is what silently pushed it past `ruleCount` here
    // before.
    const slot = i % SELECTOR_RESTATE_INTERVAL === 0 ? Math.max(i - 1, 0) : i;
    lines.push(`.c${slot % SELECTOR_PERIOD} .e${slot % SELECTOR_POOL_DESCENDANT} {\n${decls.join('\n')}\n}`);
  }

  for (const query of ['(min-width: 768px)', '(min-width: 1024px)', 'print']) {
    for (let i = 0; i < 60; i++) {
      lines.push(`@media ${query} {\n\t.m${i % 30} {\n\t\tcolor: #333;\n\t\tmargin: 0;\n\t}\n}`);
    }
  }

  return lines.join('\n\n');
}

// The fastest run, not the mean or the median: Contention (GC, another
// process waking up) only ever adds time, so the floor is the sample least
// polluted by it—and the floor is what compares two versions of the code
// fairly. A median needs most of the batch to be clean, which a busy machine
// doesn’t give: Measured over identical batches, the median’s readings
// spanned 208% against the min’s 141%, and it recovered the true floor in
// four of eight batches where the min managed six.
//
// Not a cure, though—a batch contended end to end has no clean sample to
// find, and both statistics then report the busy machine rather than the
// code. A figure well above the usual floor means “re-run,” not “regression.”
// These numbers are a lower bound on the work, never a prediction of how long
// a run takes.
function measure(fn) {
  for (let i = 0; i < RUNS_WARMUP; i++) fn();

  let fastest = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    fn();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
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
  const header = ['Pass', 'Fastest', 'Applied', 'Skipped', 'Saved'];
  const table = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...table.map(row => row[i].length)));
  for (const row of table) console.log(formatRow(row, widths));
}

const targets = await loadTargets(process.argv.slice(2));
let totalMs = 0;

for (const { label, css } of targets) {
  const kb = (Buffer.byteLength(css, 'utf8') / 1024).toFixed(0);
  console.log(`\n${label}—${kb} KB`);

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