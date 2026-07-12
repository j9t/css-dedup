import type { Root } from 'postcss';

export type SelectorPattern = string | RegExp;

export interface CssDedupOptions {
  from?: string;
  ignoreSelectors?: SelectorPattern[];
  ignoreSelectorsDefaults?: boolean;
  aggressive?: boolean;
  savingsOnly?: boolean;
}

export interface Occurrence {
  selector: string;
  selectors: string[];
  prop?: string;
  value?: string;
  line?: number;
}

export interface Finding {
  scope: string;
  key: string;
  redundant?: true;
  repeated?: true;
  occurrences: Occurrence[];
}

export interface AnalyzeResult {
  findings: Finding[];
}

export interface AppliedChange {
  scope: string;
  key: string;
  selectors?: string[];
  value?: string;
  redundant?: true;
  folded?: true;
}

export interface SkippedChange {
  scope: string;
  key: string;
  reason: string;
}

export interface ByteCounts {
  before: number;
  after: number;
  saved: number;
}

export interface WithheldResult {
  count: number;
  bytes: ByteCounts;
}

export interface DedupRootResult {
  applied: AppliedChange[];
  skipped: SkippedChange[];
  bytes: ByteCounts;
  withheld?: WithheldResult;
}

export interface DedupResult extends DedupRootResult {
  css: string;
}

export declare function analyzeRoot(root: Root, options?: CssDedupOptions): AnalyzeResult;

export declare function analyze(css: string, options?: CssDedupOptions): AnalyzeResult;

export declare function dedupRoot(root: Root, options?: CssDedupOptions): DedupRootResult;

export declare function dedup(css: string, options?: CssDedupOptions): DedupResult;