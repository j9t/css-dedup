// Turning the CLI’s positional arguments into a list of files, and reading
// them. Nothing here prints.

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join, extname, sep } from 'node:path';

// Directories skipped when recursing into a target directory
const DIRS_IGNORED = new Set(['node_modules']);

// Preprocessor sources, skipped when named directly as an argument (a
// directory scan never reaches them—it collects `.css` only). Most of their
// syntax fails the standard parser anyway, but the subset that parses—nesting
// alongside `@include`/`@extend`—would be consolidated as if those at-rules
// contributed no declarations, and `--fix` would write that back. A denylist
// rather than a `.css` allowlist, so an extension-less path (a process
// substitution, say) still works.
const EXTENSIONS_PREPROCESSOR = new Set(['.less', '.sass', '.scss', '.styl']);

// Concurrency cap for `prefetchContents()`
const CONCURRENCY_READ = 8;

// Total bytes the prefetch may hold at once. `CONCURRENCY_READ` bounds how many
// reads are in flight, not how much is retained—without this, a run over a
// large corpus holds every file’s text from the first read to the last render.
// Past the budget, targets are left unresolved and read at processing time
// instead. Up to `CONCURRENCY_READ` reads may already be in flight when the
// budget runs out, so the ceiling is approximate.
const PREFETCH_BUDGET_BYTES = 64 * 1024 * 1024;

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
// excluded”—two situations deserving two different error messages. Preprocessor
// sources come back under `unsupported`, kept out of `discovered` so neither
// message counts a file this function already declined.
export async function expandTargets(targets, ignorePathPatterns) {
  const expanded = [];
  const declined = [];

  for (const target of targets) {
    if (target === '-') {
      expanded.push(target);
      continue;
    }

    const pathResolved = resolve(target);
    const stats = await stat(pathResolved);
    if (stats.isDirectory()) expanded.push(...(await collectCssFiles(pathResolved)).sort());
    else if (EXTENSIONS_PREPROCESSOR.has(extname(pathResolved).toLowerCase())) declined.push(pathResolved);
    else expanded.push(pathResolved);
  }

  // A path reachable twice—named directly and again through a directory, or
  // simply repeated—is one file. Deduplicated before the count, so `discovered`
  // speaks for real files rather than argument spellings.
  const unique = [...new Set(expanded)];
  const unsupported = [...new Set(declined)];
  if (!ignorePathPatterns.length) return { files: unique, discovered: unique.length, unsupported };

  const files = unique.filter(file => (
    file === '-' || !ignorePathPatterns.some(pattern => pattern.test(toPortablePath(file)))
  ));
  return { files, discovered: unique.length, unsupported };
}

// Reads non-STDIN targets concurrently, ahead of the per-file processing
// loop—so disk I/O for file N+1 overlaps with the CPU work for file N, instead
// of each file’s read waiting behind the previous file’s full report. Outcomes
// are captured rather than thrown, so a read failure still surfaces through
// the existing per-file error message, one file at a time, in the original
// order. Entries past the byte budget are left unset—`readTarget()` reads
// those on demand, so the `{ css }` / `{ err }` contract is unchanged for
// everything a caller actually gets back.
export async function prefetchContents(files, budgetBytes = PREFETCH_BUDGET_BYTES) {
  const contents = new Array(files.length);
  let next = 0;
  let remaining = budgetBytes;

  async function worker() {
    while (next < files.length && remaining > 0) {
      const index = next++;
      const file = files[index];
      if (file === '-') continue;

      const pathResolved = resolve(file);
      try {
        // The size is reserved before the read, not subtracted after it: A file
        // larger than what is left would otherwise be loaded in full before the
        // budget noticed, which is exactly the case the budget exists for. A
        // file that does not fit is left unresolved for `readTarget()`, and the
        // budget stays available for smaller ones behind it.
        const { size } = await stat(pathResolved);
        if (size > remaining) continue;
        remaining -= size;
        contents[index] = { css: await readFile(pathResolved, 'utf8') };
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
