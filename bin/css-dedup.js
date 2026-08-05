#!/usr/bin/env node

import { styleText } from 'node:util';
import { computeFilePass, describePassError } from '../src/cli/file-pass.js';
import { plural, sumBy } from '../src/cli/format.js';
import { buildRunSettings, loadConfig, parseCliArgs } from '../src/cli/options.js';
import { runPool, shouldParallelize } from '../src/cli/pool.js';
import { printOverallSummary, renderTarget } from '../src/cli/render.js';
import { expandTargets, prefetchContents, readTarget, targetLabel } from '../src/cli/targets.js';

// Same result, but as slow as a sequential run—worth a word rather than a
// silent slowdown. Mirrored in the test suite, which asserts on its absence.
const MESSAGE_POOL_FALLBACK = 'Could not start worker threads; processing files one at a time';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function showHelp(text, code) {
  console.log(text);
  process.exit(code);
}

// One target’s pass on this thread, in the shape a worker sends back
async function runFilePass(css, options, { fix, quiet, isStdin, label }) {
  try {
    return { payload: await computeFilePass(css, options, { fix, quiet, isStdin, label }) };
  } catch (err) {
    return { error: describePassError(err) };
  }
}

// Compute, render, move on—so a long run’s output appears as it goes
async function runSequentially(files, options, flags, prefetched, render) {
  for (const [index, file] of files.entries()) {
    const read = await readTarget(file, prefetched[index]);
    if (read.err) {
      render(index, { readError: read.err });
      continue;
    }
    render(index, await runFilePass(read.css, options, {
      ...flags,
      isStdin: file === '-',
      label: targetLabel(file),
    }));
  }
}

async function resolveFiles(positionals, ignorePathPatterns) {
  // `stat()`/`readdir()` aren’t wrapped inside `expandTargets()`, so a missing
  // path or unreadable directory would otherwise surface as a raw stack trace
  // instead of the clean, styled message every other resolution error gets
  let files, discovered, unsupported;
  try {
    ({ files, discovered, unsupported } = await expandTargets(positionals, ignorePathPatterns));
  } catch (err) {
    fail(styleText('red', `Could not resolve ${positionals.join(', ')}: ${err.message}`));
  }

  // A named file the run can’t speak for, so it fails the run the way an
  // unreadable or unparsable one does—out of `--exit-zero`’s reach, which only
  // ever forgives findings. Reported before the per-file output starts, since
  // the remaining targets still process normally.
  for (const file of unsupported) {
    console.error(styleText('red', `Skipped ${file}: not a \`.css\` file—CSS Dedup analyzes CSS, so point it at the compiled style sheet rather than at a Sass or Less source.`));
  }
  if (unsupported.length) process.exitCode = 1;

  if (!files.length) {
    const targets = positionals.join(', ');
    if (discovered > 0) {
      fail(`All ${discovered} \`.css\` file${plural(discovered)} found under ${targets} ${discovered !== 1 ? 'were' : 'was'} excluded by \`--ignore-path\`/\`ignorePaths\`.`);
    }
    fail(`No \`.css\` files found under ${targets}.`);
  }

  return files;
}

async function main() {
  const { values, positionals } = parseCliArgs(process.argv.slice(2), { fail, showHelp });
  const config = await loadConfig(values.config);
  const { options, ignorePathPatterns, exitZero, flags } = buildRunSettings(values, config);

  const files = await resolveFiles(positionals, ignorePathPatterns);
  const multi = files.length > 1;
  const prefetched = await prefetchContents(files);
  const results = [];

  // The single place a result reaches the terminal, in file order
  const render = (index, outcome) => {
    // A blank line between per-file reports, so each file’s closing summary is
    // visually separated from the next file’s header
    if (multi && index > 0) console.log('');
    results.push(renderTarget(files[index], { multi, flags }, outcome));
  };

  // A run big enough to pay for a pool spreads across worker threads; anything
  // smaller (and STDIN, never here alongside other targets) stays on this one.
  // Both paths feed the same payloads to the same renderer.
  const totalSize = sumBy(prefetched, entry => entry?.css?.length ?? 0);
  const parallel = !files.includes('-') && shouldParallelize(files.length, totalSize);

  if (parallel) {
    const slots = files.map((file, index) => {
      const preread = prefetched[index];
      if (preread?.err) return { outcome: { readError: preread.err } };
      const label = targetLabel(file);
      return preread ? { css: preread.css, label } : { label };
    });

    try {
      await runPool(slots, { options, ...flags }, render);
    } catch (err) {
      // Only a pool that never started can fall back: it dispatched nothing,
      // so the run can start over here. A failure once work was under way has
      // already written files and printed lines, and repeating the set would
      // duplicate both.
      if (!err.poolStartFailed) throw err;
      console.error(styleText('yellow', `${MESSAGE_POOL_FALLBACK} (${err.message})`));
      await runSequentially(files, options, flags, prefetched, render);
    }
  } else {
    await runSequentially(files, options, flags, prefetched, render);
  }

  if (multi) printOverallSummary(results, { fix: flags.fix });

  // `--exit-zero` never changes what got merged—only what a finding (skipped
  // as unsafe, or withheld by `--savings-only`) does to the exit code. A file
  // that couldn’t be read or parsed is a real failure, and stays one.
  if (results.some(result => result.exitFailure && !(exitZero && !result.errored))) process.exitCode = 1;
}

main().catch(err => {
  // A setup failure is the user’s to fix, so it gets the same message
  // every other resolution error gets
  if (err.setupFailed) fail(styleText('red', err.message));
  console.error(err);
  process.exit(1);
});
