import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, mergeConfig, type ViteDevServer } from 'vite';

import { readDocument } from './document.js';
import { devConfig } from './dev.js';
import { DOCUMENT_EXTENSIONS } from './markdown/index.js';

export interface DirectoryOptions {
    port?: number;
    host?: string;
    open: boolean;
    /** `--hydrate` / `--no-hydrate`, applied to every document served. */
    hydrate?: boolean;
}

const DEFAULT_PORT = 5173;
const PORT_ATTEMPTS = 20;

// `mkdoc dev <directory>`: a file server over the directory, in which each
// document is served by a dev server of its own.
//
// A document's Vite config is fixed per document --- the alias the template
// imports it under, whether it hydrates, its extra stylesheets --- so one Vite
// server cannot serve two of them. Each document instead gets its own, in
// middleware mode, with `base` set to the document's own URL: `notes/a.md` is
// served at `/notes/a.md/`, and everything its page loads lives beneath that.
// They all share this one HTTP server, and Vite's HMR socket only answers an
// upgrade on its own `base`, so their live reloads cannot cross.
//
// A document's server is made the first time the document is opened and kept
// for the rest of the session: opening one costs a second or so of Vite
// starting up, and coming back to it should not.
export async function serveDirectory(dir: string, options: DirectoryOptions) {
    const root = path.resolve(dir);
    const documents = new Map<string, Promise<ViteDevServer>>();

    const httpServer = http.createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) sendError(res, 500, error);
            else res.destroy();
        });
    });

    async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let segments: string[];
        try {
            segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        } catch {
            return sendError(res, 400, 'malformed URL');
        }
        if (segments.some((segment) => segment == '..' || segment.includes(path.sep))) {
            return sendError(res, 400, 'no such path');
        }

        // The first segment that names a document ends the part of the URL that
        // is a path on disk; the rest belongs to that document's dev server.
        for (let i = 1; i <= segments.length; i++) {
            const file = path.join(root, ...segments.slice(0, i));
            if (!isDocument(file)) continue;

            const base = dirUrl(segments.slice(0, i));
            if (i == segments.length && !url.pathname.endsWith('/')) {
                return redirect(res, base + url.search);
            }
            const server = await documentServer(file, base);
            // Rewritten to the spelling Vite was configured with. A browser is
            // free to percent-encode a path differently from `urlFor`, and Vite
            // matches `base` as a plain string prefix.
            const rest = url.pathname
                .split('/')
                .slice(i + 1)
                .join('/');
            req.url = base + rest + url.search;
            return server.middlewares(req, res, () => sendError(res, 404, 'not found'));
        }

        const target = path.join(root, ...segments);
        const stat = statOf(target);
        if (stat?.isDirectory()) {
            if (!url.pathname.endsWith('/')) return redirect(res, url.pathname + '/' + url.search);
            return sendListing(res, root, segments);
        }
        if (stat?.isFile()) return sendFile(res, target, stat);
        return sendError(res, 404, `no such file \`${segments.join('/')}\``);
    }

    function documentServer(file: string, base: string): Promise<ViteDevServer> {
        let server = documents.get(file);
        if (!server) {
            server = startDocument(file, base);
            documents.set(file, server);
            // Forgotten on failure, so that fixing the frontmatter and
            // refreshing tries again rather than showing the same error.
            server.catch(() => documents.delete(file));
        }
        return server;
    }

    async function startDocument(file: string, base: string): Promise<ViteDevServer> {
        const document = readDocument(file);
        if (options.hydrate !== undefined) document.hydrate = options.hydrate;
        console.log(`mkdoc: serving ${path.relative(root, file)}`);
        return createServer(
            mergeConfig(devConfig(document, httpServer), {
                base,
                server: { middlewareMode: true, ws: { server: httpServer } },
            }),
        );
    }

    const port = await listen(httpServer, options);
    httpServer.on('close', () => {
        for (const server of documents.values()) server.then((s) => s.close()).catch(() => {});
    });

    const url = `http://${displayHost(options.host)}:${port}/`;
    console.log(`mkdoc: serving ${root}\n  ➜  ${url}`);
    if (options.open) openBrowser(url);
    return httpServer;
}

const isDocument = (file: string) =>
    DOCUMENT_EXTENSIONS.includes(path.extname(file)) && statOf(file)?.isFile() == true;

// Built the way Vite normalises `base`, so that the links in a listing and the
// `base` a document's server is given are the same string.
const urlFor = (segments: string[]) =>
    new URL('/' + segments.map(encodeURIComponent).join('/'), 'http://localhost').pathname;

// A directory's URL, which always ends in a slash --- the root's included.
const dirUrl = (segments: string[]) => (segments.length ? urlFor(segments) + '/' : '/');

function statOf(file: string): fs.Stats | null {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

// Like `serveDocument`, it moves on to the next free port only when no port was
// asked for.
async function listen(server: http.Server, options: DirectoryOptions): Promise<number> {
    const first = options.port ?? DEFAULT_PORT;
    const attempts = options.port === undefined ? PORT_ATTEMPTS : 1;
    for (let port = first; port < first + attempts; port++) {
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, options.host ?? 'localhost', () => {
                    server.off('error', reject);
                    resolve();
                });
            });
            return port;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != 'EADDRINUSE') throw error;
        }
    }
    throw new Error(
        options.port === undefined
            ? `mkdoc: no free port between ${first} and ${first + attempts - 1}.`
            : `mkdoc: port ${first} is already in use.`,
    );
}

const displayHost = (host?: string) =>
    !host || host == '0.0.0.0' || host == '::' ? 'localhost' : host;

function openBrowser(url: string) {
    const [command, args] =
        process.platform == 'darwin'
            ? ['open', [url]]
            : process.platform == 'win32'
              ? ['cmd', ['/c', 'start', '', url]]
              : ['xdg-open', [url]];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`mkdoc: could not open a browser; visit ${url}`));
    child.unref();
}

function redirect(res: http.ServerResponse, location: string) {
    res.writeHead(302, { location });
    res.end();
}

const escape = (text: string) =>
    text.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );

// Dotfiles and dependency trees are never what someone browsing their notes is
// looking for, and a `node_modules` listing is enormous.
const HIDDEN = (name: string) => name.startsWith('.') || name == 'node_modules';

function sendListing(res: http.ServerResponse, root: string, segments: string[]) {
    const dir = path.join(root, ...segments);
    const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !HIDDEN(entry.name))
        .map((entry) => {
            const file = path.join(dir, entry.name);
            const kind = statOf(file)?.isDirectory()
                ? 'dir'
                : DOCUMENT_EXTENSIONS.includes(path.extname(entry.name))
                  ? 'doc'
                  : 'file';
            return { name: entry.name, file, kind };
        })
        .sort((a, b) =>
            a.kind == 'dir' && b.kind != 'dir'
                ? -1
                : b.kind == 'dir' && a.kind != 'dir'
                  ? 1
                  : a.name.localeCompare(b.name),
        );

    const rows = entries.map(({ name, file, kind }) => {
        const href = kind == 'file' ? urlFor([...segments, name]) : dirUrl([...segments, name]);
        const label = kind == 'dir' ? `${name}/` : name;
        const title = kind == 'doc' ? titleOf(file) : undefined;
        return (
            `<li class="${kind}"><a href="${escape(href)}">${escape(label)}</a>` +
            (title && title != path.basename(name, path.extname(name))
                ? ` <span>${escape(title)}</span>`
                : '') +
            `</li>`
        );
    });
    if (segments.length > 0) {
        rows.unshift(
            `<li class="dir"><a href="${escape(dirUrl(segments.slice(0, -1)))}">../</a></li>`,
        );
    }

    const heading = '/' + segments.map((s) => s + '/').join('');
    const body = rows.length ? `<ul>\n${rows.join('\n')}\n</ul>` : '<p>Nothing here.</p>';
    send(res, 200, 'text/html; charset=utf-8', page(`${path.basename(root)}${heading}`, body));
}

// The listing names a document by its title, where it has one --- and a
// document whose frontmatter does not parse is still listed, by its filename.
function titleOf(file: string): string | undefined {
    try {
        return readDocument(file).title;
    } catch {
        return undefined;
    }
}

function page(heading: string, body: string) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(heading)}</title>
<style>
    :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --link: #0b57d0; --rule: #e5e5ea; }
    @media (prefers-color-scheme: dark) {
        :root { --fg: #f2f2f7; --muted: #a1a1a6; --bg: #161618; --link: #8ab4f8; --rule: #2c2c2e; }
    }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 48rem; margin: 0 auto; padding: 2rem 16px; }
    h1 { font-size: 1.1rem; font-weight: 600; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 0.4rem 0; border-top: 1px solid var(--rule); overflow-wrap: anywhere; }
    a { color: var(--link); text-decoration: none; font-family: ui-monospace, monospace; }
    a:hover { text-decoration: underline; }
    li.doc a { font-weight: 600; }
    li.file a { color: var(--muted); }
    span { color: var(--muted); margin-left: 0.5rem; }
    p { color: var(--muted); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>${escape(heading)}</h1>
${body}
</main>
</body>
</html>
`;
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.zip': 'application/zip',
};

// Anything not listed above is shown as text when it looks like text --- which
// is most of what sits beside a document: source files, data, notes --- and
// offered as a download otherwise.
function sendFile(res: http.ServerResponse, file: string, stat: fs.Stats) {
    let type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (!type)
        type = looksLikeText(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
}

function looksLikeText(file: string): boolean {
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(4096);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return !buffer.subarray(0, read).includes(0);
    } finally {
        fs.closeSync(fd);
    }
}

function send(res: http.ServerResponse, status: number, type: string, body: string) {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

// A document that fails to load --- bad frontmatter, most often --- is reported
// on the page that was asked for, and the server carries on.
function sendError(res: http.ServerResponse, status: number, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) console.error(message);
    send(
        res,
        status,
        'text/html; charset=utf-8',
        page(`${status}`, `<pre>${escape(message)}</pre>`),
    );
}
