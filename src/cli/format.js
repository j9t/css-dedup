// Byte figures and the prose clauses wrapping them. Every percentage in the
// CLI’s output is computed here, against whichever “before” size the caller is
// speaking for—one file’s own, or a whole run’s combined original size.

export function sumBy(list, fn) {
  return list.reduce((total, item) => total + fn(item), 0);
}

// `${n} file${plural(n)}`—the CLI states a lot of counts
export function plural(count) {
  return count !== 1 ? 's' : '';
}

// Byte counts are pinned to one locale: the percentages beside them use
// `toFixed()`, which always emits a dot decimal separator, so a host locale
// that groups with dots (`1.234 bytes (-12.3%)`) would read as two different
// number formats in one sentence
function formatCount(bytes) {
  return bytes.toLocaleString('en-US');
}

function percentOf(bytesAbs, before) {
  return before ? (bytesAbs / before) * 100 : 0;
}

// Savings are “-” (the file got smaller), growth “+”, so the sign carries the
// direction and no surrounding sentence has to
function signOf(delta) {
  return delta >= 0 ? '-' : '+';
}

// A byte magnitude with a signed percentage, for the bulleted summaries.
// `more` marks the amount as additional on top of a total stated elsewhere
// (the `--aggressive` bullets, which quote what aggressive mode adds beyond
// plain `--fix`).
export function formatByteMagnitude(bytesAbs, before, sign, { more = false } = {}) {
  return `${formatCount(bytesAbs)} ${more ? 'more bytes' : 'bytes'} (${sign}${percentOf(bytesAbs, before).toFixed(1)}%)`;
}

// One bullet’s outcome clause—always still-hypothetical phrasing, since the
// one bullet describing an already-applied `--fix` change has its own clause
// in `formatAppliedReduceClause()`
export function formatByteDeltaClause(saved, before, more = false) {
  const magnitude = formatByteMagnitude(Math.abs(saved), before, signOf(saved), { more });
  return saved >= 0 ? `save ${magnitude}` : `grow by ${magnitude}`;
}

// A single-file bullet’s full outcome clause: “Reduce duplication and save …”
// when it pays off, “but grow …” when it doesn’t
export function formatReduceClause(saved, before, more = false) {
  return `Reduce duplication ${saved >= 0 ? 'and' : 'but'} ${formatByteDeltaClause(saved, before, more)}`;
}

// The fix-mode consolidated bullet’s clause: the concrete before → after
// counts fold into the parenthetical, and the conjunction is always “and”—
// “but grew” read as though the growth undercut the “reduced duplication”
// result, when `--fix` applies both changes regardless
export function formatAppliedReduceClause(bytes) {
  const bytesAbs = Math.abs(bytes.saved);
  const magnitude = `${formatCount(bytesAbs)} bytes (${formatCount(bytes.before)} → ${formatCount(bytes.after)} bytes, ${signOf(bytes.saved)}${percentOf(bytesAbs, bytes.before).toFixed(1)}%)`;
  return `Reduced duplication and ${bytes.saved >= 0 ? `saved ${magnitude}` : `grew by ${magnitude}`}`;
}

// The mixed-results net—shrinking files’ savings minus growing files’ growth—
// against the run’s combined original size
export function formatOverallNet(net, totalBefore) {
  const netAbs = Math.abs(net);
  const sign = signOf(net);
  return `total: ${sign}${formatCount(netAbs)} bytes / ${sign}${percentOf(netAbs, totalBefore).toFixed(1)}%`;
}

// Appended to an `--aggressive` bullet: where its own delta lands once
// combined with the base bullet printed just above
export function formatAggregateTotalNote(totalSaved, before) {
  return ` (${formatOverallNet(totalSaved, before)})`;
}

// A byte magnitude against the overall summary’s own total original size
// rather than one file’s. The explicit “overall” avoids a mismatch reading as
// an error: a file’s own summary a few lines up already showed this same byte
// count against a different (smaller) denominator.
export function formatBytesShareOfTotal(bytesAbs, totalBefore) {
  return `${formatCount(bytesAbs)} bytes (${percentOf(bytesAbs, totalBefore).toFixed(1)}% overall)`;
}

// A byte magnitude for the report table: decimal KB by default (matching how
// web-perf tooling usually states transfer size), falling back to a plain byte
// count when KB would round to “0.0” (a real, if small, saving shouldn’t read
// as nothing), and up to MB past the million-byte line
export function formatSize(bytesAbs) {
  if (bytesAbs >= 1_000_000) return `${(bytesAbs / 1_000_000).toFixed(1)} MB`;
  const kb = (bytesAbs / 1000).toFixed(1);
  if (kb === '0.0') return `${formatCount(bytesAbs)} B`;
  return `${kb} KB`;
}

// One report-table savings cell: sign on both the magnitude and the percentage
// (unlike the bullets’ `formatByteMagnitude()`, which only signs the
// percentage), and no sign at all for an exact no-op
export function formatSavingsCell(saved, before) {
  if (saved === 0) return `${formatSize(0)} (0%)`;
  const savedAbs = Math.abs(saved);
  const sign = signOf(saved);
  return `${sign}${formatSize(savedAbs)} (${sign}${percentOf(savedAbs, before).toFixed(1)}%)`;
}

// The one outcome bullet the all-files summary prints twice—once for the base
// count, once for what `--aggressive` adds—covering its three shapes: every
// file shrinks, every file grows, or the split is mixed.
//
// `tense` is `'done'` for `--fix` (already applied: no flag to suggest, and no
// “but”, since the growth happened alongside the shrinkage rather than despite
// it) or `'todo'` for a recommendation. `more` marks the `--aggressive`
// bullets. `aggregateNote` replaces the mixed shape’s own net rather than
// sitting alongside it—two differently-scoped nets both labeled “total:” back
// to back would read as a contradiction.
export function formatOutcomeBullet({ countLabel, tense, filesShrinkLen, shrinkTotal, filesGrowLen, growTotal, totalBefore, flag, skipFlag, more = false, aggregateNote = '' }) {
  const reduce = tense === 'done' ? 'Reduced' : 'Reduce';
  const flagClause = tense === 'done' ? '' : ` with \`${flag}\``;

  if (filesShrinkLen && !filesGrowLen) {
    const saved = tense === 'done' ? 'saved' : 'save';
    return [`* ${countLabel}: ${reduce} duplication and ${saved} ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })}${flagClause}${aggregateNote}`];
  }

  if (!filesShrinkLen && filesGrowLen) {
    const grew = tense === 'done' ? 'grew' : 'grow';
    const conjunction = tense === 'done' ? 'and' : 'but';
    return [`* ${countLabel}: ${reduce} duplication ${conjunction} ${grew} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}${flagClause}${aggregateNote}`];
  }

  if (filesShrinkLen && filesGrowLen) {
    const netNote = aggregateNote || ` (${formatOverallNet(shrinkTotal - growTotal, totalBefore)})`;
    const shrinkClause = `${filesShrinkLen} file${plural(filesShrinkLen)} by ${formatByteMagnitude(shrinkTotal, totalBefore, '-', { more })}`;
    const growClause = `${filesGrowLen} file${plural(filesGrowLen)} by ${formatByteMagnitude(growTotal, totalBefore, '+', { more })}`;

    // A gerund list for `--fix`, not “and shrink … but grow …”: the run
    // already applied both changes, so there’s no contrast left to draw
    if (tense === 'done') {
      return [`* ${countLabel}: Reduced duplication, shrinking ${shrinkClause} and growing ${growClause}${netNote}`];
    }
    return [
      `* ${countLabel}: Reduce duplication and shrink ${shrinkClause} but grow ${growClause}${flagClause}${netNote}`,
      `  - Skip files that grow in size to save ${formatByteMagnitude(shrinkTotal, totalBefore, '-')} in total with \`${skipFlag}\``,
    ];
  }

  return null;
}

// The “in aggressive mode” preview bullet, shared by `--fix` and report mode—
// always still-hypothetical, so always present-tense even inside a `--fix`
// run. `baseSaved` only spells out the combined total in the trailing note;
// the main clause quotes `aggExtraSaved` on its own.
export function formatAggressivePreviewLine(aggExtra, aggExtraSaved, before, baseSaved) {
  const label = aggExtra > 0 ? `${aggExtra} more declaration${plural(aggExtra)}` : 'Further consolidation';
  return `* ${label} in aggressive mode: ${formatReduceClause(aggExtraSaved, before, true)} with \`--fix --aggressive\`${formatAggregateTotalNote(baseSaved + aggExtraSaved, before)}`;
}
