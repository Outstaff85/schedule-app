// The last step of `npm run build` (docs/build.md): copies the old pages and
// their files (scripts/static-files.mjs) into dist/, unchanged, next to what
// Vite built. Firebase Hosting serves dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticFiles } from './static-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const files = staticFiles(root);
for (const f of files) {
  const to = path.join(dist, f);
  if (fs.existsSync(to)) throw new Error(`copy-static: ${f} is also built by Vite`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, f), to);
}
console.log(`copy-static: ${files.length} files of the old pages copied into dist/`);
