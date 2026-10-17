// The build check (docs/build.md, docs/tests.md), run after `npm run build`:
// dist/ — what Firebase Hosting serves — holds every file of the old pages
// byte for byte (scripts/static-files.mjs: the files Hosting served from the
// repo root before), the pages Vite built, and nothing that must never be
// public (functions, tests, docs, rules, the new stack's sources and config).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(DIST)) { console.log('dist/ is missing: run `npm run build` at the repo root first'); process.exit(1); }
  const { staticFiles } = await import(path.join(ROOT, 'scripts', 'static-files.mjs'));
  const errs = [];
  const old = staticFiles(ROOT);
  for (const f of ['schedule-manager.html', 'worker-punch.html', 'service-worker.js', 'og.css', 'manifest.json', 'payroll.js'])
    if (!old.includes(f)) errs.push(`${f} is not in the list of served files (scripts/static-files.mjs)`);
  // The new pages are built by Vite, never copied: /next, the client portal (stage 3) and the supplier portal (stage 4).
  for (const [f, src] of [['client-portal.html', 'src/client/'], ['supplier-portal.html', 'src/supplier/']])
    if (old.includes(f)) errs.push(`${f} is a Vite entry (${src}): it must not be in the copied list`);
  for (const f of old) {
    const to = path.join(DIST, f);
    if (!fs.existsSync(to)) errs.push(`dist/${f} missing`);
    else if (!fs.readFileSync(to).equals(fs.readFileSync(path.join(ROOT, f)))) errs.push(`dist/${f} differs from ${f}`);
  }
  const built = walk(DIST);
  const never = /^(functions|functions-auth|tests|docs|src|scripts|node_modules|Tokens)\/|(^|\/)\.|\.(md|rules|py|ts|tsx|mts)$|^(firebase|package|package-lock|tsconfig|components|firestore\.indexes)\.json$/;
  for (const f of built) if (never.test(f)) errs.push(`dist/${f} must never be served`);
  for (const [page, what] of [['next/index.html', 'the /next page'], ['client-portal.html', 'the client portal'], ['supplier-portal.html', 'the supplier portal']]) {
    const file = path.join(DIST, page);
    if (!fs.existsSync(file)) { errs.push(`dist/${page} missing (${what})`); continue; }
    const html = fs.readFileSync(file, 'utf8');
    const js = (html.match(/src="\/(assets\/[^"]+\.js)"/) || [])[1];
    if (!js || !fs.existsSync(path.join(DIST, js))) errs.push(`dist/${page}: its script is not in dist/assets`);
    if (/src="\/src\//.test(html)) errs.push(`dist/${page} still points at /src (not built)`);
  }
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  if (fb.hosting.public !== 'dist') errs.push(`firebase.json: hosting.public is "${fb.hosting.public}", must be "dist"`);
  console.log(`${old.length} files of the old pages, ${built.length} files in dist/, ${errs.length} problems`);
  errs.forEach(e => console.log('  ' + e));
  process.exit(errs.length ? 1 : 0);
})();
