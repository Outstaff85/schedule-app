// The /next component gallery of the new stack (docs/components.md) in
// Chromium, from the built dist/ (run `npm run build` at the repo root first),
// on a computer (1280px, mouse) and a phone (390px, touch): every component is
// drawn, Tailwind's classes carry the og.css tokens, and the app's templates
// hold — windows close on the backdrop with no ✕ and go back to the window they
// came from, a Drawer on a phone, tap reads / double click / long press edits /
// swipe left, Delete with Undo, Select mode, lists page by 10, the form checks
// its fields, the language sheet switches the page (layout stays left to right),
// the theme switch (Dark / Light / System) turns the light theme on and back off
// and the light theme's text, plates, bars and badges keep their contrast;
// the full-screen scanner (src/scan/ui/, docs/scan-plan.md → S9) on its fake
// session at a phone's size — the status line, the pages' strip, the bar and
// Done, a page opened large with its type chips, the corner editor, Delete with
// Undo, Looks good, the full Window.
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
  controls: ['button', 'input', 'select', 'dates', 'checkbox', 'toggle-group', 'form'],
  lists: ['plate', 'select-button', 'plate-sizes', 'empty'],
  windows: ['window', 'signature', 'sign-documents', 'sign-document', 'menu', 'account', 'theme', 'sheet'],
  feedback: ['alert', 'toast', 'progress'],
  data: ['table', 'data-table', 'chart', 'calendar', 'card'],
  layout: ['tabs', 'accordion', 'collapsible'],
  scanner: ['scanner'],
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
  // SignDocuments with one document (a client's contract): "the end of the document", never "both documents"
  await open(p, 'windows');
  const signOne = await p.evaluate(() => ({ one: document.querySelector('[data-testid=demo-sign-document]').innerText,
    two: document.querySelector('[data-testid=demo-sign-documents]').innerText }));
  ok(!/both documents/.test(signOne.one) && /both documents/.test(signOne.two) && (/end of the document/.test(signOne.one) || /Sign/.test(signOne.one)),
    'next: SignDocuments with one document speaks of the document, with two of both ' + JSON.stringify(signOne));
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
  await p.locator('[data-testid=plate-select] button').click(); await sleep(200);
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
  // The one calendar everywhere (docs/components.md → date-picker.tsx): its header is ‹ month ▾ year ▾ ›, the years
  // reach a birth in 1940 and an expiry in 2040; an optional date empties with its line; a typed date field gets
  // the same calendar behind its icon; a period is the same popover over the months, with its named periods.
  const dp = {};
  await p.click('#d-expiry'); await p.waitForSelector('[data-slot=date-calendar]');
  dp.range = await p.evaluate(() => { const y = [...document.querySelectorAll('[data-slot=date-calendar] select')].map(s => [...s.options].map(o => +o.value)).find(v => v.some(x => x > 1900)) || [];
    return y.includes(1940) && y.includes(2040); });
  dp.tail = await p.locator('[data-slot=popover-content] [data-slot=pop-tail]').count();
  dp.sunday = await p.evaluate(() => (document.querySelector('[data-slot=date-calendar] thead th, [data-slot=date-calendar] .rdp-weekday') || {}).textContent || '');
  // no date yet: the calendar opens at this month — the 5th of it
  await p.locator('[data-slot=date-calendar] [data-day]:not([data-outside]) button', { hasText: /^5$/ }).first().click(); await sleep(200);
  dp.picked = (await p.locator('#d-expiry').innerText()).trim();
  await p.click('#d-expiry'); await p.click('[data-testid=date-clear]'); await sleep(200);
  dp.cleared = (await p.locator('#d-expiry').innerText()).trim();
  await p.fill('#d-dob', '12/03/1984');
  await p.click('[data-testid=demo-dates] [data-slot=date-input-calendar]'); await p.waitForSelector('[data-slot=date-calendar]');
  dp.dobMonth = await p.evaluate(() => [...document.querySelectorAll('[data-slot=date-calendar] select')].map(s => s.value).join('/'));
  await p.locator('[data-slot=date-calendar] [data-day="1984-03-20"] button').click(); await sleep(200);
  dp.dob = await p.inputValue('#d-dob');
  await p.click('#d-period'); await p.waitForSelector('[data-slot=month-grid]');
  dp.presets = await p.locator('[data-slot=month-presets] button').count();
  const prevYm = await p.evaluate(() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); });
  if (!(await p.locator(`[data-slot=month-grid] [data-month="${prevYm}"]`).count())) await p.click('[data-slot=month-grid] button[aria-label="Previous year"]');
  await p.click(`[data-slot=month-grid] [data-month="${prevYm}"]`); await sleep(200);
  dp.period = await p.locator('#d-period').getAttribute('data-value');
  ok(dp.range && dp.tail === 1 && /^su/i.test(dp.sunday.trim()) && dp.dobMonth.includes('1984') && /^\d\d\/\d\d\/\d{4}$/.test(dp.picked) && !/\d/.test(dp.cleared) && dp.dob === '20/03/1984' && dp.presets === 3 && dp.period === 'm:' + prevYm,
    'next: the one calendar — years from 1940 to 2040 in its header, the tail, an optional date picked and emptied, a typed date field picked in the same calendar (dd/mm/yyyy), a period picked over the months ' + JSON.stringify(dp));
  await p.locator('[data-testid=worker-form] button[type=submit]').click(); await sleep(300);
  const formErr = await p.locator('[data-testid=worker-form] [data-slot=form-message]').allInnerTexts();
  ok(formErr.includes('Enter a first name') && formErr.includes('Enter a phone like 050-1234567'), 'next: the form shows its field errors ' + JSON.stringify(formErr));
  await p.screenshot({ path: path.join(OUT, 'next-computer-form-errors.png'), fullPage: true });

  // language: the sheet lists the dictionaries' languages; Hebrew switches the page, layout stays LTR
  // The manager app's frame (V7, Shell `app`): the side menu (no breadcrumb), the greeting in the middle,
  // the panel only on Workers / Schedule, the figures as tiles, the sections as panels, plates in three columns.
  await open(p, 'frame');
  const fr = await p.evaluate(async () => {
    const box = q => document.querySelector(q).getBoundingClientRect(), r = {}, crumb = () => document.querySelector('[data-testid=shell-crumb]') ? 'crumb' : (document.querySelector('[data-testid=shell-menu] button[aria-current=page] > span:last-child') || {}).innerText?.trim();
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
  ok(fr.menu && fr.crumb === 'Today' && fr.greet && fr.noAside && fr.tiles && fr.panels && fr.aside && fr.crumbW === 'Workers' && fr.threeCols,
    'next: the app frame (V7) — side menu with the open section lit, no breadcrumb, greeting in the middle, the panel only on Workers, tiles, panels, plates in three columns ' + JSON.stringify(fr));
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
    return { menuRight: box('[data-testid=shell-menu]').right > innerWidth - 2, brandRight: box('[data-testid=app-brand]').left > innerWidth / 2, noCrumb: !document.querySelector('[data-testid=shell-crumb]'),
      pageLtr: getComputedStyle(document.querySelector('[data-testid=page-frame]')).direction === 'ltr' };
  });
  ok(frHe.menuRight && frHe.brandRight && frHe.noCrumb && frHe.pageLtr, 'next: in Hebrew the app frame is mirrored (menu and brand on the right, no breadcrumb), the page stays left to right ' + JSON.stringify(frHe));
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

  // The Select template on a phone (owner, 2026-10-27): the one Select button is the last thing at the right of
  // the line above its list; a tap turns selecting on and the same button reads "Select all"; a tap ticks every
  // item — all 14, not only the 10 drawn — and it reads "Select none"; the gallery shows both states.
  await open(p, 'lists');
  const rightOf = tid => p.evaluate(t => {
    const head = document.querySelector(`[data-testid=${t}]`), btn = head.querySelector('button'), row = head.parentElement;
    const b = btn.getBoundingClientRect(), r = row.getBoundingClientRect();
    return Math.abs(b.right - r.right) <= 1.5 && [...row.children].every(c => c === head || c.getBoundingClientRect().right <= b.left + 1);
  }, tid);
  const label = tid => p.locator(`[data-testid=${tid}] button`).innerText().then(s => s.trim());
  const st = { right: await rightOf('plate-select'), states: (await label('select-state-off')) + '|' + (await label('select-state-on')), drawn: await p.locator('[data-testid^=plate-w]').count() };
  await p.locator('[data-testid=plate-select] button').tap(); await sleep(250);
  st.on = await label('plate-select'); st.rightOn = await rightOf('plate-select');
  await p.locator('[data-testid=plate-select] button').tap(); await sleep(250);
  st.all = (await p.locator('[data-testid=select-bar] b').innerText()).trim(); st.none = await label('plate-select');
  await p.locator('[data-testid=plate-select] button').tap(); await sleep(250);
  st.cleared = (await p.locator('[data-testid=select-bar] b').innerText()).trim();
  await p.locator('[data-testid=select-bar] button[aria-label=Done]').tap(); await sleep(250);
  st.ended = !(await visible(p, '[data-testid=select-bar]')) && (await label('plate-select')) === 'Select';
  ok(st.right && st.rightOn && st.states === 'Select|Select all' && st.drawn === 10 && st.on === 'Select all' && st.all === '14 selected' && st.none === 'Select none' && st.cleared === '0 selected' && st.ended,
    'next (phone): the Select button sits at the right of its line; a tap → "Select all", which ticks all 14 (10 drawn) → "Select none"; ✕ ends; the gallery shows both states ' + JSON.stringify(st));

  await open(p, 'frame');
  const frp = await p.evaluate(() => {
    const box = q => document.querySelector(q).getBoundingClientRect(), g = box('[data-testid=shell-greeting]'), a = box('[data-testid=account-btn]'), hd = box('[data-slot=shell] > header');
    return { rows: !document.querySelector('[data-testid=shell-crumb]') && Math.abs(g.top - a.top) < 12 && hd.height < 70, noMenu: !document.querySelector('[data-testid=shell-menu]'), bar: !!document.querySelector('[data-testid=shell-bar]'),
      noWords: getComputedStyle(document.querySelector('[data-testid=shell-greet-text]')).display === 'none', sticky: getComputedStyle(document.querySelector('[data-slot=shell] > header')).position === 'sticky',
      tilesRow: (() => { const t = [...document.querySelectorAll('[data-slot=figures] > button')].map(b => Math.round(b.getBoundingClientRect().top)); return t.length === 4 && t.every(x => x === t[0]); })() };
  });
  ok(frp.rows && frp.noMenu && frp.bar && frp.noWords && frp.sticky && frp.tilesRow, 'next: the app frame on a phone — one header row (no breadcrumb), no greeting words, the bottom bar, four tiles in a row ' + JSON.stringify(frp));
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

// The full-screen scanner (src/scan/ui/, docs/scan-plan.md → S9) on the gallery's fake session, at a phone's size.
async function scanner(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await pdfRoute(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  // the status line and the hint under the frame as they change, from the first draw (the fake's camera: finding →
  // a corner out → hold → found)
  await p.addInitScript(() => {
    window.__seen = []; window.__tips = [];
    const look = () => {
      const el = document.querySelector('[data-testid=scanner-camera] [data-testid=scan-status]'); const t = el && el.textContent; if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t);
      const tip = document.querySelector('[data-testid=scanner-camera] [data-testid=scan-tip]'), h = tip && tip.dataset.hint ? tip.textContent : '';
      if (h && window.__tips[window.__tips.length - 1] !== h) window.__tips.push(h);
    };
    setInterval(look, 50);
  });
  await open(p, 'scanner');
  const cam = '[data-testid=scanner-camera] [data-testid=scanner]';
  const calls = () => p.locator('[data-testid=scanner-calls]').innerText();
  const thumbs = () => p.locator(cam + ' [data-testid=scan-thumb]').count();
  // a button low in the 844px frame may sit under the gallery's own bottom bar: clicked where it is
  const press = sel => p.locator(sel).first().dispatchEvent('click');
  await p.waitForSelector(cam + ' [data-testid=scan-thumb]');
  const shape = await p.evaluate(cam => {
    const root = document.querySelector(cam), q = s => root.querySelector(s), box = el => el.getBoundingClientRect();
    const r = box(root), bar = box(q('[data-testid=scan-bar]')), st = box(q('[data-testid=scan-status]')), strip = box(q('[data-testid=scan-thumbs]')), done = box(q('[data-testid=scan-done]')), auto = box(q('[data-testid=scan-auto]'));
    const files = q('[data-testid=scan-files]');
    // the status: a short one centred, a long one taking the width beside Auto (it wraps)
    return { h: Math.round(r.height), statusTop: st.top - r.top < 90 && st.left >= r.left + 12 && st.right <= auto.left
        && (Math.abs((st.left + st.right) / 2 - (r.left + r.right) / 2) < 3 || st.width > r.width / 2), barBottom: r.bottom - bar.bottom < 30, stripAboveBar: strip.bottom <= bar.top + 1,
      autoTopRight: auto.top - r.top < 90 && r.right - auto.right < 30, doneInBar: !!q('[data-testid=scan-bar] [data-testid=scan-done]') && r.right - done.right < 30 && done.top >= bar.top,
      thumbs: root.querySelectorAll('[data-testid=scan-thumb]').length, files: !!files && files.type === 'file' && !files.hasAttribute('accept') && files.multiple,
      shutter: !!q('[data-testid=scan-shutter]'), auto: q('[data-testid=scan-auto]').getAttribute('aria-pressed'), done: q('[data-testid=scan-done]').textContent };
  }, cam);
  ok(shape.h >= 840 && shape.statusTop && shape.barBottom && shape.stripAboveBar && shape.autoTopRight && shape.doneInBar && shape.thumbs === 3 && shape.files && shape.shutter && shape.auto === 'true' && /Done · 3/.test(shape.done),
    'scanner: the camera screen (template 6) — the status line at the top centre, Auto at the top right, the photos\' strip above the bottom bar (Photos/PDF with no type filter, the shutter, Done at the bottom right) ' + JSON.stringify(shape));
  await sleep(2600);
  const seen = await p.evaluate(() => window.__seen);
  ok(seen.some(t => /corner is outside the frame/.test(t)) && seen.some(t => /Hold still · 0\.6 s/.test(t)) && /1 document found/.test(seen[seen.length - 1]),
    'scanner: the status line follows the session — a corner out, Hold still · 0.6 s, 1 document found ' + JSON.stringify(seen));
  const drawn = await p.evaluate(cam => { const c = document.querySelector(cam + ' [data-testid=scan-overlay]'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }, cam);
  ok(drawn > 1000, 'scanner: the live frame is drawn over the camera ' + drawn);
  const tips = await p.evaluate(() => window.__tips);
  ok(tips.includes('Move the phone back a little'), 'scanner: the hint under the frame tells the person what to do (a corner out: move back) ' + JSON.stringify(tips));
  const kinds = await p.evaluate(cam => [...document.querySelectorAll(cam + ' [data-testid=scan-thumb]')].map(e => e.dataset.kind).join(), cam);
  const pcts = await p.locator(cam + ' [data-testid=scan-thumb-pct]').allInnerTexts();
  ok(kinds === 'id_front,id_back,passport' && pcts.join() === '97%,88%,81%', 'scanner: each photo in the strip has its type, and the model\'s % under it (the third once read) ' + JSON.stringify({ kinds, pcts }));
  await p.screenshot({ path: path.join(OUT, 'scanner-camera.png') });

  // the shutter takes a page (read a moment later); there is no Next: the live frame goes on by itself
  await p.locator(cam + ' [data-testid=scan-shutter]').tap(); await sleep(150);
  const shot = { n: await thumbs(), reading: await p.locator(cam + ' [data-testid=scan-thumb]').last().locator('[data-reading]').count(), status: await p.locator(cam + ' [data-testid=scan-status]').innerText() };
  ok(shot.n === 4 && shot.reading === 1 && /Captured in 180 ms/.test(shot.status) && /snap/.test(await calls()), 'scanner: the shutter takes a page, shown at once with a spinner while it is read ' + JSON.stringify(shot));
  // while the shot is still in work the shutter is off (a second cut would drop the shot's other documents)
  ok(await p.locator(cam + ' [data-testid=scan-shutter]').isDisabled(), 'scanner: the shutter is off while the shot is still in work');
  await p.waitForFunction(cam => !document.querySelector(cam + ' [data-testid=scan-shutter]').disabled, cam, { timeout: 3000 });
  await p.waitForFunction(cam => /Taken/.test(document.querySelector(cam + ' [data-testid=scan-status]').textContent), cam, { timeout: 3000 });
  const after = { label: await p.locator(cam + ' [data-testid=scan-shutter]').getAttribute('aria-label'), text: await p.locator(cam + ' [data-testid=scan-shutter]').innerText(),
    tip: await p.locator(cam + ' [data-testid=scan-tip]').innerText(), wake: /wake/.test(await calls()) };
  ok(after.label === 'Take the shot' && !after.text.trim() && /next document/.test(after.tip) && !after.wake,
    'scanner: no Next after a shot — the shutter stays the shutter, the status says taken and the hint asks for the next document ' + JSON.stringify(after));

  // a tap on a photo makes it grow in place: its type and % on top, Edit corners on its left, Delete on its right
  await p.locator(cam + ' [data-testid=scan-thumb]').first().tap(); await sleep(350);
  const grown = await p.evaluate(cam => {
    const t = document.querySelector(cam + ' [data-testid=scan-thumb][data-selected]');
    if (!t) return null;
    const pic = t.firstElementChild.getBoundingClientRect(), b = s => t.querySelector(s) && t.querySelector(s).getBoundingClientRect(), fix = b('[data-testid=scan-thumb-fix]'), del = b('[data-testid=scan-thumb-delete]');
    return { id: t.dataset.id, size: Math.round(pic.width) + 'x' + Math.round(pic.height), kind: t.querySelector('[data-testid=scan-thumb-kind]').textContent,
      fixLeft: !!fix && fix.right < (pic.left + pic.right) / 2, delRight: !!del && del.left > (pic.left + pic.right) / 2, n: document.querySelectorAll(cam + ' [data-testid=scan-thumb][data-selected]').length };
  }, cam);
  ok(!!grown && grown.id === 'p1' && grown.size === '190x124' && grown.kind === 'ID card 97%' && grown.fixLeft && grown.delRight && grown.n === 1, 'scanner: a tap makes a photo grow to 190×124 with its type and %, Edit corners and Delete ' + JSON.stringify(grown));
  await p.screenshot({ path: path.join(OUT, 'scanner-grown.png') });
  // a tap on it again shrinks it; a tap on another grows that one instead
  await p.locator(cam + ' [data-testid=scan-thumb]').first().tap(); await sleep(150);
  const shrunk = await p.locator(cam + ' [data-testid=scan-thumb][data-selected]').count();
  await p.locator(cam + ' [data-testid=scan-thumb]').nth(1).tap(); await sleep(150);
  await p.locator(cam + ' [data-testid=scan-thumb]').first().tap(); await sleep(150);
  const moved = await p.evaluate(cam => [...document.querySelectorAll(cam + ' [data-testid=scan-thumb][data-selected]')].map(e => e.dataset.id).join(), cam);
  ok(shrunk === 0 && moved === 'p1', 'scanner: a tap on the grown photo shrinks it, a tap on another grows that one ' + JSON.stringify({ shrunk, moved }));

  // its type and % open the page large: the type chips with the model's %, Fix corners, Delete, Looks good
  await press(cam + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-open]'); await sleep(200);
  const view = await p.evaluate(cam => {
    const v = document.querySelector(cam + ' [data-testid=page-view]');
    if (!v) return null;
    const on = v.querySelector('[data-testid=kind-chip][data-state=on]'), model = v.querySelector('[data-testid=kind-model]');
    return { chips: v.querySelectorAll('[data-testid=kind-chip]').length, on: on && on.dataset.kind, model: model && model.textContent,
      modelOn: !!v.querySelector('[data-testid=kind-chip][data-kind=id_front] [data-testid=kind-model]'), fix: !!v.querySelector('[data-testid=page-fix]'), del: !!v.querySelector('[data-testid=page-delete]'), keep: !!v.querySelector('[data-testid=page-keep]'), img: !!v.querySelector('img[data-testid=page-view-img]') };
  }, cam);
  ok(view && view.chips === 6 && view.on === 'id_front' && view.model === '97%' && view.modelOn && view.fix && view.del && view.keep && view.img, 'scanner: a photo\'s type opens the page large — six type chips, the model\'s answer marked 97%, Fix corners, Delete, Looks good ' + JSON.stringify(view));
  await p.screenshot({ path: path.join(OUT, 'scanner-page.png') });
  await press(cam + ' [data-testid=kind-chip][data-kind=sefach]'); await sleep(100);
  ok(await p.locator(cam + ' [data-testid=kind-chip][data-kind=sefach]').getAttribute('data-state') === 'on' && /Appendix/.test(await p.locator(cam + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-kind]').innerText()), 'scanner: a chip picks another type, and the photo in the strip says it');

  // Fix corners: the corner editor; a corner dragged, Apply gives the moved corners (5 decimals) to the session
  await press(cam + ' [data-testid=page-fix]'); await sleep(250);
  const ed = await p.evaluate(cam => { const c = document.querySelector(cam + ' [data-testid=corner-canvas]'); return c && { pts: JSON.parse(c.dataset.pts), fit: c.dataset.fit.split(',').map(Number) }; }, cam);
  ok(!!ed && ed.pts.length === 4, 'scanner: Fix corners opens the corner editor with the page\'s four corners ' + JSON.stringify(ed));
  await p.evaluate(({ cam, ed }) => {
    const c = document.querySelector(cam + ' [data-testid=corner-canvas]'), b = c.getBoundingClientRect(), [ox, oy, iw, ih] = ed.fit;
    const x0 = b.left + ox + ed.pts[0][0] * iw + 10, y0 = b.top + oy + ed.pts[0][1] * ih + 10;  // 10 px off the corner: within its 48 px
    const fire = (type, dx, dy) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x0 + dx, clientY: y0 + dy }));
    fire('pointerdown', 0, 0); fire('pointermove', 15, 20); fire('pointermove', 30, 40); fire('pointerup', 30, 40);
  }, { cam, ed });
  await p.screenshot({ path: path.join(OUT, 'scanner-corners.png') });
  await press(cam + ' [data-testid=corner-apply]'); await sleep(200);
  const fixed = ((await calls()).match(/fix p1 (\[\[.*?\]\])/) || [])[1];
  const pts = fixed ? JSON.parse(fixed) : null;
  ok(!!pts && pts[0][0] > ed.pts[0][0] + 0.01 && pts[0][1] > ed.pts[0][1] + 0.01 && JSON.stringify(pts.slice(1)) === JSON.stringify(ed.pts.slice(1)) && pts.flat().every(v => Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6)
    && !(await visible(p, cam + ' [data-testid=corner-editor]')) && await visible(p, cam + ' [data-testid=page-view]'),
    'scanner: a dragged corner moves, Apply gives the moved corners rounded to 5 decimals and goes back to the page ' + JSON.stringify({ before: ed.pts, after: pts }));

  // Looks good marks this page only, and goes back to the camera
  await press(cam + ' [data-testid=page-keep]'); await sleep(200);
  const looked = await p.locator(cam + ' [data-testid=scan-thumb][data-looked]').count();
  ok(looked === 1 && /keep p1/.test(await calls()) && !(await visible(p, cam + ' [data-testid=page-view]')), 'scanner: Looks good marks that one page and goes back to the camera ' + looked);

  // Edit corners on the grown photo: the corner editor straight from the strip; Cancel goes back to the camera
  await p.locator(cam + ' [data-testid=scan-thumb]').nth(2).tap(); await sleep(200);
  await press(cam + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-fix]'); await sleep(250);
  const stripFix = await visible(p, cam + ' [data-testid=corner-editor]') && !(await visible(p, cam + ' [data-testid=page-view]'));
  await press(cam + ' [data-testid=corner-cancel]'); await sleep(200);
  ok(stripFix && !(await visible(p, cam + ' [data-testid=corner-editor]')), 'scanner: Edit corners on a grown photo opens the corner editor straight from the strip');

  // Delete on the grown photo: no question, the page goes, the Undo snack; Undo brings it back; Done makes the delete
  await p.locator(cam + ' [data-testid=scan-thumb]').nth(1).tap(); await sleep(200);
  await press(cam + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-delete]'); await sleep(400);
  ok(await thumbs() === 3 && /Page deleted/.test(await p.locator('[data-testid=undo-snack]').innerText()) && !/remove/.test(await calls()), 'scanner: Delete on a grown photo never asks — the page goes and the Undo snack shows');
  await p.locator('[data-testid=undo-snack] button').tap(); await sleep(200);
  ok(await thumbs() === 4, 'scanner: Undo brings the page back');
  await p.locator(cam + ' [data-testid=scan-thumb]').nth(1).tap(); await sleep(200);
  await press(cam + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-delete]'); await sleep(300);
  await press(cam + ' [data-testid=scan-done]'); await sleep(300);
  ok(/remove p2 · done/.test(await calls()), 'scanner: Done makes a delete still offering Undo, then ends the scan ' + await calls());
  ok(!(await visible(p, '[data-testid=undo-snack]')) && await thumbs() === 0 && await p.locator(cam + ' [data-testid=scan-done]').isDisabled(),
    'scanner: Done ends the Undo snack and the screen starts empty (its pages let go)');

  // the still screens: a photo grown in the strip, a page opened large, the corner editor
  ok(await visible(p, '[data-testid=scanner-grow] [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-delete]') && await visible(p, '[data-testid=scanner-grow] [data-testid=scan-thumb-fix]'), 'scanner: the gallery\'s photo grown in the strip');
  await p.locator('[data-testid=scanner-grow]').screenshot({ path: path.join(OUT, 'scanner-screen-grow.png') });
  ok(await visible(p, '[data-testid=scanner-page] [data-testid=page-view]') && await p.locator('[data-testid=scanner-page] [data-testid=kind-chip]').count() === 6, 'scanner: the gallery\'s second screen is a page opened large');
  ok(await visible(p, '[data-testid=scanner-fix] [data-testid=corner-editor]'), 'scanner: the gallery\'s third screen is the corner editor');
  // a whole side moves (owner's template pair 6): the right side by its middle bar, the bottom side by its line
  // itself away from its handles — both corners of each side together, along the side's normal; the others stay
  const sides = await p.evaluate(() => {
    const c = document.querySelector('[data-testid=scanner-fix] [data-testid=corner-canvas]'), b = c.getBoundingClientRect();
    const [ox, oy, iw, ih] = c.dataset.fit.split(',').map(Number), q0 = JSON.parse(c.dataset.pts);
    const S = ([x, y]) => [b.left + ox + x * iw, b.top + oy + y * ih];
    const fire = (type, [x, y]) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    const drag = (from, dx, dy) => { fire('pointerdown', from); const grab = c.dataset.grab; fire('pointermove', [from[0] + dx / 2, from[1] + dy / 2]); fire('pointermove', [from[0] + dx, from[1] + dy]); fire('pointerup', [from[0] + dx, from[1] + dy]); return grab; };
    const mid = (a, b2, t) => [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t];
    const r = { q0 };
    r.bar = drag(S(mid(q0[1], q0[2], 0.5)), 25, 0);
    r.q1 = JSON.parse(c.dataset.pts);
    const p = S(mid(r.q1[2], r.q1[3], 0.25)); r.line = drag([p[0], p[1] + 12], 0, 30);  // > 48 px from corner 2 and the bar
    r.q2 = JSON.parse(c.dataset.pts);
    r.released = c.dataset.grab;
    r.px = ([a, b2], [c2, d]) => [Math.round((c2[0] - a[0]) * iw), Math.round((c2[1] - a[1]) * ih), Math.round((d[0] - b2[0]) * iw), Math.round((d[1] - b2[1]) * ih)];
    r.right = r.px([q0[1], q0[2]], [r.q1[1], r.q1[2]]); r.bottom = r.px([r.q1[2], r.q1[3]], [r.q2[2], r.q2[3]]);
    delete r.px;
    return r;
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const close = (a, b) => Math.abs(a - b) <= 1;
  ok(sides.bar === 'side1' && sides.line === 'side2' && sides.released === ''
    && close(sides.right[0], sides.right[2]) && close(sides.right[1], sides.right[3]) && sides.right[0] > 15
    && close(sides.bottom[0], sides.bottom[2]) && close(sides.bottom[1], sides.bottom[3]) && sides.bottom[1] > 20
    && same(sides.q1[0], sides.q0[0]) && same(sides.q1[3], sides.q0[3]) && same(sides.q2[0], sides.q0[0]) && same(sides.q2[1], sides.q1[1]),
    'scanner: a side moves whole — by its middle bar and by its line — both its corners together, the others stay ' + JSON.stringify(sides));
  await p.locator('[data-testid=scanner-page]').screenshot({ path: path.join(OUT, 'scanner-screen-page.png') });
  await p.locator('[data-testid=scanner-fix]').screenshot({ path: path.join(OUT, 'scanner-screen-fix.png') });

  // the full Window: the whole screen, closed by a swipe down from its top band or Escape
  await p.locator('[data-testid=open-scanner]').tap(); await sleep(500);
  const full = await p.evaluate(() => { const w = document.querySelector('[data-testid=window][data-kind=full]'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, scanner: !!w.querySelector('[data-testid=scanner] [data-testid=scan-status]') }; });
  ok(!!full && full.x === 0 && full.y === 0 && full.w === 390 && full.h === 844 && full.scanner, 'scanner: Window full fills the screen with the scanner ' + JSON.stringify(full));
  const locked = await p.evaluate(() => ({ attr: document.body.hasAttribute('data-scroll-locked'), overflow: getComputedStyle(document.body).overflow }));
  ok(locked.attr && locked.overflow === 'hidden', 'scanner: the page behind the full window does not scroll ' + JSON.stringify(locked));
  // the host's kept page (from before): first in the strip, counted in Done, opened with its type and Delete only
  const fw = '[data-testid=window][data-kind=full] [data-testid=scanner]';
  const keptShape = { first: await p.locator(fw + ' [data-testid=scan-thumb]').first().getAttribute('data-id'), n: await p.locator(fw + ' [data-testid=scan-thumb]').count(), done: await p.locator(fw + ' [data-testid=scan-done]').innerText() };
  await p.locator(fw + ' [data-testid=scan-thumb]').first().dispatchEvent('click'); await sleep(200);
  keptShape.stripFix = await p.locator(fw + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-fix]').count();
  await p.locator(fw + ' [data-testid=scan-thumb][data-selected] [data-testid=scan-thumb-open]').dispatchEvent('click'); await sleep(200);
  Object.assign(keptShape, { kept: await p.locator(fw + ' [data-testid=page-view]').getAttribute('data-kept'), fix: await p.locator(fw + ' [data-testid=page-fix]').count(), keep: await p.locator(fw + ' [data-testid=page-keep]').count(), del: await p.locator(fw + ' [data-testid=page-delete]').count() });
  ok(keptShape.first === 'kept1' && keptShape.n === 3 && /Done · 3/.test(keptShape.done) && keptShape.stripFix === 0 && keptShape.kept === 'true' && keptShape.fix === 0 && keptShape.keep === 0 && keptShape.del === 1,
    'scanner: the pages the host kept show first, count in Done and can be deleted (not fixed) ' + JSON.stringify(keptShape));
  await p.keyboard.press('Escape'); await sleep(200);
  await p.screenshot({ path: path.join(OUT, 'scanner-full.png') });
  await p.evaluate(() => {
    const band = document.querySelector('[data-testid=window-band]'), r = band.getBoundingClientRect();
    const fire = (type, y) => band.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2, clientY: y }));
    fire('pointerdown', r.top + 8); fire('pointermove', r.top + 60); fire('pointermove', r.top + 160); fire('pointerup', r.top + 160);
  });
  await sleep(400);
  ok(!(await visible(p, '[data-testid=window][data-kind=full]')), 'scanner: a swipe down from the top band closes the full window');
  await p.locator('[data-testid=open-scanner]').tap(); await sleep(500);
  await p.keyboard.press('Escape'); await sleep(400);
  ok(!(await visible(p, '[data-testid=window][data-kind=full]')), 'scanner: Escape closes the full window');
  ok(errors.length === 0, 'scanner: no script errors ' + JSON.stringify(errors));
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
    await scanner(browser);
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
