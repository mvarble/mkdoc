<script>
    // The frontmatter arrives as props: mdsvex exports it as `metadata`, and
    // `Page.svelte` spreads it over this component. Anything the author writes
    // is available here, whether or not this template uses it.
    let { title, description, author, date, children } = $props();

    // mdsvex serialises the frontmatter through JSON, so a YAML date --- which
    // js-yaml parses into a `Date` --- reaches the page as an ISO string.
    // Anything else the author wrote is left exactly as they wrote it.
    const parsed = $derived(
        typeof date == 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(date) ? new Date(date) : null,
    );
    const formatted = $derived(
        parsed && !Number.isNaN(parsed.valueOf())
            ? parsed.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  timeZone: 'UTC',
              })
            : date,
    );
</script>

<svelte:head>
    {#if title}<title>{title}</title>{/if}
    {#if description}<meta name="description" content={description} />{/if}
    {#if author}<meta name="author" content={author} />{/if}
</svelte:head>

<article>
    {#if title || author || formatted}
        <header>
            {#if title}<h1>{title}</h1>{/if}
            {#if author || formatted}
                <p class="byline">
                    {#if author}<span>{author}</span>{/if}
                    {#if formatted}
                        <time datetime={parsed ? parsed.toISOString().slice(0, 10) : undefined}>
                            {formatted}
                        </time>
                    {/if}
                </p>
            {/if}
        </header>
    {/if}
    {@render children?.()}
</article>
