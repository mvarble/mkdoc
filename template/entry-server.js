import { render } from 'svelte/server';
import Page from './Page.svelte';

// Called by the build once, to turn the document into the HTML that ships.
export function renderDocument() {
    return render(Page);
}
