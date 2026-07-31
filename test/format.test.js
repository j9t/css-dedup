// In-process tests for the CLI’s pure output layer—`src/cli/format.js` (byte
// figures and the prose around them) and `src/cli/report.js` (the report
// table’s columns, highlighting, and layout). Everything here is a plain
// function over plain data, so unlike `cli.test.js` nothing is spawned.

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import {
  formatAggressivePreviewLine,
  formatAppliedReduceClause,
  formatByteDeltaClause,
  formatByteMagnitude,
  formatBytesShareOfTotal,
  formatOutcomeBullet,
  formatOverallNet,
  formatReduceClause,
  formatSavingsCell,
  formatSize,
  plural,
  sumBy,
} from '../src/cli/format.js';
import {
  bestSavingsColumns,
  disambiguateLabels,
  renderReportTable,
  reportRowValues,
  reportTotalRowValues,
} from '../src/cli/report.js';

// One file’s row data, in the shape `buildReportStats()` produces. Each pass is
// `[saved, unavailable]`; `before` is shared, the way one file’s four passes
// always share it.
function stats({ findingsDefault = 1, findingsAgg = 1, before = 1000, passes }) {
  const [passDefault, passDefaultS, passAgg, passAggS] = passes.map(([saved, unavailable = false]) => (
    { bytes: { before, after: before - saved, saved }, unavailable }
  ));
  return { findingsDefault, findingsAgg, passDefault, passDefaultS, passAgg, passAggS };
}

function columns(...specs) {
  return specs.map(([saved, unavailable = false]) => ({ saved, before: 1000, unavailable }));
}

// `renderReportTable()` reads the terminal width for its wrap budget; pin it so
// the expected output doesn’t depend on where the suite runs
function withTerminalWidth(width, fn) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else delete process.stdout.columns;
  }
}

describe('Byte magnitudes', () => {
  test('States sizes in decimal KB, and in MB past the million-byte line', () => {
    assert.strictEqual(formatSize(1500), '1.5 KB');
    assert.strictEqual(formatSize(999_999), '1000.0 KB');
    assert.strictEqual(formatSize(1_000_000), '1.0 MB');
    assert.strictEqual(formatSize(2_500_000), '2.5 MB');
  });

  test('Falls back to a plain byte count where KB would round to “0.0”, so a small saving doesn’t read as nothing', () => {
    assert.strictEqual(formatSize(0), '0 B');
    assert.strictEqual(formatSize(49), '49 B');
    // The first value that survives rounding switches back to KB
    assert.strictEqual(formatSize(50), '0.1 KB');
  });

  test('Signs both the magnitude and the percentage in a savings cell, and neither for an exact no-op', () => {
    assert.strictEqual(formatSavingsCell(2000, 10_000), '-2.0 KB (-20.0%)');
    assert.strictEqual(formatSavingsCell(-2000, 10_000), '+2.0 KB (+20.0%)');
    assert.strictEqual(formatSavingsCell(0, 10_000), '0 B (0%)');
  });

  test('Signs only the percentage in a summary bullet’s magnitude, and marks `--aggressive` extras as “more bytes”', () => {
    assert.strictEqual(formatByteMagnitude(500, 1000, '-'), '500 bytes (-50.0%)');
    assert.strictEqual(formatByteMagnitude(500, 1000, '+', { more: true }), '500 more bytes (+50.0%)');
  });

  test('Groups thousands, so a large byte count stays readable', () => {
    assert.match(formatByteMagnitude(1_234_567, 10_000_000, '-'), /^1,234,567 bytes/);
  });

  test('Treats a zero “before” size as 0%, rather than dividing by it', () => {
    assert.strictEqual(formatByteMagnitude(100, 0, '-'), '100 bytes (-0.0%)');
    assert.strictEqual(formatBytesShareOfTotal(100, 0), '100 bytes (0.0% overall)');
    assert.doesNotMatch(formatSavingsCell(100, 0), /NaN|Infinity/);
  });
});

describe('Summary clauses', () => {
  test('Switches verb and conjunction on the direction of the byte delta', () => {
    assert.strictEqual(formatByteDeltaClause(500, 1000), 'save 500 bytes (-50.0%)');
    assert.strictEqual(formatByteDeltaClause(-500, 1000), 'grow by 500 bytes (+50.0%)');
    assert.match(formatReduceClause(500, 1000), /^Reduce duplication and save /);
    assert.match(formatReduceClause(-500, 1000), /^Reduce duplication but grow by /);
  });

  test('Folds before → after counts into the applied clause, keeping “and” even when the file grew', () => {
    assert.strictEqual(
      formatAppliedReduceClause({ before: 1000, after: 800, saved: 200 }),
      'Reduced duplication and saved 200 bytes (1,000 → 800 bytes, -20.0%)',
    );
    // “but grew” would read as though the growth undercut the deduplication,
    // when `--fix` applied both changes regardless
    assert.strictEqual(
      formatAppliedReduceClause({ before: 1000, after: 1200, saved: -200 }),
      'Reduced duplication and grew by 200 bytes (1,000 → 1,200 bytes, +20.0%)',
    );
  });

  test('States the overall net with its sign on both figures', () => {
    assert.strictEqual(formatOverallNet(250, 1000), 'total: -250 bytes / -25.0%');
    assert.strictEqual(formatOverallNet(-250, 1000), 'total: +250 bytes / +25.0%');
  });

  test('Names a declaration count in the aggressive preview, or falls back to “Further consolidation” at zero', () => {
    assert.match(formatAggressivePreviewLine(3, 100, 1000, 50), /^\* 3 more declarations in aggressive mode: /);
    assert.match(formatAggressivePreviewLine(1, 100, 1000, 50), /^\* 1 more declaration in aggressive mode: /);
    assert.match(formatAggressivePreviewLine(0, 100, 1000, 50), /^\* Further consolidation in aggressive mode: /);
  });

  test('Quotes the combined total, not just its own delta, in the aggressive preview’s trailing note', () => {
    // 50 already saved by `--fix`, 100 more from aggressive → 150 combined
    assert.match(formatAggressivePreviewLine(1, 100, 1000, 50), /\(total: -150 bytes \/ -15\.0%\)$/);
  });

  test('Pluralizes on the count', () => {
    assert.strictEqual(plural(0), 's');
    assert.strictEqual(plural(1), '');
    assert.strictEqual(plural(2), 's');
  });

  test('Sums by an accessor, including over an empty list', () => {
    assert.strictEqual(sumBy([{ n: 1 }, { n: 2 }], item => item.n), 3);
    assert.strictEqual(sumBy([], item => item.n), 0);
  });
});

describe('Outcome bullets', () => {
  const base = { countLabel: '3 declarations consolidated', totalBefore: 1000, skipFlag: '--fix --savings-only' };

  test('Reports an all-shrinking split in past tense for `--fix`, with no flag to suggest', () => {
    const [line, ...rest] = formatOutcomeBullet({ ...base, tense: 'done', filesShrinkLen: 2, shrinkTotal: 200, filesGrowLen: 0, growTotal: 0 });
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(line, '* 3 declarations consolidated: Reduced duplication and saved 200 bytes (-20.0%)');
  });

  test('Recommends the flag in present tense for a preview', () => {
    const [line] = formatOutcomeBullet({ ...base, tense: 'todo', filesShrinkLen: 2, shrinkTotal: 200, filesGrowLen: 0, growTotal: 0, flag: '--fix' });
    assert.strictEqual(line, '* 3 declarations consolidated: Reduce duplication and save 200 bytes (-20.0%) with `--fix`');
  });

  test('Uses “and grew” for an applied all-growing split but “but grow” for a preview', () => {
    const [done] = formatOutcomeBullet({ ...base, tense: 'done', filesShrinkLen: 0, shrinkTotal: 0, filesGrowLen: 1, growTotal: 50 });
    const [todo] = formatOutcomeBullet({ ...base, tense: 'todo', filesShrinkLen: 0, shrinkTotal: 0, filesGrowLen: 1, growTotal: 50, flag: '--fix' });
    // “and” for `--fix`, where the growth happened alongside the deduplication
    // rather than despite it; “but” only where the choice is still open
    assert.strictEqual(done, '* 3 declarations consolidated: Reduced duplication and grew by 50 bytes (+5.0%)');
    assert.strictEqual(todo, '* 3 declarations consolidated: Reduce duplication but grow by 50 bytes (+5.0%) with `--fix`');
  });

  test('Itemizes a mixed split as a gerund list for `--fix`, with no contrast left to draw', () => {
    const lines = formatOutcomeBullet({ ...base, tense: 'done', filesShrinkLen: 2, shrinkTotal: 300, filesGrowLen: 1, growTotal: 100 });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /Reduced duplication, shrinking 2 files by 300 bytes \(-30\.0%\) and growing 1 file by 100 bytes \(\+10\.0%\)/);
    assert.match(lines[0], /\(total: -200 bytes \/ -20\.0%\)$/);
  });

  test('Adds the `--savings-only` follow-up line only for a mixed preview', () => {
    const lines = formatOutcomeBullet({ ...base, tense: 'todo', filesShrinkLen: 2, shrinkTotal: 300, filesGrowLen: 1, growTotal: 100, flag: '--fix' });
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /Reduce duplication and shrink 2 files .* but grow 1 file /);
    assert.strictEqual(lines[1], '  - Skip files that grow in size to save 300 bytes (-30.0%) in total with `--fix --savings-only`');
  });

  test('Lets an aggregate note replace the mixed split’s own net, so two differently-scoped “total:” figures never sit back to back', () => {
    const lines = formatOutcomeBullet({
      ...base, tense: 'todo', filesShrinkLen: 1, shrinkTotal: 300, filesGrowLen: 1, growTotal: 100,
      flag: '--fix --aggressive', more: true, aggregateNote: ' (total: -900 bytes / -90.0%)',
    });
    assert.match(lines[0], /\(total: -900 bytes \/ -90\.0%\)$/);
    assert.strictEqual(lines[0].match(/total:/g).length, 1);
    assert.match(lines[0], /more bytes/);
  });

  test('Returns “null” when neither side of the split has a file, so the caller prints no bullet at all', () => {
    assert.strictEqual(formatOutcomeBullet({ ...base, tense: 'done', filesShrinkLen: 0, shrinkTotal: 0, filesGrowLen: 0, growTotal: 0 }), null);
  });
});

describe('Report table columns', () => {
  test('Renders a findings cell plus one savings cell per pass', () => {
    const row = reportRowValues(stats({ findingsDefault: 2, findingsAgg: 5, before: 10_000, passes: [[1000], [1000], [2000], [2000]] }));
    assert.deepStrictEqual(row, ['2 (5)', '-1.0 KB (-10.0%)', '-1.0 KB (-10.0%)', '-2.0 KB (-20.0%)', '-2.0 KB (-20.0%)']);
  });

  test('Shows `n/a` for a pass that wouldn’t touch the file, but a real figure for a net-zero one that would', () => {
    const row = reportRowValues(stats({ passes: [[0, true], [0], [50], [50]] }));
    assert.strictEqual(row[1], 'n/a');
    // Applied something, bytes washed out—that still touched the file
    assert.strictEqual(row[2], '0 B (0%)');
  });

  test('Totals findings and savings across files, against their combined original size', () => {
    const row = reportTotalRowValues([
      stats({ findingsDefault: 1, findingsAgg: 2, before: 10_000, passes: [[1000], [1000], [2000], [2000]] }),
      stats({ findingsDefault: 3, findingsAgg: 4, before: 10_000, passes: [[500], [500], [500], [500]] }),
    ]);
    assert.strictEqual(row[0], '4 (6)');
    // 1,500 of a combined 20,000 bytes
    assert.strictEqual(row[1], '-1.5 KB (-7.5%)');
  });

  test('Marks the Total `n/a` only when every file’s own pass was, since one real merge means something happens in the run', () => {
    const mixed = reportTotalRowValues([
      stats({ passes: [[10], [10], [10], [10, true]] }),
      stats({ passes: [[0, true], [0, true], [5], [5, true]] }),
    ]);
    assert.notStrictEqual(mixed[1], 'n/a');
    assert.strictEqual(mixed[4], 'n/a');
  });
});

describe('Report table highlighting', () => {
  test('Marks the single best column, shifted past the columns preceding the savings ones', () => {
    assert.deepStrictEqual([...bestSavingsColumns(columns([10], [10], [99], [20]), 1)], [3]);
    // Two leading columns in the all-files table rather than one
    assert.deepStrictEqual([...bestSavingsColumns(columns([10], [10], [99], [20]), 2)], [4]);
  });

  test('Marks every column in a tie', () => {
    assert.deepStrictEqual([...bestSavingsColumns(columns([100], [100], [50], [0]), 0)], [0, 1]);
  });

  test('Excludes an `n/a` column from winning and from setting the bar the others are measured against', () => {
    // The 100 is unavailable, so the 50 wins rather than losing to an outcome
    // nothing actually produced
    assert.deepStrictEqual([...bestSavingsColumns(columns([100, true], [50], [10], [10]), 0)], [1]);
  });

  test('Marks nothing when every column grows the file, since growth isn’t an improvement to point at', () => {
    assert.deepStrictEqual([...bestSavingsColumns(columns([-10], [-5], [-20], [-1]), 0)], []);
  });

  test('Still marks an exact no-op, which beats growth', () => {
    assert.deepStrictEqual([...bestSavingsColumns(columns([0], [-5]), 0)], [0]);
  });

  test('Marks nothing when every column is `n/a`', () => {
    assert.deepStrictEqual([...bestSavingsColumns(columns([10, true], [20, true]), 0)], []);
  });
});

describe('Report table layout', () => {
  test('Sizes every column from its header and each row’s actual content', () => {
    const lines = renderReportTable(['File', 'N'], [['a.css', '1'], ['bbbbbb.css', '22']]);
    assert.deepStrictEqual(lines, [
      'File        N',
      'a.css       1',
      'bbbbbb.css  22',
    ]);
  });

  test('Trims the trailing gutter, so no line carries padding past its last cell', () => {
    for (const line of renderReportTable(['File', 'N'], [['a.css', '1'], ['bbbbbb.css', '22']])) {
      assert.strictEqual(line, line.trimEnd());
    }
  });

  test('Keeps columns flush when a highlight is applied', () => {
    const rows = [['a.css', '1']];
    const plain = renderReportTable(['File', 'N'], rows);
    const highlighted = renderReportTable(['File', 'N'], rows, { rowHighlights: [new Set([1])] });

    // Padding is computed before any coloring, so the visible layout is the
    // same either way. Compared with escape codes stripped, since whether
    // `styleText()` emits any depends on the environment—the ANSI path itself
    // is asserted on by the spawned `runColor()` tests.
    assert.deepStrictEqual(highlighted.map(stripVTControlCharacters), plain);
    assert.match(stripVTControlCharacters(highlighted[1]), /^a\.css {2}1$/);
  });

  test('Wraps an over-long cell at the last `/` that fits, rather than widening the table or cutting mid-segment', () => {
    const lines = withTerminalWidth(30, () => (
      renderReportTable(['File', 'N'], [['very/deep/nested/path/to/file.css', '1']], { wrapColumn: 0 })
    ));
    assert.deepStrictEqual(lines, [
      'File                         N',
      'very/deep/nested/path/to/',
      'file.css                     1',
    ]);
  });

  test('Leaves a cell with no early enough `/` whole, overflowing that one line instead of breaking mid-word', () => {
    const lines = withTerminalWidth(30, () => (
      renderReportTable(['File', 'N'], [['averyveryverylongsinglesegment.css', '1']], { wrapColumn: 0 })
    ));
    assert.strictEqual(lines.length, 2);
    assert.match(lines[1], /^averyveryverylongsinglesegment\.css {2}1$/);
  });

  test('Widens the wrap column to fit the longest post-wrap tail, so a wrapped row’s later columns stay flush', () => {
    // The tail is longer than the budget, so clamping the column to the budget
    // would leave it unpadded and drag every other row’s later columns out of
    // line with it
    const lines = withTerminalWidth(20, () => renderReportTable(
      ['File', 'N'],
      [[`aa/${'b'.repeat(40)}.css`, '1'], ['short.css', '22']],
      { wrapColumn: 0 },
    ));
    assert.deepStrictEqual(lines, [
      'File                                          N',
      'aa/',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.css  1',
      'short.css                                     22',
    ]);
    // Every line that carries the trailing column starts it at the same offset
    const offsets = lines.filter(line => /\d$/.test(line)).map(line => line.lastIndexOf(' ') + 1);
    assert.strictEqual(new Set(offsets).size, 1, `columns drifted: ${JSON.stringify(lines)}`);
  });

  test('Never sizes the wrap column below its own header, however tight the budget', () => {
    // Only reachable with a wrap-column header longer than the 8-character
    // budget floor—`File` never binds here, so this pins the guard rather than
    // any behavior the shipped table produces
    const lines = withTerminalWidth(20, () => (
      renderReportTable(['A very long column header', 'N'], [['x.css', '1']], { wrapColumn: 0 })
    ));
    assert.deepStrictEqual(lines, [
      'A very long column header  N',
      'x.css                      1',
    ]);
  });

  test('Renders without a wrap column when none is asked for, however long a cell is', () => {
    const long = 'x'.repeat(200);
    const lines = withTerminalWidth(30, () => renderReportTable(['File', 'N'], [[long, '1']]));
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].startsWith(long));
  });
});

describe('File label disambiguation', () => {
  const at = (...segments) => path.join(process.cwd(), ...segments);

  test('Uses the basename alone when it is already unique', () => {
    assert.deepStrictEqual(disambiguateLabels([at('a', 'one.css'), at('b', 'two.css')]), ['one.css', 'two.css']);
  });

  test('Extends colliding labels by one segment at a time until each is unique', () => {
    assert.deepStrictEqual(
      disambiguateLabels([at('components', 'button.css'), at('pages', 'button.css')]),
      ['components/button.css', 'pages/button.css'],
    );
  });

  test('Never grows a label that is already unique, so one long outlier path doesn’t drag the others out', () => {
    assert.deepStrictEqual(
      disambiguateLabels([at('x', 'deep', 'nest', 'button.css'), at('y', 'button.css'), at('solo.css')]),
      ['nest/button.css', 'y/button.css', 'solo.css'],
    );
  });

  test('Passes `(stdin)` through untouched', () => {
    assert.deepStrictEqual(disambiguateLabels(['(stdin)', at('a.css')]), ['(stdin)', 'a.css']);
  });

  test('Stops extending at the path root rather than looping', () => {
    assert.deepStrictEqual(disambiguateLabels([at('same.css'), at('same.css')]).length, 2);
  });
});
