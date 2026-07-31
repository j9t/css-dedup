// Everything that reaches the terminal. Every line of a run’s output goes
// through here, on the main thread, in file order—whether the pass ran here or
// on a worker.

import { styleText } from 'node:util';
import { aggressiveKeySpelling } from './file-pass.js';
import {
  formatAggregateTotalNote,
  formatAggressivePreviewLine,
  formatAppliedReduceClause,
  formatByteDeltaClause,
  formatBytesShareOfTotal,
  formatOutcomeBullet,
  plural,
  sumBy,
} from './format.js';
import {
  bestSavingsColumns,
  buildReportStats,
  disambiguateLabels,
  REPORT_HEADER,
  REPORT_LEGEND,
  reportRowValues,
  reportSavingsColumns,
  reportTotalRowValues,
  renderReportTable,
  totalSavingsColumns,
} from './report.js';
import { targetLabel } from './targets.js';

// A file that never made it into `stats` (read/parse failure): excluded from
// the overall-summary totals, but counted so those totals can note how many
// files they don’t speak for
const RESULT_ERRORED = { exitFailure: true, errored: true, stats: null };

function scopeLabel(scope) {
  return scope === 'root' ? '(root)' : scope;
}

function printFindings(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    if (!grouped.has(finding.scope)) grouped.set(finding.scope, []);
    grouped.get(finding.scope).push(finding);
  }

  for (const [scope, items] of grouped) {
    console.log(styleText('bold', scopeLabel(scope)));

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

// One skipped-group line, with the “may merge with `--aggressive`” hint when
// the aggressive pass didn’t skip the group—matched under both the default and
// the aggressive spelling of the key, so a respelled key never produces a
// false hint
function formatSkippedLine(item, skippedAggressive) {
  const stillSkipped = !skippedAggressive
    || skippedAggressive.has(`${item.scope}\0${item.key}`)
    || skippedAggressive.has(`${item.scope}\0${aggressiveKeySpelling(item.key)}`);
  const hint = stillSkipped ? '' : ' (may merge with `--aggressive`)';
  return `  ${styleText('dim', scopeLabel(item.scope))}  ${item.key}—${item.reason}${hint}`;
}

// `log` is `console.log` in report mode, and in `--fix` mode either that or
// `console.error`, depending on whether STDOUT needs to stay clear for piped
// CSS output
function logSkippedDetail(log, skipped, skippedAggressive) {
  if (!skipped.length) return;

  log(styleText('yellow', `${skipped.length} duplicate group${plural(skipped.length)} considered unsafe to auto-merge:`));
  for (const item of skipped) {
    log(formatSkippedLine(item, skippedAggressive));
  }
  log('');
}

function renderFixPass(payload, { isStdin, label, multi, flags }) {
  const { applied, skipped, skippedAggressive, bytes, withheld, sourceMapStale, aggressiveDiffers, aggressiveOnly, aggExtra, aggExtraSaved, aggDiffers } = payload;
  const log = isStdin ? console.error : console.log;

  // STDIN’s consolidated style sheet, which has no file to be rewritten in
  // place. It goes out before the status lines, which is why those go to
  // STDERR here—so STDOUT stays a clean, pipeable style sheet.
  if (payload.stdout !== null) process.stdout.write(payload.stdout);

  // Detail before counts, so a long skipped list can’t push the outcome
  // off-screen. `--quiet` drops it: the summary bullets restate the count.
  if (!flags.quiet) logSkippedDetail(log, skipped, skippedAggressive);

  // A multi-file run restates each file’s label on its own summary line—by the
  // time the run ends, the header this file printed may be out of scrollback
  log(multi ? styleText('bold', `Summary for ${label}:`) : 'Summary:');

  // The outcome first, then this run’s footnotes on it (growth caveat,
  // aggressive-only warning, where it was written), then the two
  // forward-looking items (what was skipped, what `--aggressive` adds)
  if (withheld) {
    log(`* 0 declarations consolidated, ${withheld.count} withheld: \`savingsOnly\` left this file untouched—consolidating would ${formatByteDeltaClause(withheld.bytes.saved, withheld.bytes.before)}`);
  } else {
    log(`* ${applied} declaration${plural(applied)} consolidated${applied ? `: ${formatAppliedReduceClause(bytes)}` : ''}`);
  }

  if (applied) {
    if (bytes.saved < 0) {
      log('* Worth it for maintainability (each declaration used once); skip `--fix` here if you care more about transfer size.');
    }
    if (aggressiveDiffers) {
      const share = aggressiveOnly > 0
        ? `${aggressiveOnly} of these merges ${aggressiveOnly !== 1 ? 'are' : 'is'}`
        : 'Some of these merges are';
      log(styleText('yellow', `* ${share} aggressive-only—probably, but not provably, safe. Review the diff and test the affected pages.`));
    }
    if (payload.wrote) log(`* Wrote ${label}`);
    if (sourceMapStale) {
      log(styleText('yellow', `* ${isStdin ? 'This style sheet' : label} references a source map (\`sourceMappingURL\`); \`--fix\` doesn’t regenerate it, so the map no longer describes this file and should be rebuilt. To keep maps intact, run CSS Dedup before your minifier, or in-pipeline via \`css-dedup/plugin\`.`));
    }
  }

  if (skipped.length) {
    log(styleText('yellow', `* ${skipped.length} finding${plural(skipped.length)} skipped (considered unsafe to auto-merge)`));
  }
  // The opposite-mode pass this was measured against went through the same
  // `savingsOnly` gate, so a result the re-run would withhold earns no hint
  if (aggDiffers) log(formatAggressivePreviewLine(aggExtra, aggExtraSaved, bytes.before, bytes.saved));

  return {
    exitFailure: skipped.length > 0 || Boolean(withheld),
    errored: false,
    stats: {
      findings: null,
      applied,
      skipped: skipped.length,
      bytesBefore: bytes.before,
      bytesSaved: bytes.saved,
      withheldCount: withheld ? withheld.count : 0,
      withheldGrowth: withheld ? Math.abs(withheld.bytes.saved) : 0,
      aggExtra,
      aggExtraSaved,
      aggDiffers,
    },
  };
}

function renderReportPass(payload, { label }) {
  if (payload.clean) {
    console.log('No duplicate declarations found.');
    return { exitFailure: false, errored: false, stats: buildReportStats(label, payload) };
  }

  // Absent under `--quiet`, where the table below already gives the counts
  if (payload.findings) {
    printFindings(payload.findings);
    // Findings don’t distinguish safe from unsafe—without this, a duplicate
    // group `--fix` would just skip reads as if nothing follows from it
    logSkippedDetail(console.log, payload.skipped, payload.skippedAggressive);
  }

  // The label is always restated (even for a single file): by the time a long
  // run ends, the per-file header above may be out of scrollback
  console.log(styleText('bold', `Summary for ${label}:`));
  const stats = buildReportStats(label, payload);
  const rowHighlights = [bestSavingsColumns(reportSavingsColumns(stats), 1)];
  for (const line of renderReportTable(REPORT_HEADER, [reportRowValues(stats)], { rowHighlights })) console.log(line);
  console.log(REPORT_LEGEND);

  return { exitFailure: payload.findingsDefault > 0, errored: false, stats };
}

// Prints one target’s report and returns `{ exitFailure, errored, stats }`:
// whether it counts against the exit code, whether it never produced stats
// (read/parse failure), and the numbers the overall summary aggregates
export function renderTarget(file, { multi, flags }, outcome) {
  const isStdin = file === '-';
  const label = targetLabel(file);

  if (multi && !flags.quiet) console.log(styleText('bold', label));

  if (outcome.readError) {
    console.error(styleText('red', `Could not read ${label}: ${outcome.readError.message}`));
    return RESULT_ERRORED;
  }
  // A file that fails to parse (invalid CSS, or a non-standard dialect PostCSS
  // doesn’t accept) shouldn’t take the rest of the run down with it
  if (outcome.error) {
    if (outcome.error.syntax) {
      console.error(styleText('red', outcome.error.message));
      console.error(outcome.error.sourceCode);
    } else {
      console.error(styleText('red', `Error processing ${label}: ${outcome.error.message}`));
    }
    return RESULT_ERRORED;
  }

  if (outcome.payload.mode === 'fix') return renderFixPass(outcome.payload, { isStdin, label, multi, flags });
  return renderReportPass(outcome.payload, { label });
}

// Rolls up every file’s `stats` into one closing report, so a terminal showing
// only the last N lines of a multi-file run doesn’t leave the final file’s own
// summary looking like it spoke for the whole run
export function printOverallSummary(results, { fix }) {
  const ok = results.filter(result => result.stats);
  const errored = results.length - ok.length;
  const erroredNote = errored ? ` (${errored} file${plural(errored)} could not be processed; see errors above)` : '';

  console.log('');
  console.log(styleText('bold', `Summary for all files:${erroredNote}`));

  if (!fix) {
    printOverallReportTable(ok);
    return;
  }
  printOverallFixSummary(ok);
}

// Report mode’s all-files table is the per-file table again, one row per file
// plus a closing `Total`—no separate “further with `--aggressive`” bullet
// needed, since aggressive is its own pair of columns rather than a mode
function printOverallReportTable(ok) {
  const statsList = ok.map(result => result.stats);
  const labels = disambiguateLabels(statsList.map(stats => stats.label));
  const header = ['File', ...REPORT_HEADER];
  const rows = statsList.map((stats, i) => [labels[i], ...reportRowValues(stats)]);
  const rowHighlights = statsList.map(stats => bestSavingsColumns(reportSavingsColumns(stats), 2));

  if (statsList.length) {
    rows.push(['Total', ...reportTotalRowValues(statsList)]);
    rowHighlights.push(bestSavingsColumns(totalSavingsColumns(statsList), 2));
  }

  for (const line of renderReportTable(header, rows, { wrapColumn: 0, rowHighlights })) console.log(line);
  console.log(REPORT_LEGEND);
}

function printOverallFixSummary(ok) {
  // Every percentage below is against this—the combined original size of every
  // successfully processed file—since there’s no single file left to relate a
  // byte count to once the run’s totals are combined
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

  const totalApplied = sumBy(ok, result => result.stats.applied);
  const totalSkipped = sumBy(ok, result => result.stats.skipped);

  const outcome = formatOutcomeBullet({
    countLabel: `${totalApplied} declaration${plural(totalApplied)} consolidated`,
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
    console.log(styleText('yellow', `* ${totalSkipped} finding${plural(totalSkipped)} skipped (considered unsafe to auto-merge)`));
  }
  if (withheldFiles.length) {
    console.log(`* ${withheldFiles.length} file${plural(withheldFiles.length)} left untouched by \`--savings-only\`—consolidating would have made ${withheldFiles.length !== 1 ? 'them' : 'it'} ${formatBytesShareOfTotal(withheldGrowthTotal, totalBeforeAll)} bigger in total`);
  }

  if (!aggFiles.length) return;

  // Always a preview (never yet applied) of what `--fix --aggressive` would
  // add on top of the `--fix` run that just happened. `aggExtraSaved` is 0 for
  // a file aggressive doesn’t affect, so the aggregate already nets correctly.
  const extra = sumBy(aggFiles, result => result.stats.aggExtra);
  const aggNetAll = (shrinkTotal - growTotal) + (aggShrinkTotal - aggGrowTotal);
  const aggOutcome = formatOutcomeBullet({
    countLabel: `${extra > 0 ? `${extra} more declaration${plural(extra)}` : 'Further consolidation'} in aggressive mode`,
    tense: 'todo',
    filesShrinkLen: aggFilesShrink.length,
    shrinkTotal: aggShrinkTotal,
    filesGrowLen: aggFilesGrow.length,
    growTotal: aggGrowTotal,
    totalBefore: totalBeforeAll,
    flag: '--fix --aggressive',
    skipFlag: '--fix --aggressive --savings-only',
    more: true,
    aggregateNote: formatAggregateTotalNote(aggNetAll, totalBeforeAll),
  });
  if (aggOutcome) {
    for (const line of aggOutcome) console.log(line);
  }
}
