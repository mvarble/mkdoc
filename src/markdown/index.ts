import { mdsvex, type MdsvexOptions } from 'mdsvex';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';

import { rehypeKatex } from './katex.js';
import { rehypeAssets, hoistAssetImports } from './assets.js';
import { rehypeMathBox } from './mathbox.js';
import { highlight } from './highlight.js';

export const DOCUMENT_EXTENSIONS = ['.svx', '.md'];

// The whole reason this tool exists: one parser configuration, baked in, rather
// than re-derived per project. Order matters --- `rehypeAssets` has to see the
// tree after KaTeX has run, so that nothing it rewrote is mistaken for an asset.
export interface PreprocessorOptions {
    /** Set while the dev server is running: diagnostics repeat on every rebuild. */
    watch?: boolean;
}

export function markdownPreprocessors(options: PreprocessorOptions = {}) {
    return [
        mdsvex({
            extensions: DOCUMENT_EXTENSIONS,
            remarkPlugins: [remarkFrontmatter, remarkMath],
            rehypePlugins: [[rehypeKatex, { watch: options.watch }], rehypeMathBox, rehypeAssets],
            highlight: { highlighter: highlight },
        } as MdsvexOptions),
        hoistAssetImports,
    ];
}
