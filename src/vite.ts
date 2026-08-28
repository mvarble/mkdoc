import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isBuiltin } from 'node:module';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { InlineConfig, Plugin } from 'vite';

import type { Document } from './document.js';
import { packageDir, templateDir } from './paths.js';
import { clientModules, installedClientModules } from './modules.js';
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

// Bare specifiers that reach here resolved against nothing: this plugin runs
// after Vite's resolver, so it is only ever called for an import that has
// already failed. Vite's own message for that ("Failed to resolve import") does
// not say where mkdoc was looking, which is the only part the author can act on.
//
// Only imports written outside this package are answered for. mkdoc's own
// template and dependencies import each other constantly, and a module of theirs
// that fails to resolve is a bug in mkdoc, not something to explain in terms of
// `mkdoc.modules`.
function moduleDiagnostics(): Plugin {
    const listed = new Set(clientModules());
    return {
        name: 'mkdoc:modules',
        enforce: 'post',
        resolveId(id, importer, options) {
            // Vite's dependency scanner resolves speculatively and swallows
            // what it cannot find; a throw from here would fail the scan
            // instead. It does not advertise itself in the public hook type.
            if (!importer || (options as { scan?: boolean }).scan) return null;
            if (!BARE_IMPORT.test(id) || id.includes('\0') || isBuiltin(id)) return null;
            if (id.startsWith('@vite/') || isInsidePackage(importer)) return null;

            const name = packageNameOf(id);
            throw new Error(
                listed.has(name)
                    ? `mkdoc: \`${name}\` is listed in \`mkdoc.modules\` but is not installed.\n` +
                          `Run \`pnpm add ${name}\` in ${packageDir}.`
                    : `mkdoc: \`${name}\` is not a module documents may import.\n` +
                          `Install it in ${packageDir} and add it to \`mkdoc.modules\` in that package.json.`,
            );
        },
    };
}

// The separator matters: a document kept in a sibling directory whose name
// merely starts with this one's --- `mkdoc-notes` next to `mkdoc` --- is not
// inside the package, and should still get the message.
const isInsidePackage = (file: string) =>
    file == packageDir || file.startsWith(packageDir + path.sep);

// Neither relative, nor absolute, nor a URL --- Vite's own test for the kind of
// specifier that is resolved out of `node_modules`.
const BARE_IMPORT = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/;

// `three` from `three/examples/jsm/controls/OrbitControls.js`, and
// `@scope/name` from a subpath of a scoped package.
function packageNameOf(id: string): string {
    const parts = id.split('/');
    return id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
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
    // `root` is inside this package because that is where every bare specifier
    // a document writes has to be resolved from: the document lives wherever the
    // author keeps it, with no `node_modules` above it. Vite walks up from the
    // importer and does *not* fall back to `root` when that fails --- the one
    // thing that redirects a package to `root` is `resolve.dedupe` below, which
    // is why the `svelte/internal/*` imports in the document's compiled output
    // resolve at all. Pointing `root` at the document's directory would break
    // every one of them; it is not the free simplification it looks like.
    const root = templateDir;

    return {
        configFile: false,
        envDir: false,
        root,
        cacheDir: cacheDirFor(document),
        publicDir: false,
        resolve: {
            alias: { [DOCUMENT_ID]: document.filename },
            // Deduping is what lets a bare specifier resolve from this package
            // rather than from beside the document: Vite resolves a deduped
            // package from `root`, whoever the importer was.
            //
            // Svelte has to be on the list regardless of what a document
            // imports --- the document is compiled against this package's
            // Svelte, and a second copy reached through the document's own
            // directory would produce two runtimes and a render that fails on
            // the first component.
            dedupe: ['svelte', ...clientModules()],
        },
        optimizeDeps: {
            // Pre-bundled up front rather than discovered when a document turns
            // out to import one: discovery mid-session costs a re-optimize and
            // a full page reload, which in this tool is indistinguishable from
            // the dev server having lost track of the document.
            include: installedClientModules(),
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
            moduleDiagnostics(),
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
