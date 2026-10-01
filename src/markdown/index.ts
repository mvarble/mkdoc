import { markdownPreprocessors as sharedPreprocessors } from '@mvarble/mesearch-markdown';

export { DOCUMENT_EXTENSIONS } from '@mvarble/mesearch-markdown';

// The parser configuration --- KaTeX with the base macro table, display math in
// scroll boxes, Shiki with fenced file imports, relative assets turned into
// Vite imports --- is shared with mesearch and the blog, so that a document
// renders the same in all three.
export interface PreprocessorOptions {
    /** Set while the dev server is running: diagnostics repeat on every rebuild. */
    watch?: boolean;
}

export function markdownPreprocessors(options: PreprocessorOptions = {}) {
    return sharedPreprocessors({
        katex: { label: 'mkdoc', watch: options.watch },
        watch: options.watch,
    });
}
