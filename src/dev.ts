import fs from 'node:fs';
import path from 'node:path';
import { createLogger, createServer, mergeConfig, type Plugin, type ViteDevServer } from 'vite';

import type { Document } from './document.js';
import { mkdocConfig } from './vite.js';
import { templateDir } from './paths.js';

export interface DevOptions {
    port?: number;
    host?: string;
    open: boolean;
}

const POLL_INTERVAL_MS = 250;
// Long enough for the watcher's own event, and the hot update it triggers, to
// land before the fallback decides nothing happened.
const WATCHER_GRACE_MS = 400;

// Keeping the page in step with the document is this command's whole job, so it
// is defended three times over.
//
// Vite caches each module's compiled output and only a watcher event evicts it.
// When the watcher misses a save --- which depends on how the editor writes the
// file, and is not something this tool controls --- the stale module survives
// even a full browser refresh, and the only cure is restarting the server. That
// is the failure this exists to rule out.
//
//  1. The document is added to the watcher explicitly. It lives outside Vite's
//     root, where it is otherwise watched only as a side effect of having been
//     requested.
//  2. The watcher polls rather than relying on filesystem notifications, which
//     an editor that saves by renaming a temporary file over the original can
//     defeat. Polling a directory of template files and one document costs
//     nothing measurable.
//  3. Failing both, a stat poll on the document forces the issue: it invalidates
//     the cached module by hand and reloads the page. It compares `stat` on the
//     path, so an editor that saves by renaming a temporary file over the
//     original --- which replaces the inode --- cannot hide a change from it.
//
// The watcher is preferred when it works, because it drives Svelte's hot update
// and that preserves scroll position. The fallback only acts on a change the
// watcher did not report.
function watchDocument(document: Document): Plugin {
    const name = path.basename(document.filename);
    return {
        name: 'mkdoc:watch-document',
        configureServer(server) {
            server.watcher.add(document.filename);

            server.watcher.on('change', (file) => {
                const changed = path.resolve(file);
                if (changed == document.filename) {
                    announce(name);
                } else if (changed.startsWith(templateDir)) {
                    announce(path.join('template', path.relative(templateDir, changed)));
                }
            });

            // Deliberately a plain interval rather than `fs.watchFile`. Node
            // keys stat watchers by path and `fs.unwatchFile` drops *every*
            // listener registered for that path --- so chokidar, which uses
            // `fs.watchFile` itself in polling mode, silently unregisters this
            // one as part of its own bookkeeping. Measured: zero events.
            let previous = statOf(document.filename);
            const poll = setInterval(() => {
                const current = statOf(document.filename);
                if (!current || !previous || sameFile(current, previous)) {
                    previous = current ?? previous;
                    return;
                }
                previous = current;
                // What matters is not whether the watcher emitted an event but
                // whether the cached module was actually evicted --- that is the
                // thing whose absence makes a refresh serve stale content. The
                // poll can only notice a write up to one interval after it
                // happened, so an eviction from shortly before counts as
                // covering this same save.
                const noticedAt = Date.now();
                setTimeout(() => {
                    if (wasInvalidatedSince(server, document, noticedAt - POLL_INTERVAL_MS * 2)) {
                        return;
                    }
                    announce(name, 'the watcher missed this one, reloading');
                    reloadDocument(server, document);
                }, WATCHER_GRACE_MS);
            }, POLL_INTERVAL_MS);
            poll.unref();

            server.httpServer?.on('close', () => clearInterval(poll));
        },
    };
}

// An atomic save briefly leaves nothing at the path, so a failed stat is a
// moment to skip rather than a change to report.
function statOf(file: string): fs.Stats | null {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

const sameFile = (a: fs.Stats, b: fs.Stats) =>
    a.mtimeMs == b.mtimeMs && a.size == b.size && a.ino == b.ino;

// Says, in the terminal, that the server saw your save. Without it the only
// evidence is the page changing --- and when the page is the thing that looks
// broken, that is precisely the evidence you cannot trust.
function announce(what: string, note?: string) {
    const at = new Date().toTimeString().slice(0, 8);
    console.log(`mkdoc: ${what} changed at ${at}${note ? ` (${note})` : ''}`);
}

// Whether anything has evicted the document's compiled output since `since`.
// Vite stamps every module with the time it was last invalidated, which is a
// direct answer to "will the next request recompile this?" --- unlike a watcher
// event, which only says something noticed the file.
function wasInvalidatedSince(server: ViteDevServer, document: Document, since: number): boolean {
    return Object.values(server.environments).some((environment) => {
        const module = environment.moduleGraph.getModuleById(document.filename);
        return module != null && module.lastInvalidationTimestamp >= since;
    });
}

// Drops the cached compilation of the document in every environment, so that the
// next request --- including a plain browser refresh --- has to build it again.
function reloadDocument(server: ViteDevServer, document: Document) {
    for (const environment of Object.values(server.environments)) {
        const module = environment.moduleGraph.getModuleById(document.filename);
        if (module) environment.moduleGraph.invalidateModule(module);
    }
    server.hot.send({ type: 'full-reload' });
}

// Vite's own per-update line prints the document's full absolute path, which
// buries the useful part, and `announce` already says it readably. Only that one
// line is dropped --- lowering the log level wholesale would also take the
// startup banner with the server's URL, which is the last thing to hide when a
// stale tab is a plausible reason a page looks frozen.
function quietHmrLogger() {
    const logger = createLogger('info');
    const info = logger.info.bind(logger);
    logger.info = (message, options) => {
        if (message.includes('hmr update')) return;
        info(message, options);
    };
    return logger;
}

// The dev server renders in the browser rather than serving the SSR output the
// build produces. That costs nothing that matters here: KaTeX and the syntax
// highlighting both run in the preprocessor, so what the browser receives is
// the same HTML either way --- it just arrives via the Svelte runtime, and
// arrives again, instantly, on every save.
export async function serveDocument(document: Document, options: DevOptions) {
    const server = await createServer(
        mergeConfig(mkdocConfig(document, { watch: true }), {
            customLogger: quietHmrLogger(),
            plugins: [watchDocument(document)],
            server: {
                port: options.port,
                host: options.host,
                open: options.open,
                // Only when a port was asked for. Otherwise Vite silently moves
                // to the next free port, and a browser tab still pointing at the
                // old one shows a stale page that never updates --- which looks
                // exactly like a broken watcher.
                strictPort: options.port !== undefined,
                watch: { usePolling: true, interval: POLL_INTERVAL_MS },
            },
        }),
    );

    try {
        await server.listen();
    } catch (error) {
        // A server that failed to listen still holds its watcher and its
        // optimizer open, and those keep the event loop alive: without this the
        // command prints "Port 5321 is already in use" and then hangs.
        await server.close();
        throw error;
    }
    server.printUrls();
    return server;
}
