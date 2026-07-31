// Turning the CLI’s positional arguments into a list of files, and reading
// them. Nothing here prints.

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join, extname, sep } from 'node:path';

// Directories skipped when recursing into a target directory
const DIRS_IGNORED = new Set(['node_modules']);

// Concurrency cap for `prefetchContents()`
const CONCURRENCY_READ = 8;

// A path relative to the working directory with forward slashes, regardless of
// host OS—shared by `--ignore-path` matching and the all-files table’s
// File-column disambiguation
export function toPortablePath(file) {
  return relative(process.cwd(), file).split(sep).join('/');
}

// The label a target is reported under: its resolved path, or `(stdin)`
export function targetLabel(file) {
  return file === '-' ? '(stdin)' : resolve(file);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Recursively collects `.css` files, skipping `node_modules` and dotfolders—
// not configurable, since a project-specific exclude list belongs in
// `css-dedup.config.js`’s `ignorePaths`
async function collectCssFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || DIRS_IGNORED.has(entry.name)) continue;
    const entryPath = join(dirPath, entry.name);

    if (entry.isDirectory()) files.push(...await collectCssFiles(entryPath));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.css') files.push(entryPath);
  }

  return files;
}

// Expands each positional into one or more file paths: `-` (STDIN) and plain
// files pass through, a directory recurses into its `.css` files (sorted, for
// stable output across runs). `ignorePathPatterns` then filters the combined
// list, so an explicit file argument is excluded the same way a
// directory-discovered one is.
//
// Returns `discovered` alongside the filtered `files` so the caller can tell
// “nothing under these targets” from “everything under these targets got
// excluded”—two situations deserving two different error messages.
export async function expandTargets(targets, ignorePathPatterns) {
  const expanded = [];

  for (const target of targets) {
    if (target === '-') {
      expanded.push(target);
      continue;
    }

    const pathResolved = resolve(target);
    const stats = await stat(pathResolved);
    if (stats.isDirectory()) expanded.push(...(await collectCssFiles(pathResolved)).sort());
    else expanded.push(pathResolved);
  }

  if (!ignorePathPatterns.length) return { files: expanded, discovered: expanded.length };

  const files = expanded.filter(file => (
    file === '-' || !ignorePathPatterns.some(pattern => pattern.test(toPortablePath(file)))
  ));
  return { files, discovered: expanded.length };
}

// Reads every non-STDIN target concurrently, ahead of the per-file processing
// loop—so disk I/O for file N+1 overlaps with the CPU work for file N, instead
// of each file’s read waiting behind the previous file’s full report. Outcomes
// are captured rather than thrown, so a read failure still surfaces through
// the existing per-file error message, one file at a time, in the original
// order.
export async function prefetchContents(files) {
  const contents = new Array(files.length);
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (file === '-') continue;
      try {
        contents[index] = { css: await readFile(resolve(file), 'utf8') };
      } catch (err) {
        contents[index] = { err };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY_READ, files.length) }, worker));
  return contents;
}

// Same `{ css }` / `{ err }` shape `prefetchContents()` produces, so a
// prefetched target and STDIN look identical to the caller
export async function readTarget(file, preread) {
  if (preread) return preread;
  try {
    return { css: file === '-' ? await readStdin() : await readFile(resolve(file), 'utf8') };
  } catch (err) {
    return { err };
  }
}
