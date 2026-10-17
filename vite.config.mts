// The new stack's build (docs/build.md). The project root is the repo root, so
// the dev server (`npm run dev`) also serves the old pages and their files
// (og.css, fonts/, i18n/ …) at the same paths as Hosting. Only the pages listed
// in `input` are built; scripts/copy-static.mjs then copies the old pages into
// dist/ unchanged. The manager app (an old page) loads its React pieces from
// one module with a fixed name, assets/manager.js (src/manager/, docs/build.md →
// The manager's React pieces); the dev server answers that path from the source.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(root, p);

// The manager's module: built as assets/manager.js (the old page names it), served from src/ by the dev server.
const MANAGER_JS = '/assets/manager.js';
const managerDev = {
  name: 'manager-dev',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => { if (req.url === MANAGER_JS) req.url = '/src/manager/main.tsx'; next(); });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), managerDev],
  resolve: { alias: { '@': r('src') } },
  publicDir: false,
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  // only the new pages: the old ones are plain scripts, not modules
  optimizeDeps: { entries: ['next/index.html', 'client-portal.html', 'supplier-portal.html', 'worker-punch.html', 'src/manager/main.tsx'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: { next: r('next/index.html'), client: r('client-portal.html'), supplier: r('supplier-portal.html'), punch: r('worker-punch.html'), manager: r('src/manager/main.tsx') },
      output: { entryFileNames: chunk => (chunk.name === 'manager' ? MANAGER_JS.slice(1) : 'assets/[name]-[hash].js') },
    },
  },
});
