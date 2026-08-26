import 'katex/dist/katex.min.css';
import './styles/index.css';
import 'virtual:mkdoc/styles';

import { hydrate, mount } from 'svelte';
import Page from './Page.svelte';

const target = document.getElementById('mkdoc');

// The dev server serves the shell with an empty root, so there is nothing to
// hydrate and the document is mounted outright. A built page always has the
// rendered HTML in place; `__MKDOC_HYDRATE__` says whether this document has
// anything interactive that needs to be attached to it.
if (import.meta.env.DEV) {
    mount(Page, { target });
} else if (__MKDOC_HYDRATE__) {
    hydrate(Page, { target });
}
