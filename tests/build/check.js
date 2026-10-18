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
  for (const f of ['schedule-manager.html', 'service-worker.js', 'og.css', 'manifest.json', 'payroll.js', 'manager-core.js', 'firestore-backend.js', 'icon-192.png', 'icon-512.png'])
    if (!old.includes(f)) errs.push(`${f} is not in the list of served files (scripts/static-files.mjs)`);
  // The new pages are built by Vite, never copied: /next, the client portal (stage 3), the supplier portal (stage 4) and the punch page (stage 5).
  for (const [f, src] of [['client-portal.html', 'src/client/'], ['supplier-portal.html', 'src/supplier/'], ['worker-punch.html', 'src/punch/']])
    if (old.includes(f)) errs.push(`${f} is a Vite entry (${src}): it must not be in the copied list`);
  for (const f of old) {
    const to = path.join(DIST, f);
    if (!fs.existsSync(to)) errs.push(`dist/${f} missing`);
    else if (!fs.readFileSync(to).equals(fs.readFileSync(path.join(ROOT, f)))) errs.push(`dist/${f} differs from ${f}`);
  }
  const built = walk(DIST);
  const never = /^(functions|functions-auth|tests|docs|src|scripts|node_modules|Tokens)\/|(^|\/)\.|\.(md|rules|py|ts|tsx|mts)$|^(firebase|package|package-lock|tsconfig|components|firestore\.indexes)\.json$/;
  for (const f of built) if (never.test(f)) errs.push(`dist/${f} must never be served`);
  for (const [page, what] of [['next/index.html', 'the /next page'], ['client-portal.html', 'the client portal'], ['supplier-portal.html', 'the supplier portal'], ['worker-punch.html', 'the punch page']]) {
    const file = path.join(DIST, page);
    if (!fs.existsSync(file)) { errs.push(`dist/${page} missing (${what})`); continue; }
    const html = fs.readFileSync(file, 'utf8');
    const js = (html.match(/src="\/(assets\/[^"]+\.js)"/) || [])[1];
    if (!js || !fs.existsSync(path.join(DIST, js))) errs.push(`dist/${page}: its script is not in dist/assets`);
    if (/src="\/src\//.test(html)) errs.push(`dist/${page} still points at /src (not built)`);
  }
  // The punch page's manifest: built by Vite (hashed, in assets/), never copied; its paths are absolute,
  // so they resolve from /assets/ too, and every icon it names is served.
  if (old.includes('manifest-punch.json')) errs.push('manifest-punch.json is built by Vite (worker-punch.html): it must not be in the copied list');
  const ph = fs.existsSync(path.join(DIST, 'worker-punch.html')) ? fs.readFileSync(path.join(DIST, 'worker-punch.html'), 'utf8') : '';
  const mf = (ph.match(/<link rel="manifest" href="\/(assets\/manifest-punch-[^"]+\.json)"/) || [])[1];
  if (!mf || !fs.existsSync(path.join(DIST, mf))) errs.push('dist/worker-punch.html: its manifest is not a built file in dist/assets');
  else {
    const m = JSON.parse(fs.readFileSync(path.join(DIST, mf), 'utf8'));
    for (const u of [m.start_url, m.scope, m.id, ...(m.icons || []).map(i => i.src)]) if (!/^\//.test(String(u))) errs.push(`${mf}: "${u}" must be an absolute path`);
    for (const i of m.icons || []) if (!fs.existsSync(path.join(DIST, i.src))) errs.push(`${mf}: icon ${i.src} is not in dist/`);
    if (!fs.existsSync(path.join(DIST, m.start_url))) errs.push(`${mf}: start_url ${m.start_url} is not in dist/`);
  }
  // The manager app (an old page, copied) loads its React pieces (stage 6) from the fixed
  // name assets/manager.js, built by Vite from src/manager/ with every chunk it imports.
  const mh = fs.existsSync(path.join(DIST, 'schedule-manager.html')) ? fs.readFileSync(path.join(DIST, 'schedule-manager.html'), 'utf8') : '';
  if (!/<script type="module" src="assets\/manager\.js"><\/script>/.test(mh)) errs.push('dist/schedule-manager.html: no module script assets/manager.js');
  const mjs = path.join(DIST, 'assets', 'manager.js');
  if (!fs.existsSync(mjs)) errs.push('dist/assets/manager.js is missing (vite.config.mts → input manager)');
  else for (const [, dep] of fs.readFileSync(mjs, 'utf8').matchAll(/from"\.\/([^"]+\.js)"/g)) if (!fs.existsSync(path.join(DIST, 'assets', dep))) errs.push(`dist/assets/manager.js imports ${dep}, which is not in dist/assets`);
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  if (fb.hosting.public !== 'dist') errs.push(`firebase.json: hosting.public is "${fb.hosting.public}", must be "dist"`);
  console.log(`${old.length} files of the old pages, ${built.length} files in dist/, ${errs.length} problems`);
  errs.forEach(e => console.log('  ' + e));
  process.exit(errs.length ? 1 : 0);
})();
