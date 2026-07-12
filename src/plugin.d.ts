import type { PluginCreator } from 'postcss';
import type { CssDedupOptions } from './index.js';

export interface CssDedupPluginOptions extends CssDedupOptions {
  fix?: boolean;
}

declare const cssdedup: PluginCreator<CssDedupPluginOptions>;

export default cssdedup;