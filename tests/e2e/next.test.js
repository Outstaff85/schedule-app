// The /next component gallery of the new stack (docs/components.md) in
// Chromium, from the built dist/ (run `npm run build` at the repo root first),
// on a computer (1280px, mouse) and a phone (390px, touch): every component is
// drawn, Tailwind's classes carry the og.css tokens, and the app's templates
// hold — windows close on the backdrop with no ✕ and go back to the window they
// came from, a Drawer on a phone, tap reads / double click / long press edits /
// swipe left, Delete with Undo, Select mode, lists page by 10, the form checks
// its fields, the language sheet switches the page (layout stays left to right),
// the theme switch (Dark / Light / System) turns the light theme on and back off
// and the light theme's text, plates, bars and badges keep their contrast.
// No emulators needed.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const OUT = process.env.E2E_OUT || path.join(__dirname, 'out');
const BASE = 'http://127.0.0.1:8766/next';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c){ fails++; if (process.env.GITHUB_ACTIONS) console.log('::error::' + String(m).replace(/\r?\n/g, ' ').slice(0, 900)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(path.join(DIST, 'next', 'index.html'))) { console.log('dist/next/index.html is missing: run `npm run build` at the repo root first'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// Hosting in small: files from dist/, and the /next rewrite of firebase.json.
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/next' || u === '/next/') u = '/next/index.html';
  const f = path.join(DIST, path.normalize(u));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const DEMOS = {
  controls: ['button', 'input', 'select', 'checkbox', 'toggle-group', 'form'],
  lists: ['plate', 'plate-sizes', 'empty'],
  windows: ['window', 'signature', 'sign-documents', 'menu', 'account', 'theme', 'sheet'],
  feedback: ['alert', 'toast', 'progress'],
  data: ['table', 'data-table', 'chart', 'calendar', 'card'],
  layout: ['tabs', 'accordion', 'collapsible'],
};

// pdf.js (the documents shown before signing) from node_modules, as the CDN would give it
const pdfRoute = t => t.route(/cdnjs\.cloudflare\.com\/.*\/pdf(\.worker)?\.min\.js$/, r => r.fulfill({ status: 200, contentType: 'application/javascript',
  body: fs.readFileSync(require.resolve('pdfjs-dist/build/' + r.request().url().split('/').pop())) }));
async function open(p, section) {
  await p.goto(BASE + '#' + section, { waitUntil: 'networkidle' });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector(`[data-testid=page-${section}]`);
}
const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
// a touch gesture as the browser sends it: pointer events with pointerType touch
async function touch(p, sel, steps) {
  await p.evaluate(({ sel, steps }) => {
    const el = document.querySelector(sel); const r = el.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const fire = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x0 + dx, clientY: y0 }));
    for (const [type, dx] of steps) fire(type, dx);
  }, { sel, steps });
}

async function computer(browser) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await pdfRoute(p);
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  // The tab icon's request cancelled by the test's own reload (open()) is not a failed load.
  p.on('requestfailed', r => { const why = (r.failure() || {}).errorText; if (!(why === 'net::ERR_ABORTED' && /\/icon-192[^/]*\.png$/.test(r.url()))) errors.push('failed: ' + r.url() + ' ' + why); });

  // every component block, on every section
  const missing = [];
  for (const [section, ids] of Object.entries(DEMOS)) {
    await open(p, section);
    for (const id of ids) if (!(await p.locator(`[data-testid=demo-${id}]`).count())) missing.push(id);
    await p.screenshot({ path: path.join(OUT, `next-computer-${section}.png`), fullPage: true });
  }
  ok(!missing.length, 'next: the gallery draws every component ' + JSON.stringify({ missing }));
  ok(await visible(p, '[data-testid=shell-tabs]') && !(await visible(p, '[data-testid=shell-bar]')), 'next: a computer gets the section tabs, no bottom bar');

  // tokens through Tailwind
  await open(p, 'lists');
  const look = await p.evaluate(() => {
    const plate = document.querySelector('[data-testid=plate-w0] .og-plate');
    const cs = getComputedStyle(plate);
    return { bg: cs.backgroundColor, radius: cs.borderRadius, ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(), font: getComputedStyle(document.body).fontFamily };
  });
  ok(look.bg === 'rgb(27, 30, 41)' && look.radius === '16px' && look.ground === '#10141f' && /DM Sans/.test(look.font), 'next: plates and fonts carry the og.css tokens ' + JSON.stringify(look));

  // lists: page by 10, tap reads, double click edits, ⋮ → Delete → Undo
  const plates = () => p.locator('[data-testid^=plate-w]').count();
  ok(await plates() === 10, 'next: a list shows 10 rows first');
  // the next page comes only after the user's own downward input with "Show more (N left)" in view
  // (the old pages' renderPagedList rules): a scroll by script loads nothing, a wheel up neither
  const more = p.locator('[data-slot=paged-more]');
  ok(/Show more \(4 left\)/.test(await more.innerText()), 'next: the list ends with "Show more (4 left)"');
  await more.scrollIntoViewIfNeeded(); await sleep(400);
  ok(await plates() === 10, 'next: a scroll that no user input started loads nothing');
  const box = await more.boundingBox();
  await p.mouse.move(box.x + 20, box.y - 40);
  await p.mouse.wheel(0, -60); await sleep(400);
  ok(await plates() === 10, 'next: a wheel up never loads, even with the row in view');
  await p.mouse.wheel(0, 60); await sleep(500);
  ok(await plates() === 14 && await more.count() === 0, 'next: a wheel down with the row in view loads the next page');
  await p.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
  await p.click('[data-testid=plate-w0] .og-plate', { position: { x: 60, y: 20 } }); await sleep(400);
  ok(/Overtime/.test(await p.locator('[data-testid=plate-w0]').innerText()), 'next: a tap on a plate opens its details');
  await p.dblclick('[data-testid=plate-w1] .og-plate', { position: { x: 60, y: 20 } }); await sleep(400);
  const editKind = await p.locator('[data-testid=window]').getAttribute('data-kind').catch(() => null);
  ok(editKind === 'dialog' && /Edit worker/.test(await p.locator('[data-testid=window]').innerText()), 'next: a double click opens the edit window, a centred Dialog on a computer');
  ok(await p.locator('[data-testid=window] button', { hasText: /^(Close|Cancel|✕|×)$/ }).count() === 0 && await p.locator('[data-testid=window] [data-slot=dialog-close]').count() === 0, 'next: a window has no ✕ and no Cancel');
  await p.mouse.click(20, 880); await sleep(400);
  ok(!(await visible(p, '[data-testid=window]')), 'next: a tap on the backdrop closes the window');
  await p.click('[data-testid=plate-w2] button[aria-label=Actions]'); await sleep(250);
  const items = await p.locator('[role=menuitem]').allInnerTexts();
  const delColor = await p.locator('[role=menuitem]').last().evaluate(el => getComputedStyle(el).color);
  ok(items.map(s => s.trim()).join() === 'Edit,Open card,Delete' && delColor === 'rgb(255, 209, 214)', 'next: ⋮ holds the actions, Delete last in red-soft ' + JSON.stringify({ items, delColor }));
  await p.locator('[role=menuitem]').last().click(); await sleep(500);
  ok(await p.locator('[data-testid=plate-w2]').count() === 0 && /Andrei Popescu deleted/.test(await p.locator('[data-testid=undo-snack]').innerText()), 'next: Delete never asks — the plate goes and the Undo snack shows');
  await p.click('[data-testid=undo-snack] .og-snack-u'); await sleep(400);
  ok(await p.locator('[data-testid=plate-w2]').count() === 1 && !(await visible(p, '[data-testid=undo-snack]')), 'next: Undo brings the plate back');

  // Select mode
  await p.getByRole('button', { name: 'Select', exact: true }).click(); await sleep(200);
  await p.click('[data-testid=plate-w3] .og-plate', { position: { x: 80, y: 20 } });
  await p.click('[data-testid=plate-w4] .og-plate', { position: { x: 80, y: 20 } }); await sleep(200);
  const selText = await p.locator('[data-testid=select-bar]').innerText();
  ok(/2 selected/.test(selText) && await p.locator('[data-testid=plate-w3] .og-plate.on').count() === 1 && await p.locator('[data-testid=plate-w3] button[aria-label=Actions]').count() === 0, 'next: Select — tick boxes, "2 selected", no ⋮ while selecting');
  await p.locator('[data-testid=select-bar]').getByRole('button', { name: /Delete/ }).click(); await sleep(500);
  ok(/2 workers deleted/.test(await p.locator('[data-testid=undo-snack]').innerText()) && !(await visible(p, '[data-testid=select-bar]')), 'next: a bulk delete shows "2 workers deleted · Undo" and ends Select');

  // figures as a filter
  await p.getByRole('button', { name: /Notices/ }).click(); await sleep(400);
  ok(await plates() < 10 && await plates() > 0, 'next: a figure filters the list');

  // Data Table (TanStack Table): 10 rows and Show more; a tap on a column head sorts; the totals row covers every row
  await p.locator('[data-testid=shell-tabs] button', { hasText: 'Data' }).click(); await p.waitForSelector('[data-testid=page-data]');
  const dt = '[data-testid=data-table-demo]';
  const dtRows = () => p.locator(dt + ' tbody tr').count();
  const first = () => p.locator(dt + ' tbody tr').first().locator('td').first().innerText();
  const r0 = {rows: await dtRows(), foot: await p.locator(dt + ' tfoot').innerText()};
  await p.locator(dt).getByRole('button', { name: /Show more/ }).click(); await sleep(200);
  r0.all = await dtRows();
  await p.locator(dt + ' th button', { hasText: 'Worker' }).click(); await sleep(150); r0.asc = await first();
  await p.locator(dt + ' th button', { hasText: 'Worker' }).click(); await sleep(150); r0.desc = await first();
  ok(r0.rows === 10 && r0.all === 14 && /14/.test(r0.foot) && r0.asc === 'Andrei Popescu' && r0.desc === 'Yosef Peretz', 'next: Data Table — 10 rows then Show more, sorting by a column head, totals cover every row ' + JSON.stringify(r0));

  // windows: a window opened from another goes back to it
  await open(p, 'windows');
  await p.click('[data-testid=open-window]'); await sleep(300);
  await p.getByRole('button', { name: 'Open another window' }).click(); await sleep(400);
  const second = await p.locator('[data-testid=window]').innerText();
  await p.keyboard.press('Escape'); await sleep(400);
  const back = await p.locator('[data-testid=window]').innerText().catch(() => '');
  ok(/Bank details/.test(second) && /Pay/.test(back) && /Hourly rate/.test(back), 'next: closing the second window goes back to the first');
  await p.keyboard.press('Escape'); await sleep(300);

  // controls: Select, Combobox search, Date Picker, form errors
  await open(p, 'controls');
  await p.click('[data-testid=select-trigger]'); await sleep(250);
  await p.getByRole('option', { name: 'Ashdod Logistics' }).click(); await sleep(200);
  ok(/Ashdod Logistics/.test(await p.locator('[data-testid=select-trigger]').innerText()), 'next: Select picks a value');
  await p.click('#d-worker'); await sleep(250);
  await p.keyboard.type('omar'); await sleep(250);
  const found = await p.locator('[data-slot=command-item]').allInnerTexts();
  ok(found.length === 1 && /Omar Haddad/.test(found[0]), 'next: Combobox searches its list ' + JSON.stringify(found));
  await p.keyboard.press('Enter'); await sleep(250);
  ok(/Omar Haddad/.test(await p.locator('#d-worker').innerText()), 'next: Combobox picks the found item');
  await p.click('#d-date'); await sleep(250);
  await p.locator('[data-slot=popover-content] button', { hasText: /^20$/ }).first().click(); await sleep(250);
  ok((await p.locator('#d-date').innerText()).includes('20/10/2026'), 'next: the Date Picker sets a dd/mm/yyyy date');
  await p.locator('[data-testid=worker-form] button[type=submit]').click(); await sleep(300);
  const formErr = await p.locator('[data-testid=worker-form] [data-slot=form-message]').allInnerTexts();
  ok(formErr.includes('Enter a first name') && formErr.includes('Enter a phone like 050-1234567'), 'next: the form shows its field errors ' + JSON.stringify(formErr));
  await p.screenshot({ path: path.join(OUT, 'next-computer-form-errors.png'), fullPage: true });

  // language: the sheet lists the dictionaries' languages; Hebrew switches the page, layout stays LTR
  // The manager app's frame (V7, Shell `app`): the side menu, the breadcrumb, the greeting in the middle,
  // the panel only on Workers / Schedule, the figures as tiles, the sections as panels, plates in three columns.
  await open(p, 'frame');
  const fr = await p.evaluate(async () => {
    const box = q => document.querySelector(q).getBoundingClientRect(), r = {}, crumb = () => document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim();
    r.menu = Math.abs(box('[data-testid=shell-menu]').width - 210) < 2 && box('[data-testid=shell-menu]').left < 2 && !document.querySelector('[data-testid=shell-tabs]');
    r.crumb = crumb();
    r.greet = /Good /.test(document.querySelector('[data-testid=shell-greeting]').textContent) && !!document.querySelector('[data-testid=shell-greeting] svg.gic');
    r.noAside = !document.querySelector('[data-testid=shell-aside]');
    r.tiles = document.querySelectorAll('[data-testid=page-frame] [data-slot=figures] > button').length === 4;
    r.panels = document.querySelectorAll('[data-testid=page-frame] section[data-panel]').length === 2;
    [...document.querySelectorAll('[data-testid=shell-menu] button')].find(b => /Workers/.test(b.textContent)).click(); await new Promise(res => setTimeout(res, 300));
    r.aside = !!document.querySelector('[data-testid=shell-aside]'); r.crumbW = crumb();
    const tops = [...document.querySelectorAll('[data-testid=page-frame] [data-slot=paged-list] > *')].slice(0, 4).map(e => Math.round(e.getBoundingClientRect().top));
    r.threeCols = tops[0] === tops[2] && tops[3] > tops[0];
    return r;
  });
  ok(fr.menu && fr.crumb === 'Today' && fr.greet && fr.noAside && fr.tiles && fr.panels && fr.aside && fr.crumbW === 'Workers 12' && fr.threeCols,
    'next: the app frame (V7) — side menu, breadcrumb, greeting in the middle, the panel only on Workers, tiles, panels, plates in three columns ' + JSON.stringify(fr));
  await p.screenshot({ path: path.join(OUT, 'next-computer-frame.png') });
  // The title bar as the manager page draws it: the 11C mark with the name and its two lines, Saved, the bell with its count, the account with the firm.
  const bar = await p.evaluate(() => ({
    mark: !!document.querySelector('[data-testid=app-brand] svg.og-mark'),
    name: (document.querySelector('[data-testid=app-brand] .og-name') || {}).innerText || '',
    saved: (document.querySelector('[data-testid=save-indicator]') || {}).innerText || '',
    bell: (document.querySelector('[data-testid=shell-bell] .og-bell-n') || {}).textContent || '',
    acct: (document.querySelector('[data-testid=account-btn]') || {}).innerText || '',
  }));
  ok(bar.mark && /Interactive Manager/.test(bar.name) && /Everything under one roof/.test(bar.name) && /Saved/.test(bar.saved) && bar.bell === '2' && /Owner · Firm One/.test(bar.acct),
    'next: the app frame\'s title bar — the 11C mark and name, Saved, the bell with its count, the account with the firm ' + JSON.stringify(bar));
  await p.click('[data-testid=account-btn]'); await sleep(300);
  await p.getByRole('menuitem', { name: 'Back to the gallery' }).click(); await sleep(300);
  ok(await p.locator('[data-testid=page-controls]').count() === 1, 'next: the frame demo goes back to the gallery');

  await p.click('[data-testid=lang-btn]'); await sleep(300);
  const langs = await p.locator('[data-testid=lang-list] .lang-li').allInnerTexts();
  ok(langs.length === 3 && /עברית/.test(langs.join()) && /Hebrew/.test(langs.join()), 'next: the Language window lists every language ' + JSON.stringify(langs));
  await p.locator('[data-testid=lang-list] .lang-li', { hasText: 'עברית' }).click(); await sleep(800);
  const he = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'he.json'), 'utf8'));
  const heState = await p.evaluate(() => ({ lang: document.documentElement.lang, dir: getComputedStyle(document.body).direction, h1: document.querySelector('main h1').textContent.trim(), stored: localStorage.getItem('uiLang') }));
  ok(heState.lang === 'he' && heState.dir === 'ltr' && heState.h1 === he['Components'] && heState.stored === 'he', 'next: Hebrew translates the page and keeps it left to right ' + JSON.stringify(heState));
  await p.screenshot({ path: path.join(OUT, 'next-computer-hebrew.png'), fullPage: true });
  await p.reload({ waitUntil: 'networkidle' }); await sleep(300);
  ok((await p.locator('main h1').innerText()).trim() === he['Components'], 'next: the language is kept on the device (uiLang, shared with the old pages)');
  await open(p, 'frame');
  const frHe = await p.evaluate(() => {
    const box = q => document.querySelector(q).getBoundingClientRect();
    return { menuRight: box('[data-testid=shell-menu]').right > innerWidth - 2, crumbRight: box('[data-testid=shell-crumb]').left > innerWidth / 2,
      pageLtr: getComputedStyle(document.querySelector('[data-testid=page-frame]')).direction === 'ltr' };
  });
  ok(frHe.menuRight && frHe.crumbRight && frHe.pageLtr, 'next: in Hebrew the app frame is mirrored (menu and breadcrumb on the right), the page stays left to right ' + JSON.stringify(frHe));
  await p.screenshot({ path: path.join(OUT, 'next-computer-frame-hebrew.png') });
  await p.evaluate(() => localStorage.setItem('uiLang', 'en'));

  ok(errors.length === 0, 'next: no script errors or failed loads on a computer ' + JSON.stringify(errors));
  await p.close();
}

async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await pdfRoute(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await open(p, 'controls');
  const bar = await p.locator('[data-testid=shell-bar] button').allInnerTexts();
  ok(!(await visible(p, '[data-testid=shell-tabs]')) && bar.length === 5 && /More/.test(bar[4]), 'next: a phone gets the bottom bar, four sections and More ' + JSON.stringify(bar));
  await p.locator('[data-testid=shell-bar] button').nth(4).tap(); await sleep(500);
  const more = await p.locator('[data-testid=window]').innerText();
  ok(await p.locator('[data-testid=window]').getAttribute('data-kind') === 'sheet' && /Data/.test(more) && /Layout/.test(more), 'next: More opens a bottom sheet with the other sections');
  await p.getByRole('button', { name: 'Layout' }).tap(); await sleep(600);
  ok(await p.locator('[data-testid=page-layout]').count() === 1, 'next: a section from More opens');
  for (const s of Object.keys(DEMOS)) { await open(p, s); await p.screenshot({ path: path.join(OUT, `next-phone-${s}.png`), fullPage: true }); }

  await open(p, 'frame');
  const frp = await p.evaluate(() => {
    const box = q => document.querySelector(q).getBoundingClientRect(), c = box('[data-testid=shell-crumb]'), g = box('[data-testid=shell-greeting]');
    return { rows: c.top >= g.bottom - 1, noMenu: !document.querySelector('[data-testid=shell-menu]'), bar: !!document.querySelector('[data-testid=shell-bar]'),
      noWords: getComputedStyle(document.querySelector('[data-testid=shell-greet-text]')).display === 'none', sticky: getComputedStyle(document.querySelector('[data-slot=shell] > header')).position === 'sticky',
      tilesRow: (() => { const t = [...document.querySelectorAll('[data-slot=figures] > button')].map(b => Math.round(b.getBoundingClientRect().top)); return t.length === 4 && t.every(x => x === t[0]); })() };
  });
  ok(frp.rows && frp.noMenu && frp.bar && frp.noWords && frp.sticky && frp.tilesRow, 'next: the app frame on a phone — two header rows (the breadcrumb under them), no greeting words, the bottom bar, four tiles in a row ' + JSON.stringify(frp));
  await p.screenshot({ path: path.join(OUT, 'next-phone-frame.png') });

  await open(p, 'lists');
  await touch(p, '[data-testid=plate-w0] .og-plate', [['pointerdown', 0], ['pointermove', -40], ['pointermove', -110], ['pointerup', -110]]); await sleep(400);
  ok(await visible(p, '[data-testid=plate-w0] .og-acts'), 'next: a swipe left shows Edit and Delete behind the plate');
  await p.screenshot({ path: path.join(OUT, 'next-phone-swipe.png') });
  await touch(p, '[data-testid=plate-w5] .og-plate', [['pointerdown', 0]]); await sleep(750);
  await touch(p, '[data-testid=plate-w5] .og-plate', [['pointerup', 0]]); await sleep(500);
  const kind = await p.locator('[data-testid=window]').getAttribute('data-kind').catch(() => null);
  ok(kind === 'sheet' && /Edit worker/.test(await p.locator('[data-testid=window]').innerText()), 'next: a long press opens the edit form, as a bottom sheet on a phone');
  await p.screenshot({ path: path.join(OUT, 'next-phone-sheet.png') });
  // the sheet's opening animation ends first (a tap during it is not a tap on the backdrop yet); its closing one takes ~0.5 s
  await p.evaluate(() => Promise.all(document.querySelector('[data-testid=window]').getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
  await p.mouse.click(195, 40);
  let sheetGone = false;
  for (let i = 0; i < 20 && !(sheetGone = !(await visible(p, '[data-testid=window]'))); i++) await sleep(150);
  ok(sheetGone, 'next: a tap above the sheet closes it');
  ok(errors.length === 0, 'next: no script errors on a phone ' + JSON.stringify(errors));
  await ctx.close();
}

// The light theme (docs/redesign.md → Light theme): the contrast of what is on
// screen — every text inside plates, badges and the figures against what is
// really behind it (the rgba fills composited up to the first solid one), and
// each plate's coloured bar against the plate.
async function contrastReport(p) {
  return p.evaluate(() => {
    const parse = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const ground = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    const behind = el => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } return stack.reverse().reduce((acc, c) => over(c, acc), ground); };
    const out = { texts: 0, low: [], bars: 0, lowBars: [] };
    const seen = new Set();
    for (const host of document.querySelectorAll('.og-plate, [data-slot=badge], [data-slot=figures] > *, [data-slot=figure]')) {
      for (const el of [host, ...host.querySelectorAll('*')]) {
        if (seen.has(el)) continue; seen.add(el);
        const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        const r = el.getBoundingClientRect();
        if (!own || !r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || Number(getComputedStyle(el).opacity) < 0.5) continue;
        const fg = parse(getComputedStyle(el).color); if (!fg) continue;
        const bg = behind(el), k = ratio(over(fg, bg), bg);
        out.texts++;
        if (k < 4.5) out.low.push(el.textContent.trim().slice(0, 30) + ' ' + k.toFixed(2) + ' ' + el.className + ' ' + getComputedStyle(el).color + ' on ' + JSON.stringify(bg));
      }
    }
    for (const pl of document.querySelectorAll('.og-plate')) {
      const bar = parse(getComputedStyle(pl).boxShadow), bg = behind(pl); if (!bar) continue;
      out.bars++;
      const k = ratio(bar, bg); if (k < 3) out.lowBars.push(pl.textContent.trim().slice(0, 20) + ' ' + k.toFixed(2));
    }
    return out;
  });
}

async function theme(browser) {
  for (const [w, h, mobile] of [[1280, 860, false], [390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
    await pdfRoute(ctx);
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    const look = () => p.evaluate(() => document.documentElement.dataset.theme);
    const stored = () => p.evaluate(() => localStorage.getItem('uiTheme'));
    await open(p, 'windows');
    ok(await look() === 'dark', `theme ${w}: Dark is the default ` + await look());
    // the switch in the gallery: Light
    await p.click('[data-testid=demo-theme] [data-testid=theme-switch] [data-testid=theme-light]');
    ok(await look() === 'light' && await stored() === 'light', `theme ${w}: Light turns the light theme on and keeps it on the device ` + JSON.stringify([await look(), await stored()]));
    const ground = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim());
    ok(ground === '#eef1f7', `theme ${w}: the light tokens of og.css apply (--ground) ` + ground);
    // it is there before the first draw on the next visit (the <head> script)
    await p.reload({ waitUntil: 'domcontentloaded' });
    ok(await look() === 'light', `theme ${w}: the light theme is set before the page draws, after a reload`);
    await p.waitForSelector('[data-testid=page-windows]');
    // the readability of the light theme: plates, badges, figures, bars
    for (const section of ['lists', 'feedback', 'data']) {
      await open(p, section);
      const r = await contrastReport(p);
      ok(r.texts > 0 && r.low.length === 0, `theme ${w}: every text on plates, badges and figures is ≥ 4.5:1 in the light theme (${section}, ${r.texts} texts) ` + JSON.stringify(r.low));
      if (section === 'lists') ok(r.bars > 3 && r.lowBars.length === 0, `theme ${w}: the plates' coloured bars stand out (≥ 3:1, ${r.bars} plates) ` + JSON.stringify(r.lowBars));
      await p.screenshot({ path: path.join(OUT, `next-theme-light-${section}-${w}.png`), fullPage: false });
    }
    // System follows the device's own setting, live
    await open(p, 'windows');
    if (mobile) {
      // a phone page without an account (the punch page) has the bare button: it opens the switch in a window
      await p.click('[data-testid=demo-theme] [data-testid=theme-btn]');
      await p.waitForSelector('[data-testid=window] [data-testid=theme-switch]');
      await p.click('[data-testid=window] [data-testid=theme-system]');
      await p.keyboard.press('Escape');
    } else {
      // the account menu carries the switch
      await p.click('[data-testid=demo-account] [data-testid=account-btn]');
      await p.waitForSelector('[data-testid=account-menu] [data-testid=account-theme]');
      await p.click('[data-testid=account-menu] [data-testid=theme-system]');
      ok(await visible(p, '[data-testid=account-menu]'), `theme ${w}: picking a theme leaves the account menu open`);
      await p.keyboard.press('Escape');
    }
    await p.emulateMedia({ colorScheme: 'dark' });
    await sleep(100);
    ok(await stored() === 'system' && await look() === 'dark', `theme ${w}: System on a dark device is dark ` + JSON.stringify([await stored(), await look()]));
    await p.emulateMedia({ colorScheme: 'light' });
    await sleep(100);
    ok(await look() === 'light', `theme ${w}: System follows the device turning light`);
    // and back to Dark
    await p.click('[data-testid=demo-theme] [data-testid=theme-switch] [data-testid=theme-dark]');
    ok(await look() === 'dark' && await stored() === 'dark', `theme ${w}: Dark switches the light theme off again ` + JSON.stringify([await look(), await stored()]));
    const g2 = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim());
    ok(g2 === '#10141f', `theme ${w}: the dark tokens are back (--ground) ` + g2);
    ok(errors.length === 0, `theme ${w}: no script errors ` + JSON.stringify(errors));
    await ctx.close();
  }
}

(async () => {
  await new Promise(r => server.listen(8766, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    await computer(browser);
    await phone(browser);
    await theme(browser);
    // The manager page is a Vite entry (stage 8c-2): built, its module in /assets, its files loaded as they are.
    const mgr = await (await fetch('http://127.0.0.1:8766/schedule-manager.html')).text();
    ok(/<script type="module" crossorigin src="\/assets\/manager-[^"]+\.js"><\/script>/.test(mgr) && !/\/src\//.test(mgr) && /href="og\.css"/.test(mgr) && /src="payroll\.js"/.test(mgr) && !/vite-ignore/.test(mgr),
      'next: the manager page is served built from dist/ (its module in /assets, og.css and payroll.js as they are)');
  } finally {
    await browser.close(); server.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
