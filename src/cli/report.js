// The report table: which columns a row has, what goes in each cell, which
// cell counts as the row’s best outcome, and how the whole thing is laid out.

import { styleText } from 'node:util';
import { formatSavingsCell, sumBy } from './format.js';
import { PASS_KEYS } from './file-pass.js';
import { toPortablePath } from './targets.js';

export const REPORT_HEADER = ['Findings -f (-a)', 'Savings with: -f', '-f -s', '-f -a', '-f -a -s'];
export const REPORT_LEGEND = 'Legend: -f: --fix, -a: --aggressive, -s: --savings-only';

// The report table’s per-row data, under the label this thread knows the file by
export function buildReportStats(label, { findingsDefault, findingsAgg, passes }) {
  return { label, findingsDefault, findingsAgg, ...passes };
}

// `n/a` whenever this pass wouldn’t actually write anything—no findings under
// this mode, every finding unsafe to auto-merge, or the engine’s `savingsOnly`
// gate declining a real merge for growing the file. All three collapse to the
// same question—would `--fix` with these flags touch the file?—which
// `unavailable` (see `slimPass()`) already answers. A genuine net-zero result,
// where bytes wash out but something *was* applied, still counts as touching
// it, so that’s not `n/a`.
function savingsCell({ saved, before, unavailable }) {
  return unavailable ? 'n/a' : formatSavingsCell(saved, before);
}

// One file’s four savings columns
export function reportSavingsColumns(stats) {
  return PASS_KEYS.map(key => ({
    saved: stats[key].bytes.saved,
    before: stats[key].bytes.before,
    unavailable: stats[key].unavailable,
  }));
}

// The `Total` row’s four columns. `unavailable` only when every file’s own
// pass was—one file’s real, applied merge means something happens somewhere in
// the run, so the total isn’t `n/a` just because it nets to zero.
export function totalSavingsColumns(statsList) {
  const before = sumBy(statsList, stats => stats.passDefault.bytes.before);
  return PASS_KEYS.map(key => ({
    saved: sumBy(statsList, stats => stats[key].bytes.saved),
    before,
    unavailable: statsList.every(stats => stats[key].unavailable),
  }));
}

// A row’s data cells (everything but the leading `File` cell, which only the
// all-files table has)
export function reportRowValues(stats) {
  return [`${stats.findingsDefault} (${stats.findingsAgg})`, ...reportSavingsColumns(stats).map(savingsCell)];
}

export function reportTotalRowValues(statsList) {
  const findingsDefault = sumBy(statsList, stats => stats.findingsDefault);
  const findingsAgg = sumBy(statsList, stats => stats.findingsAgg);
  return [`${findingsDefault} (${findingsAgg})`, ...totalSavingsColumns(statsList).map(savingsCell)];
}

// Which savings columns to mark as the row’s best outcome. An `n/a` column is
// excluded both from winning and from setting the bar the others are compared
// against—marking (or comparing against) an outcome nothing actually produced
// would misattribute it. A row whose best remaining column still grows the
// file isn’t marked at all, since growth isn’t an improvement to point at.
// Ties all win. `offset` shifts the indices past however many columns
// (`Findings` alone, or `File` and `Findings`) precede the savings ones.
export function bestSavingsColumns(columns, offset) {
  const eligible = columns.map((column, i) => ({ i, column })).filter(({ column }) => !column.unavailable);
  if (!eligible.length) return new Set();

  const best = Math.max(...eligible.map(({ column }) => column.saved));
  if (best < 0) return new Set();
  return new Set(eligible.filter(({ column }) => column.saved === best).map(({ i }) => i + offset));
}

// The all-files table’s `File` labels: the basename alone, unless two or more
// files share one—then, and only for those, one more path segment is added at
// a time until every label in the run is unique. A file already unique at its
// current depth never grows further, so one long outlier path doesn’t drag
// every other row’s label out with it.
export function disambiguateLabels(labels) {
  const segments = labels.map(label => (label === '(stdin)' ? [label] : toPortablePath(label).split('/')));
  const depth = segments.map(() => 1);
  const candidate = i => {
    const segs = segments[i];
    return segs.slice(segs.length - Math.min(depth[i], segs.length)).join('/');
  };

  for (let changed = true; changed;) {
    changed = false;
    const current = labels.map((_, i) => candidate(i));
    const counts = new Map();
    for (const label of current) counts.set(label, (counts.get(label) ?? 0) + 1);

    for (let i = 0; i < labels.length; i++) {
      if (counts.get(current[i]) > 1 && depth[i] < segments[i].length) {
        depth[i]++;
        changed = true;
      }
    }
  }

  return labels.map((_, i) => candidate(i));
}

const TABLE_GUTTER = '  ';

// `highlight` is a `Set` of column indices to color. Padding happens on the
// plain text first and the color wraps the already-padded result after—
// coloring first would fold the invisible escape-code bytes into `padEnd()`'s
// width, dragging every column after it out of line. The trailing trim moves
// to the last cell alone, ahead of that cell’s own color wrapping, since
// trimming the joined line afterward wouldn’t reach past a trailing reset code.
function padRow(cells, widths, highlight = new Set()) {
  const padded = cells.map((cell, i) => cell.padEnd(widths[i]));
  padded[padded.length - 1] = padded[padded.length - 1].trimEnd();
  return padded.map((cell, i) => (highlight.has(i) ? styleText(['bold', 'green'], cell) : cell)).join(TABLE_GUTTER);
}

// The last `/` at or before `ceiling`—the rightmost, and so shortest-tail,
// split keeping the head within budget. `null` when nothing splits that early,
// in which case the cell is left whole rather than cut mid-segment. The one
// seam both the width-floor pre-pass and the render call go through, so the
// two can never disagree on where a cell splits.
function splitCellForWrap(cell, ceiling) {
  const splitAt = cell.lastIndexOf('/', ceiling);
  if (splitAt <= 0) return null;
  return { head: cell.slice(0, splitAt + 1), tail: cell.slice(splitAt + 1) };
}

function renderTableRow(row, widths, wrapColumn, budget, highlight) {
  if (wrapColumn < 0 || row[wrapColumn].length <= widths[wrapColumn]) return [padRow(row, widths, highlight)];

  const split = splitCellForWrap(row[wrapColumn], budget);
  if (!split) return [padRow(row, widths, highlight)];

  const tailRow = [...row];
  tailRow[wrapColumn] = split.tail;
  return [split.head, padRow(tailRow, widths, highlight)];
}

// Every column’s width comes from its header and every row’s actual content,
// so columns can’t drift the way hand-aligned output would.
//
// `wrapColumn` gets capped to the terminal’s width and wrapped instead of
// widening the whole table to fit its longest value—but never below what a row
// actually needs post-wrap: the whole cell when it has no `/` to split on, or
// otherwise the tail `splitCellForWrap()` would leave at that same budget.
// Clamping to the budget outright would leave a too-long tail unpadded,
// dragging every later column out of line—which is why the render call gets
// this same `budget` rather than the possibly-since-widened column width.
//
// `rowHighlights[i]` is the `Set` of column indices to color in `rows[i]`.
export function renderReportTable(header, rows, { wrapColumn = -1, rowHighlights } = {}) {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => row[i].length)));
  let budget = -1;

  if (wrapColumn >= 0) {
    const width = process.stdout.columns || 80;
    const fixedWidth = widths.reduce((sum, w, i) => (i === wrapColumn ? sum : sum + w), 0) + TABLE_GUTTER.length * (widths.length - 1);
    budget = Math.max(width - fixedWidth, 8);

    let minRequired = header[wrapColumn].length;
    for (const row of rows) {
      const split = splitCellForWrap(row[wrapColumn], budget);
      minRequired = Math.max(minRequired, split ? split.tail.length : row[wrapColumn].length);
    }
    widths[wrapColumn] = Math.max(minRequired, Math.min(widths[wrapColumn], budget));
  }

  const lines = [padRow(header, widths)];
  rows.forEach((row, i) => lines.push(...renderTableRow(row, widths, wrapColumn, budget, rowHighlights?.[i])));
  return lines;
}
