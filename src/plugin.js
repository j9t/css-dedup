import { analyzeRoot, dedupRoot } from './index.js';

// A thin PostCSS plugin wrapper around `analyzeRoot`/`dedupRoot`, for
// dropping CSS Dedup into an existing `postcss([…])` pipeline (e.g., alongside
// Autoprefixer, cssnano) instead of running it as a separate file-based pass.
// By default it only reports, via `result.warn()`—pass `fix: true` to
// rewrite the root in place, same as the CLI’s `--fix`.
export default function cssdedup(options = {}) {
  return {
    postcssPlugin: 'css-dedup',
    OnceExit(root, { result }) {
      if (options.fix) {
        const { skipped, withheld } = dedupRoot(root, options);
        if (withheld) {
          root.warn(result, `Consolidation withheld (\`savingsOnly\`): ${withheld.count} merge${withheld.count !== 1 ? 's' : ''} would make the style sheet ${Math.abs(withheld.bytes.saved)} bytes bigger`);
        }
        for (const item of skipped) {
          root.warn(result, `Duplicate \`${item.key}\` left unmerged (${item.scope === 'root' ? 'root' : item.scope}): ${item.reason}`);
        }
        return;
      }

      const { findings } = analyzeRoot(root, options);
      for (const finding of findings) {
        if (finding.repeated) {
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

cssdedup.postcss = true;