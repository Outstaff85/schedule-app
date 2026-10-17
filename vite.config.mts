// The new stack's build (docs/build.md). The project root is the repo root, so
// the dev server (`npm run dev`) also serves the old pages and their files
// (og.css, fonts/, i18n/ …) at the same paths as Hosting. Only the pages listed
// in `input` are built; scripts/copy-static.mjs then copies the old pages into
// dist/ unchanged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(root, p);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': r('src') } },
  publicDir: false,
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  // only the new pages: the old ones are plain scripts, not modules
  optimizeDeps: { entries: ['next/index.html', 'client-portal.html', 'supplier-portal.html'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: { next: r('next/index.html'), client: r('client-portal.html'), supplier: r('supplier-portal.html') },
    },
  },
});
