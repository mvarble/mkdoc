#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { readDocument } from './document.js';
import { buildDocument } from './build.js';
import { serveDocument } from './dev.js';
import { packageDir } from './paths.js';

const USAGE = `
mkdoc --- build a webpage out of a single markdown or mdsvex document.

  mkdoc build <document>    write a static page (the default command)
  mkdoc dev <document>      serve the document, rebuilding it as you type

Build options
  -o, --out <dir>     where to write the page   (default: build/<document>)
      --base <path>   URL prefix for the page's own files   (default: ./)
      --force         overwrite an output directory mkdoc did not write

Dev options
  -p, --port <n>      port to listen on
      --host [addr]   expose the server on the network
      --no-open       do not open a browser (it opens one by default)

Both
      --hydrate       ship the client bundle, making the page interactive
      --no-hydrate    omit it, leaving a page that needs no JavaScript
  -h, --help          show this message
  -v, --version       show the version

A document's frontmatter may set \`title\`, \`description\`, \`author\`, \`date\`,
\`hydrate\`, \`css\` (extra stylesheets, relative to the document) and
\`katex_macros\` (macros folded over mkdoc's own).
`.trim();

const OPTIONS = {
    out: { type: 'string', short: 'o' },
    base: { type: 'string' },
    force: { type: 'boolean', default: false },
    hydrate: { type: 'boolean', default: false },
    'no-hydrate': { type: 'boolean', default: false },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    open: { type: 'boolean', default: false },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
} as const;

async function main() {
    const { values, positionals } = parseArgs({
        options: OPTIONS,
        allowPositionals: true,
    });

    if (values.help) return console.log(USAGE);
    if (values.version) return console.log(version());

    // `mkdoc notes.md` and `mkdoc build notes.md` mean the same thing.
    const [first, ...rest] = positionals;
    const command = first == 'build' || first == 'dev' ? first : 'build';
    const targets = first == 'build' || first == 'dev' ? rest : positionals;

    if (targets.length != 1) {
        console.error(USAGE);
        throw new Error(
            targets.length == 0
                ? 'mkdoc: name the document to build.'
                : 'mkdoc: mkdoc builds one document at a time.',
        );
    }

    const document = readDocument(targets[0]!);
    // The flags win over the frontmatter, which wins over the guess made from
    // whether the document has a `<script>` block at all.
    if (values.hydrate) document.hydrate = true;
    if (values['no-hydrate']) document.hydrate = false;

    if (command == 'dev') {
        await serveDocument(document, {
            port: values.port ? Number(values.port) : undefined,
            host: values.host,
            // Opening the browser is the default: this tool previews one
            // document, and the commonest way to see "nothing happens" is to
            // be looking at a tab from an earlier run on a different port.
            open: !values['no-open'],
        });
        return;
    }

    const outDir = await buildDocument(document, {
        outDir: values.out ?? path.join('build', basename(document.filename)),
        base: values.base ?? './',
        force: values.force,
    });
    console.log(`mkdoc: wrote ${path.relative(process.cwd(), outDir) || '.'}/index.html`);
}

const basename = (filename: string) => path.basename(filename, path.extname(filename));

function version(): string {
    const manifest = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version: string }).version;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
