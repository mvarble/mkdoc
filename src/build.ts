import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as viteBuild, mergeConfig } from 'vite';

import type { Document } from './document.js';
import { cacheDirFor, mkdocConfig } from './vite.js';

export interface BuildOptions {
    /** Directory the page is written to. Emptied before the build. */
    outDir: string;
    /** Prefix the page's own URLs get. Relative by default, so that the built
     *  `index.html` also opens straight off the filesystem. */
    base: string;
    /** Overwrite an output directory that mkdoc did not write. */
    force: boolean;
}

// Marks a directory as ours, so that a mistyped `--out` cannot quietly delete
// somebody's work: the build empties its output directory, and it will only do
// that to a directory that is empty or that a previous build made.
const MARKER = '.mkdoc';

// The client build resolves its asset URLs against a *relative* base, which it
// can only do from a document it knows the location of. The SSR bundle has no
// such document --- with a relative base Vite would fall back to
// `import.meta.url`, which at render time is a `file://` URL into a temporary
// directory. So the SSR build uses an absolute sentinel base instead, and the
// rendered HTML has it swapped for the real one afterwards.
const SENTINEL_BASE = '/__mkdoc_base__/';

export async function buildDocument(document: Document, options: BuildOptions): Promise<string> {
    const outDir = path.resolve(options.outDir);
    // Not under `outDir`: the output directory should hold only what ships, and
    // a build that dies partway through should not leave scaffolding in it.
    const ssrDir = path.join(cacheDirFor(document), 'ssr');
    await prepareOutDir(outDir, options.force);

    const config = mkdocConfig(document);

    // The client build writes everything that ships: `index.html` with its
    // stylesheet links already injected, the CSS, the KaTeX fonts, and every
    // image the document referenced.
    await viteBuild(
        mergeConfig(config, {
            base: options.base,
            logLevel: 'warn',
            build: { outDir, emptyOutDir: true },
        }),
    );

    // The SSR build exists only to be imported once, below. Its asset URLs come
    // out identical to the client build's, because Vite hashes assets by
    // content and both builds see the same files.
    await viteBuild(
        mergeConfig(config, {
            base: SENTINEL_BASE,
            logLevel: 'warn',
            // Everything the render needs goes into the one bundle. Left
            // external, an import like Svelte's `clsx` would be resolved by Node
            // at render time --- walking up from wherever the bundle happens to
            // sit, which is not a place mkdoc's own dependencies are visible.
            // That works from a checkout and fails from an installed CLI.
            ssr: { noExternal: true },
            build: {
                ssr: 'entry-server.js',
                outDir: ssrDir,
                emptyOutDir: true,
                ssrEmitAssets: false,
                rollupOptions: { output: { entryFileNames: 'entry-server.js' } },
            },
        }),
    );

    const entry = pathToFileURL(path.join(ssrDir, 'entry-server.js')).href;
    const { renderDocument } = (await import(entry)) as {
        renderDocument: () => { head: string; body: string };
    };
    const rendered = renderDocument();

    const htmlPath = path.join(outDir, 'index.html');
    let html = await fs.readFile(htmlPath, 'utf8');
    // `lang` belongs on `<html>`, which is in the shell rather than in
    // anything Svelte renders.
    const lang = document.frontmatter.lang;
    if (typeof lang == 'string') html = html.replace('<html lang="en">', `<html lang="${lang}">`);

    html = html
        .replace('<!--mkdoc:head-->', () => rebase(rendered.head, options.base))
        .replace('<!--mkdoc:body-->', () => rebase(rendered.body, options.base));

    // Vite marks the tags it injects `crossorigin`, which is harmless over HTTP
    // and fatal over `file://`: the stylesheet becomes a cross-origin request
    // from an opaque origin, the browser drops it, and the page renders bare.
    // Opening the built `index.html` straight off disk is half the point of this
    // tool, so the attribute goes.
    html = html.replace(/(<(?:link|script)\b[^>]*?)\s+crossorigin(?=[\s>])/g, '$1');

    // The template only renders a `<title>` when the frontmatter names one. A
    // page with no title at all shows the reader a tab labelled by its URL, so
    // the fallback goes in here.
    if (!/<title[\s>]/.test(html)) {
        html = html.replace('</head>', `    <title>${escapeHtml(document.title)}</title>\n</head>`);
    }

    // A document with nothing interactive in it is already complete as HTML.
    // Dropping the module scripts leaves a page that needs no JavaScript at
    // all --- the stylesheet links are separate, so the styling survives.
    if (!document.hydrate) {
        html = html.replace(/\s*<script\b[^>]*\btype="module"[^>]*>\s*<\/script>/g, '');
        html = html.replace(/\s*<link\b[^>]*\brel="modulepreload"[^>]*>/g, '');
    }

    await fs.writeFile(htmlPath, html);
    await fs.rm(ssrDir, { recursive: true, force: true });
    // Written last: the client build empties the directory, marker and all.
    await fs.writeFile(path.join(outDir, MARKER), '');
    if (!document.hydrate) await pruneUnreferencedScripts(outDir, html);

    return outDir;
}

const rebase = (html: string, base: string) => html.replaceAll(SENTINEL_BASE, base);

const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function prepareOutDir(outDir: string, force: boolean) {
    const entries = await fs.readdir(outDir).catch(() => null);
    if (entries == null) {
        await fs.mkdir(outDir, { recursive: true });
    } else if (entries.length > 0 && !entries.includes(MARKER) && !force) {
        throw new Error(
            `mkdoc: \`${outDir}\` is not empty and was not written by mkdoc.\n` +
                'Building would erase it. Pass --force if that is what you want.',
        );
    }
}

// Vite bundles the client entry whether or not the page ends up loading it,
// because that is also how it discovers the CSS. Once the script tags are gone
// the chunks are dead weight, so they go too.
async function pruneUnreferencedScripts(outDir: string, html: string) {
    const assetsDir = path.join(outDir, 'assets');
    const entries = await fs.readdir(assetsDir).catch(() => []);
    await Promise.all(
        entries
            .filter((entry) => entry.endsWith('.js') && !html.includes(entry))
            .map((entry) => fs.rm(path.join(assetsDir, entry), { force: true })),
    );
}
