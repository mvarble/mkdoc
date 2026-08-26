import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { DOCUMENT_EXTENSIONS } from './markdown/index.js';

export interface Document {
    /** Absolute path to the source document. */
    filename: string;
    /** The directory the document's relative imports are resolved against. */
    dirname: string;
    /** Parsed YAML frontmatter, or an empty object when there is none. */
    frontmatter: Record<string, unknown>;
    /** Whether the built page ships the client bundle that makes it interactive. */
    hydrate: boolean;
    /** Absolute paths to extra stylesheets the document asked for. */
    styles: string[];
    /** What the browser tab is called. */
    title: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

// Reads the document that the whole build is configured from. The parser reads
// the frontmatter again later, through mdsvex, but a few decisions --- whether
// to emit a client bundle, which stylesheets to pull in --- have to be made
// before Vite is configured, which is before any document has been compiled.
export function readDocument(filename: string): Document {
    const absolute = path.resolve(filename);

    if (!fs.existsSync(absolute)) {
        throw new Error(`mkdoc: no such document \`${filename}\`.`);
    }
    if (!DOCUMENT_EXTENSIONS.includes(path.extname(absolute))) {
        throw new Error(
            `mkdoc: \`${filename}\` is not a ${DOCUMENT_EXTENSIONS.join(' or ')} document.`,
        );
    }

    const source = fs.readFileSync(absolute, 'utf8');
    const frontmatter = parseFrontmatter(absolute, source);
    const reader = new Frontmatter(absolute, frontmatter);

    const document: Document = {
        filename: absolute,
        dirname: path.dirname(absolute),
        frontmatter,
        // A plain markdown document has nothing to hydrate, and shipping a
        // runtime to re-assert HTML that is already correct only slows the page
        // down. A `<script>` block means the document imports something, so it
        // gets the bundle. Over-shipping is the safe direction here, and
        // `hydrate` in the frontmatter settles the question either way.
        hydrate: reader.optionalBoolean('hydrate', hasInstanceScript(source)),
        styles: reader.optionalPaths('css'),
        // Only the `<title>` falls back like this. The template prints a heading
        // of its own from `title`, and a document that opens with an `# H1`
        // would then show it twice.
        title:
            reader.optionalString('title') ??
            firstHeading(source) ??
            path.basename(absolute, path.extname(absolute)),
    };

    reader.check();
    return document;
}

function parseFrontmatter(filename: string, source: string): Record<string, unknown> {
    const match = FRONTMATTER.exec(source);
    if (!match) return {};
    let data: unknown;
    try {
        data = yaml.load(match[1]!, { filename });
    } catch (error) {
        throw new Error(`mkdoc: could not parse the frontmatter of \`${filename}\`.\n${error}`);
    }
    if (data == null) return {};
    if (typeof data != 'object' || Array.isArray(data)) {
        throw new Error(`mkdoc: the frontmatter of \`${filename}\` is not a mapping.`);
    }
    return data as Record<string, unknown>;
}

// mdsvex emits the frontmatter as a `<script context="module">` block; that one
// is not the document's own.
const INSTANCE_SCRIPT = /<script(?![^>]*\b(?:context|module)\b)[^>]*>/;

// Documents written elsewhere often carry no `title` in their frontmatter and
// open with an `# H1` instead.
const HEADING = /^ {0,3}#\s+(.+?)\s*#*\s*$/m;
const firstHeading = (source: string) => HEADING.exec(source.replace(FRONTMATTER, ''))?.[1];

// Code the document is quoting rather than running: a note *about* a script tag
// should still build to a page that needs no JavaScript.
const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1[^\n]*$/gm;
const INLINE = /(`+)[^`][\s\S]*?\1/g;

const hasInstanceScript = (source: string) =>
    INSTANCE_SCRIPT.test(source.replace(FENCED, '').replace(INLINE, ''));

// Collects every problem it finds rather than stopping at the first, so that one
// run reports everything wrong with the frontmatter.
class Frontmatter {
    private readonly problems: string[] = [];

    constructor(
        private readonly filename: string,
        private readonly data: Record<string, unknown>,
    ) {}

    private reject(field: string, expected: string) {
        this.problems.push(`${this.filename}: frontmatter \`${field}\` must be ${expected}.`);
    }

    optionalString(field: string): string | undefined {
        const value = this.data[field];
        if (value === undefined) return undefined;
        if (typeof value != 'string' || !value) {
            this.reject(field, 'a non-empty string');
            return undefined;
        }
        return value;
    }

    optionalBoolean(field: string, fallback: boolean): boolean {
        const value = this.data[field];
        if (value === undefined) return fallback;
        if (typeof value != 'boolean') {
            this.reject(field, 'a boolean');
            return fallback;
        }
        return value;
    }

    // One path or a list of them, each written relative to the document.
    optionalPaths(field: string): string[] {
        const value = this.data[field];
        if (value === undefined) return [];
        const values = Array.isArray(value) ? value : [value];
        if (values.some((item) => typeof item != 'string')) {
            this.reject(field, 'a path or a list of paths');
            return [];
        }
        return (values as string[]).map((item) => path.resolve(path.dirname(this.filename), item));
    }

    check() {
        if (this.problems.length == 0) return;
        throw new Error(this.problems.join('\n'));
    }
}
