// Builds src/lib/payroll.ts into payroll.js at the repo root (docs/build.md →
// payroll.js): a plain script (IIFE) that defines one global, `Payroll`, for
// the old pages, which have no build and load it with <script src="payroll.js">.
// The file is committed, so the old pages also work served from the repo root
// or opened as files.
//   node scripts/build-payroll.mjs          write payroll.js
//   node scripts/build-payroll.mjs --check  fail when payroll.js is not what
//                                           payroll.ts builds to (npm run build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'payroll.js');

const BANNER = `// GENERATED from src/lib/payroll.ts by scripts/build-payroll.mjs — never edit
// by hand: change payroll.ts and run \`node scripts/build-payroll.mjs\`
// (npm run build fails while this file is stale). Defines the global \`Payroll\`
// used by the old pages (docs/accounting.md → Payroll module).`;

const res = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  publicDir: false,
  build: {
    write: false,
    minify: false,
    emptyOutDir: false,
    target: 'es2019',
    lib: { entry: path.join(root, 'src/lib/payroll.ts'), formats: ['iife'], name: 'Payroll', fileName: () => 'payroll.js' },
    rolldownOptions: { output: { banner: BANNER } },
  },
});
const outputs = (Array.isArray(res) ? res : [res]).flatMap(r => r.output);
const chunk = outputs.find(o => o.type === 'chunk');
if (!chunk) throw new Error('build-payroll: no output');
const code = chunk.code.endsWith('\n') ? chunk.code : chunk.code + '\n';

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== code) {
    console.error('payroll.js is stale: run `node scripts/build-payroll.mjs` and commit payroll.js');
    process.exit(1);
  }
  console.log('payroll.js is up to date');
} else {
  fs.writeFileSync(out, code);
  console.log('wrote payroll.js');
}
