// The new stack's build (docs/build.md). The project root is the repo root, so
// the dev server (`npm run dev`) also serves the files the pages load as they
// are (og.css, fonts/, i18n/, payroll.js, firestore-backend.js …) at the same
// paths as Hosting. Only the pages listed in `input` are built; the manager page
// (schedule-manager.html) is one of them since stage 8c-2 — its module is
// src/manager/page/entry.ts, and its links to the files copied as they are
// carry `vite-ignore`. scripts/copy-static.mjs then copies those files into dist/.
// scan-lab/index.html is the scanner lab: the same scanner as the site's, in lab mode (docs/scan-plan.md →
// S9); its models are put next to it in dist/scan-lab/ at deploy (docs/build.md → The scanner's entries).
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
  // The scanner's background thread (src/scan/engine/worker.ts) is a module worker: it imports ONNX Runtime
  // from the surface's own copy at run time (docs/scan-plan.md → S9).
  worker: { format: 'es' },
  optimizeDeps: { entries: ['next/index.html', 'worker-punch.html', 'schedule-manager.html', 'scan-lab/index.html'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: { next: r('next/index.html'), punch: r('worker-punch.html'), manager: r('schedule-manager.html'), scanLab: r('scan-lab/index.html') },
    },
  },
});
