import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { InlineConfig, Plugin } from 'vite';

import type { Document } from './document.js';
import { packageDir, templateDir } from './paths.js';
import { markdownPreprocessors, DOCUMENT_EXTENSIONS } from './markdown/index.js';

// The id the template entries import the document under. It is an alias rather
// than a virtual module so that `vite-plugin-svelte` sees a real `.md`/`.svx`
// path and compiles it.
export const DOCUMENT_ID = 'virtual:mkdoc/document';
const STYLES_ID = 'virtual:mkdoc/styles';

// Warnings the author cannot act on: the deprecated `context="module"` block is
// emitted by mdsvex itself, and markdown's `![alt](...)` syntax is called `alt`.
const IGNORED_WARNINGS = new Set(['script_context_deprecated', 'a11y_img_redundant_alt']);

// Pulls in the stylesheets a document asked for through its `css` frontmatter,
// after the baked-in ones so that a document can override them.
function userStyles(document: Document): Plugin {
    const resolved = `\0${STYLES_ID}`;
    return {
        name: 'mkdoc:styles',
        resolveId: (id) => (id == STYLES_ID ? resolved : null),
        load: (id) =>
            id == resolved
                ? document.styles.map((file) => `import ${JSON.stringify(file)};`).join('\n')
                : null,
    };
}

// Somewhere writable that is not the package directory: a globally installed
// CLI may sit in a directory it cannot write to, and Vite wants to put its
// dependency cache under `root`.
export function cacheDirFor(document: Document): string {
    const hash = crypto.createHash('sha256').update(document.filename).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), `mkdoc-${hash}`);
}

export interface ConfigOptions {
    /** True for `mkdoc dev`, where diagnostics should repeat on every rebuild. */
    watch?: boolean;
}

export function mkdocConfig(document: Document, options: ConfigOptions = {}): InlineConfig {
    // Vite resolves a bare specifier by walking up from the importer and then,
    // failing that, from `root`. The document lives wherever the author keeps
    // it, with no `node_modules` above it, so the `svelte/internal/*` imports
    // its compiled output contains resolve only because `root` is inside this
    // package. Pointing `root` at the document's directory would break every
    // such import --- it is not the free simplification it looks like.
    const root = templateDir;

    return {
        configFile: false,
        envDir: false,
        root,
        cacheDir: cacheDirFor(document),
        publicDir: false,
        resolve: {
            alias: { [DOCUMENT_ID]: document.filename },
            // The document is compiled against this package's Svelte; a second
            // copy reached through the document's own directory would produce
            // two runtimes and a render that fails on the first component.
            dedupe: ['svelte'],
        },
        define: { __MKDOC_HYDRATE__: JSON.stringify(document.hydrate) },
        build: {
            // Shared by both passes of the build on purpose. Inlining is decided
            // per asset by size, so a threshold that differed between the client
            // pass and the SSR pass would have one emit a file and the other
            // write a `data:` URI for the very same image.
            assetsInlineLimit: 0,
            rollupOptions: {
                onwarn(warning: { code?: string; message?: string }, handler: (w: never) => void) {
                    // mdsvex exports `metadata` only when the document has
                    // frontmatter. `Page.svelte` reads it through a namespace
                    // import for exactly that reason, so a document without any
                    // is not worth two warnings.
                    const missing =
                        warning.code == 'MISSING_EXPORT' || warning.code == 'IMPORT_IS_UNDEFINED';
                    if (missing && warning.message?.includes('metadata')) return;
                    handler(warning as never);
                },
            },
        },
        server: {
            // The document and its images are outside `root`, so the dev server
            // has to be told they may be served.
            fs: { allow: [packageDir, document.dirname] },
        },
        plugins: [
            userStyles(document),
            svelte({
                extensions: ['.svelte', ...DOCUMENT_EXTENSIONS],
                preprocess: markdownPreprocessors({ watch: options.watch }),
                compilerOptions: { runes: true },
                onwarn: (warning, handler) => {
                    if (IGNORED_WARNINGS.has(warning.code)) return;
                    handler?.(warning);
                },
            }),
        ],
    };
}
