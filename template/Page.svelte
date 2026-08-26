<script>
    import * as document from 'virtual:mkdoc/document';
    import Layout from './Layout.svelte';

    // A namespace import, because mdsvex only exports `metadata` when the
    // document actually has frontmatter --- a named import of it turns a plain
    // markdown file into a build error.
    //
    // Wrapping the document here rather than through mdsvex's own `layout`
    // option also keeps the whole tree in runes mode: that option renders
    // `{...$$props}`, which runes mode rejects.
    const Doc = document.default;
    const metadata = document.metadata ?? {};
</script>

<Layout {...metadata}>
    <Doc />
</Layout>
