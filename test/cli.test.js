import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { poolSize, shouldParallelize } from '../src/cli/pool.js';
import { dedup } from '../src/index.js';
import { BEST_CELL, RE_MERGED_AB, RE_MERGED_AC, RE_PAYOFF_FIX, RE_SYNTAX_ERROR, RE_SYNTAX_ERROR_UNCLOSED, RE_WITHHELD_ONE, cssGrowing, cssGrowingAggressive, cssShrinkingAggressive, dirTest, findingsRow, fixturesDir, makeTempDir, run, runColor } from './helpers.js';

describe('CLI', () => {
  test('Shows help with `--help`', () => {
    const { stdout, status } = run(['--help']);
    assert.ok(stdout.includes('Usage:'));
    assert.strictEqual(status, 0);
  });

  test('Shows help and exits non-zero when no file is given', () => {
    const { stdout, status } = run([]);
    assert.ok(stdout.includes('Usage:'));
    assert.strictEqual(status, 1);
  });

  test('Excludes a selector via `-i` (short for `--ignore-selector`)', () => {
    const dirTemp = makeTempDir('temp_ignore_selector');
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run(['-i', '^\\.legacy-', file]);
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns in report mode when merging would grow the file rather than shrink it', () => {
    const dirTemp = makeTempDir('temp_growth_report');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run([file]);
      // The `-f` savings column shows a growth (`+`) instead of a save
      assert.match(stdout, /1 \(1\) {2,}\+\d+ (?:B|KB|MB) \(\+\d+\.\d%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns in `--fix` mode when consolidation grows the file rather than shrinks it', () => {
    const dirTemp = makeTempDir('temp_growth_dedup');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /\* 1 declaration consolidated: Reduced duplication and grew by \d+ bytes \(\d+ → \d+ bytes, \+\d+\.\d%\)/);
      assert.match(stdout, /\* Worth it for maintainability \(each declaration used once\); skip `--fix` here if you care more about transfer size\./);
      assert.ok(fs.readFileSync(file, 'utf8').includes('.very-long-selector-name-one, .b'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Rejects `--savings-only` without `--fix`', () => {
    const { stderr, status } = run(['--savings-only', path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes('`--savings-only` only applies together with `--fix`'));
  });

  test('`--fix --savings-only` leaves a file untouched when consolidation would grow it', () => {
    const dirTemp = makeTempDir('temp_savings_only');
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowing;
    fs.writeFileSync(file, source);

    try {
      const { stdout, status } = run(['--fix', '--savings-only', file]);
      assert.strictEqual(status, 1);
      assert.match(stdout, /\* 0 declarations consolidated, 1 withheld: `savingsOnly` left this file untouched—consolidating would grow by \d+ bytes \(\+\d+\.\d%\)/);
      assert.ok(!stdout.includes('Wrote'));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only` still writes a file whose consolidation shrinks it', () => {
    const dirTemp = makeTempDir('temp_savings_only_shrink');
    const file = path.join(dirTemp, 'shrink.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, status } = run(['-f', '-s', file]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.ok(stdout.includes('Wrote'));
      assert.ok(fs.readFileSync(file, 'utf8').includes('.a, .b'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --aggressive --savings-only` withholds a growing aggressive merge', () => {
    const dirTemp = makeTempDir('temp_savings_only_aggressive');
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowingAggressive;
    fs.writeFileSync(file, source);

    try {
      const { stdout, status } = run(['-f', '-a', '-s', file]);
      assert.strictEqual(status, 1);
      assert.match(stdout, RE_WITHHELD_ONE);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
      // Nothing was written, so the test-your-pages advice must not appear
      assert.ok(!stdout.includes('aggressive-only'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` prints the skipped-group detail before the counts summary, so the outcome survives at the end of a long list', () => {
    const dirTemp = makeTempDir('temp_summary_order');
    const file = path.join(dirTemp, 'mixed.css');
    // Combines `cssGrowing` (withheld under `--savings-only`, since the
    // split it needs to preserve declaration order costs more bytes than it
    // saves) with an unsafe `background` pair (skipped), so the run
    // produces both a withheld count and a skipped-group detail block to
    // order against it
    fs.writeFileSync(file, `${cssGrowing}\n.x { background: white; }\n.y { background: black; }\n.z { background: white; }\n`);

    try {
      const { stdout } = run(['--fix', '--savings-only', file]);
      const detailIndex = stdout.indexOf('duplicate group considered unsafe to auto-merge:');
      const countsIndex = stdout.indexOf('0 declarations consolidated, 1 withheld');
      assert.ok(detailIndex !== -1 && countsIndex !== -1);
      assert.ok(detailIndex < countsIndex);
      // The counts line—the run’s conclusion—must be among the last things
      // printed, not stranded above the skipped-group detail
      assert.ok(stdout.includes('more declarations in aggressive mode'));
      assert.match(stdout, /\* 0 declarations consolidated, 1 withheld:.*\n\* 1 finding skipped \(considered unsafe to auto-merge\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only -` still writes the untouched style sheet to STDOUT when withholding', () => {
    const source = cssGrowing;
    const { stdout, stderr, status } = run(['--fix', '-s', '-'], { input: source });
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout, source);
    assert.match(stderr, RE_WITHHELD_ONE);
  });

  test('Loads `savingsOnly: true` from the config file', () => {
    const dirTemp = makeTempDir('temp_config_savings_only');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { savingsOnly: true };\n');
    const file = path.join(dirTemp, 'grow.css');
    const source = cssGrowing;
    fs.writeFileSync(file, source);

    try {
      const { stdout } = run(['--fix', file], { cwd: dirTemp });
      assert.match(stdout, RE_WITHHELD_ONE);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), source);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Still warns to test when an aggressive cross-block fold nets fewer applied entries than the default pass would', () => {
    const dirTemp = makeTempDir('temp_aggressive_fewer_entries');
    const file = path.join(dirTemp, 'cross.css');
    // Aggressive merges all four selectors in ONE entry where the default
    // pass would do TWO per-block merges—entry counts can’t tell the modes
    // apart here, only the outputs can
    fs.writeFileSync(file, '@media (min-width: 40em) { .a { color: red; } .b { color: red; } }\n@media (min-width: 40em) { .c { color: red; } .d { color: red; } }\n');

    try {
      const { stdout } = run(['-f', '-a', file]);
      assert.match(stdout, /Some of these merges are aggressive-only—probably, but not provably, safe\./);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Still previews `--aggressive` when it would restructure merges into fewer entries', () => {
    const dirTemp = makeTempDir('temp_aggressive_preview_fewer');
    const file = path.join(dirTemp, 'cross.css');
    fs.writeFileSync(file, '@media (min-width: 40em) { .a { color: red; } .b { color: red; } }\n@media (min-width: 40em) { .c { color: red; } .d { color: red; } }\n');

    try {
      const report = run([file]);
      // The `-f -a` column saves more than plain `-f`, even though the
      // finding count is unchanged (a cross-block merge absorbing entries
      // rather than adding new ones)
      assert.match(report.stdout, /1 \(1\) {2,}-30 B \(-22\.4%\) {2,}-30 B \(-22\.4%\) {2,}-0\.1 KB \(-55\.2%\) {2,}-0\.1 KB \(-55\.2%\)/);

      const fix = run(['--fix', file]);
      assert.match(fix.stdout, /\* Further consolidation in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Does not hint “may merge with `--aggressive`” when the aggressive pass skips the group too', () => {
    const dirTemp = makeTempDir('temp_no_false_hint');
    const file = path.join(dirTemp, 'hint.css');
    // The blocker `.a.x` shares a class with the group in both modes; only
    // the key’s spelling differs between them (hsl vs. canonicalized hex)
    fs.writeFileSync(file, '.a { color: hsl(120, 50%, 50%); }\n.a.x { color: blue; }\n.c { color: hsl(120, 50%, 50%); }\n');

    try {
      const { stdout } = run([file]);
      assert.match(stdout, /intervening `color` declaration in `\.a\.x`/);
      assert.ok(!stdout.includes('may merge with `--aggressive`'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Suppresses the `--aggressive` re-run hint on a withheld run when aggressive would grow the file too', () => {
    const dirTemp = makeTempDir('temp_withheld_no_hint');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout } = run(['-f', '-s', file]);
      assert.match(stdout, RE_WITHHELD_ONE);
      // A `--fix --aggressive --savings-only` re-run would withhold as
      // well, so promising it anything—let alone “savings” measured against
      // the never-written output—would be false
      assert.ok(!stdout.includes('in aggressive mode'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Notes when the `--aggressive` extras would grow the file rather than shrink it', () => {
    const dirTemp = makeTempDir('temp_growth_aggressive');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowingAggressive);

    try {
      const report = run([file]);
      // `-f`/`-f -s` read `n/a`: The one default-mode finding is unsafe (see
      // the skipped-group detail above), so nothing would actually apply.
      // `-f -a` finds the same group safe to merge, but it would grow the
      // file (`+`), so `-f -a -s` declines it (`n/a`), too.
      assert.match(report.stdout, /1 \(1\) {2,}n\/a {2,}n\/a {2,}\+\d+(?:\.\d+)? (?:B|KB|MB) \(\+\d+\.\d%\) {2,}n\/a/);

      const fix = run(['--fix', file]);
      assert.match(fix.stdout, /\* 1 more declaration in aggressive mode: Reduce duplication but grow by \d+ more bytes \(\+\d+\.\d%\) with `--fix --aggressive`/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Processes multiple files in one invocation, with a header per file', () => {
    const dirTemp = makeTempDir('temp_multi');
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { color: blue; }\n');

    try {
      const { stdout, status } = run([fileA, fileB]);
      assert.ok(stdout.includes(fileA));
      assert.ok(stdout.includes(fileB));
      assert.ok(stdout.includes('No duplicate declarations found.'));
      assert.ok(stdout.includes(`\n\n${fileB}`));
      assert.ok(!stdout.includes(`\n\n\n${fileB}`));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` consolidates each of multiple files independently', () => {
    const dirTemp = makeTempDir('temp_multi_dedup');
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { margin: 0; }\n.d { margin: 0; }\n');

    try {
      const { stdout } = run(['--fix', fileA, fileB]);
      assert.ok(stdout.includes(fileA));
      assert.ok(stdout.includes(fileB));
      assert.match(fs.readFileSync(fileA, 'utf8'), RE_MERGED_AB);
      assert.match(fs.readFileSync(fileB, 'utf8'), /\.c,\s*\.d\s*{\s*margin: 0;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Labels each file’s own summary with its path, and closes with an all-files table, in report mode', () => {
    const dirTemp = makeTempDir('temp_multi_summary_report');
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.c { margin: 0; }\n.d { margin: 0; }\n');

    try {
      const { stdout } = run([fileA, fileB]);
      assert.ok(stdout.includes(`Summary for ${fileA}:`));
      assert.ok(stdout.includes(`Summary for ${fileB}:`));
      assert.ok(stdout.includes('Summary for all files:'));
      assert.match(stdout, /File +Findings -f \(-a\).*\na\.css.*\nb\.css.*\nTotal +2 \(2\)/s);
      // A single file’s own summary is labeled with its path too—by the
      // time a long run ends, the per-file header printed above may
      // already be out of scrollback, single-file runs included
      const { stdout: single } = run([fileA]);
      assert.ok(single.includes(`Summary for ${fileA}:`));
      assert.ok(!single.includes('Summary for all files'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Separates shrinking and growing files in the overall summary table', () => {
    const dirTemp = makeTempDir('temp_multi_summary_mixed');
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run([fileShrink, fileGrow]);
      // The lone growing file (18 bytes) outweighs the shrinking file (15
      // bytes), so the plain `-f` Total comes out growing (`+`)—but the
      // `-f -s` Total only counts what `--savings-only` would actually keep
      // (the growing file declines), so it nets to a save (`-`) instead
      assert.match(stdout, /shrink\.css {2,}1 \(1\) {2,}-15 B \(-39\.5%\) {2,}-15 B \(-39\.5%\)/);
      assert.match(stdout, /grow\.css {2,}1 \(1\) {2,}\+18 B \(\+21\.7%\) {2,}n\/a {2,}\+18 B \(\+21\.7%\) {2,}n\/a/);
      assert.match(stdout, /Total {2,}2 \(2\) {2,}\+3 B \(\+2\.5%\) {2,}-15 B \(-12\.4%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a net shrink in the overall summary table when a shrinking file outweighs a growing one', () => {
    const dirTemp = makeTempDir('temp_multi_summary_net_shrink');
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n.c { color: red; }\n.d { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run([fileShrink, fileGrow]);
      // The shrinking file’s savings now outweigh the one growing file, so
      // the plain `-f` Total flips to a save (`-`) too, not just `-f -s`
      assert.match(stdout, /Total {2,}2 \(2\) {2,}-27 B \(-17\.0%\) {2,}-45 B \(-28\.3%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes an unreadable/unparseable file from the overall summary, but counts it', () => {
    const dirTemp = makeTempDir('temp_multi_summary_error');
    const fileGood = path.join(dirTemp, 'good.css');
    const fileBad = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(fileGood, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileBad, '.broken { color XP_WIN, }\n');

    try {
      const { stdout, stderr, status } = run([fileGood, fileBad]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.ok(stdout.includes('Summary for all files: (1 file could not be processed; see errors above)'));
      assert.match(stdout, /good\.css {2,}1 \(1\)/);
      assert.match(stdout, /Total {2,}1 \(1\)/);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('The all-files table’s `-s` Total is `n/a` only when nothing would be saved anywhere in the run, not just because one file declined', () => {
    const dirTemp = makeTempDir('temp_multi_summary_all_decline');
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.writeFileSync(fileA, cssGrowing);
    fs.writeFileSync(fileB, cssGrowing);

    try {
      const { stdout } = run([fileA, fileB]);
      // Both files would grow under every combination here, so the plain
      // `-f`/`-f -a` Totals still quote the real (growing) net, but every
      // file’s `-s` outcome is 0—declined—so those Totals read `n/a`
      assert.match(stdout, /Total {2,}2 \(2\) {2,}\+36 B \(\+21\.7%\) {2,}n\/a {2,}\+36 B \(\+21\.7%\) {2,}n\/a/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Disambiguates same-named files in the all-files table by extending just enough of their path', () => {
    const dirTemp = path.join(dirTest, 'temp_multi_summary_collision');
    const dirA = path.join(dirTemp, 'components');
    const dirB = path.join(dirTemp, 'pages');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const fileA = path.join(dirA, 'button.css');
    const fileB = path.join(dirB, 'button.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.x { margin: 0; }\n.y { margin: 0; }\n');

    try {
      const { stdout } = run([fileA, fileB]);
      // Neither label is the bare `button.css` shared by both—each is
      // extended by exactly the one path segment that tells them apart
      assert.ok(!/\n {2,}button\.css {2,}/.test(stdout));
      assert.match(stdout, /components\/button\.css/);
      assert.match(stdout, /pages\/button\.css/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Wraps a File cell too long for the terminal at a path separator, keeping every column flush', () => {
    const dirTemp = path.join(dirTest, 'temp_multi_summary_wrap');
    const dirA = path.join(dirTemp, 'aa', 'bb', 'cc');
    const dirB = path.join(dirTemp, 'aa', 'dd', 'cc');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const fileA = path.join(dirA, 'shared.css');
    const fileB = path.join(dirB, 'shared.css');
    fs.writeFileSync(fileA, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileB, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout } = run([fileA, fileB]);
      // `spawnSync` gives the child no TTY, so `process.stdout.columns` is
      // undefined and the table falls back to the 80-column budget—well
      // under what these disambiguated labels (`bb/cc/shared.css`,
      // `dd/cc/shared.css`) need alongside four savings columns, so the
      // wrap is expected to trigger here, not just be possible
      const lines = stdout.split('\n');
      const headerIndex = lines.findIndex(line => line.startsWith('File '));
      assert.notStrictEqual(headerIndex, -1, 'expected the all-files table header');

      // A bare wrapped head fragment (just the leading path segment(s),
      // ending in `/`, nothing padded after it) for each of the two
      // colliding files—`bb/cc/shared.css` and `dd/cc/shared.css` disagree
      // starting at `bb`/`dd`, but the split lands after `cc/` since that’s
      // the last separator that still fits the budgeted width
      const heads = lines.filter(line => /^(bb|dd)\/cc\/$/.test(line));
      assert.strictEqual(heads.length, 2);

      // Every data row’s Findings cell (`N (N)`) must start at the same
      // column—both the two wrapped continuation lines (just `shared.css`
      // plus the rest of the row) and the `Total` row, which never
      // wraps—proving the wrap didn’t drag anything out of alignment
      const dataLines = lines.filter(line => /^(shared\.css|Total) /.test(line));
      assert.strictEqual(dataLines.length, 3);
      const findingsStarts = new Set(dataLines.map(line => line.search(/\d+ \(\d+\)/)));
      assert.strictEqual(findingsStarts.size, 1, `expected one shared column start, got columns at ${[...findingsStarts]}`);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Labels each file’s own summary and closes with an overall summary, in `--fix` mode', () => {
    const dirTemp = makeTempDir('temp_multi_summary_fix');
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run(['--fix', fileShrink, fileGrow]);
      assert.ok(stdout.includes(`Summary for ${fileShrink}:\n* 1 declaration consolidated: Reduced duplication and saved`));
      assert.ok(stdout.includes(`Summary for ${fileGrow}:\n* 1 declaration consolidated: Reduced duplication and grew`));
      assert.ok(stdout.includes('Summary for all files:\n* 2 declarations consolidated:'));
      // The growing file (18 bytes) outweighs the shrinking file (15 bytes),
      // so the net (in parentheses) comes out positive—growing, not shrinking
      assert.match(stdout, /\* 2 declarations consolidated: Reduced duplication, shrinking 1 file by \d+ bytes \(-\d+\.\d%\) and growing 1 file by \d+ bytes \(\+\d+\.\d%\) \(total: \+\d+ bytes \/ \+\d+\.\d%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only` reports withheld files in the overall summary', () => {
    const dirTemp = makeTempDir('temp_multi_summary_withheld');
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(fileGrow, cssGrowing);

    try {
      const { stdout } = run(['--fix', '--savings-only', fileShrink, fileGrow]);
      assert.match(stdout, /\* 1 declaration consolidated: Reduced duplication and saved \d+ bytes \(-\d+\.\d%\)/);
      assert.match(stdout, /\* 1 file left untouched by `--savings-only`—consolidating would have made it \d+ bytes \(\d+\.\d% overall\) bigger in total/);
      assert.ok(fs.readFileSync(fileGrow, 'utf8') === cssGrowing);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Rolls up the aggressive columns/hint across files in the overall summary, under report and `--fix` mode alike', () => {
    const dirTemp = makeTempDir('temp_multi_summary_aggressive');
    const fileShrink = path.join(dirTemp, 'shrink.css');
    const fileGrow = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(fileShrink, cssShrinkingAggressive);
    fs.writeFileSync(fileGrow, cssGrowingAggressive);

    // One file’s aggressive-only merge saves bytes, the other’s costs more
    // than it saves—so the `Total` row must sum, not just count, both
    // files’ deltas to land on the net direction: `-f -a` (no gate) still
    // grows overall, but `-f -a -s` (each file gated on its own outcome)
    // nets to a save once the growing file’s decline is factored in. `-f`/
    // `-f -s` are `n/a`: neither file has a safe default-mode merge
    // (shrink.css needs aggressive rules, grow.css’s one finding is unsafe).
    try {
      const report = run([fileShrink, fileGrow]).stdout;
      assert.match(report, /Total {2,}1 \(2\) {2,}n\/a {2,}n\/a {2,}\+42 B \(\+16\.2%\) {2,}-31 B \(-12\.0%\)/);

      // `--fix` mode’s own bullet is untouched by the report table rework,
      // and its “preview, never yet applied” phrasing is identical whether
      // the base run was report or `--fix` mode
      const RE_AGGRESSIVE_ROLLUP = /\* 2 more declarations in aggressive mode: Reduce duplication and shrink 1 file by \d+ more bytes \(-\d+\.\d%\) but grow 1 file by \d+ more bytes \(\+\d+\.\d%\) with `--fix --aggressive` \(total: [-+]\d+ bytes \/ [-+]\d+\.\d%\)\n {2}- Skip files that grow in size to save \d+ bytes \(-\d+\.\d%\) in total with `--fix --aggressive --savings-only`/;
      assert.match(run(['--fix', fileShrink, fileGrow]).stdout, RE_AGGRESSIVE_ROLLUP);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Recursively finds `.css` files under a directory, skipping `node_modules` and dotfolders', () => {
    const dirTemp = path.join(dirTest, 'temp_dir_scan');
    fs.mkdirSync(path.join(dirTemp, 'sub', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dirTemp, 'sub', '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'one.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', 'two.css'), '.c { color: blue; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', 'node_modules', 'ignored.css'), '.z { color: red; }\n.y { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'sub', '.hidden', 'ignored.css'), '.x { color: red; }\n.w { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'readme.txt'), 'not css');
    fs.writeFileSync(path.join(dirTemp, 'theme.scss'), '.d { color: red; }\n.e { color: red; }\n');

    try {
      const { stdout, stderr, status } = run([dirTemp]);
      assert.ok(stdout.includes(path.join(dirTemp, 'one.css')));
      assert.ok(stdout.includes(path.join(dirTemp, 'sub', 'two.css')));
      assert.ok(!stdout.includes('node_modules'));
      assert.ok(!stdout.includes('.hidden'));
      // Never collected, so never worth a skip message either
      assert.ok(!stdout.includes('theme.scss'));
      assert.ok(!stderr.includes('theme.scss'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a clean error for a directory with no `.css` files', () => {
    const dirTemp = makeTempDir('temp_dir_empty');

    try {
      const { stderr, status } = run([dirTemp]);
      assert.ok(stderr.includes('No `.css` files found'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  // The SCSS subset the standard parser accepts—nesting alongside at-rules it
  // reads as generic—which is why an extension check has to catch it: No
  // syntax error stands in for one
  const scssParsable = [
    '.a { color: red; @include reset; color: blue; &:hover { color: green; } }',
    '.b { @extend .a; color: red; }',
    '.c { color: red; }',
    '',
  ].join('\n');

  test('Skips a named preprocessor source rather than consolidating it, leaving the file untouched', () => {
    const dirTemp = makeTempDir('temp_preprocessor');
    const file = path.join(dirTemp, 'theme.scss');
    fs.writeFileSync(file, scssParsable);

    try {
      const { stderr, status } = run(['--fix', file]);
      assert.ok(stderr.includes(`Skipped ${file}`));
      assert.ok(stderr.includes('not a `.css` file'));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), scssParsable);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('A skipped preprocessor source does not stop a `.css` file named alongside it', () => {
    const dirTemp = makeTempDir('temp_preprocessor_multi');
    const fileScss = path.join(dirTemp, 'theme.scss');
    const fileCss = path.join(dirTemp, 'main.css');
    fs.writeFileSync(fileScss, scssParsable);
    fs.writeFileSync(fileCss, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, stderr, status } = run([fileScss, fileCss]);
      assert.ok(stderr.includes('not a `.css` file'));
      assert.ok(stdout.includes(fileCss));
      assert.match(stdout, findingsRow(1));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--exit-zero` does not forgive a skipped preprocessor source', () => {
    const dirTemp = makeTempDir('temp_preprocessor_exit_zero');
    const fileScss = path.join(dirTemp, 'theme.scss');
    const fileCss = path.join(dirTemp, 'main.css');
    fs.writeFileSync(fileScss, scssParsable);
    fs.writeFileSync(fileCss, '.a { color: red; }\n');

    try {
      const { status } = run(['--exit-zero', fileScss, fileCss]);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Accepts a named file without an extension, which is no preprocessor source', () => {
    const dirTemp = makeTempDir('temp_no_extension');
    const file = path.join(dirTemp, 'styles');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, stderr } = run([file]);
      assert.ok(!stderr.includes('not a `.css` file'));
      assert.match(stdout, findingsRow(1));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports a concise, zoomed-in error for a CSS syntax error, not the whole source', () => {
    const dirTemp = makeTempDir('temp_syntax_error');
    const file = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(file, '.a { color XP_WIN, }\n');

    try {
      const { stderr, stdout, status } = run([file]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.match(stderr, /\^/);
      assert.ok(!stderr.includes('CssSyntaxError\n    at'));
      assert.strictEqual(stdout, '');
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('A syntax error in one file does not stop the others from being processed', () => {
    const dirTemp = makeTempDir('temp_syntax_error_multi');
    fs.writeFileSync(path.join(dirTemp, 'bad.css'), '.a { color XP_WIN, }\n');
    fs.writeFileSync(path.join(dirTemp, 'good.css'), '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout, stderr, status } = run([dirTemp]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.ok(stdout.includes(path.join(dirTemp, 'good.css')));
      assert.match(stdout, findingsRow(1));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reads from STDIN with `-` in report mode', () => {
    const { stdout } = run(['-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.match(stdout, findingsRow(1));
  });

  test('`--fix -` writes the consolidated CSS to stdout, and status to STDERR', () => {
    const { stdout, stderr } = run(['--fix', '-'], { input: '.a { color: red; }\n.b { color: red; }\n' });
    assert.match(stdout, /^\.a, \.b \{\s*color: red;\s*\}\s*$/);
    assert.ok(stderr.includes('1 declaration consolidated'));
  });

  test('`--fix -` still writes the full style sheet to STDOUT when nothing is consolidated', () => {
    const input = '.a { color: red; }\n.b { color: blue; }\n';
    const { stdout, stderr } = run(['--fix', '-'], { input });
    assert.strictEqual(stdout, input);
    assert.ok(stderr.includes('0 declarations consolidated'));
  });

  test('Rejects combining `-` with other file arguments', () => {
    const dirTemp = makeTempDir('temp_stdin_mix');
    const file = path.join(dirTemp, 'a.css');
    fs.writeFileSync(file, '.a { color: red; }\n');

    try {
      const { stderr, status } = run([file, '-']);
      assert.ok(stderr.includes('Cannot combine STDIN'));
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads `ignoreSelectors` from `css-dedup.config.js` in the working directory', () => {
    const dirTemp = makeTempDir('temp_config');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { ignoreSelectors: [/^\\.legacy-/] };\n');
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run([file], { cwd: dirTemp });
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads a config file from an explicit `--config` path', () => {
    const dirTemp = makeTempDir('temp_config_explicit');
    const fileConfig = path.join(dirTemp, 'custom.config.js');
    fs.writeFileSync(fileConfig, 'export default { ignoreSelectors: [/^\\.legacy-/] };\n');
    const file = path.join(dirTemp, 'legacy.css');
    fs.writeFileSync(file, '.a { color: red; }\n.legacy-b { color: red; }\n');

    try {
      const { stdout } = run(['--config', fileConfig, file]);
      assert.ok(stdout.includes('No duplicate declarations found.'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('An absent `css-dedup.config.js` is silently ignored', () => {
    const { stdout } = run([path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('No duplicate declarations found.'));
  });

  test('`-a` is the short flag for `--aggressive` (with `--fix`, since report mode always shows both variants)', () => {
    const dirTemp = makeTempDir('temp_short_aggressive');
    const file = path.join(dirTemp, 'aggressive.css');
    fs.copyFileSync(path.join(fixturesDir, 'aggressive.css'), file);

    try {
      const { stdout, status } = run(['-f', '-a', file]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes('* 1 declaration consolidated'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads `aggressive: true` from the config file for `--fix`', () => {
    const dirTemp = makeTempDir('temp_config_aggressive');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { aggressive: true };\n');
    const file = path.join(dirTemp, 'aliases.css');
    fs.writeFileSync(file, '.a { word-wrap: break-word; }\n.b { overflow-wrap: break-word; }\n');

    try {
      // Report mode always shows both variants regardless of config, so
      // only `--fix` can demonstrate the config setting actually took—the
      // alias fold below is aggressive-only
      const { stdout } = run(['--fix', file], { cwd: dirTemp });
      assert.ok(stdout.includes('* 1 declaration consolidated'));
      assert.ok(fs.readFileSync(file, 'utf8').includes('.a, .b { overflow-wrap: break-word; }'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes a file via `--ignore-path`/`-p`, matched against the path relative to the working directory', () => {
    const dirTemp = path.join(dirTest, 'temp_ignore_path');
    fs.mkdirSync(path.join(dirTemp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dirTemp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'dist', 'bundle.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'src', 'main.css'), '.c { color: blue; }\n.d { color: blue; }\n');

    try {
      const excluded = run(['--ignore-path', 'dist/', dirTemp]);
      assert.ok(!excluded.stdout.includes('color: red'));
      assert.ok(excluded.stdout.includes('color: blue'));

      const short = run(['-p', 'dist/', dirTemp]);
      assert.ok(!short.stdout.includes('color: red'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Reports that files were excluded, not that none were found, when `--ignore-path` removes every discovered file', () => {
    const dirTemp = makeTempDir('temp_ignore_path_all');
    fs.writeFileSync(path.join(dirTemp, 'one.css'), '.a { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'two.css'), '.b { color: blue; }\n');

    try {
      const { stderr, status } = run(['--ignore-path', '\\.css$', dirTemp]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes('All 2 `.css` files found under'));
      assert.ok(stderr.includes('excluded by `--ignore-path`'));
      assert.ok(!stderr.includes('No `.css` files found'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Excludes a file matching `ignorePaths` from the config file', () => {
    const dirTemp = path.join(dirTest, 'temp_config_ignore_path');
    fs.mkdirSync(path.join(dirTemp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { ignorePaths: [/dist\\//] };\n');
    fs.writeFileSync(path.join(dirTemp, 'dist', 'bundle.css'), '.a { color: red; }\n.b { color: red; }\n');
    fs.writeFileSync(path.join(dirTemp, 'main.css'), '.c { color: blue; }\n.d { color: blue; }\n');

    try {
      const { stdout } = run(['.'], { cwd: dirTemp });
      assert.ok(!stdout.includes('color: red'));
      assert.ok(stdout.includes('color: blue'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Warns when `--fix` rewrites a file that references a source map', () => {
    const dirTemp = makeTempDir('temp_source_map');
    const file = path.join(dirTemp, 'bundle.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n/*# sourceMappingURL=bundle.css.map */\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /references a source map \(`sourceMappingURL`\); `--fix` doesn’t regenerate it, so the map no longer describes this file and should be rebuilt\./);
      assert.match(stdout, /run CSS Dedup before your minifier, or in-pipeline via `css-dedup\/plugin`\./);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Does not warn about a source map when nothing was consolidated', () => {
    const dirTemp = makeTempDir('temp_source_map_clean');
    const file = path.join(dirTemp, 'clean.css');
    fs.writeFileSync(file, '.a { color: red; }\n/*# sourceMappingURL=clean.css.map */\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(!stdout.includes('sourceMappingURL'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`dedup()` reports a stale source map only when it rewrote a style sheet that references one', () => {
    const annotation = '\n/*# sourceMappingURL=bundle.css.map */\n';
    assert.equal(dedup(`.a { color: red; }\n.b { color: red; }${annotation}`).sourceMapStale, true);
    // Nothing to consolidate, so the style sheet—and the map—stay as they were
    assert.equal(dedup(`.a { color: red; }${annotation}`).sourceMapStale, undefined);
    // Rewritten, but no map to invalidate
    assert.equal(dedup('.a { color: red; }\n.b { color: red; }\n').sourceMapStale, undefined);
    // An annotation-shaped string in a declaration value is a value, not an
    // annotation—it parses as one, so it can’t stand in for a real reference
    assert.equal(dedup('.a { content: "/*# sourceMappingURL=fake.map */"; color: red; }\n.b { color: red; }\n').sourceMapStale, undefined);
    // Withheld consolidations leave the style sheet untouched, too
    const withheld = dedup(`${cssGrowing}${annotation}`, { savingsOnly: true });
    assert.ok(withheld.withheld);
    assert.equal(withheld.sourceMapStale, undefined);
  });

  test('Rejects a single-dash long-option spelling (`-fix`) instead of silently clustering it as `-f -i x`', () => {
    const { stderr, status } = run(['-fix', path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes('Unknown option `-fix`. Did you mean `--fix`?'));
  });

  test('Still allows genuine short-flag clustering (`-fa` for `-f -a`)', () => {
    const dirTemp = makeTempDir('temp_cluster');
    const file = path.join(dirTemp, 'basic.css');
    fs.copyFileSync(path.join(fixturesDir, 'basic.css'), file);

    try {
      const { stdout, status } = run(['-fa', file]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes('consolidated'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Processes multiple files correctly when reads are prefetched concurrently', () => {
    const dirTemp = makeTempDir('temp_prefetch');
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(dirTemp, `file-${index}.css`), `.a { color: red${index}; }\n.b { color: red${index}; }\n`);
    }

    try {
      const { stdout, status } = run([dirTemp]);
      assert.strictEqual(status, 1);
      for (let index = 0; index < 12; index++) {
        assert.ok(stdout.includes(path.join(dirTemp, `file-${index}.css`)));
      }
      // Each file’s own report must stay intact and in order, not interleaved
      assert.match(stdout, /file-0\.css[\s\S]*file-1\.css[\s\S]*file-11\.css/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});

describe('Exit code', () => {
  test('Report mode exits 0 despite findings', () => {
    const { stdout, status } = run(['--exit-zero', path.join(fixturesDir, 'merge-safety.css')]);
    assert.match(stdout, findingsRow(2));
    assert.strictEqual(status, 0);
  });

  test('`-z` is the short form', () => {
    const { status } = run(['-z', path.join(fixturesDir, 'merge-safety.css')]);
    assert.strictEqual(status, 0);
  });

  test('`--fix` exits 0 despite a group skipped as unsafe, and still applies the safe merge', () => {
    const dirTemp = makeTempDir('temp_exit_zero_fix');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout, status } = run(['--fix', '--exit-zero', file]);
      assert.ok(stdout.includes('1 finding skipped (considered unsafe to auto-merge)'));
      assert.strictEqual(status, 0);
      assert.match(fs.readFileSync(file, 'utf8'), RE_MERGED_AC);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix --savings-only` exits 0 despite a withheld file', () => {
    const dirTemp = makeTempDir('temp_exit_zero_withheld');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      const { stdout, status } = run(['--fix', '--savings-only', '--exit-zero', file]);
      assert.match(stdout, RE_WITHHELD_ONE);
      assert.strictEqual(status, 0);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), cssGrowing);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Does not forgive a file that fails to read or parse', () => {
    const dirTemp = makeTempDir('temp_exit_zero_error');
    const file = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(file, '.broken { color XP_WIN, }\n');

    try {
      const { stderr, status } = run(['--exit-zero', file]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  // `chmod` only restricts read access on POSIX—on Windows it merely toggles
  // the read-only (write-protection) attribute, so `readFile` would still
  // succeed there and this couldn’t exercise the failure it’s meant to. Root
  // bypasses file permission checks entirely on POSIX, too, so a CI runner
  // (or container) executing as root would hit the same false negative.
  const skipUnreadableTest = process.platform === 'win32'
    ? 'chmod doesn’t restrict read access on Windows'
    : (process.getuid?.() === 0 ? 'root bypasses file permission checks' : false);

  test('Does not forgive a file discovered but unreadable at read time', { skip: skipUnreadableTest }, () => {
    const dirTemp = makeTempDir('temp_exit_zero_unreadable');
    const file = path.join(dirTemp, 'locked.css');
    fs.writeFileSync(file, '.a { color: red; }\n');
    fs.chmodSync(file, 0o000);

    try {
      const { stderr, status } = run(['--exit-zero', file]);
      assert.match(stderr, /Could not read/);
      assert.strictEqual(status, 1);
    } finally {
      fs.chmodSync(file, 0o644);
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('A read/parse failure still fails the run even alongside a clean file', () => {
    const dirTemp = makeTempDir('temp_exit_zero_error_multi');
    const fileGood = path.join(dirTemp, 'good.css');
    const fileBad = path.join(dirTemp, 'bad.css');
    fs.writeFileSync(fileGood, '.a { color: blue; }\n');
    fs.writeFileSync(fileBad, '.broken { color XP_WIN, }\n');

    try {
      const { stderr, status } = run(['--exit-zero', fileGood, fileBad]);
      assert.match(stderr, RE_SYNTAX_ERROR);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('A missing file still fails the run, even with `--exit-zero`', () => {
    const dirTemp = makeTempDir('temp_exit_zero_missing');
    const file = path.join(dirTemp, 'missing.css');

    try {
      const { stderr, status } = run(['--exit-zero', file]);
      assert.match(stderr, /Could not resolve/);
      assert.doesNotMatch(stderr, /\bat\s+async\b/);
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Loads `exitZero: true` from the config file', () => {
    const dirTemp = makeTempDir('temp_config_exit_zero');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { exitZero: true };\n');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { status } = run([file], { cwd: dirTemp });
      assert.strictEqual(status, 0);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--no-exit-zero` overrides `exitZero: true` from the config file', () => {
    const dirTemp = makeTempDir('temp_config_no_exit_zero');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { exitZero: true };\n');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { status } = run(['--no-exit-zero', file], { cwd: dirTemp });
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`-e` is the short form for `--no-exit-zero`', () => {
    const dirTemp = makeTempDir('temp_config_no_exit_zero_short');
    fs.writeFileSync(path.join(dirTemp, 'css-dedup.config.js'), 'export default { exitZero: true };\n');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { status } = run(['-e', file], { cwd: dirTemp });
      assert.strictEqual(status, 1);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Help text lists `-z, --exit-zero` and `-e, --no-exit-zero`', () => {
    const { stdout, status } = run(['--help']);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('-z, --exit-zero'));
    assert.ok(stdout.includes('-e, --no-exit-zero'));
  });
});

describe('Quiet mode', () => {
  test('Report mode: suppresses the findings and skipped-group detail, keeps the summary table', () => {
    const file = path.join(fixturesDir, 'merge-safety.css');
    const plain = run([file]);
    assert.ok(plain.stdout.includes('duplicate   color: red'));
    assert.ok(plain.stdout.includes('1 duplicate group considered unsafe to auto-merge:'));

    const { stdout, status } = run(['--quiet', file]);
    assert.strictEqual(status, 1);
    assert.ok(!stdout.includes('duplicate   color: red'));
    assert.ok(!stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
    assert.ok(!stdout.includes('— intervening'));
    assert.match(stdout, findingsRow(2));
    assert.ok(stdout.includes(`Summary for ${file}:`));
  });

  test('`--fix --quiet`: suppresses the skipped-group detail listing, keeps the summary bullets', () => {
    const dirTemp = makeTempDir('temp_quiet_fix');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--fix', '--quiet', file]);
      assert.ok(!stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
      assert.ok(!stdout.includes('— intervening'));
      assert.ok(stdout.includes('1 finding skipped (considered unsafe to auto-merge)'));
      assert.ok(stdout.includes('declaration consolidated'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Multi-file `--quiet` run: suppresses each file’s path header, keeps per-file and overall summaries', () => {
    const dirTemp = makeTempDir('temp_quiet_multi');
    const fileA = path.join(dirTemp, 'a.css');
    const fileB = path.join(dirTemp, 'b.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), fileA);
    fs.copyFileSync(path.join(fixturesDir, 'basic.css'), fileB);

    try {
      const { stdout } = run(['--quiet', fileA, fileB]);
      const headerLines = stdout.split('\n').filter(line => line.trim() === fileA || line.trim() === fileB);
      assert.strictEqual(headerLines.length, 0);
      assert.ok(stdout.includes(`Summary for ${fileA}:`));
      assert.ok(stdout.includes(`Summary for ${fileB}:`));
      assert.ok(stdout.includes('Summary for all files:'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`-q` is the short form for `--quiet`', () => {
    const file = path.join(fixturesDir, 'merge-safety.css');
    const { stdout } = run(['-q', file]);
    assert.ok(!stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
  });

  test('Help text lists `-q, --quiet`', () => {
    const { stdout, status } = run(['--help']);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('-q, --quiet'));
  });
});
// A parallel run must be a timing change and nothing else, so these compare
// against the same run forced onto one thread rather than asserting particular
// output—the rest of this file already pins down what that output says

describe('Fixtures', () => {
  test('basic.css reports the expected duplicate count', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.match(stdout, findingsRow(3));
  });

  test('media-queries.css only flags the duplicate inside the shared `@media` scope', () => {
    const { stdout } = run([path.join(fixturesDir, 'media-queries.css')]);
    assert.match(stdout, findingsRow(1));
    assert.ok(stdout.includes('min-width: 768px'));
  });

  test('nesting.css flags the duplicate between nested rules, not against the parent’s own declaration', () => {
    const { stdout } = run([path.join(fixturesDir, 'nesting.css')]);
    assert.match(stdout, findingsRow(1));
    assert.ok(stdout.includes('&:hover'));
    assert.ok(stdout.includes('&:focus'));
  });

  test('layers.css flags the duplicate inside the shared `@layer` block and doesn’t crash on the statement form', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'layers.css')]);
    assert.strictEqual(status, 1);
    assert.match(stdout, findingsRow(1));
    assert.ok(stdout.includes('@layer reset'));
  });

  test('hacks.css reports no findings once hack selectors are excluded', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'hacks.css')]);
    assert.ok(stdout.includes('No duplicate declarations found.'));
    assert.strictEqual(status, 0);
  });

  test('hacks.css reports a finding with `--no-ignore-selectors-defaults`', () => {
    const { stdout } = run(['--no-ignore-selectors-defaults', path.join(fixturesDir, 'hacks.css')]);
    assert.match(stdout, findingsRow(1));
  });

  test('hacks.css reports a finding with `-n`', () => {
    const { stdout } = run(['-n', path.join(fixturesDir, 'hacks.css')]);
    assert.match(stdout, findingsRow(1));
  });

  test('merge-safety.css report mode explains the unsafe group, then closes with the summary table', () => {
    const { stdout } = run([path.join(fixturesDir, 'merge-safety.css')]);
    assert.match(stdout, RE_PAYOFF_FIX);
    assert.ok(stdout.includes('1 duplicate group considered unsafe to auto-merge:'));
    assert.match(stdout, /background: #ffffff—intervening `background` declaration in `\.y`/);
    // The unsafe-group detail must print before the summary, so a long
    // skipped list can’t push the outcome off-screen and out of scrollback
    const unsafeIndex = stdout.indexOf('unsafe to auto-merge');
    const summaryIndex = stdout.indexOf('Summary for');
    assert.ok(unsafeIndex !== -1 && summaryIndex !== -1);
    assert.ok(unsafeIndex < summaryIndex);
    // The default-mode column pair saves less than the aggressive pair,
    // since aggressive additionally allows the group just flagged unsafe
    assert.match(stdout, /2 \(2\) {2,}-\d+(?:\.\d+)? (?:B|KB|MB) \(-\d+\.\d%\) {2,}-\d+(?:\.\d+)? (?:B|KB|MB) \(-\d+\.\d%\) {2,}-\d+(?:\.\d+)? (?:B|KB|MB) \(-\d+\.\d%\) {2,}-\d+(?:\.\d+)? (?:B|KB|MB) \(-\d+\.\d%\)/);
  });

  test('merge-safety.css --fix consolidates the safe pair and skips the unsafe one', () => {
    const dirTemp = makeTempDir('temp_merge_safety');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(stdout.includes('1 declaration consolidated'));
      assert.ok(stdout.includes('1 finding skipped (considered unsafe to auto-merge)'));
      assert.match(stdout, /\d+ → \d+ bytes, -\d+\.\d%/);

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, RE_MERGED_AC);
      assert.ok(output.includes('.x {'));
      assert.ok(output.includes('.z {'));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`--fix` omits the “unsafe to auto-merge” qualifier when nothing was skipped', () => {
    const dirTemp = makeTempDir('temp_nothing_skipped');
    const file = path.join(dirTemp, 'clean.css');
    fs.writeFileSync(file, '.a { color: red; }\n.b { color: red; }\n');

    try {
      const { stdout } = run(['--fix', file]);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.ok(!stdout.includes('unsafe to auto-merge'));
      assert.ok(!/\d+ skipped/.test(stdout));
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('basic.css report mode suggests the byte savings from running `--fix`', () => {
    const { stdout } = run([path.join(fixturesDir, 'basic.css')]);
    assert.match(stdout, RE_PAYOFF_FIX);
  });

  test('aggressive.css finds nothing under default rules, but the report table still quotes the aggressive column', () => {
    const { stdout, status } = run([path.join(fixturesDir, 'aggressive.css')]);
    // Nothing for `--fix` (no `--aggressive`) to act on by default, so this
    // doesn’t count against the exit code the way a default-mode finding would
    assert.strictEqual(status, 0);
    assert.match(stdout, findingsRow(0));
    assert.match(stdout, /0 \(1\)/);
  });

  test('aggressive.css lists the aggressive-only duplicate in detail even though report mode ignores `--aggressive`', () => {
    const { stdout } = run([path.join(fixturesDir, 'aggressive.css')]);
    assert.ok(stdout.includes('duplicate   color: hsl(0 0% 100%)'));
    // `-f`/`-f -s` read `n/a`, not `0 B (0.0%)`—there are 0 findings under
    // default rules, so there’s nothing for either to have run on
    assert.match(stdout, /0 \(1\) {2,}n\/a {2,}n\/a {2,}-[\d.]+ (?:B|KB|MB) \(-\d+\.\d%\)/);
  });

  test('Rejects bare `--aggressive` without `--fix`', () => {
    const { stderr, status } = run(['--aggressive', path.join(fixturesDir, 'basic.css')]);
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes('`--aggressive` only applies together with `--fix`'));
  });

  test('A column reads `n/a`, not `0 B (0.0%)`, when its own mode has 0 findings', () => {
    const { stdout } = run([path.join(fixturesDir, 'aggressive.css')]);
    // `-f`/`-f -s` belong to default rules, which find nothing here—`-f -a`/
    // `-f -a -s` belong to aggressive rules, which do, so only those two
    // carry a real figure
    assert.match(stdout, /0 \(1\) {2,}n\/a {2,}n\/a {2,}-[\d.]+ (?:B|KB|MB) \(-\d+\.\d%\)/);
  });

  test('A column reads `n/a` when its findings are all unsafe, even though `findings > 0`', () => {
    const dirTemp = makeTempDir('temp_all_unsafe');
    const file = path.join(dirTemp, 'all-unsafe.css');
    // The one duplicate here is blocked by the intervening `.mid` rule under
    // default rules, so `--fix` wouldn’t touch the file at all—`findings`
    // is 1, not 0, but `applied` still comes out empty
    fs.writeFileSync(file, '.a { color: red; }\n.mid { color: blue; }\n.b { color: red; }\n');

    try {
      const { stdout } = run([file]);
      assert.match(stdout, /1 \(1\) {2,}n\/a {2,}n\/a {2,}-[\d.]+ (?:B|KB|MB) \(-\d+\.\d%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Highlights the best savings column(s) in bold green, excluding `n/a`', () => {
    // merge-safety.css: `-f -a`/`-f -a -s` tie for the best (real) outcome;
    // `-f`/`-f -s` save less and stay unmarked
    const clearWinner = runColor([path.join(fixturesDir, 'merge-safety.css')]);
    const winners = [...clearWinner.stdout.matchAll(BEST_CELL)].map(match => match[1].trim());
    assert.deepStrictEqual(winners, ['-34 B (-8.9%)', '-34 B (-8.9%)']);

    // basic.css: All four columns save the same amount (aggressive adds
    // nothing here), so all four tie and all four get marked
    const fourWayTie = runColor([path.join(fixturesDir, 'basic.css')]);
    const tied = [...fourWayTie.stdout.matchAll(BEST_CELL)].map(match => match[1].trim());
    assert.strictEqual(tied.length, 4);
    assert.ok(tied.every(cell => cell === '-46 B (-16.9%)'));
  });

  test('Marks nothing when every non-`n/a` column would grow the file', () => {
    const dirTemp = makeTempDir('temp_highlight_all_grow');
    const file = path.join(dirTemp, 'grow.css');
    fs.writeFileSync(file, cssGrowing);

    try {
      // `-f`/`-f -a` both grow the file (the only real, non-`n/a` figures
      // here); a “least-bad” growth isn’t an improvement worth pointing at.
      // `matchAll()` over the shared global-flagged `BEST_CELL`, not
      // `.test()`, which would mutate its `lastIndex` for later tests.
      const { stdout } = runColor([file]);
      assert.strictEqual([...stdout.matchAll(BEST_CELL)].length, 0);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('Highlights the all-files table’s best column(s) per row, including the `Total` row', () => {
    const { stdout } = runColor([path.join(fixturesDir, 'basic.css'), path.join(fixturesDir, 'aggressive.css'), path.join(fixturesDir, 'merge-safety.css')]);
    // The all-files table is the last of several tables in this output—only
    // count matches from `Summary for all files:` onward
    const allFilesTable = stdout.slice(stdout.indexOf('Summary for all files:'));
    const winners = [...allFilesTable.matchAll(BEST_CELL)].map(match => match[1].trim());
    // basic.css (4-way tie) + aggressive.css (`-f`/`-f -s` are `n/a`, so
    // only its 2-way `-f -a`/`-f -a -s` tie counts) + merge-safety.css
    // (2-way tie) + Total (2-way tie, aggressive columns) = 10 marked cells
    assert.strictEqual(winners.length, 10);
  });

  test('aggressive.css --fix --aggressive merges across the blocks, drops the emptied one, and suggests testing', () => {
    const dirTemp = makeTempDir('temp_aggressive');
    const file = path.join(dirTemp, 'aggressive.css');
    fs.copyFileSync(path.join(fixturesDir, 'aggressive.css'), file);

    try {
      const { stdout } = run(['--fix', '--aggressive', file]);
      assert.ok(stdout.includes('* 1 declaration consolidated: Reduced duplication and saved'));
      assert.match(stdout, /1 of these merges is aggressive-only—probably, but not provably, safe\. Review the diff and test the affected pages\./);

      const output = fs.readFileSync(file, 'utf8');
      assert.strictEqual(output.match(/@media/g).length, 1);
      assert.match(output, /\.a,\s*\.b\s*{\s*color: #fff;\s*}/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('merge-safety.css --fix without `--aggressive` notes what a re-run with it would add', () => {
    const dirTemp = makeTempDir('temp_merge_safety_hint');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['--fix', file]);
      assert.match(stdout, /intervening `background` declaration in `\.y`.*\(may merge with `--aggressive`\)/);
      assert.match(stdout, /\* 1 more declaration in aggressive mode: Reduce duplication and save \d+ more bytes \(-\d+\.\d%\) with `--fix --aggressive` \(total: -\d+ bytes \/ -\d+\.\d%\)/);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('merge-safety.css -f consolidates the safe pair (short flag)', () => {
    const dirTemp = makeTempDir('temp_merge_safety_short');
    const file = path.join(dirTemp, 'merge-safety.css');
    fs.copyFileSync(path.join(fixturesDir, 'merge-safety.css'), file);

    try {
      const { stdout } = run(['-f', file]);
      assert.ok(stdout.includes('1 declaration consolidated'));

      const output = fs.readFileSync(file, 'utf8');
      assert.match(output, RE_MERGED_AC);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});

describe('Parallel runs', () => {
  // Kept in step with `css-dedup.js`, which can’t be imported (it parses
  // `process.argv` on load)
  const MESSAGE_POOL_FALLBACK = 'Could not start worker threads; processing files one at a time';

  // Enough findings and skipped groups per file to reach every detail block
  const cssPerFile = [
    '.a { color: red; }',
    '.b { color: red; }',
    '@media print { .c { margin: 0; } .d { margin: 0; } }',
    '.e { transform: rotate(90deg); }',
    '.unrelated:hover { color: blue; }',
    '.f { transform: rotate(100grad); }',
    '',
  ].join('\n');

  function withCorpus(name, fileCount, fn, body = () => cssPerFile) {
    const dirTemp = makeTempDir(`temp_parallel_${name}`);
    for (let i = 0; i < fileCount; i++) {
      fs.writeFileSync(path.join(dirTemp, `sheet-${i}.css`), body(i));
    }
    try {
      return fn(dirTemp);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  }

  const runWithWorkers = (workers, args) => run(args, { env: { ...process.env, CSS_DEDUP_WORKERS: String(workers) } });

  // Each path gets its own copy, so `--fix` writes don’t leave the second run
  // nothing to do
  function compare(name, fileCount, args) {
    const sequential = withCorpus(`${name}_seq`, fileCount, dir => ({ dir, ...runWithWorkers(0, [...args, dir]), files: readAll(dir) }));
    const parallel = withCorpus(`${name}_par`, fileCount, dir => ({ dir, ...runWithWorkers(4, [...args, dir]), files: readAll(dir) }));
    return { sequential, parallel };
  }

  // Keyed by name, since the full path differs between the two copies
  function readAll(dir) {
    return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
  }

  // Identical output is also what a silent fallback to sequential processing
  // would produce, so this asserts the pool actually ran—without that, the
  // suite would stay green with the worker path broken
  function assertSameRun({ sequential, parallel }) {
    assert.ok(!parallel.stderr.includes(MESSAGE_POOL_FALLBACK), `expected the worker pool to run, but it fell back:\n${parallel.stderr}`);
    const normalize = ({ dir }, text) => text.split(dir).join('<dir>');
    assert.strictEqual(normalize(parallel, parallel.stdout), normalize(sequential, sequential.stdout));
    assert.strictEqual(normalize(parallel, parallel.stderr), normalize(sequential, sequential.stderr));
    assert.strictEqual(parallel.status, sequential.status);
    assert.deepStrictEqual(parallel.files, sequential.files);
  }

  test('Report mode: output is identical to the same run on one thread', () => {
    const results = compare('report', 6, []);
    assert.ok(results.parallel.stdout.includes('Summary for all files:'));
    assertSameRun(results);
  });

  test('`--fix`: output and the files written are identical to the same run on one thread', () => {
    const results = compare('fix', 6, ['--fix']);
    assert.ok(results.parallel.stdout.includes('* Wrote '));
    assertSameRun(results);
  });

  test('`--fix --aggressive` and `--fix --savings-only`: identical to the same runs on one thread', () => {
    assertSameRun(compare('fix_agg', 6, ['--fix', '--aggressive']));
    assertSameRun(compare('fix_savings', 6, ['--fix', '--savings-only']));
  });

  test('`--quiet`: identical to the same run on one thread', () => {
    assertSameRun(compare('quiet', 6, ['--quiet']));
  });

  // The first file is by far the slowest, so it is dispatched first and lands
  // last, forcing every later result to be buffered. Equally-sized files would
  // often finish in order and pass without exercising `deliver()` at all.
  test('Per-file reports stay in file order, however the workers finish', () => {
    const cssSlow = Array.from({ length: 600 }, (_, i) => `.slow-${i} { color: red; margin: 0; padding: 0; }`).join('\n');
    withCorpus('order', 8, dir => {
      const { stdout } = runWithWorkers(4, [dir]);
      const headers = stdout.split('\n').filter(line => line.startsWith(dir)).map(line => path.basename(line.trim()));
      assert.deepStrictEqual(headers, fs.readdirSync(dir).sort());
    }, i => (i === 0 ? cssSlow : cssPerFile));
  });

  // Everything above sets `CSS_DEDUP_WORKERS`, which bypasses both floors—so
  // without this, the default branch every real run takes goes untested
  test('Auto: a run over both floors uses the pool with `CSS_DEDUP_WORKERS` unset', () => {
    // Bytes PostCSS parses but barely consolidates: big without being slow
    const padding = `/* ${'-'.repeat(50_000)} */\n`;
    const body = () => padding + cssPerFile;
    const auto = withCorpus('auto_par', 4, dir => ({ dir, ...run([dir]), files: readAll(dir) }), body);
    const sequential = withCorpus('auto_seq', 4, dir => ({ dir, ...runWithWorkers(0, [dir]), files: readAll(dir) }), body);

    // Below three cores the run correctly stays sequential, with no pool to
    // assert about
    if (poolSize(4) > 1) {
      assert.ok(shouldParallelize(4, padding.length * 4), 'expected this corpus to clear both automatic floors');
      assertSameRun({ sequential, parallel: auto });
    }
  });

  test('A run under either floor stays on one thread', () => {
    // Enough files, but nowhere near enough CSS
    assert.strictEqual(shouldParallelize(60, 191_999), false);
    // Plenty of CSS, but too few files
    assert.strictEqual(shouldParallelize(3, 10_000_000), false);
    // Over both, the answer is whatever the core count allows
    assert.strictEqual(shouldParallelize(4, 192_000), poolSize(4) > 1);
  });

  test('`CSS_DEDUP_WORKERS` overrides both the pool size and the floors', () => {
    const previous = process.env.CSS_DEDUP_WORKERS;
    try {
      process.env.CSS_DEDUP_WORKERS = '3';
      assert.strictEqual(poolSize(10), 3);
      // Never more workers than there are files to give them
      assert.strictEqual(poolSize(2), 2);
      // An explicit setting means it, floors and all
      assert.strictEqual(shouldParallelize(2, 1), true);

      // `0` and `1` both name the sequential path
      for (const sequential of ['0', '1']) {
        process.env.CSS_DEDUP_WORKERS = sequential;
        assert.strictEqual(shouldParallelize(60, 10_000_000), false);
      }

      // A value that isn’t a count at all falls back to automatic sizing
      process.env.CSS_DEDUP_WORKERS = 'lots';
      assert.strictEqual(poolSize(1000), Math.max(availableParallelism() - 1, 0));
    } finally {
      if (previous === undefined) delete process.env.CSS_DEDUP_WORKERS;
      else process.env.CSS_DEDUP_WORKERS = previous;
    }
  });

  test('Auto: the pool leaves one core to the main thread', () => {
    const previous = process.env.CSS_DEDUP_WORKERS;
    delete process.env.CSS_DEDUP_WORKERS;
    try {
      assert.strictEqual(poolSize(1000), Math.max(availableParallelism() - 1, 0));
    } finally {
      if (previous !== undefined) process.env.CSS_DEDUP_WORKERS = previous;
    }
  });

  // A failure keeps its place in the output rather than surfacing wherever its
  // worker happened to give up
  test('A file that fails to parse fails only itself, in place', () => {
    const dirTemp = makeTempDir('temp_parallel_broken');
    for (const name of ['a.css', 'b.css', 'c.css', 'e.css']) {
      fs.writeFileSync(path.join(dirTemp, name), cssPerFile);
    }
    fs.writeFileSync(path.join(dirTemp, 'd.css'), 'a { color: red;\n');

    try {
      const sequential = runWithWorkers(0, [dirTemp]);
      const parallel = runWithWorkers(4, [dirTemp]);
      assert.strictEqual(parallel.status, 1);
      assert.ok(parallel.stdout.includes('(1 file could not be processed; see errors above)'));
      assert.match(parallel.stderr, RE_SYNTAX_ERROR_UNCLOSED);
      assert.strictEqual(parallel.stdout, sequential.stdout);
      assert.strictEqual(parallel.stderr, sequential.stderr);
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  test('`CSS_DEDUP_WORKERS` is listed in the help text', () => {
    const { stdout, status } = run(['--help']);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('CSS_DEDUP_WORKERS'));
  });
});
