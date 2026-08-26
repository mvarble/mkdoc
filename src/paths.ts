import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `dist/paths.js` sits one directory below the package root.
export const packageDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// The baked-in template: the HTML shell, the Vite entries and the stylesheets.
export const templateDir = path.join(packageDir, 'template');
