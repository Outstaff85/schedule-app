// Icon check: every `ti-<name>` the pages use must be in the self-hosted
// subset (icons/tabler-icons.css). A missing one shows as an empty box —
// rebuild the subset with tests/icons/build.py. A name glued from pieces
// ('ti ti-chevron-' + dir) is skipped here: list it in build.py's EXTRA.
//   node tests/icons/check.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// The files that still draw `ti-*` icons (the React pages import theirs from @tabler/icons-react).
const FILES = ['schedule-manager.html', ...fs.readdirSync(path.join(ROOT, 'src/manager/page')).filter(f => f.endsWith('.ts')).map(f => 'src/manager/page/' + f)];
const css = fs.readFileSync(path.join(ROOT, 'icons', 'tabler-icons.css'), 'utf8');
const have = new Set([...css.matchAll(/\.ti-([a-z0-9-]+):before/g)].map(m => m[1]));
const missing = new Set();
for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/\bti-([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9-])/g)) if (!have.has(m[1])) missing.add(m[1] + '  (' + f + ')');
}
console.log(`${have.size} icons in the subset, ${missing.size} used but missing`);
missing.forEach(m => console.log('  missing  ti-' + m));
if (missing.size) { console.log('Run: python tests/icons/build.py <@tabler/icons-webfont package dir>'); process.exit(1); }
