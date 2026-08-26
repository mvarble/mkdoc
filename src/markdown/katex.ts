import katex, { type KatexOptions } from 'katex';
import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';

// KaTeX's own macro type: a definition may be a string, but it may also be a
// structure or an expander function.
export type KatexMacros = NonNullable<KatexOptions['macros']>;

const alphabet = 'abcdefghijklmnopqrstuvwxyz';
const greeks = [
    ['α', 'alpha'],
    ['β', 'beta'],
    ['γ', 'gamma'],
    ['δ', 'delta'],
    ['ϵ', 'epsilon'],
    ['ζ', 'zeta'],
    ['η', 'eta'],
    ['θ', 'theta'],
    ['ι', 'iota'],
    ['κ', 'kappa'],
    ['λ', 'lambda'],
    ['μ', 'mu'],
    ['ν', 'nu'],
    ['ξ', 'xi'],
    ['π', 'pi'],
    ['ρ', 'rho'],
    ['σ', 'sigma'],
    ['τ', 'tau'],
    ['ϕ', 'phi'],
    ['ψ', 'psi'],
    ['χ', 'chi'],
    ['ω', 'omega'],
];

const titleCase = (str: string) => (str.length ? str.at(0)!.toUpperCase() + str.slice(1) : '');

// Macros every document gets for free: `\bfx` for a bold `x`, `\calF` for a
// script `F`, `\bbR` for the reals, and the same for the Greek letters. A
// document adds to these from its frontmatter, and a document-level macro of
// the same name wins.
export const baseMacros: KatexMacros = {
    ...Object.fromEntries([
        ...alphabet.split('').flatMap((char) => [
            [`\\rm${char}`, `{\\rm ${char}}`],
            [`\\bf${char}`, `\\boldsymbol{${char}}`],
            [`\\rm${char.toUpperCase()}`, `\\mathrm{${char.toUpperCase()}}`],
            [`\\cal${char.toUpperCase()}`, `\\mathcal{${char.toUpperCase()}}`],
            [`\\scr${char.toUpperCase()}`, `\\mathscr{${char.toUpperCase()}}`],
            [`\\bb${char.toUpperCase()}`, `\\mathbb{${char.toUpperCase()}}`],
            [`\\bf${char.toUpperCase()}`, `\\mathbf{${char.toUpperCase()}}`],
        ]),
        ...greeks.flatMap(([char, ident]) => [
            [`\\rm${ident}`, `{\\rm ${char}}`],
            [`\\bf${ident}`, `\\boldsymbol{${char}}`],
            [`\\rm${titleCase(ident!)}`, `\\mathrm{${char!.toUpperCase()}}`],
            [`\\cal${titleCase(ident!)}`, `\\mathcal{${char!.toUpperCase()}}`],
            [`\\bf${titleCase(ident!)}`, `\\mathbf{${char!.toUpperCase()}}`],
        ]),
    ]),
    '\\im': '\\rmi',
    '\\defeq': '\\coloneqq',
    '\\eqdef': '\\eqqcolon',
};

// Both spellings are accepted. `katex_macros` is the documented one; documents
// written for other tools reach for the camelCase form often enough that
// rejecting it only produces a confusing wall of undefined-control-sequence
// errors.
const MACRO_FIELDS = ['katex_macros', 'katexMacros'];

function documentMacros(vfile: unknown): KatexMacros {
    const fm = (vfile as { data?: { fm?: unknown } }).data?.fm;
    if (!fm || typeof fm != 'object') return {};
    const macros: KatexMacros = {};
    for (const field of MACRO_FIELDS) {
        const value = (fm as Record<string, unknown>)[field];
        if (value && typeof value == 'object') Object.assign(macros, value);
    }
    return macros;
}

const isMath = (node: Element): 'inline' | 'display' | null => {
    const classes = node.properties?.className;
    if (!Array.isArray(classes)) return null;
    if (classes.includes('math-display')) return 'display';
    if (classes.includes('math-inline')) return 'inline';
    return null;
};

function textOf(node: Element): string {
    let text = '';
    const stack = [...node.children].reverse();
    while (stack.length > 0) {
        const child = stack.pop()!;
        if (child.type == 'text') text += child.value;
        else if (child.type == 'element') stack.push(...[...child.children].reverse());
    }
    return text;
}

export interface KatexPluginOptions {
    katex?: KatexOptions;
    /** Re-report on every recompile, rather than only when something changes. */
    watch?: boolean;
}

// What was last reported for each document. A build compiles each document
// twice, once per Vite pass, so without this the same broken equation is
// reported twice for one command.
const lastReported = new Map<string, string>();

// KaTeX is called directly rather than through `rehype-katex`: the escaping a
// Svelte template needs is a one-liner, and going through a wrapper meant the
// math was rendered by whichever KaTeX that wrapper depended on rather than the
// one whose stylesheet and fonts this package ships. Skewed versions render
// markup the stylesheet does not fully cover.
export const rehypeKatex: Plugin<[KatexPluginOptions?], Root> = (settings) => {
    const options = settings?.katex;
    return (tree, vfile) => {
        // One copy per document: KaTeX writes `\gdef`s back into this object, so
        // a definition made in one equation is visible to later ones, while the
        // base table stays intact for the next document.
        const macros: KatexMacros = {
            ...baseMacros,
            ...(options?.macros ?? {}),
            ...documentMacros(vfile),
        };
        const filename = (vfile as { filename?: string }).filename ?? 'document';
        const failures: string[] = [];

        const stack: Array<Root | Element> = [tree];
        while (stack.length > 0) {
            const node = stack.pop()!;
            for (const child of node.children) {
                if (child.type != 'element') continue;
                const mode = isMath(child);
                if (!mode) {
                    stack.push(child);
                    continue;
                }

                const tex = textOf(child);
                const settings = { ...options, macros, displayMode: mode == 'display' };
                let html: string;
                try {
                    html = katex.renderToString(tex, { ...settings, throwOnError: true });
                } catch (error) {
                    // Rendered anyway, in KaTeX's error colour: a document being
                    // drafted should still produce a page, with the broken
                    // formula visible in place rather than a failed build.
                    html = katex.renderToString(tex, { ...settings, throwOnError: false });
                    failures.push(`${summarise(error)}\n      in: ${tex.trim().split('\n')[0]}`);
                }
                child.children = [{ type: 'text', value: `{@html ${JSON.stringify(html)}}` }];
            }
        }

        report(filename, failures, settings?.watch ?? false);
    };
};

// Every failure the document currently has, every time it is recompiled ---
// not just the ones that are new. While you are editing macros to fix an
// expression, an error that is still there is the thing you most need to be
// told about, and silence reads as success.
//
// Outside watch mode the same report would be printed once per build pass, so
// there it is emitted only when the set of failures actually changes.
function report(filename: string, failures: string[], watch: boolean) {
    const signature = failures.join('\n');
    const previous = lastReported.get(filename);
    lastReported.set(filename, signature);

    if (!watch && signature == previous) return;

    if (failures.length == 0) {
        // Only worth saying when it is news: the document had errors a moment
        // ago and now does not.
        if (watch && previous) console.log(`mkdoc: ${filename}\n    math renders cleanly`);
        return;
    }
    for (const failure of failures) console.warn(`mkdoc: ${filename}\n    ${failure}`);
}

const summarise = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replace(/ at position \d+.*$/s, '');
