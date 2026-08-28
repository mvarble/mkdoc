import fs from 'node:fs';
import path from 'node:path';

import { packageDir } from './paths.js';

// A document lives wherever its author keeps it, with no `node_modules` above
// it, so a bare `import * as THREE from 'three'` has nothing to resolve
// against. `resolve.dedupe` is the cure: Vite resolves a deduped package from
// `root` rather than from the importer's directory, and `root` is inside this
// package --- which is also why the document's own `svelte/internal/*` imports
// work at all.
//
// So the list below is the allow-list and the resolution mechanism at once.
// Nothing is bundled for being on it; a module ships only if a document
// actually imports it.
//
// It lives in this package's `package.json` rather than in this file so that it
// sits beside the `dependencies` entry it accompanies, and so that adding to it
// takes effect without a `pnpm build` --- which matters when the CLI on your
// PATH is a link to a checkout.
const FIELD = 'mkdoc.modules';

let cached: string[] | undefined;

export function clientModules(): string[] {
    if (cached) return cached;

    const manifest = path.join(packageDir, 'package.json');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        mkdoc?: { modules?: unknown };
    };

    const value = data.mkdoc?.modules;
    if (value === undefined) return (cached = []);
    if (!Array.isArray(value) || value.some((name) => typeof name != 'string' || !name)) {
        throw new Error(`mkdoc: \`${FIELD}\` in ${manifest} must be a list of module names.`);
    }

    return (cached = [...new Set(value as string[])]);
}

// Whether a listed module is actually installed. Only `optimizeDeps.include`
// needs to know: Vite fails the whole run when an included dependency is
// missing, which would break every document rather than just the ones that
// import it. Resolution itself needs no such check --- a missing module simply
// fails to resolve, and `mkdoc:modules` says so.
export function installedClientModules(): string[] {
    return clientModules().filter((name) =>
        fs.existsSync(path.join(packageDir, 'node_modules', ...name.split('/'), 'package.json')),
    );
}
