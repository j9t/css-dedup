import { analyzeRoot, dedupRoot } from './index.js';

// A thin PostCSS plugin wrapper around `analyzeRoot`/`dedupRoot`, for
// dropping UDJO into an existing `postcss([…])` pipeline (e.g. alongside
// Autoprefixer, cssnano) instead of running it as a separate file-based pass.
// By default it only reports, via `result.warn()`—pass `dedup: true` to
// rewrite the root in place, same as the CLI’s `--dedup`.
export default function udjo(options = {}) {
  return {
    postcssPlugin: 'udjo',
    OnceExit(root, { result }) {
      if (options.dedup) {
        const { skipped } = dedupRoot(root, options);
        for (const item of skipped) {
          root.warn(result, `Duplicate \`${item.key}\` left unmerged (${item.scope === 'root' ? 'root' : item.scope}): ${item.reason}`);
        }
        return;
      }

      const { findings } = analyzeRoot(root, options);
      for (const finding of findings) {
        if (finding.repeatedSelector) {
          root.warn(result, `Selector \`${finding.key}\` written ${finding.occurrences.length} times in its scope (${finding.scope === 'root' ? 'root' : finding.scope})`);
          continue;
        }

        const occurrence = finding.occurrences.at(-1);
        const message = finding.redundant
          ? `Redundant declaration \`${finding.key}\` repeated in \`${occurrence.selector}\``
          : `Duplicate declaration \`${finding.key}\` also in ${finding.occurrences.slice(0, -1).map(o => `\`${o.selector}\``).join(', ')}`;
        root.warn(result, message, { node: occurrence.decl });
      }
    },
  };
}

udjo.postcss = true;