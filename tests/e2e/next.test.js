// The /next page of the new stack (docs/build.md) in Chromium, from the built
// dist/ (run `npm run build` at the repo root first): React draws the page,
// Tailwind's classes carry the Odinson Glass tokens of og.css, a tap updates
// the state. No emulators needed.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
let fails = 0;
const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FAIL ') + msg); if (!c) fails++; };

if (!fs.existsSync(path.join(DIST, 'next', 'index.html'))) { console.log('dist/next/index.html is missing: run `npm run build` at the repo root first'); process.exit(1); }

// Hosting in small: files from dist/, and the /next rewrite of firebase.json.
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/next' || u === '/next/') u = '/next/index.html';
  const f = path.join(DIST, path.normalize(u));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8766, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('requestfailed', r => errors.push('failed: ' + r.url()));
    await p.goto('http://127.0.0.1:8766/next', { waitUntil: 'networkidle' });
    const s = await p.evaluate(() => {
      const plate = document.querySelector('[data-testid=checks] > div');
      return {
        title: document.querySelector('h1') && document.querySelector('h1').textContent,
        rows: document.querySelectorAll('[data-testid=checks] > div').length,
        plateBg: plate && getComputedStyle(plate).backgroundColor,
        plateRadius: plate && getComputedStyle(plate).borderRadius,
        ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(),
        font: getComputedStyle(document.body).fontFamily,
      };
    });
    ok(s.title === 'Interactive Manager · next' && s.rows === 3, 'next: React draws the page ' + JSON.stringify({ title: s.title, rows: s.rows }));
    ok(s.ground === '#10141f' && s.plateBg === 'rgb(27, 30, 41)' && s.plateRadius === '16px', 'next: Tailwind classes use the og.css tokens (bg-plate, rounded-lg) ' + JSON.stringify(s));
    ok(/DM Sans/.test(s.font), 'next: the page font is DM Sans ' + s.font);
    await p.click('[data-testid=tap]'); await p.click('[data-testid=tap]');
    ok((await p.textContent('[data-testid=tap]')).trim() === 'Taps: 2', 'next: a tap updates the state');
    ok(errors.length === 0, 'next: no script errors or failed loads ' + JSON.stringify(errors));
    const old = await (await fetch('http://127.0.0.1:8766/schedule-manager.html')).text();
    ok(old === fs.readFileSync(path.join(__dirname, '..', '..', 'schedule-manager.html'), 'utf8'), 'next: the old manager page is served unchanged from dist/');
  } finally {
    await browser.close(); server.close();
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
