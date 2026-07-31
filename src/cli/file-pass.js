// One file’s consolidation work: pure computation over a CSS string, returning
// a structured-cloneable payload for `css-dedup.js` to render. Split out so the
// same pass runs on the main thread or on a worker (see `pool.js`).

import { writeFile } from 'node:fs/promises';
import { analyze, dedup } from '../index.js';
import { declarationKey } from '../lib/normalization.js';

// The opposite-mode consolidation of the same source—a second, discarded pass
// serving as the aggressive preview on default runs, and as the default-mode
// baseline that measures what rode on the flag on aggressive runs
function oppositePass(css, targetOptions) {
  return dedup(css, { ...targetOptions, aggressive: !targetOptions.aggressive });
}

// A skipped group’s key as the aggressive pass would spell it: aggressive
// normalization can rewrite it (`word-wrap` onto `overflow-wrap`), so matching
// the default spelling alone would hint at groups aggressive also skips.
// Selector-list keys carry no `prop: value` shape and pass through.
export function aggressiveKeySpelling(key) {
  const important = key.endsWith(' !important');
  const base = important ? key.slice(0, -' !important'.length) : key;
  const separator = base.indexOf(': ');
  if (separator === -1) return key;
  return declarationKey(base.slice(0, separator), base.slice(separator + 2), important, true);
}

// The scope + key identities of the groups the aggressive pass still skipped,
// so the “may merge” hint check is a lookup rather than a scan per printed line
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

// Keeps only what the report table needs from a `dedup()` result—not the
// rewritten CSS, which a worker would otherwise copy back for nothing.
// `unavailable` answers every `n/a` cell’s one question—would `--fix` touch
// this file?—since nothing found, nothing safe, and a `savingsOnly` refusal all
// leave `applied` empty by construction.
function slimPass(pass) {
  return { bytes: pass.bytes, unavailable: pass.applied.length === 0 };
}

// Mirrors `dedupRoot()`’s `savingsOnly` gate against an already-computed plain
// pass, rather than running `dedup()` again just to reapply a rule that only
// looks at the first pass’s own `bytes.saved`
function applySavingsOnlyGate(pass) {
  if (pass.bytes.saved >= 0) return pass;
  return {
    bytes: { before: pass.bytes.before, after: pass.bytes.before, saved: 0 },
    applied: [],
  };
}

// The report table’s four savings columns, in the order they’re rendered.
// Named once here, where they’re produced, so the consumers in `report.js`
// can’t drift out of sync with them.
export const PASS_KEYS = ['passDefault', 'passDefaultS', 'passAgg', 'passAggS'];

// Only two of the four actually run `dedup()`; the `-s` variants are derived
// from those, since a second full pass would just reproduce the first one’s
// `bytes` before the gate looks at them.
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

// `--fix`: consolidate, and write where there’s a file to write. The write
// happens here, not at render time, so a parallel run does its I/O on the
// worker. STDIN has no file, so its output rides back on the payload.
async function computeFixPass(css, targetOptions, { isStdin, label }) {
  const potential = targetOptions.aggressive ? null : oppositePass(css, targetOptions);

  // `savingsOnly` is the engine’s gate (see `dedupRoot()`): A withheld
  // result arrives as the untouched style sheet, with `applied` empty and
  // the declined outcome under `withheld`
  const { css: output, applied, skipped, bytes, withheld, sourceMapStale } = dedup(css, targetOptions);

  // Whether anything actually rode on the flag—measured by comparing output,
  // never by entry counts: one aggressive fold can absorb what the default
  // pass would have done in several separate merges, so a count delta can be
  // zero or negative on an entirely aggressive-only run
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
    // Always the complete style sheet, even with nothing consolidated—a
    // pipeline would otherwise receive nothing and lose the CSS entirely
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

// The four `dedup()` combinations are deferred past the all-clean shortcut
// below: scanning a directory of already-clean files is the common case, and
// there’s nothing for them to find in a style sheet already known to have no
// duplicates.
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
    // Falling back to the aggressive findings keeps a `0 (1)` row from quoting
    // byte figures for a finding the reader can’t see listed anywhere.
    // `--quiet` prints neither block, so neither is computed—these are the one
    // part of the payload that grows with the style sheet.
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

// `label` doubles as PostCSS’s `from` and as the path `--fix` writes back to
export function computeFilePass(css, options, { fix, quiet, isStdin, label }) {
  const targetOptions = { ...options, from: isStdin ? undefined : label };
  if (fix) return computeFixPass(css, targetOptions, { isStdin, label });
  return computeReportPass(css, targetOptions, { quiet });
}

// A failure reduced to the strings the CLI prints—an `Error` and PostCSS’s
// on-demand `showSourceCode()` wouldn’t survive the clone off a worker
export function describePassError(err) {
  if (err.name === 'CssSyntaxError') return { syntax: true, message: err.message, sourceCode: err.showSourceCode() };
  return { syntax: false, message: err.message };
}
