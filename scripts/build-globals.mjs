// Builds the manager page's plain scripts from their TypeScript sources
// (docs/build.md → Generated scripts). The manager page has no build of its
// own and loads them with <script src>, so each is one IIFE at the repo root,
// committed (the page also works served from the repo root or opened as a file):
//   payroll.js            from src/lib/payroll.ts — the global `Payroll`
//   firestore-backend.js  from src/lib/firestore-backend-global.ts — the
//                         global initFirestoreBackend() (src/lib/firestore-backend.ts)
//   manager-core.js       from src/manager/globals.ts — the manager page's
//                         data layer and logic under their old global names (stage 8b, 8c)
//   node scripts/build-globals.mjs          write them
//   node scripts/build-globals.mjs --check  fail when one is not what its
//                                           source builds to (npm run build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const banner = (src, what) => `// GENERATED from ${src} by scripts/build-globals.mjs — never edit
// by hand: change the TypeScript and run \`node scripts/build-globals.mjs\`
// (npm run build fails while this file is stale). ${what}`;

const TARGETS = [
  { out: 'payroll.js', entry: 'src/lib/payroll.ts', name: 'Payroll', target: 'es2019',
    banner: banner('src/lib/payroll.ts', 'Defines the global `Payroll`\n// used by the old pages (docs/accounting.md → Payroll module).') },
  { out: 'firestore-backend.js', entry: 'src/lib/firestore-backend-global.ts', target: 'es2020',
    banner: banner('src/lib/firestore-backend.ts', 'Defines the global\n// initFirestoreBackend(), the browser data layer (docs/backend.md → Browser data layer).') },
  { out: 'manager-core.js', entry: 'src/manager/globals.ts', target: 'es2020',
    banner: banner('src/manager/data/, src/manager/logic/', 'The manager page\'s data\n// layer (session, dispatcher, load / save / cache, punches, uploads, telemetry)\n// and its logic (access, i18n, pay, workers, uploads…) under their old global\n// names (docs/app-core.md → Data calls).') },
];

async function codeOf(t) {
  const res = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    publicDir: false,
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      target: t.target,
      lib: { entry: path.join(root, t.entry), formats: ['iife'], name: t.name || '_unused', fileName: () => t.out },
      rolldownOptions: { output: { banner: t.banner } },
    },
  });
  const outputs = (Array.isArray(res) ? res : [res]).flatMap(r => r.output);
  const chunk = outputs.find(o => o.type === 'chunk');
  if (!chunk) throw new Error('build-globals: no output for ' + t.out);
  return chunk.code.endsWith('\n') ? chunk.code : chunk.code + '\n';
}

const check = process.argv.includes('--check');
let stale = false;
for (const t of TARGETS) {
  const out = path.join(root, t.out);
  const code = await codeOf(t);
  if (check) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (cur !== code) { console.error(`${t.out} is stale: run \`node scripts/build-globals.mjs\` and commit ${t.out}`); stale = true; }
    else console.log(`${t.out} is up to date`);
  } else {
    fs.writeFileSync(out, code);
    console.log('wrote ' + t.out);
  }
}
if (stale) process.exit(1);
