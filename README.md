# mkdoc

Build a webpage out of a single markdown or mdsvex document.

```sh
mkdoc dev notes/measures.md      # live-reloading server while you write
mkdoc build notes/measures.md    # a static page in build/measures/
mkdoc dev notes/                 # browse a directory, previewing any document in it
```

The point is to get what a well-configured Vite project gives you --- KaTeX rendered at build time, syntax highlighting, images and scripts referenced relative to the document --- without a project.
The template and the whole parser configuration are baked into the CLI, so a document is just a file somewhere on disk.

## Getting it on your PATH

The simplest install is `npm i -g @mvarble/mkdoc` (or `pnpm add -g @mvarble/mkdoc`), which puts the `mkdoc` command on your PATH.

`mkdoc` is an ordinary npm bin, so any global install puts it there.
While you are still tuning the parser configuration, link the working copy --- the command then runs the code in this checkout, and an edit to `template/` or a `pnpm build` takes effect on the very next `mkdoc` run, with no reinstall:

```sh
pnpm build
pnpm link --global
```

For a frozen copy that does not follow the checkout:

```sh
npm i -g .          # copies, and runs `prepare` to build dist/ for you
```

Note that `pnpm add -g <directory>` links rather than copies, and does not run `prepare` --- run `pnpm build` first if you go that way.
Uninstall with `pnpm uninstall -g @mvarble/mkdoc`.

Both land in a directory that is already on your PATH: pnpm uses `$PNPM_HOME`, npm uses its configured prefix.
If node is managed by fnm or nvm, npm's prefix lives inside the active node version, so an `npm i -g` install disappears when you switch versions; pnpm's does not.

## What a document gets

**Math**, through `remark-math` and KaTeX, rendered statically.
A large table of macros is built in: `\bfX` for a bold `X`, `\calF`, `\bbR`, `\rmalpha`, and the same pattern for every letter and Greek letter.
A document adds its own:

```yaml
---
katex_macros:
    '\PP': '\mathbb{P}'
    '\EE': '\mathbb{E}'
---
```

Plain and single-quoted keys both work; **double** quotes do not, because a double-quoted YAML scalar processes escapes and `"\PP"` is an unknown escape
sequence.
`katexMacros` is accepted as a spelling of the same field.

An expression KaTeX cannot parse does not fail the build --- it is rendered in KaTeX's error colour so you can see which one it is, and mkdoc prints the message and the offending source.

Display equations are wrapped in a scroll container, so a long one slides sideways instead of overflowing a narrow screen.

**Files next to the document.** `![](./figure.png)` works --- the URL is turned into a Vite import, so the image is hashed and emitted with the page.
So do `<script>` imports in a `.svx` document, including other Svelte components.

**Code**, highlighted by Shiki in a light and a dark theme at once.
A fence whose entire body is `{./path/to/file}` is replaced by that file's contents; add a range as `{./path/to/file:10..20}`.

**Modules installed in mkdoc.** A document sits wherever you keep it, with no `node_modules` above it, so a package has to be installed here and named before a document may reach for it:

```sh
pnpm add three
```

```json
{
    "mkdoc": {
        "modules": ["three"]
    }
}
```

From then on any document imports it by name, the way it would in a project that had one:

```svelte
<script>
    import * as THREE from 'three';
    import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
</script>
```

Nothing is bundled for being on the list --- a module ships only with a page that actually imports it, and a document that imports none still builds to a page with no JavaScript in it.
The list only decides what is _reachable_; see `example/scene.svx` for a working one.

Two things worth knowing. The `<script>` block is also what makes such a page ship its bundle, so no extra flag is needed.
And the build renders the document under Node once, to produce the static HTML --- a library that touches `window` while it is being imported will fail there, and the way round it is to `import()` the library inside `onMount` instead, where it only ever runs in a browser.

**Frontmatter.** `title`, `description`, `author`, `date` and `lang` are used by the template.
`css` names one or more stylesheets, relative to the document, that are loaded after mkdoc's own --- which is how you override anything about the look.
`hydrate` decides whether the page ships JavaScript.
Any other field is passed to the template as a prop.

## Browsing a directory

`mkdoc dev <directory>` serves the directory as a plain file listing.
Clicking a `.md` or `.svx` opens it at its own URL (`notes/measures.md` at `/notes/measures.md/`), live-reloading exactly as `mkdoc dev notes/measures.md` would; every other file is served as-is.
Each document gets its own dev server the first time you open it, so the first visit takes a moment and later ones do not.
`--hydrate` and `--no-hydrate` apply to every document opened this way.

## Static by default

A plain markdown document has nothing to run, so the built page contains no JavaScript at all: the HTML, one stylesheet, and the KaTeX fonts.
A document with a `<script>` block is assumed to have something interactive in it and gets a client bundle; `hydrate: true` or `hydrate: false` in the frontmatter, or `--hydrate` / `--no-hydrate`, settles it either way.

URLs in the built page are relative, so a static `index.html` opens straight off the filesystem --- double-click it, mail it, drop it on a USB stick.
A page that ships JavaScript needs to be served over HTTP, because browsers refuse to load ES modules from `file://`.
Pass `--base /some/prefix/` if you are serving it from a subdirectory.

## Options

```
mkdoc build <document>    write a static page (the default command)
mkdoc dev <document>      serve the document, rebuilding it as you type
mkdoc dev <directory>     browse a directory, serving each document you open

  -o, --out <dir>     where to write the page   (default: build/<document>)
      --base <path>   URL prefix for the page's own files   (default: ./)
      --force         overwrite an output directory mkdoc did not write
  -p, --port <n>      port to listen on
      --host [addr]   expose the dev server on the network
      --open          open a browser once the server is up
      --hydrate       ship the client bundle, making the page interactive
      --no-hydrate    omit it, leaving a page that needs no JavaScript
```

## Development

```sh
pnpm install
pnpm build                          # tsc, into dist/
node dist/cli.js dev example/measures.md
```

`src/` is the CLI: `dev.ts` and `directory.ts` are the two dev servers, `document.ts` reads the frontmatter that configures the build, `modules.ts` reads the `mkdoc.modules` list, `vite.ts` assembles the Vite config both commands share, and `markdown/` configures the parser. The parser itself --- the KaTeX, display-math, highlighting and asset plugins --- is [`@mvarble/mesearch-markdown`](https://github.com/mvarble/mesearch/tree/main/packages/markdown), which mesearch and the blog use too, so a document renders the same in all three.
`template/` is the page itself --- the HTML shell, the Svelte layout and the stylesheets --- and is consumed by Vite at runtime rather than compiled by `tsc`.
