const { chromium } = require('playwright');
const fs = require('fs');
// Screenshots go to E2E_OUT (default: tests/e2e/out, git-ignored).
const SP = process.env.E2E_OUT || (__dirname + '/out');
fs.mkdirSync(SP, {recursive: true});
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
const BUNDLE = fs.readFileSync(__dirname + '/build/firebase-all.js', 'utf8');
const BASE = 'http://127.0.0.1:8765/';
let fails = 0;
// A failed check is also printed as a GitHub annotation (::error::), so CI shows it without the log.
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c){ fails++; if (process.env.GITHUB_ACTIONS) console.log('::error::' + String(m).replace(/\r?\n/g, ' ').slice(0, 900)); } };
// Payroll (stage 2): the page runs the one copy, payroll.js (src/lib/payroll.ts),
// through its wrappers — the page's own functions give what Payroll gives.
const payrollCheck = (p, page, fns) => p.evaluate(([fns]) => {
  if (typeof Payroll !== 'object') return {loaded: false};
  const w = {hourlyRate: 40}, d = new Date(2026, 9, 5, 8);
  const r = {loaded: true, wrapped: fns.every(f => typeof window[f] === 'function' && /Payroll\./.test(String(window[f])))};
  if (fns.includes('shiftPay')) r.pay = shiftPay(10, w, false, '') === Payroll.shiftPay(10, w, false, '', []) && shiftPay(10, w, false, '') === 420;
  r.ymd = localYMD(d) === '2026-10-05';
  return r;
}, [fns]).then(r => ok(r.loaded && r.wrapped && r.ymd && r.pay !== false, page + ': shift pairing and pay come from payroll.js ' + JSON.stringify(r)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = async path => (await fetch('http://127.0.0.1:5055' + path, {method:'POST', body:'{}'})).json();

(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {});
  const external = [];
  async function newCtx(opts={}){
    const ctx = await b.newContext(opts);
    // The page's clock starts at E2E_NOW (run.sh), the day server.py seeds from.
    if (process.env.E2E_NOW) await ctx.clock.install({time: new Date(process.env.E2E_NOW)});
    await ctx.route('**/*', async r => {
      const u = r.request().url();
      if (u.startsWith('http://127.0.0.1')) return r.continue();
      if (u === FB + 'firebase-app.js') return r.fulfill({status:200, contentType:'application/javascript', headers:{'Access-Control-Allow-Origin':'*'}, body:BUNDLE});
      if (u.startsWith(FB)) return r.fulfill({status:200, contentType:'application/javascript', headers:{'Access-Control-Allow-Origin':'*'}, body:`export * from '${FB}firebase-app.js';`});
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|hours|ai_read|weather)$/) || [])[1];
      if (fn) {
        if (r.request().method() === 'OPTIONS') return r.fulfill({status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST'}});
        const h = r.request().headers();
        const res = await fetch('http://127.0.0.1:5055/' + fn, {method:'POST', body:r.request().postData(), headers: h.authorization ? {Authorization: h.authorization} : {}});
        return r.fulfill({status:res.status, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body: await res.text()});
      }
      if (/xlsx\.full\.min\.js$/.test(u)) return r.fulfill({status:200, contentType:'application/javascript', body:require('fs').readFileSync(require.resolve('xlsx/dist/xlsx.full.min.js'))});
      if (/fonts\.g|cdnjs|tabler|jsdelivr|unpkg/.test(u)) return r.fulfill({status:200, body:''});
      external.push(u);
      return r.fulfill({status:200, body:''});
    });
    await ctx.addInitScript(() => {
      localStorage.setItem('fsEmulator', '127.0.0.1');
      window.FIREBASE_WEB_CONFIG = {apiKey:'fake-key', projectId:'demo-schedule', authDomain:'demo-schedule.firebaseapp.com', storageBucket:'demo-schedule.appspot.com'};
      // A real-looking geolocation reply: not instant (the page flags < 800 ms).
      const pos = {coords:{latitude:32.0, longitude:34.8, accuracy:10, speed:null, altitude:null}, timestamp:Date.now()};
      Object.defineProperty(navigator, 'geolocation', {value:{getCurrentPosition:(ok)=>setTimeout(()=>ok(Object.assign({}, pos, {timestamp:Date.now()})), 900)}});
    });
    return ctx;
  }
  const page = async ctx => { const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept()); return p; };
  const waitFor = async (p, fn, ms=10000) => { const end = Date.now()+ms; while (Date.now() < end) { try { if (await p.evaluate(fn)) return true; } catch (e) {} await sleep(150); } return false; };
  const login = async (p, url, u, pw) => {
    await p.goto(url);
    await p.waitForSelector('#loginScreen', {state:'visible'});
    await p.fill('#loginUsername', u); await p.fill('#loginPassword', pw);
    await p.click(await p.$('#loginBtn') ? '#loginBtn' : 'button[onclick="submitLogin()"]');
  };

  let ctx, p;
  // ── A supplier signing in on the main site is taken to its portal ──
  // The supplier portal is a React page (src/supplier/, stage 4): the checks read its DOM and the supplier function's replies.
  const supReady = () => !!document.querySelector('[data-testid="supplier-portal"][data-ready="1"]');
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'sup1', 'sup-pass-11');
  ok(await waitFor(p, () => /supplier-portal\.html/.test(location.href) && !!document.querySelector('[data-testid="supplier-portal"][data-ready="1"]'), 15000), 'supplier: a login on the main site lands in the supplier portal, signed in');
  ok(await p.evaluate(() => !localStorage.getItem('schedMgr_session')), 'supplier: no manager-app session is left behind');
  await ctx.close();

  // ── Supplier portal ──
  ctx = await newCtx(); p = await page(ctx);
  const supReplies = [];
  // The supplier function's replies; `supTweak` (when set) rewrites a loadSchedule reply on its way to the page.
  let supTweak = null;
  await p.route(/cloudfunctions\.net\/supplier$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fallback();
    const h = r.request().headers(), body = r.request().postData() || '{}';
    const res = await fetch('http://127.0.0.1:5055/supplier', {method:'POST', body, headers: h.authorization ? {Authorization: h.authorization} : {}});
    let text = await res.text();
    supReplies.push({action: JSON.parse(body).action, text});
    if (supTweak && JSON.parse(body).action === 'loadSchedule') { const j = JSON.parse(text); supTweak(j); text = JSON.stringify(j); }
    return r.fulfill({status: res.status, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, body: text});
  });
  await login(p, BASE + 'supplier-portal.html', 'sup1', 'sup-pass-11');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, supReady, 15000), 'supplier: the portal loads');
  const tabTo = async label => { await p.click(`[data-testid="shell-tabs"] button:has-text("${label}")`); await sleep(250); };
  const sched = () => JSON.parse((supReplies.filter(x => x.action === 'loadSchedule').pop() || {text: '{}'}).text);
  const s0 = sched();
  ok((s0.workers || []).length === 1 && s0.workers[0].name === 'Avi Cohen' && !('token' in s0.workers[0]) && !('docUrl' in s0.workers[0]) && s0.workers[0].hourlyRate === 50 && s0.showPay === true
    && !JSON.stringify(s0.clients).includes('billRate') && !supReplies.some(x => /tok-|billRate|gpsAccuracy|"lat"/.test(x.text)), 'supplier: own worker only; no token or file link; sees pay by default (own rate), never client billing or GPS');
  const s_sp0 = await p.evaluate(() => ({old: typeof Payroll !== 'undefined' || typeof myWorkers !== 'undefined' || typeof hoursReviewMount !== 'undefined', mark: !!document.querySelector('header [data-testid="brand-mark"]'),
    tabs: [...document.querySelectorAll('[data-testid="shell-tabs"] button')].map(b => b.innerText.trim()).join()}));
  ok(!s_sp0.old && s_sp0.mark && s_sp0.tabs === 'Dashboard,My Workers,My Hours,Approvals', 'supplier portal: a React page (no old globals), the brand in the title bar, its tabs (Approvals with an hours tick) ' + JSON.stringify(s_sp0));
  // Dashboard: figures (on site, my workers, punches today) and today's punches.
  const db = await p.evaluate(() => ({figs: document.querySelectorAll('[data-testid="dashboard"] [data-slot="figures"] > button').length, text: document.querySelector('[data-testid="dashboard"]').innerText}));
  ok(db.figs === 3 && /My workers/i.test(db.text) && /Today's log/i.test(db.text), 'supplier dashboard: three figures and today\'s log ' + JSON.stringify(db));
  // My Hours → Pay (a Data Table on a computer): Avi 8h × own rate 50 = ₪400, commission 8 × 5 = ₪40.
  await tabTo('My Hours');
  const payRow = () => p.evaluate(() => { const t = document.querySelector('[data-testid="pay-table"]'); return t ? t.innerText.replace(/\s+/g, ' ') : ''; });
  const pt = await payRow();
  ok(/Avi Cohen 8\.0 1 ₪50\/h ₪400 ₪40/.test(pt) && /Total 8\.0 1 ₪400 ₪40/.test(pt) && await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] [data-slot="data-table"][data-kind="table"]')),
    'supplier pay: a Data Table — 8h × own rate 50 = ₪400, commission 8 × 5 = ₪40, with totals ' + JSON.stringify(pt));
  await p.click('[data-testid="pay-table"] th button:has-text("Pay")');
  ok(await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] th[aria-sort]')), 'supplier pay: a tap on a column head sorts by it');
  // A daily-paid worker with a ₪/day commission (the reply rewritten): the commission is ₪/day × days.
  supTweak = j => { Object.assign(j.workers[0], {payMode: 'daily', supplierDayRate: 90}); };
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('My Hours');
  const ptd = await payRow();
  supTweak = null;
  ok(/Avi Cohen 8\.0 1 ₪50\/day ₪50 ₪90/.test(ptd), 'supplier pay: a daily worker — pay by the day, commission ₪/day × days ' + JSON.stringify(ptd));
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('My Hours');
  // A timesheet file fills the picked worker's shifts; other workers' rows are left out.
  const XLSXn = require('xlsx');
  const s_wb = XLSXn.utils.book_new();
  XLSXn.utils.book_append_sheet(s_wb, XLSXn.utils.aoa_to_sheet([['Worker', 'Date', 'In', 'Out'], ['Avi Cohen', '01/10/2026', '08:00', '16:30'], ['Someone Else', '01/10/2026', '09:00', '17:00'], ['avi cohen', '2026-10-02', '7:30', '15:00']]), 'T');
  const lazy = await p.evaluate(() => typeof XLSX === 'undefined');
  await p.setInputFiles('[data-testid="timesheet-file"]', {name: 'sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSXn.write(s_wb, {type: 'buffer', bookType: 'xlsx'})});
  await waitFor(p, () => document.querySelectorAll('[data-send-row]').length >= 2, 10000);
  const sendRows = () => p.evaluate(() => [...document.querySelectorAll('[data-send-row]')].map(r => [r.querySelector('[data-slot="date-picker"]').innerText.trim(), ...[...r.querySelectorAll('input[type=time]')].map(i => i.value)].join(' ')));
  const ts = await sendRows();
  ok(lazy && ts.length === 2 && ts[0] === '01/10/2026 08:00 16:30' && ts[1] === '02/10/2026 07:30 15:00', 'supplier: an Excel timesheet (SheetJS loaded on demand) fills the picked worker\'s shifts, other workers\' rows are left out ' + JSON.stringify(ts));
  while (await p.$('[data-send-row] button[aria-label="Remove"]')) await p.click('[data-send-row] button[aria-label="Remove"]');
  // A row without times is outlined and explained, nothing is sent; with times it is sent and listed as pending.
  await p.click('[data-testid="send-hours"] button:has-text("Add shift")');
  const nSubmit = () => supReplies.filter(x => x.action === 'supplierSubmitHours').length;
  await p.click('[data-testid="send-hours-btn"]'); await sleep(300);
  const bad = {outlined: await p.evaluate(() => !!document.querySelector('[data-send-row][data-bad="1"]')), sent: nSubmit()};
  await p.fill('[data-send-row] input[aria-label="In"]', '09:00'); await p.fill('[data-send-row] input[aria-label="Out"]', '13:00');
  await p.click('[data-testid="send-hours-btn"]');
  const today = await p.evaluate(() => new Date().toLocaleDateString('en-GB'));
  await waitFor(p, () => /Sent for review/i.test(document.querySelector('[data-testid="sent-hours"]').innerText), 10000);
  const s_sh = await p.evaluate(() => document.querySelector('[data-testid="sent-hours"]').innerText);
  ok(bad.outlined && bad.sent === 0 && s_sh.includes('Avi Cohen · 1 shift(s): ' + today) && /Sent for review/i.test(s_sh) && !(await p.$('[data-send-row]')), 'supplier: a row without times is outlined, nothing sent; hours sent for approval are listed as pending ' + JSON.stringify({bad, s_sh}));
  // The date of a row is picked with the Date Picker (a calendar in a popover).
  await p.click('[data-testid="send-hours"] button:has-text("Add shift")');
  await p.click('[data-send-row] [data-slot="date-picker"]');
  ok(await p.waitForSelector('[data-slot="calendar"], .rdp-root', {timeout: 5000}).then(() => true).catch(() => false), 'supplier: a shift\'s date is picked in the Date Picker');
  await p.keyboard.press('Escape'); await p.click('[data-send-row] button[aria-label="Remove"]');
  // My Workers: the edit form (React Hook Form + Zod) — the given name is required; a save goes through the supplier function.
  await tabTo('My Workers');
  const plateOf = id => `[data-worker-id="${id}"]`;
  await p.click(plateOf('w1') + ' .og-plate b');
  await p.waitForSelector('[data-testid="worker-form"]');
  const s_ed = await p.evaluate(() => ({secs: [...document.querySelectorAll('[data-testid="worker-form"] [data-slot="accordion-trigger"]')].map(t => t.innerText.split('\n')[0].trim()).join(), kind: document.querySelector('[data-testid="window"]').dataset.kind}));
  await p.fill('[data-field="docGiven"]', ''); await p.click('[data-testid="worker-save"]'); await sleep(200);
  const req = await p.evaluate(() => (document.querySelector('[data-testid="worker-form"] [data-slot="form-message"]') || {}).innerText || '');
  await p.fill('[data-field="docGiven"]', 'Avi'); await p.fill('[data-field="phone"]', '0509');
  await p.click('[data-testid="worker-save"]');
  ok(await waitFor(p, () => !document.querySelector('[data-testid="worker-form"]') && /0509/.test((document.querySelector('[data-worker-id="w1"]') || {}).innerText || ''), 10000)
    && s_ed.secs === 'Person,Address' && s_ed.kind === 'dialog' && req === 'Name required' && supReplies.some(x => x.action === 'supplierUpdateWorker' && /"ok": ?true/.test(x.text)),
    'supplier: the worker form — section plates, the given name required, saved through the supplier function ' + JSON.stringify({s_ed, req}));
  // Lists: ⋮ (Edit, Delete); Delete → the Undo snack → the real delete only after 5 s; Select two → Delete.
  const addWorker = async n => {
    await p.click('[data-testid="workers"] button.og-new'); await p.waitForSelector('[data-testid="worker-form"]');
    await p.fill('[data-field="docGiven"]', n); await p.fill('[data-field="docSurname"]', 'Temp'); await p.click('[data-testid="worker-save"]');
    await p.waitForFunction(n => !document.querySelector('[data-testid="worker-form"]') && [...document.querySelectorAll('[data-worker-id]')].some(e => e.innerText.includes(n + ' Temp')), n, {timeout: 10000}).catch(() => {});
  };
  for (const n of ['Tmpa', 'Tmpb', 'Tmpc']) await addWorker(n);
  const idOf = n => p.evaluate(n => { const e = [...document.querySelectorAll('[data-worker-id]')].find(e => e.innerText.includes(n + ' Temp')); return e ? e.dataset.workerId : ''; }, n);
  const [wt1, wt2, wt3] = [await idOf('Tmpa'), await idOf('Tmpb'), await idOf('Tmpc')];
  const nb = await p.evaluate(id => !!document.querySelector(`[data-worker-id="${id}"] [data-testid="new-badge"]`), wt1);
  await p.click(plateOf(wt1) + ' button[aria-label="Actions"]'); await p.waitForSelector('[role="menuitem"]');
  const spl = {menu: await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(m => m.innerText.trim()).join()), nb};
  await p.click('[role="menuitem"]:has-text("Delete")'); await sleep(400);
  console.log('DBG', await p.evaluate(() => [...document.querySelectorAll('[data-testid="window"]')].map(w => w.innerText.slice(0,200))));
  await p.screenshot({path: SP + '/dbg.png'});
  spl.gone = !(await p.$(plateOf(wt1))); spl.snack = await p.evaluate(() => (document.querySelector('[data-testid="undo-snack"]') || {}).innerText || '');
  await p.click('[data-testid="undo-snack"] .og-snack-u'); await sleep(400);
  spl.back = !!(await p.$(plateOf(wt1)));
  await sleep(5300);
  spl.noDelete = !supReplies.some(x => x.action === 'supplierDeleteWorker');
  ok(spl.menu === 'Edit,Delete' && spl.nb && spl.gone && /Tmpa Temp deleted/.test(spl.snack) && spl.back && spl.noDelete, 'supplier lists: a NEW badge; ⋮ Edit / Delete; Delete → Undo snack; Undo keeps the worker ' + JSON.stringify(spl));
  await p.click('[data-testid="workers"] button:has-text("Select")');
  await p.click(plateOf(wt2) + ' .og-plate b'); await p.click(plateOf(wt3) + ' .og-plate b');
  const s_sel = {count: await p.evaluate(() => document.querySelector('[data-testid="select-bar"] b').innerText.trim()), noEditor: !(await p.$('[data-testid="worker-form"]'))};
  await p.click('[data-testid="select-bar"] button:has-text("Delete")'); await sleep(300);
  s_sel.barGone = !(await p.$('[data-testid="select-bar"]')); s_sel.snack = await p.evaluate(() => (document.querySelector('[data-testid="undo-snack"]') || {}).innerText || '');
  s_sel.notYet = supReplies.filter(x => x.action === 'supplierDeleteWorker').length === 0;
  await sleep(5600);
  for (let i = 0; i < 40 && supReplies.filter(x => x.action === 'supplierDeleteWorker').length < 2; i++) await sleep(150);
  await p.reload(); await waitFor(p, supReady, 15000);
  s_sel.deleted = !(await p.$(plateOf(wt2))) && !(await p.$(plateOf(wt3))) && !!(await p.$(plateOf(wt1)));
  ok(s_sel.count === '2 selected' && s_sel.noEditor && s_sel.barGone && /2 workers deleted/.test(s_sel.snack) && s_sel.notYet && s_sel.deleted, 'supplier lists: Select two, Delete → Undo snack, deleted on the server only after 5 s ' + JSON.stringify(s_sel));
  await p.click(plateOf(wt1) + ' button[aria-label="Actions"]'); await p.click('[role="menuitem"]:has-text("Delete")');
  await sleep(5600); for (let i = 0; i < 40 && supReplies.filter(x => x.action === 'supplierDeleteWorker').length < 3; i++) await sleep(150);
  // Hours approval tab (hours ticks hours, approve, export): only its own workers; no dispute / fix; the month approved at once.
  await tabTo('Approvals');
  const hrvReadyS = () => !!document.querySelector('[data-testid="hours-review"][data-ready="1"]') && document.querySelectorAll('[data-day-key]').length >= 1;
  ok(await waitFor(p, hrvReadyS, 15000), 'supplier: the hours review loads');
  const sKey = await p.evaluate(() => [...document.querySelectorAll('[data-day-key]')].map(d => d.dataset.dayKey).find(k => k.startsWith('w1|')));
  await p.click(`[data-day-key="${sKey}"] button[aria-label="Actions"]`); await p.waitForSelector('[role="menuitem"]');
  const s_sr = {acts: await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(m => m.innerText.trim()).join()),
    names: await p.evaluate(() => [...document.querySelectorAll('[data-testid="hours-review"] [data-slot="section"] .og-label > span:first-child')].map(b => b.textContent).join())};
  await p.keyboard.press('Escape'); await sleep(150);
  await p.click('[data-testid="approve-month"]'); await p.click('[data-testid="approve-month-ok"]');
  await waitFor(p, () => /Every day approved/.test((document.querySelector('[data-testid="hours-status"]') || {}).innerText || ''), 10000);
  s_sr.status = await p.evaluate(() => document.querySelector('[data-testid="hours-status"]').innerText);
  ok(s_sr.names === 'Avi Cohen' && s_sr.acts === 'Approve this day' && /Every day approved/.test(s_sr.status), 'supplier: reviews only its own workers, no dispute / fix without those ticks, approves the month ' + JSON.stringify(s_sr));
  // The language: English by default; the header Language button switches the portal to Hebrew; a reload keeps it.
  await tabTo('My Hours');
  const nLoadsS = supReplies.filter(x => x.action === 'loadSchedule').length;
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("עברית")');
  const sl = {he: await waitFor(p, () => document.documentElement.lang === 'he' && localStorage.getItem('uiLang') === 'he', 10000)};
  sl.tab = await p.evaluate(() => [...document.querySelectorAll('[data-testid="shell-tabs"] button')].map(b => b.innerText.trim())[2]);
  sl.stayed = await p.evaluate(() => document.querySelector('[data-testid="supplier-portal"]').dataset.tab); sl.loads = supReplies.filter(x => x.action === 'loadSchedule').length - nLoadsS;
  ok(sl.he && sl.tab === 'השעות שלי' && sl.stayed === 'hours' && sl.loads === 0, 'supplier: the header Language button switches the portal to Hebrew in place — the tab and the data stay ' + JSON.stringify(sl));
  await p.reload();
  ok(await waitFor(p, () => document.documentElement.lang === 'he' && [...document.querySelectorAll('[data-testid="shell-tabs"] button')].map(b => b.innerText.trim())[0] === 'לוח בקרה', 15000), 'supplier: a reopened portal keeps the chosen language');
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("English")');
  await waitFor(p, () => document.documentElement.lang === 'en', 10000);
  // A phone: the bottom bar; the pay table becomes plates; the worker window opens from the bottom.
  await p.setViewportSize({width: 390, height: 844}); await sleep(300);
  await p.click('nav button:has-text("My Hours")').catch(() => {}); await sleep(300);
  const s_ph = {cards: await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] [data-slot="data-table"][data-kind="cards"]')),
    plate: await p.evaluate(() => ((document.querySelector('[data-pay-row="w1"]') || {}).innerText || '').replace(/\s+/g, ' '))};
  await p.click('nav button:has-text("My Workers")').catch(() => {}); await sleep(300);
  await p.click(plateOf('w1') + ' .og-plate b'); await p.waitForSelector('[data-testid="worker-form"]');
  s_ph.sheet = await p.evaluate(() => document.querySelector('[data-testid="window"]').dataset.kind);
  await p.screenshot({path: SP + '/supplier-portal-phone.png'}).catch(()=>{});
  await p.keyboard.press('Escape'); await sleep(300);
  await p.setViewportSize({width: 1280, height: 720});
  ok(s_ph.cards && /Avi Cohen 8\.0h · 1 day · ₪50\/h · Pay ₪400 ₪40/.test(s_ph.plate) && s_ph.sheet === 'sheet', 'supplier portal: on a phone the pay table is plates and a window opens from the bottom ' + JSON.stringify(s_ph));
  // The account menu: the name, "Supplier", Sign out.
  await p.click('[data-testid="account-btn"]'); await p.waitForSelector('[data-testid="account-menu"]');
  const am = await p.evaluate(() => document.querySelector('[data-testid="account-menu"]').innerText);
  ok(/sup1/.test(am) && /Supplier/.test(am) && /Sign out/.test(am), 'supplier portal: the account menu holds the name and Sign out ' + JSON.stringify(am));
  await p.click('[role="menuitem"]:has-text("Sign out")');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && !localStorage.getItem('supplierPortal_session'), 15000), 'supplier portal: Sign out opens the one login page');
  ok(p.errs.length === 0, 
  'errs ' + p.errs.join('|')); await ctx.close(); await b.close(); process.exit(0);
})();
