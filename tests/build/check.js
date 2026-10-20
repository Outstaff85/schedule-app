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
  for (const f of ['service-worker.js', 'og.css', 'manifest.json', 'payroll.js', 'firestore-backend.js', 'icon-192.png', 'icon-512.png'])
    if (!old.includes(f)) errs.push(`${f} is not in the list of served files (scripts/static-files.mjs)`);
  // The new pages are built by Vite, never copied: /next, the punch page and the manager app.
  for (const [f, src] of [['worker-punch.html', 'src/punch/'], ['schedule-manager.html', 'src/manager/page/']])
    if (old.includes(f)) errs.push(`${f} is a Vite entry (${src}): it must not be in the copied list`);
  // /supplier and /client (permissions plan, stage 4): small static pages that only send to the manager app.
  for (const f of ['client-portal.html', 'supplier-portal.html']) {
    if (!old.includes(f)) errs.push(`${f} (a page that sends to the manager app) is not in the copied list`);
    const h = fs.existsSync(path.join(DIST, f)) ? fs.readFileSync(path.join(DIST, f), 'utf8') : '';
    if (!/location\.replace\('\/schedule-manager\.html'\)/.test(h) || /type="module"/.test(h)) errs.push(`dist/${f} must only send to /schedule-manager.html`);
  }
  for (const f of old) {
    const to = path.join(DIST, f);
    if (!fs.existsSync(to)) errs.push(`dist/${f} missing`);
    else if (!fs.readFileSync(to).equals(fs.readFileSync(path.join(ROOT, f)))) errs.push(`dist/${f} differs from ${f}`);
  }
  const built = walk(DIST);
  const never = /^(functions|functions-auth|services|tests|docs|src|scripts|node_modules|Tokens)\/|(^|\/)\.|\.(md|rules|py|ts|tsx|mts)$|^(firebase|package|package-lock|tsconfig|components|firestore\.indexes)\.json$/;
  for (const f of built) if (never.test(f)) errs.push(`dist/${f} must never be served`);
  for (const [page, what] of [['next/index.html', 'the /next page'], ['worker-punch.html', 'the punch page'], ['schedule-manager.html', 'the manager app']]) {
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
  // The manager app (a Vite entry since stage 8c-2): the files it loads as they are (vite-ignore) are copied.
  const mh = fs.existsSync(path.join(DIST, 'schedule-manager.html')) ? fs.readFileSync(path.join(DIST, 'schedule-manager.html'), 'utf8') : '';
  for (const f of ['og.css', 'payroll.js', 'fonts/fonts.css', 'icons/tabler-icons.css', 'manifest.json'])
    if (!mh.includes(`"${f}"`) || !old.includes(f)) errs.push(`dist/schedule-manager.html: ${f} is not loaded as it is (vite-ignore) or not copied`);
  if (/vite-ignore/.test(mh)) errs.push('dist/schedule-manager.html: a vite-ignore attribute was left in the built page');
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  if (fb.hosting.public !== 'dist') errs.push(`firebase.json: hosting.public is "${fb.hosting.public}", must be "dist"`);
  console.log(`${old.length} files of the old pages, ${built.length} files in dist/, ${errs.length} problems`);
  errs.forEach(e => console.log('  ' + e));
  process.exit(errs.length ? 1 : 0);
})();
