// One file’s consolidation work, with nothing printed and nothing formatted.
//
// The split exists so the same pass can run either on the main thread or on a
// worker (see `pool.js`): everything here is pure computation over a CSS
// string, returning a plain, structured-cloneable payload that `css-dedup.js`
// renders. Anything that touches color, terminal width, or output order stays
// on the main thread, so a parallel run prints exactly what a sequential one
// does.

import { writeFile } from 'node:fs/promises';
import { analyze, dedup } from '../src/index.js';
import { declarationKey } from '../src/normalization.js';

// The opposite-mode consolidation of the same source—a second, discarded pass
// serving as the aggressive preview on default runs, and as the default-mode
// baseline that measures what rode on the flag on aggressive runs
function oppositePass(css, targetOptions) {
  return dedup(css, { ...targetOptions, aggressive: !targetOptions.aggressive });
}

// A skipped group’s key as the aggressive pass would spell it: Aggressive
// normalization can rewrite the default spelling (`hsl()` onto hex,
// `word-wrap` onto `overflow-wrap`), so matching the default spelling alone
// would hint at groups the aggressive pass also skips. Selector-list keys
// (blocked same-selector folds) carry no `prop: value` shape and pass
// through unchanged.
export function aggressiveKeySpelling(key) {
  const important = key.endsWith(' !important');
  const base = important ? key.slice(0, -' !important'.length) : key;
  const separator = base.indexOf(': ');
  if (separator === -1) return key;
  return declarationKey(base.slice(0, separator), base.slice(separator + 2), important, true);
}

// The scope + key identities of the groups the aggressive pass still skipped,
// as one Set—so the “may merge” hint check is a lookup, not a scan of the
// whole skipped list per printed line. A `Set` of strings survives the
// structured clone to the main thread as-is.
function skippedWithAggressive(potential) {
  return potential ? new Set(potential.skipped.map(item => `${item.scope}\0${item.key}`)) : null;
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

// Keeps only what the report table (single-file and all-files alike) needs
// from a `dedup()` result—not the rewritten CSS text itself, which a
// multi-file run would otherwise hold onto for every file for no reason (and
// which a worker would then copy back across the thread boundary for nothing).
// `unavailable` is the one question every `n/a` cell in the table asks: would
// this pass actually write anything? `applied.length === 0` answers it
// directly, covering every way the answer can be “no” in one check—nothing
// found, every finding unsafe to auto-merge, or the `savingsOnly` gate
// declining a real merge for growing the file (each of which already leaves
// `applied` empty, by construction, before this ever looks at it)—rather than
// this needing to separately ask about findings counts and the gate.
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

// `--fix`: consolidate, and write the result where there’s a file to write.
// The write happens here rather than at render time so a parallel run does its
// I/O on the worker too, and so both paths write through one code path. STDIN
// has no file to rewrite in place, so its output rides back on the payload for
// the main thread to put on STDOUT.
async function computeFixPass(css, targetOptions, { isStdin, label }) {
  const potential = targetOptions.aggressive ? null : oppositePass(css, targetOptions);

  // `savingsOnly` is the engine’s gate (see `dedupRoot()`): A withheld
  // result arrives as the untouched style sheet, with `applied` empty and
  // the declined outcome under `withheld`
  const { css: output, applied, skipped, bytes, withheld, sourceMapStale } = dedup(css, targetOptions);

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

  const wrote = !isStdin && applied.length > 0;
  if (wrote) await writeFile(label, output);

  return {
    mode: 'fix',
    // STDOUT must always carry the complete style sheet for STDIN input—
    // even with nothing consolidated (or everything withheld), a pipeline
    // consuming it would otherwise receive nothing and lose the CSS entirely
    stdout: isStdin ? output : null,
    applied: applied.length,
    skipped,
    skippedAggressive: skippedWithAggressive(potential),
    bytes,
    withheld,
    sourceMapStale: Boolean(sourceMapStale),
    aggressiveDiffers,
    aggressiveOnly,
    wrote,
    ...computeAggressivePreview(potential, output, applied, bytes),
  };
}

// Report mode always compares the default and aggressive variants side by
// side (see the summary table `css-dedup.js` renders)—`--aggressive`/
// `--savings-only` name table columns here, not a mode to switch into (bare
// `--aggressive` without `--fix` is rejected at startup for exactly that
// reason). The four `dedup()` combinations this needs are deferred past the
// all-clean shortcut just below, though: For the common case of scanning a
// directory of already-clean files, there’s nothing for them to find, so
// running them at all would just be four wasted consolidation passes over a
// style sheet already known to have no duplicates.
function computeReportPass(css, targetOptions, { quiet }) {
  const findingsDefault = analyze(css, { ...targetOptions, aggressive: false }).findings;
  const findingsAgg = analyze(css, { ...targetOptions, aggressive: true }).findings;

  if (!findingsDefault.length && !findingsAgg.length) {
    const before = Buffer.byteLength(css, 'utf8');
    const zeroPass = { bytes: { before, after: before, saved: 0 }, unavailable: true };
    return {
      mode: 'report',
      clean: true,
      findingsDefault: 0,
      findingsAgg: 0,
      findings: null,
      skipped: [],
      skippedAggressive: null,
      passes: { passDefault: zeroPass, passDefaultS: zeroPass, passAgg: zeroPass, passAggS: zeroPass },
    };
  }

  const { passDefault, passDefaultS, passAgg, passAggS } = computeReportPasses(css, targetOptions);

  return {
    mode: 'report',
    clean: false,
    findingsDefault: findingsDefault.length,
    findingsAgg: findingsAgg.length,
    // A style sheet clean under default rules but with something aggressive
    // mode would additionally catch (the table’s `Findings -f (-a)` column
    // showing e.g. `0 (1)`) still gets its one duplicate group listed in
    // detail—otherwise the table’s aggressive columns would quote a byte
    // figure for a finding the reader can’t actually see anywhere.
    // `--quiet` drops both detail blocks, so neither is computed into the
    // payload then: they’re the one part of it that grows with the style
    // sheet, and a worker would otherwise copy every finding back unread.
    findings: quiet ? null : (findingsDefault.length ? findingsDefault : findingsAgg),
    skipped: quiet ? [] : passDefault.skipped,
    skippedAggressive: quiet ? null : skippedWithAggressive(passAgg),
    passes: {
      passDefault: slimPass(passDefault),
      passDefaultS: slimPass(passDefaultS),
      passAgg: slimPass(passAgg),
      passAggS: slimPass(passAggS),
    },
  };
}

// One file’s complete pass. `label` doubles as PostCSS’s `from` (for source
// positions in error messages) and as the path `--fix` writes back to.
export function computeFilePass(css, options, { fix, quiet, isStdin, label }) {
  const targetOptions = { ...options, from: isStdin ? undefined : label };
  if (fix) return computeFixPass(css, targetOptions, { isStdin, label });
  return computeReportPass(css, targetOptions, { quiet });
}

// A pass failure reduced to just what the CLI prints for it. An `Error` (and
// PostCSS’s `showSourceCode()`, which renders on demand) wouldn’t survive the
// structured clone off a worker, so the rendering decision is made here and
// only the resulting strings travel. PostCSS decides about color itself, as it
// does on the main thread—see `workerEnv()` in `pool.js` for how a worker is
// set up to reach the same answer.
export function describePassError(err) {
  if (err.name === 'CssSyntaxError') return { syntax: true, message: err.message, sourceCode: err.showSourceCode() };
  return { syntax: false, message: err.message };
}
