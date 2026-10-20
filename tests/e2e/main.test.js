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
      // the scanner's ONNX Runtime is fetched at deploy, not in the tests' build: a stand-in whose
      // models never start, so the lab page's own script runs (its file reading is tested)
      if (/\/scan\/ort(130)?\/ort\.all\.min\.js$/.test(u)) return r.fulfill({status:200, contentType:'application/javascript',
        body:"window.ort={env:{wasm:{},webgpu:{}},Tensor:function(){},InferenceSession:{create:async()=>{throw new Error('no models in the tests')}}};"});
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
      if (/cdnjs\.cloudflare\.com\/.*\/pdf(\.worker)?\.min\.js$/.test(u)) return r.fulfill({status:200, contentType:'application/javascript', body:require('fs').readFileSync(require.resolve('pdfjs-dist/build/' + u.split('/').pop()))});
      if (/xlsx\.full\.min\.js$/.test(u)) return r.fulfill({status:200, contentType:'application/javascript', body:require('fs').readFileSync(require.resolve('xlsx/dist/xlsx.full.min.js'))});
      if (/fonts\.g|cdnjs|tabler|jsdelivr|unpkg/.test(u)) return r.fulfill({status:200, body:''});
      external.push(u);
      return r.fulfill({status:200, body:''});
    });
    await ctx.addInitScript(() => {
      // The worker windows are React (stage 6c-2): a field is filled as a person types (the input event),
      // a select shows its value in data-value, a scan field its mark in data-scan.
      window.T = {
        tick: (ms = 0) => new Promise(r => setTimeout(r, ms)),
        async until(fn, ms = 8000){ const end = Date.now() + ms; while (Date.now() < end){ if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return !!fn(); },
        el: sel => typeof sel === 'string' ? (document.getElementById(sel) || document.querySelector(sel)) : sel,
        // a tap on a React Plate (its pointer handlers): touch down and up on the plate
        tap(sel){ const el = (T.el(sel) || {}).classList && T.el(sel).classList.contains('og-plate') ? T.el(sel) : T.el(sel) && T.el(sel).querySelector('.og-plate'); if(!el) return false;
          for (const t of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(t, {bubbles: true, pointerType: 'touch', isPrimary: true})); return true; },
        esc: () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})),
        fill(sel, v){ const el = T.el(sel); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); },
        val: id => { const el = document.getElementById(id); return el ? (el.dataset.value != null ? el.dataset.value : el.value) : undefined; },
        scan: id => ((document.getElementById(id) || {}).dataset || {}).scan || '',
        hint: key => document.querySelector('[data-testid="scan-hint"][data-for="' + key + '"]'),
        removeClient: id => document.querySelector('[data-testid="editor-clients"] [data-client="' + id + '"] button').click(),
        async addClient(id){
          document.getElementById('wClientSearch').click();
          await T.until(() => document.querySelector('[cmdk-item]'), 3000);
          const name = clients.find(c => c.id === id).name;
          [...document.querySelectorAll('[cmdk-item]')].find(x => x.textContent.includes(name)).click();
          await T.tick(50);
        },
      };
      localStorage.setItem('fsEmulator', '127.0.0.1');
      window.FIREBASE_WEB_CONFIG = {apiKey:'fake-key', projectId:'demo-schedule', authDomain:'demo-schedule.firebaseapp.com', storageBucket:'demo-schedule.appspot.com'};
      // A real-looking geolocation reply: not instant (the page flags < 800 ms).
      const pos = {coords:{latitude:32.0, longitude:34.8, accuracy:10, speed:null, altitude:null}, timestamp:Date.now()};
      Object.defineProperty(navigator, 'geolocation', {value:{getCurrentPosition:(ok)=>setTimeout(()=>ok(Object.assign({}, pos, {timestamp:Date.now()})), 900)}});
      // The location permission: given (a worker who allowed GPS before); localStorage gpsPerm changes it.
      const pq = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);
      if (pq) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({state: localStorage.getItem('gpsPerm') || 'granted', onchange: null}) : pq(d);
    });
    return ctx;
  }
  // the scan window's frame (/scan/, the lab's page) runs without its engine here: CI fetches no models
  const page = async ctx => { const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => { if (!/\/scan\//.test(e.stack || '')) p.errs.push(e.message); }); p.on('dialog', d => d.accept()); return p; };
  const waitFor = async (p, fn, ms=10000) => { const end = Date.now()+ms; while (Date.now() < end) { try { if (await p.evaluate(fn)) return true; } catch (e) {} await sleep(150); } return false; };
  const login = async (p, url, u, pw) => {
    await p.goto(url);
    await p.waitForSelector('#loginScreen', {state:'visible'});
    await p.fill('#loginUsername', u); await p.fill('#loginPassword', pw);
    await p.click(await p.$('#loginBtn') ? '#loginBtn' : 'button[onclick="submitLogin()"]');
  };

  // ── Manager app, firm owner ──
  let ctx = await newCtx(); let p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => typeof workers !== 'undefined' && workers.length === 2), 'owner: workers load from Firestore');
  const idle = await p.evaluate(() => { switchTab('admin'); return {none: !!document.querySelector('#adminRoot [data-testid="admin-tiles"]') || !window.ManagerIsland, rows: document.querySelectorAll('#adminRoot [data-testid="punch-row"]').length, pane: __adminPane}; });
  ok(idle.none && idle.rows === 0 && idle.pane === null, 'admin opens with no section: punch log not drawn until tapped ' + JSON.stringify(idle));
  ok(await p.evaluate(() => typeof BACKEND === 'undefined' && typeof API_SECRET === 'undefined' && API_URL === 'api://app'), 'no BACKEND switch, no API_SECRET');
  ok(await waitFor(p, () => getPunchLog().length >= 2), 'owner: punches load (live window)');
  // save round-trip
  ok(await p.evaluate(async () => { clients[1].name = 'Site B2'; const ok = await gsSave(getDataObj()); const d = await (await loadFirestoreBackend()).loadSchedule(fsTenantId(), false); return ok && d.clients.find(c=>c.id==='c2').name === 'Site B2'; }), 'owner: save reaches Firestore');
  // Finance lives in Accounting → Worker pay: the worker modal has no rate; the pay modal sets it all.
  const rt = await p.evaluate(async () => {
    const out = {};
    const c1 = clients.find(c => c.id === 'c1'); c1.defaultHourlyRate = 60;
    const wi = workers.findIndex(w => w.id === 'w2'); window.__keepW2 = JSON.parse(JSON.stringify(workers[wi]));
    openEditWorker(wi);
    out.noRateInModal = !document.getElementById('wRate') && !document.getElementById('wBank') && !document.getElementById('wTravelAllowance');
    closeModal('workerOverlay');
    switchTab('accounting');
    out.listed = !!document.querySelector('#accountingRoot [data-testid="acc-salary"]') && !document.getElementById('workerPayWrap');  // one Salary section, no Worker pay
    openPayModal('w2'); await T.tick(50);
    out.open = document.getElementById('payOverlay').classList.contains('open') && !!document.querySelector('#payModal [data-testid="pay-window"]');
    return out;
  });
  // The pay window is React (stage 6e): its Paid select through the page, the fields as a person types.
  await p.click('#payModal [data-testid="pay-mode"]'); await p.click('[role="option"]:has-text("By the day")'); await sleep(100);
  Object.assign(rt, await p.evaluate(async () => {
    const out = {};
    const wi = workers.findIndex(w => w.id === 'w2');
    out.otHidden = !document.querySelector('#payModal [data-testid="pay-ot-row"]') && !!document.getElementById('payDays');
    T.fill('payRate', '400'); T.fill('payTravelDay', '20'); T.fill('payTravelMonth', '150');
    T.fill('payBank', 'Leumi'); T.fill('payBankAccount', '123'); await T.tick(20);
    document.querySelector('#payModal [data-testid="pay-save"]').click(); await T.tick(50);
    out.closed = !document.getElementById('payOverlay').classList.contains('open');
    const w = workers[wi];
    out.saved = {mode: w.payMode, rate: w.hourlyRate, td: w.travelAllowance, tm: w.travelMonthly, bank: w.bank, acc: w.bankAccountNumber, reg: w.regRate};
    out.travel = travelPay(w, 3, 2);
    await ManagerBridge.setPeriod('all'); setAccTab('salary'); await T.tick(50);
    const row = [...document.querySelectorAll('#accountingRoot [data-testid="sal-table"] tbody tr')].find(r => r.textContent.includes(w.name));
    out.card = row ? row.textContent.replace(/\s+/g, ' ') : '';
    if (row) { row.querySelector('td:nth-child(2)').click(); await T.tick(150); }
    out.card += ' ' + ((document.querySelector('[data-testid="window"] [data-testid="sal-det"]') || {}).textContent || '');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(150);
    await ManagerBridge.setPeriod('week');
    return out;
  }));
  Object.assign(rt, await p.evaluate(async () => {
    const out = {};
    const wi = workers.findIndex(w => w.id === 'w2');
    const c1 = clients.find(c => c.id === 'c1');
    // An edit in the worker modal keeps the pay fields.
    openEditWorker(wi); await T.tick(); await saveWorker();
    out.keptAfterEdit = workers[wi].hourlyRate === 400 && workers[wi].travelMonthly === 150 && workers[wi].bank === 'Leumi';
    // Moved to a client with its own rate: an hourly worker's own rate gives way to the client's.
    delete workers[wi].payMode; workers[wi].hourlyRate = 70;
    const c2 = clients.find(c => c.id === 'c2'); c2.defaultHourlyRate = 55;
    openEditWorker(wi); await T.tick(); T.removeClient('c2'); await T.tick(); await saveWorker();
    openEditWorker(wi); await T.tick(); await T.addClient('c2'); await saveWorker();
    out.moved = workers[wi].hourlyRate; delete c2.defaultHourlyRate;
    delete c1.defaultHourlyRate; workers[wi] = window.__keepW2; await gsSave(getDataObj());
    switchTab('schedule');
    return out;
  }));
  ok(rt.noRateInModal && rt.listed && rt.open && rt.otHidden && rt.closed && rt.saved.reg === null, 'worker pay: no money fields in the worker modal; one Salary section; the pay modal opens', JSON.stringify(rt));
  ok(rt.saved.mode === 'daily' && rt.saved.rate === 400 && rt.saved.td === 20 && rt.saved.tm === 150 && rt.saved.bank === 'Leumi' && rt.saved.acc === '123' && rt.travel === 360 && /₪400\/day/.test(rt.card) && /Leumi/.test(rt.card), 'worker pay: the pay modal saves mode, rate, travel per day and per month, bank; the Salary row shows them', JSON.stringify(rt));
  // Salary: one compact line per worker; a tap opens its details. The header: one account menu.
  const sc = await p.evaluate(async () => {
    switchTab('accounting'); setAccTab('salary'); await ManagerBridge.setPeriod('all'); await T.tick(50);
    const row = document.querySelector('#accountingRoot [data-testid="sal-table"] tbody tr'); if(!row) return {};
    const det = () => !!document.querySelector('[data-testid="window"] [data-testid="sal-det"]');
    const r = {h: row.getBoundingClientRect().height, before: det()};
    row.querySelector('td:nth-child(2)').click(); await T.tick(300); r.after = det();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(300); r.closedDet = !det();
    await ManagerBridge.setPeriod('week');
    // The account menu is the React frame's (AccountMenu): it opens on a press of its button.
    const acct = document.querySelector('[data-testid=account-btn]');
    acct.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerType: 'mouse'})); await T.tick(200);
    const m = document.querySelector('[data-testid=account-menu]');
    r.menu = {open: !!m, lang: !!m && !m.querySelector('.lang-btn, select') && !!acct.previousElementSibling?.matches('[data-testid=lang-btn]'), out: !!m && /Sign out/.test(m.innerText), name: !!m && /My name/.test(m.innerText)};
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(200); r.closed = !document.querySelector('[data-testid=account-menu]');
    return r;
  });
  ok(sc.h > 0 && sc.h < 60 && !sc.before && sc.after && sc.closedDet, 'salary: one compact line per worker (the Data Table), a tap opens its details in a window ' + JSON.stringify(sc));
  ok(sc.menu && sc.menu.open && sc.menu.lang && sc.menu.out && sc.menu.name && sc.closed, 'header: one account menu with my name and sign out; the Language button beside it ' + JSON.stringify(sc.menu));
  // An inactive worker leaves the everyday lists and comes back when set Active; a contract warning shows a notice at the top.
  const ia = await p.evaluate(async () => {
    const w = workers.find(x => x.id === 'w2'), keep = JSON.parse(JSON.stringify(w)), r = {};
    const wait = ms => new Promise(res => setTimeout(res, ms));
    switchTab('workers');
    w.status = 'fired'; render(); await wait(50);
    const names = () => [...document.querySelectorAll('#workersRoot [data-testid="worker-name"]')].map(x => x.title).join(' ');
    const link = () => document.querySelector('#workersRoot [data-testid="workers-inactive"]');
    r.hidden = !/Dana Levi/.test(names()) && !!link() && /Inactive: 1/.test(link().innerText);
    link().click(); await wait(50); r.shown = /Dana Levi/.test(names()) && !link();
    w.status = 'active'; document.querySelector('#workersRoot [data-testid="workers-chips"] button[data-key="status"]').click(); render(); await wait(50); r.back = /Dana Levi/.test(names());
    const d = new Date(); d.setMonth(d.getMonth() - 2);
    Object.assign(w, {expiryEnabled: true, expiryMonths: 1, expiryWarnMonths: 1, startDate: localYMD(d)});
    try{ sessionStorage.removeItem('contractNoticeClosed'); }catch(e){}
    showContractNotice(); const n = document.getElementById('contractNotice');
    r.notice = n.style.display !== 'none' && /Contracts: 1 expired/.test(n.innerText);
    closeContractNotice(); r.closed = n.style.display === 'none';
    Object.keys(w).forEach(k => delete w[k]); Object.assign(w, keep); render();
    return r;
  });
  ok(ia.hidden && ia.shown && ia.back, 'workers: an inactive worker leaves the lists, "Inactive: N — show" brings them, Active returns them ' + JSON.stringify(ia));
  ok(ia.notice && ia.closed, 'contracts: an expired contract shows a notice at the top until closed ' + JSON.stringify(ia));
  // V7 (stage 6a): the frame on a computer — the sections in a side menu, the breadcrumb plate (section,
  // count, open sub-tab), the date / greeting / weather in the middle, no page titles, no side panel
  // (removed, owner 2026-10-18) on any tab, the page at most 1200px; Today drawn in React.
  const v7 = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const box = q => document.querySelector(q).getBoundingClientRect(), shown = q => { const el = document.querySelector(q); return !!el && getComputedStyle(el).display !== 'none'; };
    const crumb = () => document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim();
    switchTab('dashboard'); await wait(300);
    const nav = box('[data-testid=shell-menu]'), t = box('[data-testid=shell-menu] button:nth-child(1)'), s2 = box('[data-testid=shell-menu] button:nth-child(2)');
    r.menu = nav.left < 2 && Math.abs(nav.width - 210) < 2 && s2.top > t.top && Math.abs(s2.left - t.left) < 2;
    r.crumbToday = crumb();
    r.noTitle = [...document.querySelectorAll('.page-title')].every(e => getComputedStyle(e).display === 'none');
    r.center = /\d/.test(document.querySelector('[data-testid=shell-date]').innerText) && /^Good /.test(document.querySelector('[data-testid=shell-greet-text]').textContent);
    r.noSidebarToday = !document.querySelector('.sidebar, #workerList, #sidebarClientList');
    r.react = !!document.querySelector('#todayRoot [data-testid=today]') && document.querySelectorAll('#todayRoot [data-slot=figures] > button').length === 4 && document.querySelectorAll('#todayRoot section[data-panel]').length >= 1;
    r.width = getComputedStyle(document.getElementById('sectionDashboard')).maxWidth === '1200px';
    switchTab('workers'); await wait(200);
    r.sidebarWorkers = !document.querySelector('.sidebar'); r.crumbWorkers = crumb();
    switchTab('accounting'); setAccTab('salary'); await wait(200);
    r.crumbAcc = crumb(); r.noRepeat = !shown('#accountingRoot [data-testid=acc-figs]') && shown('#accountingRoot [data-testid=sal-sum]');
    setAccTab('billing'); document.body.click(); await wait(100);
    r.crumbBill = crumb(); r.figsBack = shown('#accountingRoot [data-testid=acc-figs]');
    setAccTab('salary'); switchTab('dashboard'); await wait(200);
    return r;
  });
  ok(v7.menu && v7.crumbToday === 'Today' && v7.noTitle && v7.center && v7.noSidebarToday && v7.react && v7.width && v7.sidebarWorkers && /^Workers \d+$/.test(v7.crumbWorkers)
    && v7.crumbAcc === 'Accounting Salary' && v7.noRepeat && v7.crumbBill === 'Accounting Billing' && v7.figsBack,
    'V7 frame: side menu, breadcrumb with count and sub-tab, date / greeting / weather in the middle, no page titles, no side panel, Accounting figures not repeated on Salary ' + JSON.stringify(v7));
  // Hebrew mirrors the frame only: the menu on the right, the account on the left, the page left to right.
  await p.evaluate(() => setLanguage('he', {save:false})); await waitFor(p, () => I18N_LANG === 'he' && document.documentElement.lang === 'he');
  await sleep(400);
  const v7he = await p.evaluate(() => {
    const box = q => document.querySelector(q).getBoundingClientRect();
    return {menuRight: box('[data-testid=shell-menu]').right > innerWidth - 2, acctLeft: box('[data-testid=account-btn]').left < box('[data-testid=app-brand]').left, crumbRight: box('[data-testid=shell-crumb]').left > innerWidth / 2,
      pageLtr: getComputedStyle(document.querySelector('#todayRoot')).direction === 'ltr', today: document.querySelector('#todayRoot [data-testid=today] p').textContent};
  });
  await p.evaluate(() => setLanguage('en', {save:false})); await waitFor(p, () => I18N_LANG === 'en');
  ok(v7he.menuRight && v7he.acctLeft && v7he.crumbRight && v7he.pageLtr && v7he.today === 'נוכחות בזמן אמת', 'V7 Hebrew: the side menu on the right, brand and breadcrumb right, the account left; Today\'s content stays left to right, in Hebrew ' + JSON.stringify(v7he));
  // Today, drawn in React (stage 6a): the figures as glass tiles, the sections as panels; a figure filters
  // to its section ("Show all" brings the rest back), the arrow folds a section (kept on this device).
  const tf = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    switchTab('dashboard'); await wait(300);
    const root = document.getElementById('todayRoot'), secs = () => [...root.querySelectorAll('section[data-sec]')].map(x => x.dataset.sec);
    const figs = [...root.querySelectorAll('[data-slot=figures] > button')];
    r.figs = figs.map(b => b.querySelector('span').textContent).join();
    r.tiles = figs.every(b => getComputedStyle(b).borderTopStyle === 'solid' && parseFloat(getComputedStyle(b.querySelector('b')).fontSize) >= 26);
    r.all = secs().join();
    const notices = figs[3]; r.noticeN = Number(notices.querySelector('b').textContent);
    notices.click(); await wait(150);
    r.only = secs().join() === 'notices' && /Show all/.test((root.querySelector('[data-testid=today-filter-note]') || {}).textContent || '');
    root.querySelector('[data-testid=today-filter-note] button').click(); await wait(150);
    r.back = secs().join() === r.all;
    const logHead = () => root.querySelector('section[data-sec=log] button[aria-expanded]');
    logHead().click(); await wait(700);
    // the body collapses to no height (under the test's fake clock Motion's fade-out never ends, so it may stay in the DOM)
    const body = logHead().closest('section').children[1];
    r.folded = logHead().getAttribute('aria-expanded') === 'false' && (!body || body.getBoundingClientRect().height < 1) && JSON.parse(localStorage.getItem('dashFolded') || '[]').includes('log');
    logHead().click(); await wait(450);
    r.open = logHead().getAttribute('aria-expanded') === 'true' && JSON.parse(localStorage.getItem('dashFolded') || '[]').indexOf('log') < 0;
    r.emptyFrame = getComputedStyle(root.querySelector('[data-testid=today-log-empty]')).borderTopStyle === 'dashed';
    // a notice chip opens the worker's notices sheet; a plate opens the worker card
    root.querySelector('section[data-sec=notices] [data-slot=badge]').click(); await wait(200);
    r.sheet = document.getElementById('noticesOverlay').classList.contains('open'); closeModal('noticesOverlay'); await wait(200);
    switchTab('accounting'); setAccTab('salary'); await new Promise(r => setTimeout(r, 300));
    const sr = () => document.querySelector('#accountingRoot [data-testid=sal-search]'), btn = () => document.querySelector('#accountingRoot [data-testid=sal-search-btn]');
    r.hidden = !sr(); btn().click(); await wait(50); r.shown = !!sr() && document.activeElement === sr(); btn().click(); await wait(50); r.closed = !sr();
    switchTab('dashboard');
    return r;
  });
  ok(tf.figs === 'On shift,Late,No punch,Notices' && tf.tiles && /notices/.test(tf.all) && /log/.test(tf.all) && tf.noticeN >= 1 && tf.only && tf.back && tf.folded && tf.open && tf.emptyFrame && tf.sheet && tf.hidden && tf.shown && tf.closed,
    'today (React): figures as glass tiles, a figure filters to its section and Show all brings the rest back, the arrow folds a section (kept), the empty log in a dashed frame, a chip opens the notices; salary search opens from its icon ' + JSON.stringify(tf));
  // Template 3 on a phone: Today (figures, colored lines), Workers, Accounting — screenshots for review.
  await p.setViewportSize({width: 390, height: 844});
  const t3 = await p.evaluate(async () => { switchTab('dashboard'); await new Promise(r => setTimeout(r, 300));
    const box = q => document.querySelector(q).getBoundingClientRect(), figs = [...document.querySelectorAll('#todayRoot [data-slot=figures] > button')];
    const cr = box('[data-testid=shell-crumb]'), c = box('[data-testid=shell-greeting]'), a = document.querySelector('[data-testid=account-btn]').parentElement.getBoundingClientRect(), tb = getComputedStyle(document.querySelector('[data-slot=shell] > header'));
    return {stats: figs.length, row: figs.every(f => Math.abs(f.getBoundingClientRect().top - figs[0].getBoundingClientRect().top) < 1), lines: document.querySelectorAll('#todayRoot .og-plate').length,
      twoRows: cr.top >= c.bottom - 1 && cr.top >= a.bottom - 1 && Math.abs(c.top - a.top) < 12, fixed: tb.position === 'sticky' && tb.top === '0px',
      greetHidden: getComputedStyle(document.querySelector('[data-testid=shell-greet-text]')).display === 'none' && !!document.querySelector('[data-testid=shell-greeting] svg.gic'),
      shortDate: getComputedStyle(document.querySelector('[data-testid=shell-date] > span:last-child')).display !== 'none' && getComputedStyle(document.querySelector('[data-testid=shell-date] > span:first-child')).display === 'none',
      noMenu: !document.querySelector('[data-testid=shell-menu]') && box('[data-testid=shell-bar]').bottom > innerHeight - 2}; });
  await p.screenshot({path: SP + '/t3-today.png'}).catch(()=>{});
  // A long list on a phone scrolls to its end above the bottom bar: the page keeps room for the bar under its last row.
  const endGap = await p.evaluate(async () => {
    const keep = workers.slice(); for (let i = 0; i < 12; i++) workers.push({...workers[0], id: 'tall' + i, name: 'Tall ' + i});
    switchTab('workers'); await new Promise(r => setTimeout(r, 600)); window.scrollTo(0, 1e6); await new Promise(r => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('#workersRoot .og-plate')], bar = document.querySelector('[data-testid=shell-bar]').getBoundingClientRect();
    const r = {rows: rows.length, lastBottom: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom), barTop: Math.round(bar.top)};
    workers.length = 0; workers.push(...keep); window.scrollTo(0, 0); switchTab('dashboard'); await new Promise(r => setTimeout(r, 300));
    return r;
  });
  ok(endGap.rows >= 10 && endGap.lastBottom <= endGap.barTop, 'phone: a long list scrolls to its last row above the bottom bar ' + JSON.stringify(endGap));
  // The phone bottom bar (variant 11): Today, Schedule, Workers, Accounting, More; More opens a sheet with the other tabs.
  const bb = await p.evaluate(async () => {
    const btns = () => [...document.querySelectorAll('[data-testid=shell-bar] > button')], more = () => btns()[btns().length - 1];
    const shown = btns().map(t => t.querySelector('.lb').textContent.trim());
    const bar = document.querySelector('[data-testid=shell-bar]').getBoundingClientRect(), fixed = Math.abs(bar.bottom - innerHeight) < 2 && Math.abs(bar.width - innerWidth) < 2;
    const todayColor = getComputedStyle(btns()[0]).color;
    more().click(); await new Promise(r => setTimeout(r, 400));
    const win = () => document.querySelector('[data-testid=window]');
    const sheet = !!win(), items = win() ? [...win().querySelectorAll('button span.flex-1')].map(b => b.textContent.trim()) : [];
    // the sheet lies over the bottom bar (the bar never covers its last item): at the bar's middle the sheet is on top
    // (the open sheet turns the page's pointer events off; turned back on for the look, the topmost element is hit)
    const pe = document.body.style.pointerEvents; document.body.style.pointerEvents = 'auto';
    const barHit = document.elementFromPoint(innerWidth / 2, innerHeight - 20); document.body.style.pointerEvents = pe;
    const onTop = !!win() && !!barHit && win().contains(barHit);
    if(win()) win().querySelectorAll('button span.flex-1')[0].closest('button').click(); await new Promise(r => setTimeout(r, 400));
    const r = {shown, fixed, todayColor, sheet, items, onTop, tab: currentTab, moreOn: more().getAttribute('aria-current') === 'page', closed: !win() || win().dataset.state === 'closed'};
    switchTab('dashboard'); await new Promise(r => setTimeout(r, 200)); r.moreOff = more().getAttribute('aria-current') !== 'page';
    return r;
  });
  ok(bb.shown.join() === 'Today,Schedule,Workers,Accounting,More' && bb.fixed && bb.todayColor === 'rgb(34, 211, 238)' && bb.sheet && bb.items.join() === 'Clients,Suppliers,Admin' && bb.onTop && bb.tab === 'clients' && bb.moreOn && bb.closed && bb.moreOff,
    'phone bottom bar: Today, Schedule, Workers, Accounting, More (the active one in its color); More opens Clients, Suppliers, Admin, all of them above the bar ' + JSON.stringify(bb));
  // Schedule (stage 6b: React, src/manager/Schedule.tsx): a plate per worker with its week; a tap opens its 7 days, a day opens the shift window.
  const W0 = await p.evaluate(async () => {
    const w0 = workers.find(w => isActiveWorker(w)); window.__keepSched = JSON.stringify(w0.schedule || []);
    w0.schedule = [{type:'off'}, {type:'work', start:'09:00', end:'17:00'}, {type:'work', start:'22:00', end:'06:00'}, {type:'off'}, {type:'off'}, {type:'off'}, {type:'off'}];
    filterByClient(null); switchTab('schedule'); render(); await new Promise(r => setTimeout(r, 200));
    return w0.id;
  });
  const schedPlate = `#scheduleRoot [data-testid="sched-worker"][data-id="${W0}"] > [data-slot="plate"] > [role="button"]`;
  const sch = await p.evaluate(sel => {
    const line = document.querySelector(sel), q = s => document.querySelectorAll('#scheduleRoot ' + s);
    return {sum: line ? line.querySelector('small').innerText : '', arrows: q('[data-testid="week-prev"]').length + q('[data-testid="week-next"]').length,
      marks: line ? line.querySelectorAll('[data-testid="daymarks"] i').length : 0, hrs: line ? (line.querySelector('[data-testid="week-hours"]') || {}).textContent : '',
      kinds: line ? [...line.querySelectorAll('[data-testid="daymarks"] i')].map(i => i.dataset.k).join('') : '',
      week: (document.querySelector('#scheduleRoot [data-testid="week-range"]') || {}).innerText || '', crumb: document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' '),
      old: !!document.getElementById('ganttBody')};
  }, schedPlate);
  await p.click(schedPlate, {position: {x: 30, y: 14}});
  sch.days = await waitFor(p, () => document.querySelectorAll('#scheduleRoot [data-testid="sched-day"]').length === 7, 3000);
  await sleep(300); await p.screenshot({path: SP + '/t3-schedule-days.png'}).catch(()=>{});
  await p.click('#scheduleRoot [data-testid="sched-day"][data-date] >> nth=1');
  sch.editor = await waitFor(p, () => !!document.querySelector('[data-testid="shift-window"]') && /09:00/.test(document.getElementById('shiftFrom').value), 3000);
  await p.keyboard.press('Escape'); await waitFor(p, () => !document.querySelector('[data-testid="shift-window"]'), 3000);
  await p.click(schedPlate, {position: {x: 30, y: 14}});
  sch.closedNow = await waitFor(p, () => document.querySelectorAll('#scheduleRoot [data-testid="sched-day"]').length === 0, 3000);
  ok(/shift/.test(sch.sum) && sch.days && sch.editor && sch.closedNow && /–/.test(sch.week) && !sch.old, 'schedule: a plate per worker, a tap opens its 7 days, a day opens the shift window ' + JSON.stringify(sch));
  await p.screenshot({path: SP + '/t3-schedule.png'}).catch(()=>{});
  // Glass week arrows, site tabs (the breadcrumb follows), 7 day marks per worker (green work, blue a night).
  const sc6 = await p.evaluate(async () => {
    const r = {}, tabs = [...document.querySelectorAll('#scheduleRoot [data-testid="site-tabs"] button')]; r.tabs = tabs.map(b => b.textContent);
    r.crumbAll = document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ');
    if(tabs[1]){ tabs[1].click(); await new Promise(res => setTimeout(res, 50));
      r.filtered = selectedClientId === clients[0].id && document.querySelector('#scheduleRoot [data-testid="site-tabs"] button.on').textContent === clients[0].name;
      r.crumbSite = document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' '); filterByClient(null); }
    return r;
  });
  ok(sch.arrows === 2 && sch.marks === 7 && /h$/.test(sch.hrs) && sch.kinds === '-wn----' && sc6.tabs[0] === 'All sites' && sc6.filtered
    && /Schedule.*All sites/.test(sc6.crumbAll) && new RegExp('Schedule.*' + sc6.tabs[1]).test(sc6.crumbSite),
    'schedule: glass arrows, site tabs filter (breadcrumb "Schedule › <site>"), 7 day marks and the week\'s hours per worker ' + JSON.stringify({sch, sc6}));
  await p.evaluate(() => { workers.find(w => isActiveWorker(w)).schedule = JSON.parse(window.__keepSched); render(); });
  await p.evaluate(async () => { localStorage.setItem('workersView', 'cards'); switchTab('workers'); await new Promise(r => setTimeout(r, 300)); });
  await p.screenshot({path: SP + '/t3-workers.png'}).catch(()=>{});
  // Salary on a phone: the Data Table becomes plates; a tap opens a plate's details under it.
  const salPhone = await p.evaluate(async () => { switchTab('accounting'); setAccTab('salary'); await ManagerBridge.setPeriod('all'); await new Promise(res => setTimeout(res, 200));
    const r = {kind: (document.querySelector('#accountingRoot [data-slot=data-table]') || {dataset: {}}).dataset.kind};
    const plate = document.querySelector('#accountingRoot [data-testid=sal-row] .og-plate');
    if (plate) { plate.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'touch', isPrimary: true})); plate.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerType: 'touch', isPrimary: true})); }
    await new Promise(res => setTimeout(res, 450));
    const det = document.querySelector('#accountingRoot [data-testid=sal-row] [data-testid=sal-det]'); r.open = !!det && det.getBoundingClientRect().height > 40;
    window.scrollTo(0, 0); document.querySelector('#sectionAccounting').scrollIntoView(); await new Promise(res => setTimeout(res, 300)); return r; });
  await p.screenshot({path: SP + '/t3-accounting.png'}).catch(()=>{});
  ok(salPhone.kind === 'cards' && salPhone.open, 'salary on a phone: plates, a tap opens the details under the plate ' + JSON.stringify(salPhone));
  await p.evaluate(async () => { await ManagerBridge.setPeriod('week'); });
  await p.setViewportSize({width: 1280, height: 720});
  ok(t3.stats === 4 && t3.row && t3.lines >= 1, 'today: four figure tiles in one row on a phone and colored plates ' + JSON.stringify(t3));
  ok(t3.twoRows && t3.fixed && t3.greetHidden && t3.shortDate && t3.noMenu, 'V7 on a phone: two header rows fixed at the top (logo · short date and weather · buttons; the breadcrumb under them), the greeting\'s words hidden, the bottom bar stays ' + JSON.stringify(t3));
  // On a phone a worker card is compact: one summary line instead of the detail rows.
  await p.setViewportSize({width: 390, height: 800});
  const wc = await p.evaluate(async () => { switchTab('workers'); await new Promise(r => setTimeout(r, 200));
    const c = document.querySelector('#workersRoot [data-testid="worker-plate"]'); return c ? {h: c.getBoundingClientRect().height, name: c.querySelector('[data-testid="worker-name"]').textContent, full: c.querySelector('[data-testid="worker-name"]').title, hrs: (c.querySelector('[data-testid="worker-hours"]') || {}).textContent, kb: !!c.querySelector('button[aria-label="Actions"]'), sw: c.classList.contains('og-sw')} : {}; });
  await p.setViewportSize({width: 1280, height: 720});
  ok(wc.h > 0 && wc.h < 100 && wc.name && wc.name === wc.full && /h$/.test(wc.hrs) && wc.kb && wc.sw, 'workers: on a phone a worker is one plate — the full name (… when it does not fit), the month\'s hours, ⋮, swipe ' + JSON.stringify(wc));
  ok(rt.keptAfterEdit, 'worker pay: an edit in the worker modal keeps the pay fields', JSON.stringify(rt));
  ok(rt.moved === 0, "worker pay: moved to a client with a rate, the worker takes the client's rate", JSON.stringify(rt));
  // Commission for a worker paid by the day: a fixed ₪ per day when set, else hours × ₪/h.
  const dc = await p.evaluate(() => {
    const w = {id: 'x', payMode: 'daily', supplierRates: {s1: {rate: 6, dayRate: 70}}};
    const e = {hours: 20, daysUsed: 3};
    return {
      sup: commissionFor(w, e, ManagerAcc.supplierCommissionRate(w, 's1'), ManagerAcc.supplierDayCommission(w, 's1')),
      noDay: commissionFor({...w, supplierRates: {s1: {rate: 6}}}, e, 6, ManagerAcc.supplierDayCommission({supplierRates: {s1: {rate: 6}}}, 's1')),
      hourly: commissionFor({id: 'y'}, e, 6, 70),
      hr: commissionFor(w, e, 4, 40)};
  });
  ok(dc.sup === 210 && dc.noDay === 120 && dc.hourly === 120 && dc.hr === 120, 'commission: a daily worker counts days × ₪/day when set, else hours × ₪/h ' + JSON.stringify(dc));
  // Hours sent for review: a live count on the Accounting tab and the latest status on the worker card.
  const hb = await p.evaluate(async () => {
    const r = {};
    const wait = async (fn) => { for(let i = 0; i < 60 && !fn(); i++) await new Promise(res => setTimeout(res, 150)); };
    // the count on the React frame's Accounting section (its side menu or bottom bar button)
    const badge = () => document.querySelector('button:has([data-testid=tab-accounting]) [data-testid=shell-count]');
    const before = (__hoursBatches || []).filter(b => b.status === 'pending').length;
    await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'savePendingHoursBatch', fileName: 'e2e', entries: [{workerId: 'w2', date: '03/10/2026', inTime: '08:00', outTime: '12:00'}]})});
    await wait(() => badge() && badge().textContent === String(before + 1));
    r.badge = badge() ? badge().textContent : null; r.before = before;
    openWorkerCard(workers.findIndex(w => w.id === 'w2'));
    const hs = () => (document.querySelector('#workerCardModal [data-testid="card-hours-status"]') || {}).textContent || '';
    r.card = hs();
    const b = latestHoursBatch('w2');
    await rejectHoursBatch(b.batchId);
    await wait(() => /Rejected/.test(hs()));
    r.after = hs();
    r.badgeAfter = badge() ? Number(badge().textContent) : 0;
    closeModal('workerCardOverlay');
    return r;
  });
  ok(hb.badge === String(hb.before + 1) && /Sent for review/.test(hb.card) && /Rejected/.test(hb.after) && hb.badgeAfter === hb.before, 'hours review: a live count on the Accounting tab and the status on the worker card ' + JSON.stringify(hb));
  // The worker window saves itself when closed by a tap outside.
  const as = await p.evaluate(async () => {
    const r = {}, tap = () => { const ov = document.getElementById('workerOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click(); };
    const wi = workers.findIndex(w => w.id === 'w2'), keepPhone = workers[wi].phone;
    openEditWorker(wi); r.noSaveBtn = !!document.querySelector('#workerModal [data-testid="worker-editor"]') && ![...document.querySelectorAll('#workerModal button')].some(b => /^\s*(Save|Create|שמור|צור עובד)/.test(b.textContent));
    T.fill('wPhone', '0547770000'); tap();
    await new Promise(res => setTimeout(res, 300));
    r.saved = workers[wi].phone; r.closed = !document.getElementById('workerOverlay').classList.contains('open');
    openEditWorker(wi); T.fill('wPhone', keepPhone || ''); tap(); await new Promise(res => setTimeout(res, 300));
    openEditWorker(wi); T.fill('wGiven', ''); T.fill('wSurname', ''); tap(); await new Promise(res => setTimeout(res, 300));
    r.nameKept = workers[wi].name; r.closedEmpty = !document.getElementById('workerOverlay').classList.contains('open');
    const n = workers.length; openAddWorker(); tap(); await new Promise(res => setTimeout(res, 300));
    r.noNew = workers.length === n && !document.getElementById('workerOverlay').classList.contains('open');
    return r;
  });
  ok(as.noSaveBtn && as.saved === '0547770000' && as.closed, 'worker window: no Save button; a tap outside saves and closes ' + JSON.stringify(as));
  ok(as.nameKept === 'Dana Levi' && as.closedEmpty && as.noNew, 'worker window: an empty name is not saved; an empty new worker is not created ' + JSON.stringify(as));
  // The header's language select: English by default; Hebrew from i18n/he.json, Russian (an empty dictionary) falls back to English.
  // The Language button is the React frame's (LanguageButton): its window lists every language, with a search.
  const hdrLang = 'header [data-testid=lang-btn]', list = '[data-testid=lang-list]';
  const lg = await p.evaluate(() => ({def: I18N_LANG, firmField: !!document.getElementById('firmEditLanguage')}));
  await p.click(hdrLang); await p.waitForSelector(list);
  lg.sheet = await p.evaluate(l => { const el = document.querySelector(l); return {open: !!el, all: [...el.querySelectorAll('.lang-li')].map(b => b.querySelector('b').textContent + '/' + b.querySelector('small').textContent).join(), ticked: el.querySelector('.lang-li.on').dataset.lang}; }, list);
  await p.fill('#lang-search', 'hebr'); lg.sheet.found = await p.evaluate(l => [...document.querySelectorAll(l + ' .lang-li')].map(b => b.dataset.lang).join(), list);
  await p.fill('#lang-search', 'zz'); lg.sheet.none = await p.evaluate(l => document.querySelectorAll(l + ' .lang-li').length === 0 && !!document.querySelector(l + ' .lang-none'), list);
  await p.keyboard.press('Escape'); await sleep(500);
  lg.sheet.closed = await p.evaluate(() => { const w = document.querySelector('[data-testid=window]'); return !w || w.dataset.state === 'closed'; });
  const setLang = async l => {
    await p.click(hdrLang); await p.waitForSelector(list); await p.click(list + ' .lang-li[data-lang="' + l + '"]');
    await sleep(300);
    return p.evaluate(async l => {
      for(let i = 0; i < 40 && I18N_LANG !== l; i++) await new Promise(res => setTimeout(res, 150));
      switchTab('accounting'); await new Promise(res => setTimeout(res, 300));
      const w = document.querySelector('[data-testid=window]');
      return {lang: I18N_LANG, tab: document.querySelector('[data-testid=shell-menu] button:has([data-testid=tab-accounting])').innerText.trim(),
        head: ((document.querySelector('#accountingRoot [data-testid=sal-table] thead th') || {}).textContent || '').trim(),
        sec: ((document.querySelector('#accSecSalary [data-slot=section] > div > button span span') || {}).firstChild || {}).textContent,
        period: document.querySelector('#accountingRoot [data-testid=acc-period]').innerText.trim(),
        stored: localStorage.getItem('uiLang'), selects: document.querySelectorAll('.lang-btn').length === 1 && (!w || w.dataset.state === 'closed')};
    }, l);
  };
  lg.he = await setLang('he');
  lg.ru = await setLang('ru');
  lg.en = await setLang('en');
  ok(lg.sheet.open && lg.sheet.all === 'English/English,עברית/Hebrew,Русский/Russian' && lg.sheet.ticked === 'en' && lg.sheet.found === 'he' && lg.sheet.none && lg.sheet.closed, 'language: the Language button opens a window with every language (own name + English), the current one ticked, a search, closes with Escape ' + JSON.stringify(lg.sheet));
  ok(lg.he.lang === 'he' && lg.he.tab === 'חשבונות' && lg.he.head === 'עובד' && lg.he.sec === 'חישוב שכר' && lg.he.period === 'השבוע' && lg.he.stored === 'he' && lg.he.selects && lg.def === 'en' && !lg.firmField, 'language: English by default; the header Language button switches to Hebrew sees Accounting in Hebrew ' + JSON.stringify(lg.he));
  ok(lg.ru.lang === 'ru' && lg.ru.tab === 'Accounting' && lg.ru.head === 'Worker', 'language: Russian with an empty dictionary shows English ' + JSON.stringify(lg.ru));
  ok(lg.en.lang === 'en' && lg.en.tab === 'Accounting' && lg.en.sec === 'Salary Calculation' && lg.en.period === 'This Week', 'language: back to English ' + JSON.stringify(lg.en));
  // One Language button per page; the user's last choice follows them to a new device.
  await p.evaluate(() => setLanguage('he')); await sleep(1500);
  {
    const c2 = await newCtx(); const p2 = await page(c2);
    await p2.goto(BASE + 'schedule-manager.html'); await p2.waitForSelector('#loginScreen', {state:'visible'});
    const onLogin = await p2.evaluate(() => ({card: (() => { const c = document.querySelector('.login-card'), cs = getComputedStyle(c); return cs.position === 'fixed' && cs.borderRadius === '22px' && !!c.querySelector('.og-mark') && /gbtn/.test(document.getElementById('loginBtn').className); })(), n: document.querySelectorAll('.lang-btn').length, selects: document.querySelectorAll('select.lang-select').length, inLogin: !!document.querySelector('#loginScreen [data-testid=lang-btn].on-cover'), lang: I18N_LANG}));
    await p2.fill('#loginUsername', 'owner1'); await p2.fill('#loginPassword', 'owner-pass-1'); await p2.click('#loginBtn');
    await p2.waitForNavigation().catch(()=>{});
    const after = await waitFor(p2, () => I18N_LANG === 'he' && !!document.querySelector('header [data-testid=lang-btn]') && document.querySelectorAll('.lang-btn').length === 1, 15000);
    ok(onLogin.card, 'sign-in: a compact glass card pinned over the site, with the logo and a glass Sign in ' + JSON.stringify(onLogin));
    ok(onLogin.n === 1 && !onLogin.selects && onLogin.inLogin && onLogin.lang === 'en' && after, 'language: one Language button per page (login screen, then the title bar); the user\'s last choice comes back on a new device ' + JSON.stringify(onLogin));
    await p2.evaluate(() => setLanguage('en')); await sleep(1000);
    await c2.close();
  }
  await p.evaluate(() => setLanguage('en', {save:false}));
  // The theme (docs/redesign.md → Light theme): Dark by default; the account menu's switch turns the light
  // theme on and keeps it on the device and on the account — login brings it back on a new device.
  {
    const th = await p.evaluate(async () => {
      const r = {def: document.documentElement.dataset.theme, stored: localStorage.getItem('uiTheme')};
      const wait = ms => new Promise(res => setTimeout(res, ms));
      document.querySelector('[data-testid=account-btn]').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerType: 'mouse'})); await wait(200);
      const sw = () => document.querySelector('[data-testid=account-theme] [data-testid=theme-switch]');
      r.items = [...sw().querySelectorAll('[data-testid^=theme-]')].map(b => b.dataset.testid.slice(6) + '/' + b.innerText.trim()).join();
      sw().querySelector('[data-testid=theme-light]').click(); await wait(100);
      r.light = document.documentElement.dataset.theme; r.saved = localStorage.getItem('uiTheme');
      r.on = (sw().querySelector('[data-state=on]') || {}).dataset?.testid?.slice(6);
      r.open = !!document.querySelector('[data-testid=account-menu]');
      r.ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await wait(200);
      return r;
    });
    ok(th.def === 'dark' && th.items === 'dark/Dark,light/Light,system/System' && th.light === 'light' && th.saved === 'light' && th.on === 'light' && th.open && th.ground === '#eef1f7', 'theme: Dark by default; the account menu\'s switch (Dark / Light / System) turns the light theme on, on this device ' + JSON.stringify(th));
    await sleep(1500);
    const c3 = await newCtx(); const p3 = await page(c3);
    await p3.goto(BASE + 'schedule-manager.html'); await p3.waitForSelector('#loginScreen', {state:'visible'});
    const before = await p3.evaluate(() => ({look: document.documentElement.dataset.theme, sw: document.querySelectorAll('#loginTheme [data-theme-v]').length, on: (document.querySelector('#loginTheme .on') || {}).dataset?.themeV}));
    await p3.fill('#loginUsername', 'owner1'); await p3.fill('#loginPassword', 'owner-pass-1'); await p3.click('#loginBtn');
    const back = await waitFor(p3, () => !!document.querySelector('header [data-testid=lang-btn]') && document.documentElement.dataset.theme === 'light' && localStorage.getItem('uiTheme') === 'light', 15000);
    await p3.screenshot({path: SP + '/theme-light-manager.png'});
    ok(before.look === 'dark' && before.sw === 3 && before.on === 'dark' && back, 'theme: the sign-in screen has the same switch (Dark on a new device); the user\'s light theme comes back with the login ' + JSON.stringify(before));
    // and back: Dark again, on the account too
    await p3.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms));
      document.querySelector('[data-testid=account-btn]').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerType: 'mouse'})); await wait(200);
      document.querySelector('[data-testid=account-theme] [data-testid=theme-dark]').click(); await wait(100);
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await wait(200); });
    await sleep(800);
    ok(await p3.evaluate(() => document.documentElement.dataset.theme === 'dark' && localStorage.getItem('uiTheme') === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() === '#10141f'), 'theme: Dark switches the light theme off again');
    await sleep(1000);
    await c3.close();
    await p.evaluate(() => setTheme('dark', {save:false}));
  }
  // Schedule: a shift for one date only wins over the weekly roster on that date (set in the React shift window).
  const dsKey = await p.evaluate(async () => {
    filterByClient('c1'); switchTab('schedule'); await new Promise(r => setTimeout(r, 200));
    const wi = workers.findIndex(w => w.id === 'w1'), d = new Date(weekStart); d.setDate(d.getDate() + 3);
    window.__dsWeekly = JSON.stringify(workers[wi].schedule[3]);
    return localYMD(d);
  });
  const w1Plate = '#scheduleRoot [data-testid="sched-worker"][data-id="w1"] > [data-slot="plate"] > [role="button"]';
  if (!(await p.$(`#scheduleRoot [data-testid="sched-day"][data-date="${dsKey}"]`))) await p.click(w1Plate, {position: {x: 30, y: 14}});
  await p.click(`#scheduleRoot [data-testid="sched-worker"][data-id="w1"] [data-testid="sched-day"][data-date="${dsKey}"]`);
  await p.waitForSelector('[data-testid="shift-window"]');
  await p.click('[data-testid="shift-type"] [role="radio"]:first-child');
  await p.click('[data-testid="shift-scope"]'); await p.click('[role="option"]:has-text("Only")');
  await p.fill('#shiftFrom', '10:00'); await p.fill('#shiftTo', '14:00');
  await p.click('[data-testid="shift-save"]');
  await waitFor(p, () => !document.querySelector('[data-testid="shift-window"]'), 3000);
  const ds = await p.evaluate(key => {
    const w = workers.find(x => x.id === 'w1'), d = new Date(weekStart); d.setDate(d.getDate() + 3);
    const r = {weeklySame: JSON.stringify(w.schedule[3]) === window.__dsWeekly, dated: (w.dateShifts || {})[key], week: weekShifts(w)[3]};
    const next = new Date(d); next.setDate(next.getDate() + 7); r.nextWeek = shiftOn(w, next);
    r.dot = !!document.querySelector(`#scheduleRoot [data-testid="sched-day"][data-date="${key}"] [data-testid="sched-dated"]`);
    return r;
  }, dsKey);
  await p.click(`#scheduleRoot [data-testid="sched-worker"][data-id="w1"] [data-testid="sched-day"][data-date="${dsKey}"]`);
  await p.click('[data-testid="shift-back"]');
  await waitFor(p, () => !document.querySelector('[data-testid="shift-window"]'), 3000);
  ds.cleared = await p.evaluate(key => !(workers.find(x => x.id === 'w1').dateShifts || {})[key], dsKey);
  await p.evaluate(() => filterByClient(null));
  ok(ds.weeklySame && ds.dated && ds.dated.start === '10:00' && ds.week.dated && ds.week.end === '14:00' && !ds.nextWeek.dated && ds.dot && ds.cleared, 'schedule: a one-date shift overrides the weekly day only on that date; back to weekly removes it ' + JSON.stringify(ds));
  // Copy last week / Repeat for N weeks (stage 6b): only empty days get a shift, the list shows before anything is saved, Undo takes it back; never punches.
  const cpDays = await p.evaluate(async () => {
    filterByClient('c1'); switchTab('schedule');
    const w = workers.find(x => x.id === 'w1'), ymd = n => { const d = new Date(weekStart); d.setDate(d.getDate() + n); return localYMD(d); };
    window.__cpKeep = JSON.stringify(w.dateShifts || {}); window.__cpPunches = getPunchLog().length;
    // last week: Mon 08–12 and Tue 09–13; this week's Tue is already a day off for that date
    w.dateShifts = Object.assign({}, w.dateShifts, {[ymd(-6)]: {type:'work', start:'08:00', end:'12:00'}, [ymd(-5)]: {type:'work', start:'09:00', end:'13:00'}, [ymd(2)]: {type:'off', start:null, end:null}});
    render(); await new Promise(r => setTimeout(r, 100));
    return {mon: ymd(1), tue: ymd(2), mon1: ymd(8), mon2: ymd(15)};
  });
  const cw = {};
  await p.click('#scheduleRoot [data-testid="copy-last"]');
  cw.preview = await waitFor(p, () => document.querySelectorAll('[data-testid="copy-item"]').length === 1, 3000);
  cw.item = await p.evaluate(() => (document.querySelector('[data-testid="copy-item"]') || {}).innerText || '');
  cw.notYet = await p.evaluate(k => !(workers.find(x => x.id === 'w1').dateShifts || {})[k], cpDays.mon);
  await p.click('[data-testid="copy-apply"]');
  cw.added = await p.evaluate(d => { const ds = workers.find(x => x.id === 'w1').dateShifts || {}; return ds[d.mon] && ds[d.mon].start === '08:00' && ds[d.mon].end === '12:00' && ds[d.tue].type === 'off'; }, cpDays);
  cw.snack = await waitFor(p, () => /added/.test((document.querySelector('[data-testid="undo-snack"]') || {}).innerText || ''), 3000);
  await p.click('[data-testid="undo-snack"] button');
  cw.undone = await p.evaluate(k => !(workers.find(x => x.id === 'w1').dateShifts || {})[k], cpDays.mon);
  // Again, kept; then Select → tick Avi → Repeat for 2 weeks
  await p.click('#scheduleRoot [data-testid="copy-last"]'); await p.click('[data-testid="copy-apply"]');
  await waitFor(p, () => !document.querySelector('[data-testid="copy-window"]'), 3000);
  await p.click('#scheduleRoot [data-testid="sched-workers"] button:has-text("Select")');
  await p.click('#scheduleRoot [data-testid="sched-worker"][data-id="w1"] > [data-slot="plate"] > [role="button"]', {position: {x: 30, y: 14}});
  await p.click('[data-testid="sel-copy-repeat"]');
  await p.waitForSelector('[data-testid="copy-window"]');
  await p.click('[data-testid="copy-weeks"] [role="radio"]:has-text("2")');
  cw.repeatList = await waitFor(p, () => document.querySelectorAll('[data-testid="copy-item"]').length === 2, 3000);
  await p.click('[data-testid="copy-apply"]');
  cw.repeated = await p.evaluate(d => { const ds = workers.find(x => x.id === 'w1').dateShifts || {}; return !!(ds[d.mon1] && ds[d.mon2] && ds[d.mon2].start === '08:00'); }, cpDays);
  cw.punches = await p.evaluate(() => getPunchLog().length === window.__cpPunches);
  await sleep(2500);  // autoSave's debounce
  const cpSrv = await srv('/swapState');
  cw.saved = !!((cpSrv.dateShifts.w1 || {})[cpDays.mon2]);
  await p.evaluate(async () => { workers.find(x => x.id === 'w1').dateShifts = JSON.parse(window.__cpKeep); filterByClient(null); await gsSave(getDataObj()); });
  ok(cw.preview && /08:00–12:00/.test(cw.item) && cw.notYet && cw.added && cw.snack && cw.undone && cw.repeatList && cw.repeated && cw.punches && cw.saved,
    'schedule: Copy last week fills only empty days, shows the shifts before saving, Undo takes them back; Repeat for N weeks on the selected workers is saved; punches untouched ' + JSON.stringify(cw));
  const xl = await p.evaluate(async () => {
    const atStart = typeof XLSX === 'undefined';
    await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet([['Date','In','Out'],['01/10/2026','08:00','12:00']]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
    const rows = await parseHoursExcelFile(new File([XLSX.write(wb, {type:'array', bookType:'xlsx'})], 'h.xlsx'));
    return {atStart, rows: rows.map(r => r.date + ' ' + r.inTime + ' ' + r.outTime)};
  });
  ok(xl.atStart && xl.rows.length === 1 && xl.rows[0] === '01/10/2026 08:00 12:00', 'excel: the library is not loaded with the page; an hours file still reads after loading it ' + JSON.stringify(xl));
  // Scan again from the worker modal: typed values stay, empty ones take the scan's
  const rs = await p.evaluate(async () => {
    openEditWorker(0);
    T.fill('wGiven', 'Typed');
    T.fill('wCity', '');
    T.fill('wPhone', 'P-123');
    // the scan window opens over the worker window; closed with nothing scanned, the draft stays for the scan
    const going = rescanFromWorkerModal();
    await T.until(() => document.querySelector('[data-testid="scanner"]'));
    const scanOpen = !!document.querySelector('[data-testid="scanner"]');
    T.esc(); await going;
    openWorkerModalFromScan({type:'israeli_id', given:'FromScan', surname:'Scan', city:'Haifa'});
    await T.tick();
    const r = {scanOpen, given: T.val('wGiven'), city: T.val('wCity'), phone: T.val('wPhone'), rescanned: window.__aiRescannedWorkerId === workers[0].id, draft: window.__wDraft};
    closeModal('workerOverlay'); window.__aiRescannedWorkerId = null;
    openWorkerCard(0);
    r.card = !!document.querySelector('#workerCardModal [data-testid="card-scan"]');
    closeModal('workerCardOverlay');
    return r;
  });
  ok(rs.scanOpen && rs.given === 'Typed' && rs.city === 'Haifa' && rs.phone === 'P-123' && rs.rescanned && rs.draft === null && rs.card, 'scan again from the worker modal keeps typed values, fills empty ones; card has the button');
  // The scan window (src/scan/Scanner.tsx): the scanner lab's own page, copied as it is (scan/,
  // /scan/?embed=1), inside the window; its pages come back by postMessage (scan/embed.js) into the
  // strip — a shot again (its corners refined) replaces that shot's pages; each gets Haiku's kind;
  // Done reads them in the window (src/scan-process/) and opens the worker window with what was read.
  const JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpKKKKAP/Z';
  const feedbackCalls = [];
  let attemptsOffline = false;
  const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST'};
  // Haiku's page kinds (aiDetectAlign): the first page an ID card, the second a ספח; the ID card's read (aiReadDoc)
  let kindCalls = 0;
  const readCalls = [];
  await p.route(/cloudfunctions\.net\/ai_read$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status:204, headers:CORS});
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'aiReadDoc') {
      readCalls.push(body.action);
      return r.fulfill({status:200, contentType:'application/json', headers:CORS, body: JSON.stringify({parsed: {type: 'israeli_id', given: 'Scanned', surname: 'Person', idNo: '1234567 8 2',
        dob: '1.2.1990', sex: 'M', address: 'Herzl', houseNumber: '5', city: 'Haifa'}})});
    }
    if (body.action !== 'aiDetectAlign') return r.fallback();
    kindCalls++;
    return r.fulfill({status:200, contentType:'application/json', headers:CORS, body: JSON.stringify({ok: true, align: {kind: body.image === JPG ? 'id_front' : 'sefach', rotate: 0}})});
  });
  await p.route(/cloudfunctions\.net\/scan_feedback$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status:204, headers:CORS});
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'attempt' && attemptsOffline) return r.abort('internetdisconnected');
    feedbackCalls.push(body);
    if (body.action === 'attempt') return r.fulfill({status:200, contentType:'application/json', headers:CORS,
      body: JSON.stringify({ok: true, dirs: Object.fromEntries((body.attempts || []).map(a => [a.id, 'attempts/new/' + a.source + '/2026-10-20/' + a.id]))})});
    // Admin → Scanner set to Mixed: a page the document type model is sure of needs no Haiku
    return r.fulfill({status:200, contentType:'application/json', headers:CORS, body: JSON.stringify(body.action === 'mode' ? {ok: true, doctypeMode: 'mixed'} : {ok: true})});
  });
  await p.evaluate(() => { localStorage.removeItem('scanFeedbackQueue'); window.__scanGoing = startNewScan(); });
  await p.waitForSelector('[data-testid="scanner"]');
  const lab = await p.evaluate(async () => {
    const f = document.querySelector('[data-testid="scan-lab-frame"]');
    const page = await (await fetch('/scan/?embed=1')).text();
    return {src: f && f.getAttribute('src'), camera: f && f.getAttribute('allow'), copy: /Scanner lab/.test(page) && /\/scan\/embed\.js/.test(page) && /\/scan\/scan-core\.js/.test(page) && !/\/scan-lab\//.test(page)};
  });
  // the lab page's shot: first one page, then (its corners refined, a second document found) two
  // the second page another picture (the ספח), so Haiku's mocked kind follows the page, not the call's order
  const JPG2 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2yiiiv2Q/kM//2Q==';
  // the document type model's answers (embed.js): sure of the ID card, none on the ספח (Haiku types it)
  const answers = [{doctype: 'id_front', conf: 0.97, turn: 0, turnConf: 0.99}, null];
  const post = (key, n) => p.evaluate(([pics, key, n, answers]) => window.postMessage({type: 'scan-pages', key, pages: pics.slice(0, n).map(x => 'data:image/jpeg;base64,' + x), answers: answers.slice(0, n)}, location.origin), [[JPG, JPG2], key, n, answers]);
  await post('s1', 1);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="scan-page"][data-kind]').length === 1, null, {timeout: 15000}).catch(() => {});
  await post('s1', 2);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="scan-page"][data-kind]').length === 2, null, {timeout: 15000}).catch(() => {});
  // Each page shows Haiku's kind; one set to Other is not saved; set to Contract it is again.
  const kinds0 = await p.evaluate(() => [...document.querySelectorAll('[data-testid="scan-page"]')].map(e => e.dataset.kind).join(','));
  const pickKind = async kd => {
    await p.click('[data-testid="scan-kind"] >> nth=1'); await p.click('[data-testid="scan-kind-' + kd + '"]');
    await p.waitForSelector('[data-testid="scan-kind-' + kd + '"]', {state: 'detached'}); await p.waitForTimeout(300);
  };
  await pickKind('other');
  const otherDone = await p.textContent('[data-testid="scan-done"]');
  await pickKind('contract');
  const scw = await p.evaluate(async () => {
    const r = {pages: document.querySelectorAll('[data-testid="scan-page"]').length, done: document.querySelector('[data-testid="scan-done"]').textContent};
    document.querySelector('[data-testid="scan-done"]').click();
    await window.__scanGoing;
    r.closed = await T.until(() => !document.querySelector('[data-testid="scanner"]') && !document.querySelector('[data-testid="scan-reading"]'), 4000);
    r.worker = document.getElementById('workerOverlay').classList.contains('open');
    r.given = T.val('wGiven'); r.docId = T.val('wDocId'); r.city = T.val('wCity');
    r.front = !!window.__aiScanImage;
    r.kinds = ['front', ...(window.__aiPacketOtherPages || []).map(x => x.kind + (x.contract ? ':contract' : ''))].join(',');
    // the save after a scan sends the document with what was saved (docs/hf-plan.md → H8a)
    ManagerBridge.sendScanDocument('w-test', {docType: 'israeli_id', docGiven: 'Scanned', docSurname: 'Persson', docId: '123456782'});
    closeModal('workerOverlay'); window.__aiScanImage = null; window.__aiPacketOtherPages = [];
    return r;
  });
  await p.waitForTimeout(500);
  // The lab page stays loaded (lab.ts): closed, it is hidden and kept; opened again within 3 minutes it is
  // the same page (not loaded again), laid over the window's slot
  const kindAtDone = kindCalls; // the Haiku calls of this scan, before the next checks post their own pages
  const kept = await p.evaluate(async () => {
    const f = document.querySelector('[data-testid="scan-lab-frame"]');
    const r = {hidden: !!f && f.style.visibility === 'hidden' && document.body.contains(f)};
    f.contentWindow.__mark = 1;
    const going = startNewScan();
    await T.until(() => document.querySelector('[data-testid="scan-lab-slot"]'));
    await new Promise(res => setTimeout(res, 600));
    const g = document.querySelector('[data-testid="scan-lab-frame"]');
    r.same = g === f && g.contentWindow.__mark === 1;
    r.shown = g.style.visibility === 'visible';
    const sl = document.querySelector('[data-testid="scan-lab-slot"]').getBoundingClientRect(), fr = g.getBoundingClientRect();
    r.over = Math.abs(sl.top - fr.top) < 2 && Math.abs(sl.left - fr.left) < 2 && Math.abs(sl.width - fr.width) < 2;
    // a tap there reaches the lab page: above the window, with its own pointer events
    r.tap = document.elementFromPoint(sl.left + sl.width / 2, sl.top + Math.min(sl.height / 2, 100)) === g;
    T.esc(); await going;
    r.closed = await T.until(() => g.style.visibility === 'hidden', 3000);
    return r;
  });
  // Batches (owner, 2026-10-20): the last batch under New pages; a new one folds it into a line; Looks good
  // folds it too; a tap unfolds a line; closed and opened again, the batches come back from this phone
  const batches = await p.evaluate(async ([a, b]) => {
    const post = (key, pic) => window.postMessage({type: 'scan-pages', key, pages: ['data:image/jpeg;base64,' + pic]}, location.origin);
    const n = sel => document.querySelectorAll(sel).length;
    const r = {};
    let going = startNewScan();
    await T.until(() => document.querySelector('[data-testid="scan-lab-slot"]'));
    post('s91', a);
    r.preview = await T.until(() => n('[data-testid="scan-preview"] [data-testid="scan-page"]') === 1, 4000);
    post('f91.1', b);
    r.foldedByNew = await T.until(() => n('[data-testid="scan-batch"]') === 1 && n('[data-testid="scan-preview"] [data-testid="scan-page"]') === 1, 4000);
    document.querySelector('[data-testid="scan-keep"]').click();
    r.foldedByKeep = await T.until(() => n('[data-testid="scan-batch"]') === 2 && !document.querySelector('[data-testid="scan-preview"]'), 4000);
    T.tap('[data-testid="scan-batch"]');
    r.unfolds = await T.until(() => { const d = document.querySelector('[data-testid="scan-batch"] [data-no-tap]'); return !!d && d.offsetHeight > 0 && getComputedStyle(d).opacity === '1'; }, 4000);
    r.done = document.querySelector('[data-testid="scan-done"]').textContent;
    await new Promise(res => setTimeout(res, 700)); // kept on the phone a moment after a change
    T.esc(); await going;
    await new Promise(res => setTimeout(res, 500)); // the window gone, as a person opens it again
    going = startNewScan();
    await T.until(() => document.querySelector('[data-testid="scan-lab-slot"]'));
    r.restored = await T.until(() => n('[data-testid="scan-batch"]') === 2, 4000);
    T.esc(); await going;
    await new Promise(res => { const d = indexedDB.deleteDatabase('scanner'); d.onsuccess = d.onerror = d.onblocked = res; setTimeout(res, 1000); });
    return r;
  }, [JPG, JPG2]);
  ok(batches.preview && batches.foldedByNew && batches.foldedByKeep && batches.unfolds && /2/.test(batches.done) && batches.restored,
    'scan window, batches: the last one under New pages, folded by the next one and by Looks good, a line unfolds on a tap, kept on the phone after the window closes ' + JSON.stringify(batches));
  // The lab's Photo or PDF…: several files at once, a PDF split into its pages (pdf.js), in the files' order
  const PDF2 = (() => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] >>'];
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const x = out.length;
    return out + 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
      + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF';
  })();
  const picked = await p.evaluate(async ([jpg, pdf]) => {
    const fw = document.querySelector('[data-testid="scan-lab-frame"]').contentWindow, input = fw.document.getElementById('file');
    const files = [new File([Uint8Array.from(atob(jpg), c => c.charCodeAt(0))], 'a.jpg', {type: 'image/jpeg'}), new File([pdf], 'b.pdf', {type: 'application/pdf'})];
    const out = [];
    try { for await (const [url, tag] of fw.pickedPictures(files)) out.push(tag + ' ' + url.slice(0, 10)); } catch (e) { out.push('error ' + e.message); }
    // the other documents on a photo must have a document's shape: this frame (two corners on one point,
    // from a real scan) was cut into a smeared third page; a skewed card is still one
    const shape = [fw.docShape([[0.255, 0.162], [0.997, 0], [0.248, 0.425], [0.255, 0.163]], 1002, 1045),
      fw.docShape([[0.687, 0.461], [0.936, 0.462], [0.938, 0.795], [0.537, 0.803]], 1600, 1200)];
    return {out, shape, accept: input.accept, multiple: input.multiple, one: !fw.document.getElementById('file2'), button: input.parentElement.textContent.trim()};
  }, [JPG, PDF2]);
  ok(picked.multiple && picked.accept === '' && picked.one && picked.button === 'Photos or PDF…'
    && picked.out.join('|') === 'file 1 of 2 blob:http:|file 2 of 2, page 1 of 2 data:image|file 2 of 2, page 2 of 2 data:image',
    'scan window: the lab\'s one Photos or PDF… (no file type: the phone\'s file chooser, photos and PDFs side by side) takes several files at once, a PDF page by page, in the files\' order ' + JSON.stringify(picked));
  // Every scan attempt goes for training (docs/scan-plan.md → S8): the lab's code in the site's frame sends each
  // as it is decided — a retake shares its group with the next shot, the photo at most 1600 px, source "site";
  // a kept page deleted later is told by its folder; with no network they wait on the phone, 5 at most
  const att = await p.evaluate(async () => {
    const fw = document.querySelector('[data-testid="scan-lab-frame"]').contentWindow;
    const shot = () => { const c = fw.document.createElement('canvas'); c.width = 3200; c.height = 2400; const g = c.getContext('2d'); g.fillStyle = '#ddd'; g.fillRect(0, 0, 3200, 2400); return fw.newAttempt(c, 3200, 2400, 'camera'); };
    const a = shot(); a.edgesModel = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
    fw.decideAttempts('retaken');
    const b = shot(); b.edgesMore = [[[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]]; b.pages = 2;
    fw.decideAttempts('kept');
    await new Promise(res => setTimeout(res, 2500));
    await fw.flushAttempts();
    await fw.attemptPageDeleted(b.id, 1);
    return {a: a.id, b: b.id, group: b.group === a.group, size: JSON.stringify(ManagerScan.jpegSize(Uint8Array.from(atob(b.picture), ch => ch.charCodeAt(0))))};
  });
  const sent = feedbackCalls.filter(c => c.action === 'attempt').flatMap(c => c.attempts);
  const atA = sent.find(x => x.id === att.a) || {}, atB = sent.find(x => x.id === att.b) || {};
  const outc = feedbackCalls.find(c => c.action === 'attemptOutcome') || {};
  ok(att.group && atA.outcome === 'retaken' && atB.outcome === 'kept' && atA.source === 'site' && atB.input === 'camera' && atB.pages === 2 && (atB.edgesMore || []).length === 1
    && att.size === '{"h":1200,"w":1600}' && outc.dir === 'attempts/new/site/2026-10-20/' + att.b && outc.outcome === 'deleted' && outc.page === 1,
    'scan attempts: each sent for training as it is decided (a retake and the next shot one group, the photo at most 1600 px), a page deleted later told by its folder '
    + JSON.stringify({att, a: {o: atA.outcome, g: atA.group}, b: {o: atB.outcome, g: atB.group, p: atB.pages}, outc}));
  attemptsOffline = true;
  const queue = await p.evaluate(async () => {
    const fw = document.querySelector('[data-testid="scan-lab-frame"]').contentWindow;
    for (let i = 0; i < 7; i++) { const c = fw.document.createElement('canvas'); c.width = 40; c.height = 30; fw.newAttempt(c, 40, 30, 'photo'); fw.decideAttempts('kept'); await fw.flushAttempts(); }
    await fw.flushAttempts();
    const r = {waiting: (await fw.queued()).length, shown: fw.document.getElementById('train').textContent};
    return r;
  });
  attemptsOffline = false;
  const online = await p.evaluate(async () => {
    const fw = document.querySelector('[data-testid="scan-lab-frame"]').contentWindow;
    await fw.flushAttempts();
    return {waiting: (await fw.queued()).length, shown: fw.document.getElementById('train').textContent};
  });
  ok(queue.waiting === 5 && queue.shown === 'In queue: 5 / 5' && online.waiting === 0 && online.shown === '',
    'scan attempts: with no network they wait on the phone, 5 at most ("In queue: 5 / 5"), and go when it is back ' + JSON.stringify({queue, online}));
  // The corner editor (S8-3): the window's Fix corners on a new page opens the lab's editor on its photo; a corner
  // dragged and Apply make the moved corners the attempt's answer, sent with it when it is kept
  const fixed = await p.evaluate(async () => {
    const going = startNewScan();
    await T.until(() => document.querySelector('[data-testid="scan-lab-slot"]'));
    const fw = document.querySelector('[data-testid="scan-lab-frame"]').contentWindow, fd = fw.document;
    const c = fd.createElement('canvas'); c.width = 800; c.height = 600; c.getContext('2d').fillRect(0, 0, 800, 600);
    const a = fw.newAttempt(c, 800, 600, 'camera'); a.edgesModel = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
    const img = fd.getElementById('shotImg'); img.src = c.toDataURL('image/jpeg'); img.dataset.att = a.id; img.dataset.pg = '0'; fd.getElementById('shot').hidden = false;
    window.postMessage({type: 'scan-pages', key: 's77', pages: [img.src], attempts: [{att: a.id, pg: 0}]}, location.origin);
    const r = {button: await T.until(() => document.querySelector('[data-testid="scan-preview"] [data-testid="scan-fix"]'), 4000)};
    document.querySelector('[data-testid="scan-preview"] [data-testid="scan-fix"]').click();
    r.editor = await T.until(() => fd.getElementById('cornerEditor'), 4000);
    const cv = fd.querySelector('#cornerEditor canvas'), b = cv.getBoundingClientRect();
    const k = Math.min(b.width / 800, b.height / 600), ox = (b.width - 800 * k) / 2, oy = (b.height - 600 * k) / 2;
    const ev = (type, x, y) => cv.dispatchEvent(new fw.PointerEvent(type, {clientX: b.left + ox + x * 800 * k, clientY: b.top + oy + y * 600 * k, pointerId: 1, bubbles: true}));
    ev('pointerdown', 0.1, 0.1); ev('pointermove', 0.2, 0.15); ev('pointerup', 0.2, 0.15);
    [...fd.querySelectorAll('#cornerEditor button')].find(x => x.textContent === 'Apply').click();
    r.closed = await T.until(() => !fd.getElementById('cornerEditor'), 2000);
    r.fixed = a.edgesFixed && a.edgesFixed[0].map(v => Math.round(v * 100)).join();
    r.id = a.id;
    fw.decideAttempts('kept'); await fw.flushAttempts();
    T.esc(); await going;
    return r;
  });
  const sentFix = feedbackCalls.filter(c => c.action === 'attempt').flatMap(c => c.attempts).find(x => x.id === fixed.id) || {};
  ok(fixed.button && fixed.editor && fixed.closed && fixed.fixed === '20,15' && sentFix.edgesFixed && Math.round(sentFix.edgesFixed[0][0] * 100) === 20,
    'scan corner editor: the window\'s Fix corners opens the lab\'s editor on the photo; a dragged corner is the attempt\'s answer, sent with it ' + JSON.stringify({fixed, sent: sentFix.edgesFixed}));
  ok(picked.shape.join() === 'false,true', 'scan window: another document found on a photo needs a document\'s shape (no triangle, no sliver) ' + JSON.stringify(picked.shape));
  ok(kept.hidden && kept.same && kept.shown && kept.over && kept.tap && kept.closed,
    'scan window: the lab page is kept loaded after the window closes and shown again over the window\'s slot (no new load), a tap there reaching it ' + JSON.stringify(kept));
  // Done sent the pages' document type examples (source "page"): the ID card typed by the model, the ספח
  // by Haiku and changed to Contract — with a copy of the page
  const ex = feedbackCalls.filter(c => c.action === 'add').flatMap(c => c.examples || []);
  const exOk = ex.length === 2 && ex.every(e => e.source === 'page')
    && ex[0].doctypeBy === 'model' && ex[0].doctypeModel === 'id_front' && ex[0].doctypeFixed === 'id_front'
    && ex[1].doctypeBy === 'haiku' && ex[1].doctypeModel === 'sefach' && ex[1].doctypeFixed === 'contract' && !!ex[1].pageImage;
  ok(exOk && kindAtDone === 1 && feedbackCalls.some(c => c.action === 'mode'),
    'scan window, Mixed: the page the document type model is sure of needs no Haiku (one Haiku call, for the other page); Done sends each page\'s document type example ' + JSON.stringify({kindCalls: kindAtDone, ex: ex.map(e => ({by: e.doctypeBy, m: e.doctypeModel, f: e.doctypeFixed, copy: !!e.pageImage, keep: !!e.keep}))}));
  const docCall = feedbackCalls.find(c => c.action === 'document') || {};
  ok(docCall.workerId === 'w-test' && (docCall.pages || []).length === 1 && docCall.pages[0].primary && docCall.pages[0].doctype === 'id_front' && docCall.pages[0].b64
    && docCall.read.given === 'Scanned' && docCall.scanned.docGiven === 'Scanned' && docCall.scanned.docSurname === 'Person' && docCall.saved.docSurname === 'Persson',
    'scan, the save after it: the document goes to scan_feedback (H8a) — its own pages (not the contract), the AI\'s read, the fields the scan filled and the ones saved '
    + JSON.stringify({workerId: docCall.workerId, pages: (docCall.pages || []).map(x => x.doctype + (x.primary ? '*' : '')), scanned: docCall.scanned, saved: docCall.saved}));
  ok(lab.src === '/scan/?embed=1' && lab.camera === 'camera' && lab.copy && kinds0 === 'id_front,sefach' && /\(1\)/.test(otherDone) && scw.pages === 2 && /2/.test(scw.done)
    && scw.closed && scw.worker && scw.front && scw.given === 'Scanned' && scw.docId === '123456782' && scw.city === 'Haifa' && scw.kinds === 'front,contract:contract' && readCalls.length === 1,
    'scan window: the scanner lab\'s page copied as it is (/scan/, embed.js) inside the window; its shot\'s pages come back (a refined shot replaces them), each with Haiku\'s kind; Other is not saved, Contract is the contract; Done reads them in the window (one full read of the ID card) and opens the worker window with what was read ' + JSON.stringify({lab, kinds0, otherDone, scw, readCalls, kindCalls}));
  await p.unroute(/cloudfunctions\.net\/scan_feedback$/); await p.unroute(/cloudfunctions\.net\/ai_read$/);
  // The contract pages of a scan become one PDF, a page per photo (src/scan/pdf.ts).
  const cpdf = await p.evaluate(async jpg => {
    const b64 = await ManagerScan.imagesToPdf([{b64: jpg, mediaType: 'image/jpeg'}, {b64: jpg, mediaType: 'image/jpeg'}]);
    const txt = atob(b64);
    // A camera-sized page (3000 px wide) is scaled down to A4 at 200 dpi (1654 px); the small one goes in as it is.
    const cv = document.createElement('canvas'); cv.width = 3000; cv.height = 4000;
    const g = cv.getContext('2d'); g.fillStyle = '#eee'; g.fillRect(0, 0, 3000, 4000); g.fillStyle = '#000'; g.font = '80px sans-serif'; g.fillText('Contract', 200, 400);
    const big = cv.toDataURL('image/jpeg', 0.95).split(',')[1];
    const txt2 = atob(await ManagerScan.imagesToPdf([{b64: big, mediaType: 'image/jpeg'}, {b64: jpg, mediaType: 'image/jpeg'}]));
    const widths = [...txt2.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map(m => m[1] + 'x' + m[2]).join(',');
    return {head: txt.slice(0, 8), pages: (txt.match(/\/Type \/Page\b/g) || []).length, count: /\/Count 2\b/.test(txt), images: (txt.match(/\/DCTDecode/g) || []).length, eof: /%%EOF\s*$/.test(txt),
      size: JSON.stringify(ManagerScan.jpegSize(Uint8Array.from(atob(jpg), c => c.charCodeAt(0)))), widths, smaller: txt2.length < atob(big).length};
  }, JPG);
  ok(cpdf.head === '%PDF-1.4' && cpdf.pages === 2 && cpdf.count && cpdf.images === 2 && cpdf.eof && cpdf.size === '{"h":8,"w":8}' && cpdf.widths === '1654x2205,8x8' && cpdf.smaller,
    'scan contract: its pages become one PDF, a page per photo; a camera-sized page is scaled down to A4 at 200 dpi, a small one goes in as it is ' + JSON.stringify(cpdf));
  // A scanned contract that could not be saved marks the worker until a contract document is added.
  const cfail = await p.evaluate(() => {
    const w = workers[1]; w.contractUploadFailed = true;
    const n = workerNotices(w).find(x => x.title === 'Contract not saved');
    const r = {notice: !!n && n.lvl === 'red' && !!n.act, bar: workerBarColor(w, workerNotices(w))};
    ManagerBridge.addDocs(w.id, [{id: 'dc1', type: 'contract', name: 'c.pdf', fileId: 'f', url: 'u', mediaType: 'application/pdf', uploadedAt: new Date().toISOString(), expiry: ''}]);
    r.cleared = !w.contractUploadFailed && !workerNotices(w).some(x => x.title === 'Contract not saved');
    w.docs = (w.docs || []).filter(d => d.id !== 'dc1'); render();
    return r;
  });
  ok(cfail.notice && cfail.bar === 'var(--bad)' && cfail.cleared, 'scan contract not saved: a red notice on the worker until a contract document is added ' + JSON.stringify(cfail));
  // Field search: the card's missing rows and the modal's marked fields search the saved scan
  const fs = await p.evaluate(async () => {
    const a = await uploadWorkerFile({action:'saveWorkerAssets', workerId:'w1', scanB64:'SCAN', scanMediaType:'image/jpeg', sigPng:null, extraPages:[{b64:'SEF', mediaType:'image/jpeg'}], fileNameBase:'x'}, ()=>{});
    const w = workers[0]; w.assetsFileId = a.id; w.docType = 'israeli_id'; w.city = ''; w.address = '';
    openWorkerCard(0);
    const rowsBefore = ['city','address'].map(k => !!document.getElementById('cardMiss_'+k));
    document.getElementById('cardMiss_city').click();
    await T.until(() => w.city && !document.getElementById('cardMiss_city'));
    const r = {rowsBefore, city: w.city, cityRowGone: !document.getElementById('cardMiss_city'), addrRow: !!document.getElementById('cardMiss_address')};
    closeModal('workerCardOverlay');
    openEditWorker(0); await T.tick();
    r.marked = T.scan('wAddress') === 'missing' && !T.scan('wCity');
    document.getElementById('wAddress').click();
    await T.until(() => T.hint('address'));
    r.hint = !!T.hint('address') && T.val('wAddress') === '';
    T.fill('wAddress', 'Typed'); await T.tick();
    r.cleared = !T.scan('wAddress') && !T.hint('address');
    closeModal('workerOverlay');
    return r;
  });
  await p.setViewportSize({width:420, height:900});
  await p.evaluate(() => { workers[0].city=''; workers[0].address=''; openWorkerCard(0); });
  await p.waitForTimeout(300);
  await p.screenshot({path: SP + '/shot_card.png'});
  await p.evaluate(() => { closeModal('workerCardOverlay'); openEditWorker(0); document.getElementById('wAddress').scrollIntoView({block:'center'}); });
  await p.waitForTimeout(300);
  await p.screenshot({path: SP + '/shot_modal.png'});
  await p.evaluate(() => closeModal('workerOverlay'));
  await p.setViewportSize({width:1280, height:720});
  await p.evaluate(() => openWorkerCard(0)); await p.waitForTimeout(300);
  await p.screenshot({path: SP + '/shot_card_1280.png'});
  await p.evaluate(() => { closeModal('workerCardOverlay'); openEditWorker(0); }); await p.waitForTimeout(300);
  await p.screenshot({path: SP + '/shot_modal_1280.png'});
  await p.evaluate(() => closeModal('workerOverlay')); await p.waitForTimeout(300);
  ok(fs.rowsBefore.every(Boolean) && fs.city === 'חיפה' && fs.cityRowGone && fs.addrRow, 'card: tapping a missing row finds the city in the saved scan and saves it ' + JSON.stringify(fs));
  ok(fs.marked && fs.hint && fs.cleared, 'modal: empty scan field marked; not found shows a hint; typing clears the mark');
  // A field whose zoomed re-read disagreed is framed "check this" until edited
  const uc = await p.evaluate(() => {
    window.__aiRescanWorkerId = workers[1].id;
    openWorkerModalFromScan({type:'israeli_id', given:'Avi', city:'חיפה', __uncertain:['city']}, [{type:'israeli_id', given:'Avi', city:'חיפה', __uncertain:['city']}]);
    const r = {marked: T.scan('wCity') === 'check' && !!T.hint('city'), given: T.scan('wGiven') === 'check'};
    T.fill('wCity', 'Haifa');
    return T.tick().then(() => {
      r.cleared = !T.scan('wCity') && !T.hint('city');
      closeModal('workerOverlay'); window.__aiRescannedWorkerId = null;
      return r;
    });
  });
  ok(uc.marked && !uc.given && uc.cleared, 'modal: a field the two scan reads disagree on is marked "check" until edited');
  // Second pass right after a scan: empty fields are searched for on their own
  await srv('/aicalls');
  const af = await p.evaluate(async () => {
    window.__aiRescanWorkerId = null;
    window.__aiScanImage = {b64:'FRONT', mediaType:'image/jpeg'}; window.__aiPacketOtherPages = [{b64:'SEF', mediaType:'image/jpeg'}];
    openWorkerModalFromScan({type:'israeli_id', given:'Neo', surname:'Test', dob:'01/01/1990', sex:'M'});
    await T.until(() => T.val('wCity') && T.hint('address'));
    const r = {city: T.val('wCity'), addrHint: !!T.hint('address'), given: T.val('wGiven')};
    closeModal('workerOverlay'); window.__aiScanImage = null; window.__aiPacketOtherPages = [];
    return r;
  });
  ok(af.city === 'חיפה' && af.addrHint && af.given === 'Neo', 'after a scan, empty fields are searched automatically (city found, street not found → hint)');
  const calls = await srv('/aicalls');
  ok(calls.filter(c => c.includes('city')).length === 1 && calls.some(c => c.includes('city') && c.includes('address') && c.includes('houseNumber')), 'the empty fields go in ONE AI search ('+JSON.stringify(calls)+')');
  // Every growing list pages by 10; the next 10 come only when the user scrolls to the end
  for (const [w, h] of [[1280, 800], [390, 800]]) {
    await p.setViewportSize({width:w, height:h});
    const pg = await p.evaluate(async () => {
      const real = workers.slice();
      for (let i = 0; i < 25; i++) workers.push({id:'fake' + i, name:'Worker ' + i, colorIdx:i % 8, clientIds:[], schedule:DAYS.map(() => ({type:'work', start:'09:00', end:'17:00'}))});
      const out = {};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      switchTab('workers');
      for (const view of ['cards', 'list']) {
        document.querySelector(`#workersRoot [data-testid="workers-view"] [aria-label="${view === 'cards' ? 'Cards' : 'List'}"]`).click(); await wait(400);
        // the list view is a table on a computer, plates on a phone
        const sel = '#workersRoot [data-testid="worker-plate"], #workersRoot tbody tr';
        const first = document.querySelectorAll(sel).length;
        await wait(600);
        const stillFirst = document.querySelectorAll(sel).length;
        const pm = document.querySelector('#workersRoot [data-slot="paged-more"]');
        if (!pm) { out[view] = [first, stillFirst, -1, workers.length]; continue; }
        pm.scrollIntoView({block:'end'});
        window.dispatchEvent(new WheelEvent('wheel'));
        window.dispatchEvent(new Event('scroll'));
        await wait(400);
        out[view] = [first, stillFirst, document.querySelectorAll(sel).length];
      }
      switchTab('schedule'); render(); await wait(300);
      out.gantt = document.querySelectorAll('#scheduleRoot [data-testid="sched-worker"]').length;
      workers.length = 0; real.forEach(x => workers.push(x)); document.querySelector('#workersRoot [data-testid="workers-view"] [aria-label="Cards"]').click(); render();
      return out;
    });
    console.log('PAGING', w, JSON.stringify(pg));
    ok(pg.cards[0] === 10 && pg.cards[1] === 10 && pg.cards[2] === 20 && pg.list[0] === 10 && pg.list[1] === 10 && pg.list[2] === 20,
      `workers at ${w}px: 10 at first, no auto pre-load, +10 after scrolling to the end`);
    ok(pg.gantt === 10, `schedule rows: 10 at first at ${w}px`);
  }
  for (const [w, h] of [[390, 760], [1280, 700]]) {
    await p.setViewportSize({width:w, height:h});
    await p.evaluate(() => { switchTab('workers'); window.scrollTo(0, 0); });
    await sleep(400);
    await p.screenshot({path: SP + '/shot_workers_' + w + '.png'});
  }
  await p.setViewportSize({width:1280, height:720});
  // Firm owner: one Firms section with their own firm (no separate Profile), fresh profile for Form 101
  const fm = await p.evaluate(async () => {
    switchTab('admin');
    const btns = [...document.querySelectorAll('#adminRoot [data-testid="admin-tabs"] button')].map(b => b.dataset.k);
    switchAdminPane('firms');
    await new Promise(r => setTimeout(r, 2500));
    const own = document.querySelector('#adminRoot [data-testid="own-firm"]');
    const txt = own ? own.innerText : '';
    const prof = await refreshTenantProfile(0);
    // the React Firms section (stage 6f-2): one plate for the own firm, no super-admin bar, a tap edits it
    T.tap(own); await T.until(() => document.querySelector('#firmModal [data-testid="firm-window"]'), 3000);
    const win = document.querySelector('#firmModal [data-testid="firm-window"]');
    const edit = !!win && win.dataset.mode === 'mine' && document.getElementById('editFirmOverlay').classList.contains('open') && document.getElementById('fCompanyName').value === 'Firm One';
    closeModal('editFirmOverlay');
    return {btns, txt: txt.slice(0, 200), superBar: document.querySelector('#adminRoot [data-testid="firms-bar"]') ? 'flex' : 'none', prof: prof && prof.companyName, profile: !!document.getElementById('adminPane_profile'), edit};
  });
  console.log('FIRMS', JSON.stringify(fm));
  ok(fm.btns.includes('firms') && !fm.btns.includes('profile') && !fm.profile && /Firm One/.test(fm.txt) && /012345678/.test(fm.txt) && fm.superBar === 'none' && fm.prof === 'Firm One' && fm.edit,
    'owner: Firms shows own firm card (Form 101 fields), no Profile pane, a tap edits it; profile refreshes from the server ' + JSON.stringify(fm));
  // Uploads to Storage: a worker document, the sidecar read back, then deleted
  const up = await p.evaluate(async () => {
    const r = await uploadWorkerFile({action:'saveWorkerFile', workerId:'w1', fileBase64:btoa('hello'), fileName:'contract.pdf', mimeType:'application/pdf'}, ()=>{});
    const a = await uploadWorkerFile({action:'saveWorkerAssets', workerId:'w1', scanB64:'SCAN', scanMediaType:'image/jpeg', sigPng:null, extraPages:[{b64:'P2'}], fileNameBase:'x'}, ()=>{});
    const back = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'loadWorkerAssets', fileId:a.id})})).json();
    const del = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'deleteWorkerDoc', fileId:r.id})})).json();
    const old = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'deleteWorkerDoc', fileId:'1AbCdriveId'})})).json();
    return {r, a, back, del, old};
  });
  ok(up.r.ok && /^tenants\/tenant-one\/workers\/w1\/docs\//.test(up.r.id) && !!up.r.url, 'upload: worker document to Storage with a URL');
  ok(up.a.ok && /\/assets\//.test(up.a.id) && !up.a.url, 'upload: sidecar to Storage, no URL');
  ok(up.back.ok && up.back.scanB64 === 'SCAN' && up.back.extraPages.length === 1, 'loadWorkerAssets reads the sidecar back');
  ok(up.del.ok && up.old.ok, 'deleteWorkerDoc: Storage file deleted; a non-Storage id is a no-op');
  // Scan pages (docs/contracts.md → Scanned pages, D1): each page its own JPEG, the signature a PNG.
  await p.route(/cloudfunctions\.net\/fill_form_101$/, r => r.fulfill({status: 200, contentType: 'application/json',
    body: JSON.stringify({pdfBase64: btoa('%PDF-1.4 test'), fileName: 'f101.pdf', firmMissing: []})}));
  const sp = await p.evaluate(async ([jpg, jpg2]) => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const load = async ids => (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'loadWorkerPages', fileIds: ids})})).json();
    const id = 'wpages' + Date.now();
    workers.push({id, name:'Pages Test', docType:'israeli_id', docGiven:'Pages', docSurname:'Test', clientIds:[], schedule:[]});
    const w = () => workers.find(x => x.id === id);
    // 1. a new worker from a scan: the front, the ספח and the signature
    window.__aiScanImage = {b64: jpg, mediaType:'image/jpeg', kind:'id_front'};
    window.__aiPacketOtherPages = [{b64: jpg2, mediaType:'image/jpeg', kind:'sefach'}];
    window.__wCapturedSigPng = 'data:image/png;base64,' + PNG;
    const ok1 = await autoUploadWithRetry(true, id);
    const r = {ok1, kinds: (w().scanPages || []).map(x => x.kind + (x.primary ? '*' : '')).join(','), sig: !!w().sigFileId && !!w().sigSavedAt,
      noSidecar: !w().assetsFileId, paths: (w().scanPages || []).every(x => /\/workers\/wpages\d+\/pages\/\d+-\d-(id_front|sefach)\.jpg$/.test(x.fileId)),
      sigPath: /\/signature\/\d+-signature\.png$/.test(w().sigFileId || ''), hasSig: w().docHasSignature, extra: w().docExtraPages};
    const first = w().scanPages.slice(), firstSig = w().sigFileId;
    const back = await load([...first.map(x => x.fileId), firstSig]);
    r.back = back.ok && back.pages.length === 3 && back.pages[0].b64 === jpg && back.pages[1].b64 === jpg2 && back.pages[2].mediaType === 'image/png' && back.pages[2].b64 === PNG;
    // 2. a rescan of the front only: the ספח and the signature are kept as stored, the old front is deleted
    window.__aiScanImage = {b64: jpg2, mediaType:'image/jpeg', kind:'id_front'};
    window.__aiPacketOtherPages = [];
    const ok2 = await autoUploadWithRetry(true, id);
    const now = w().scanPages;
    r.rescan = ok2 && now.length === 2 && now[0].fileId !== first[0].fileId && now[1].fileId === first[1].fileId && w().sigFileId === firstSig && w().docHasSignature === true;
    const gone = await load([first[0].fileId]);
    r.oldFrontGone = gone.ok && gone.missing.length === 1;
    // 3. a worker still on the old sidecar is split into pages on its rebuild; the sidecar goes
    window.__aiScanImage = null; window.__aiPacketOtherPages = [];
    const a = await uploadWorkerFile({action:'saveWorkerAssets', workerId:id, scanB64:jpg, scanMediaType:'image/jpeg', sigPng:'data:image/png;base64,' + PNG, extraPages:[{b64:jpg2, mediaType:'image/jpeg'}], fileNameBase:'x'}, ()=>{});
    const before = w().scanPages.map(x => x.fileId).concat(w().sigFileId);
    delete w().scanPages; delete w().sigFileId; delete w().sigSavedAt; w().assetsFileId = a.id;
    // the card's field search reads the old sidecar too
    r.legacyRead = !!(await ManagerBridge.findScanFields(id, ['city'], 'israeli_id'));
    const ok3 = await regenerateWorkerDoc(id);
    const side = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'loadWorkerAssets', fileId:a.id})})).json();
    r.split = ok3 && !w().assetsFileId && (w().scanPages || []).map(x => x.kind + (x.primary ? '*' : '')).join(',') === 'id_front*,other' && !!w().sigFileId && side.error === 'File not found';
    // the split pages are readable; a rebuild of a split worker reads them and stores nothing new
    const keep = w().scanPages.map(x => x.fileId).join();
    const ok4 = await regenerateWorkerDoc(id);
    r.rebuild = ok4 && w().scanPages.map(x => x.fileId).join() === keep;
    r.newRead = !!(await ManagerBridge.findScanFields(id, ['city'], 'israeli_id'));
    // 4. deleting the worker deletes its pages and signature
    const all = w().scanPages.map(x => x.fileId).concat(w().sigFileId);
    ManagerBridge.deleteWorkers([id]);
    let after = null;
    for (let i = 0; i < 40; i++) { after = await load(all); if (after.ok && after.missing.length === all.length) break; await new Promise(res => setTimeout(res, 200)); }
    r.deleted = after.ok && after.missing.length === all.length && !workers.some(x => x.id === id);
    r.before = before.length;
    return r;
  }, [JPG, JPG2]);
  await p.unroute(/cloudfunctions\.net\/fill_form_101$/);
  ok(sp.ok1 && sp.kinds === 'id_front*,sefach' && sp.sig && sp.noSidecar && sp.paths && sp.sigPath && sp.hasSig === true && sp.extra === 1 && sp.back,
    'scan pages: a new worker from a scan stores each page as its own JPEG (with its kind, the ID card first) and the signature as a PNG, read back in one call ' + JSON.stringify(sp));
  ok(sp.rescan && sp.oldFrontGone, 'scan pages: a rescan of the front keeps the stored ספח and signature, the replaced front is deleted ' + JSON.stringify(sp));
  ok(sp.legacyRead && sp.split && sp.rebuild && sp.newRead, 'scan pages: a worker on the old sidecar is read, and split into pages on its rebuild (the sidecar deleted); a later rebuild reads the pages ' + JSON.stringify(sp));
  ok(sp.deleted, 'scan pages: deleting the worker deletes its pages and signature ' + JSON.stringify(sp));
  // Admin pane: users through the dispatcher
  ok(await p.evaluate(async () => { const j = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'listUsers'})})).json(); return (j.users||[]).some(u=>u.username==='sup1'); }), 'owner: listUsers via the dispatcher');
  ok(await p.evaluate(async () => (await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'nope'})})).json()).error === 'Unknown action: nope'), 'unknown action answers an error');
  // A supplier login's card in Users: its supplier's workers, add and unassign
  const sw = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    switchTab('admin'); switchAdminPane('users'); await wait(1500);
    const sup = loadAdminCache('users_' + activeTenantIdForAdmin()).find(u => u.username === 'sup1');
    await openEditUserForm(sup.id); await wait(300);
    // the user window and "Add workers" are React (stage 6f-2), drawn into #userFormModal / #hrAssignModal
    const team = () => document.querySelector('#userFormModal [data-testid="user-team"]').textContent;
    const r = {shown: !!document.querySelector('#userFormModal [data-sec="workers"]'), before: team()};
    document.querySelector('#userFormModal [data-testid="user-add-workers"]').click(); await wait(300);
    r.offered = document.querySelector('#hrAssignModal [data-testid="assign-list"]').textContent;
    r.over = document.getElementById('userFormOverlay').classList.contains('open') && document.getElementById('hrAssignOverlay').classList.contains('open');
    document.querySelector('#hrAssignModal [data-testid="assign-worker"][data-wid="w2"]').click(); await wait(50);
    document.querySelector('#hrAssignModal [data-testid="assign-save"]').click(); await wait(500);
    r.after = team(); r.assignClosed = !document.getElementById('hrAssignOverlay').classList.contains('open');
    r.w2 = workers.find(w => w.id === 'w2').supplierId;
    document.querySelector('#userFormModal [data-testid="team-worker"][data-wid="w2"] [data-testid="team-unassign"]').click(); await wait(400);
    r.back = workers.find(w => w.id === 'w2').supplierId; r.end = team();
    closeModal('userFormOverlay');
    return r;
  });
  ok(sw.shown && /Avi Cohen/.test(sw.before) && !/Dana Levi/.test(sw.before) && /Dana Levi/.test(sw.offered) && !/Avi Cohen/.test(sw.offered)
     && sw.over && sw.assignClosed && /Dana Levi/.test(sw.after) && sw.w2 === 's-1' && !sw.back && !/Dana Levi/.test(sw.end), 'users: a supplier login lists its supplier\'s workers; add and unassign ' + JSON.stringify(sw));
  // load whole history, then the punch log
  await p.evaluate(() => ensureAllPunches());
  ok(await waitFor(p, () => getPunchLog().length === 4), 'owner: all punches after ensureAllPunches');
  // Punch log (stage 6f-1, src/manager/Admin.tsx): 10 plates at first even with many punches
  const PL = '#adminRoot [data-testid="punchlog"]';
  for (const [w, h] of [[1280, 800], [390, 800]]) {
    await p.setViewportSize({width:w, height:h});
    const pl = await p.evaluate(async () => {
      const base = getPunchLog().slice();
      const now = Date.now(), extra = [];
      for (let i = 0; i < 60; i++) extra.push({id: 'x' + i, workerId: 'w1', workerName: 'Avi Cohen', type: i % 2 ? 'out' : 'in', time: '08:00', ts: now - i * 3600e3, date: '', site: '', clientId: 'c1'});
      __punchLogMem = null;
      try { savePunchLog(base.concat(extra)); } catch (e) {}
      switchTab('admin'); switchAdminPane('punchlog');
      await new Promise(r => setTimeout(r, 800));
      const rows = document.querySelectorAll('#adminRoot [data-testid="punch-row"]').length;
      const more = !!document.querySelector('#adminRoot [data-testid="punchlog"] [data-slot="paged-more"]');
      try { savePunchLog(base); } catch (e) {}
      render();
      return [rows, more, getPunchLog().length];
    });
    ok(pl[0] === 10 && pl[1], 'punch log: 10 plates and Show more with 64 punches (' + w + 'px) ' + JSON.stringify(pl));
  }
  // A worker card left open by an earlier check would cover the tab.
  await p.evaluate(() => [...document.querySelectorAll('.overlay.open')].forEach(o => closeModal(o.id))); await sleep(300);
  for (const [w, h] of [[390, 760], [1280, 720]]) {
    await p.setViewportSize({width:w, height:h});
    await p.evaluate(() => { switchTab('admin'); switchAdminPane(null); window.scrollTo(0,0); });
    await sleep(300);
    await p.screenshot({path: SP + '/shot_admin_idle_' + w + '.png'});
    await p.evaluate(() => switchAdminPane('punchlog'));
    await sleep(400);
    await p.screenshot({path: SP + '/shot_admin_log_' + w + '.png'});
  }
  await p.setViewportSize({width:1280, height:720});
  // The tiles while no section is chosen; a tile opens its section; the breadcrumb follows.
  const at = await p.evaluate(async () => {
    switchTab('admin'); switchAdminPane(null); await new Promise(r => setTimeout(r, 100));
    return {tiles: [...document.querySelectorAll('#adminRoot [data-testid="admin-tile"]')].map(t => t.dataset.k).join(), crumb0: document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim(),
      noRows: !document.querySelector('#adminRoot [data-testid="punch-row"]'), oldBar: !!document.getElementById('adminPaneBar'),
      superadmin: !!document.querySelector('#adminTabs [data-k="timings"]')};
  });
  await p.click('#adminRoot [data-testid="admin-tile"][data-k="punchlog"] [role="button"]'); await sleep(250);
  Object.assign(at, await p.evaluate(() => ({
    opened: __adminPane === 'punchlog' && !!document.querySelector('#adminRoot [data-testid="punchlog"]') && !document.querySelector('#adminRoot [data-testid="admin-tiles"]'),
    crumb: document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim(),
    figs: [...document.querySelectorAll('#adminRoot [data-slot="figures"] button span:first-of-type')].map(x => x.textContent).join()})));
  // Entering the tab again (Admin in the menu) brings the tiles back: no section is kept from before.
  at.back = await p.evaluate(async () => { switchTab('dashboard'); switchTab('admin'); await new Promise(r => setTimeout(r, 100));
    const back = __adminPane === null && !!document.querySelector('#adminRoot [data-testid="admin-tiles"]');
    switchAdminPane('punchlog'); await new Promise(r => setTimeout(r, 250)); // the checks below go on in the Punch Log
    return back; });
  // A super-admin also gets the Scanner lab tile (it opens /scan-lab/ in a new tab).
  ok(at.tiles === 'punchlog,firms,users' + (at.superadmin ? ',scanner,scanlab' : '') && at.crumb0 === 'Admin' && at.noRows && !at.oldBar && at.opened && at.crumb === 'Admin Punch Log' && at.figs === 'Total IN,Total OUT,Today,Total' && at.back,
    'admin: three tiles while no section is chosen (and the Scanner and the Scanner lab for a super-admin), a tile opens its section, the breadcrumb "Admin › Punch Log", the figures, back to the tiles on entering the tab again ' + JSON.stringify(at));
  // The filters: Radix selects — the date list is newest day first; the client filter uses the punch's own clientId.
  const pickFilter = async (k, label) => {
    await p.click(PL + ' [data-testid="punch-filter-' + k + '"]'); await p.waitForSelector('[role="option"]');
    if (label != null) await p.getByRole('option', {name: label, exact: true}).click(); else await p.keyboard.press('Escape');
    await sleep(150);
  };
  await p.click(PL + ' [data-testid="punch-filter-date"]'); await p.waitForSelector('[role="option"]');
  const dates = await p.evaluate(() => [...document.querySelectorAll('[role="option"]')].slice(1).map(o => o.textContent.trim()));
  await p.keyboard.press('Escape'); await sleep(150);
  const asTime = d => { const [dd,mm,yy] = d.split('/'); return new Date(+yy, mm-1, +dd).getTime(); };
  ok(dates.length === 2 && asTime(dates[0]) > asTime(dates[1]), 'date filter: newest day first (' + dates.join(', ') + ')');
  const count = () => p.evaluate(sel => document.querySelector(sel + ' [data-testid="punch-count"]').textContent, PL);
  const siteName = id => p.evaluate(cid => clients.find(c => c.id === cid).name, id);
  await pickFilter('client', await siteName('c2'));
  const c2rows = await count();
  ok(c2rows === '4 records', 'client filter uses the punch clientId (Site B → ' + c2rows + ')');
  await pickFilter('client', 'All clients');
  // A plate: ⋮ (Edit, Delete); Select — no boxes until the Select button, then tick two, Delete → Undo keeps them.
  const pls = {};
  pls.box0 = await p.evaluate(sel => !document.querySelector(sel + ' .og-box'), PL);
  await p.click(PL + ' [data-testid="punch-row"] button[aria-label="Actions"] >> nth=0'); await p.waitForSelector('[role="menuitem"]');
  pls.menu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
  await p.keyboard.press('Escape'); await sleep(150);
  pls.n0 = await p.evaluate(() => getPunchLog().length);
  await p.click(PL + ' [data-testid="punch-select"] button:has-text("Select")'); await sleep(150);
  pls.shown = await p.evaluate(sel => document.querySelectorAll(sel + ' .og-box').length > 0, PL);
  await p.click(PL + ' [data-testid="punch-row"] >> nth=0', {position: {x: 30, y: 14}}); await sleep(80);
  await p.click(PL + ' [data-testid="punch-row"] >> nth=1', {position: {x: 30, y: 14}}); await sleep(80);
  pls.count = await p.evaluate(() => (document.querySelector('[data-testid="select-bar"] b') || {}).textContent);
  pls.noWindow = await p.evaluate(() => !document.querySelector('[data-testid="punch-window"]'));
  await p.click('[data-testid="select-bar"] button:has-text("Delete")'); await sleep(400);
  pls.snack = await p.evaluate(() => /2 punches/.test(document.querySelector('[data-testid="undo-snack"]').textContent));
  pls.hidden = await count();
  await p.click('[data-testid="undo-snack"] button'); await sleep(400);
  pls.kept = await p.evaluate(n0 => getPunchLog().length === n0, pls.n0);
  pls.back = await count();
  ok(pls.box0 && pls.menu === 'Edit,Delete' && pls.shown && pls.count === '2 selected' && pls.noWindow && pls.snack && pls.hidden === '2 records' && pls.kept && pls.back === '4 records',
    'punch log: ⋮ (Edit, Delete); no boxes until Select, then a tap ticks a plate, Delete two through Undo ' + JSON.stringify(pls));
  // The punch window: a tap opens it; the notes and the type are saved, marked edited by admin.
  const pid = await p.evaluate(sel => document.querySelector(sel + ' [data-testid="punch-row"]').dataset.pid, PL);
  const pw = {};
  const pBefore = await p.evaluate(id => ({...getPunchLog().find(e => String(e.id) === id)}), pid);
  await p.click(PL + ' [data-testid="punch-row"] >> nth=0', {position: {x: 30, y: 14}}); await p.waitForSelector('[data-testid="punch-window"]');
  pw.title = await p.evaluate(() => /Edit Punch Record/.test(document.querySelector('[data-testid="window"]').innerText));
  await p.fill('[data-testid="punch-notes"]', 'checked by e2e');
  await p.click('[data-testid="punch-save"]'); await sleep(400);
  const pAfter = await p.evaluate(id => ({...getPunchLog().find(e => String(e.id) === id)}), pid);
  // editedBy stays local (updatePunch writes type, time, site, notes, clientId and editedAt); the live listener may bring the row back without it.
  pw.saved = pAfter.notes === 'checked by e2e' && !!pAfter.editedAt && pAfter.type === pBefore.type && pAfter.clientId === pBefore.clientId;
  if (!pw.saved) pw.rows = [pBefore, pAfter];
  pw.closed = await p.evaluate(() => !document.querySelector('[data-testid="punch-window"]'));
  await p.evaluate(id => { const log = getPunchLog(); const e = log.find(x => String(x.id) === id); e.notes = ''; savePunchLog(log); render(); }, pid);
  ok(pw.title && pw.saved && pw.closed, 'punch log: a tap opens the punch window; Save writes the notes and editedAt ' + JSON.stringify(pw));
  // By Client: a section per client with its workers.
  await p.click(PL + ' [data-testid="punchlog-view"] [data-v="clients"]'); await sleep(250);
  const bc = await p.evaluate(sel => ({secs: document.querySelectorAll(sel + ' [data-testid="punch-client"]').length, n: clients.length,
    dana: /Dana Levi/.test((document.querySelector(sel + ' [data-testid="punch-client"][data-cid="c2"]') || {}).innerText || ''), subs: document.querySelectorAll(sel + ' [data-testid="punch-client"][data-cid="c2"] [data-testid="punch-sub"]').length,
    noFilters: !document.querySelector(sel + ' [data-testid="punch-filters"]')}), PL);
  await p.click(PL + ' [data-testid="punchlog-view"] [data-v="log"]'); await sleep(200);
  ok(bc.secs === bc.n && bc.dana && bc.subs >= 1 && bc.noFilters, 'punch log: By Client — a section per client, its workers and their last punches ' + JSON.stringify(bc));
  // Clear Log behind the Alert Dialog: the months with their counts; Delete only with a month and DELETE typed; Cancel deletes nothing.
  await p.click(PL + ' [data-testid="punch-clear"]'); await p.waitForSelector('[data-testid="clear-log"]');
  const clr = {};
  clr.months = await p.evaluate(() => document.querySelectorAll('[data-testid="clear-month"]').length);
  clr.off0 = await p.evaluate(() => document.querySelector('[data-testid="clear-submit"]').disabled);
  await p.click('[data-testid="clear-month"] >> nth=0'); await sleep(80);
  clr.off1 = await p.evaluate(() => document.querySelector('[data-testid="clear-submit"]').disabled);
  await p.fill('[data-testid="clear-confirm"]', 'DELETE'); await sleep(80);
  clr.on = await p.evaluate(() => !document.querySelector('[data-testid="clear-submit"]').disabled && /record/.test(document.querySelector('[data-testid="clear-submit"]').textContent));
  await p.click('[data-testid="clear-log"] button:has-text("Cancel")'); await sleep(400);
  clr.closed = await p.evaluate(() => !document.querySelector('[data-testid="clear-log"]'));
  clr.kept = await p.evaluate(n0 => getPunchLog().length === n0, pls.n0);
  ok(clr.months >= 1 && clr.off0 && clr.off1 && clr.on && clr.closed && clr.kept, 'punch log: Clear Log asks in the Alert Dialog — months, DELETE typed, Cancel keeps every punch ' + JSON.stringify(clr));
  await pickFilter('client', await siteName('c1'));
  const c1rows = await count();
  ok(c1rows === '0 records', 'client filter: Avi\'s current client has no punches (' + c1rows + ')');
  await pickFilter('client', 'All clients');
  // CSV columns
  const csv = await p.evaluate(async () => { let txt=''; const orig=URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t=>txt=t); return 'blob:x'; }; HTMLAnchorElement.prototype.click = function(){}; await exportPunchCSV(); await new Promise(r=>setTimeout(r,300)); URL.createObjectURL=orig; return txt; });
  const lines = csv.split('\n').map(l => l.split('","').length);
  ok(lines.length === 5 && lines.every(n => n === lines[0]) && lines[0] === 10, 'CSV: every row has the 10 header columns');
  ok(/"8","n-p\d"/.test(csv), 'CSV: GPS Accuracy is filled (8) and Notes follow it');
  // payable by supplier
  await p.evaluate(async () => { switchTab('accounting'); await ManagerBridge.setPeriod('all'); });
  await sleep(500);
  const billing = await p.evaluate(async () => { setAccTab('billing'); await T.tick(50);
    const el = document.querySelector('#accountingRoot [data-testid=acc-payable]');
    const r = {pay: el ? el.innerText : '', shown: !!document.querySelector('#accountingRoot [data-testid=acc-billable]'), rows: document.querySelectorAll('#accountingRoot [data-testid=billable-row]').length};
    // A tap on the supplier's line: its workers behind the sum.
    const row = document.querySelector('#accountingRoot [data-testid=payable-row] .og-plate');
    if (row) { row.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'touch', isPrimary: true})); row.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerType: 'touch', isPrimary: true})); await T.tick(300); }
    r.detail = ((document.querySelector('[data-testid=acc-detail]') || {}).innerText || '').replace(/\s+/g, ' ');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(200);
    setAccTab('salary'); return r; });
  const pay = billing.pay, bill = {shown: billing.shown, rows: billing.rows};
  ok(!/No supplier assigned/.test(pay), 'Payable by supplier: no row for workers without a supplier');
  ok(!bill.shown && bill.rows === 0, 'Billable by client: hidden when no client has a billing rate ' + JSON.stringify(bill));
  ok(/Agency\s+8\.0h\s+₪40/.test(pay), 'Agency row: 8h × default commission 5 = ₪40 ' + JSON.stringify(pay));
  ok(/Avi Cohen 8\.0h ₪40 Total 8\.0h ₪40/.test(billing.detail), 'Payable by supplier: a tap shows the workers behind the sum ' + JSON.stringify(billing.detail));
  // Daily pay: Dana (1 day, 4h, own rate 40) paid by the day; then 5 days set by hand.
  // The days are set by hand in the pay window (period 'all' picked in Salary).
  const dp = await p.evaluate(async () => {
    const dana = () => ManagerAcc.salaryEntriesFor(accData(), 'all').byWorker.w2, w2 = workers.find(w => w.id === 'w2');
    const sum = () => ManagerAcc.buildSalaryExportRows(accData(), 'all').filter(r => r.worker === 'Dana Levi').reduce((s, r) => s + r.pay, 0);
    const out = {hourly: dana().total, hourlyExport: sum()};
    w2.payMode = 'daily'; render(); out.daily = dana().total; out.dailyExport = sum(); out.days = dana().countedDays;
    openPayModal('w2'); await T.tick(50); out.daysField = !!document.getElementById('payDays') && document.getElementById('payDays').placeholder === '1';
    T.fill('payDays', '5'); await T.tick(20); document.querySelector('#payModal [data-testid=pay-save]').click(); await T.tick(50);
    out.over = dana().total; out.overExport = sum();
    setAccTab('salary'); await T.tick(50);
    const row = [...document.querySelectorAll('#accountingRoot [data-testid=sal-table] tbody tr')].find(r => r.textContent.includes('Dana Levi'));
    if (row) { row.querySelector('td:nth-child(2)').click(); await T.tick(250); }
    const det = document.querySelector('[data-testid=window] [data-testid=sal-det]');
    out.cellInput = out.daysField && !!row && !row.querySelector('input') && !!det && /punches: 1/.test(det.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(200);
    out.aviDays = ManagerAcc.salaryEntriesFor(accData(), 'all').byWorker.w1.countedDays;
    delete w2.dayOverrides; delete w2.payMode; render(); out.back = dana().total;
    return out;
  });
  // Upload hours → Enter by hand, through the buttons: consecutive dates; a daily worker sends dates only,
  // an hourly worker's date-only row is explained, not dropped.
  const mu = await p.evaluate(async () => {
    const r = {};
    const click = sel => document.querySelector(sel).click();
    const pend = async () => ((await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadPendingHours'})})).json()).batches||[]).length;
    workers.find(w => w.id === 'w2').payMode = 'daily';
    openHoursImportModal('w2');
    const addBtn = () => document.querySelector('#hoursImportModal [data-testid="hours-add-row"]');
    addBtn().click(); await T.tick(); addBtn().click(); await T.tick(); addBtn().click(); await T.tick();
    r.dates = [...document.querySelectorAll('#hoursManualRows [data-row]')].map(i => i.dataset.date);
    r.btnOn = !document.getElementById('hoursImportSubmitBtn').disabled;
    const before = await pend();
    click('#hoursImportSubmitBtn');
    for(let i = 0; i < 40 && await pend() === before; i++) await new Promise(res => setTimeout(res, 150));
    r.sentDaily = (await pend()) - before;
    // The first send is done only when its reply cleared the rows; reopening sooner lets that reply clear the next row.
    for(let i = 0; i < 40 && document.querySelector('#hoursManualRows [data-row]'); i++) await new Promise(res => setTimeout(res, 100));
    closeModal('hoursImportOverlay');
    delete workers.find(w => w.id === 'w2').payMode;
    openHoursImportModal('w2');
    addBtn().click(); await T.tick();
    const before2 = await pend();
    // The toasts shown (src/manager/toast.ts draws each into #toast).
    const toasts = [], toastEl = document.getElementById('toast');
    const seen = new MutationObserver(() => { const t = toastEl.textContent; if(t && toasts[toasts.length - 1] !== t) toasts.push(t); });
    seen.observe(toastEl, {childList: true, subtree: true, characterData: true});
    click('#hoursImportSubmitBtn');
    for(let i = 0; i < 40 && !toasts.length; i++) await new Promise(res => setTimeout(res, 100));
    await new Promise(res => setTimeout(res, 300));
    seen.disconnect();
    r.sentHourly = (await pend()) - before2; r.toast = toasts.join(' | ');
    closeModal('hoursImportOverlay');
    return r;
  });
  const dd = d => { const x = new Date(d + 'T12:00'); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); };
  ok(mu.dates.length === 3 && mu.dates[1] === dd(mu.dates[0]) && mu.dates[2] === dd(mu.dates[1]) && mu.btnOn, 'upload hours: each new shift takes the next day ' + JSON.stringify(mu));
  ok(mu.sentDaily === 1, "upload hours: a daily worker's dates alone are sent " + JSON.stringify(mu));
  ok(mu.sentHourly === 0 && /paid by the hour/.test(mu.toast), "upload hours: an hourly worker's date-only shift is explained, not sent " + JSON.stringify(mu));
  ok(dp.hourly > 0 && dp.hourlyExport === dp.hourly, 'daily pay: hourly first, Salary = export ' + JSON.stringify(dp));
  ok(dp.daily === 40 && dp.dailyExport === 40 && dp.days === 1 && dp.cellInput && dp.aviDays === 1, 'daily pay: 1 day × 40 in Salary and in the export', JSON.stringify(dp));
  ok(dp.over === 200 && dp.overExport === 200 && dp.back === dp.hourly, 'daily pay: 5 days set by hand → 200, back to hourly → same as before', JSON.stringify(dp));
  await payrollCheck(p, 'manager', ['groupPunchesIntoShifts', 'analyzeDayPunches', 'effectiveRates', 'shiftPay', 'shiftPayFor', 'salaryPeriodKey', 'dayOverride', 'wOwnRate', 'localYMD'].concat(['travelPay']));
  // Accountant report: the Summary sheet carries the Salary figures (salaryEntriesFor), a total row and the Shifts sheet.
  const acc = await p.evaluate(async () => {
    await loadXlsx();
    let wb = null, name = ''; const orig = XLSX.writeFile; XLSX.writeFile = (w, n) => { wb = w; name = n; };
    switchTab('accounting'); setAccTab('salary'); await ManagerBridge.setPeriod('all'); await T.tick(50);
    document.querySelector('#accountingRoot [data-testid=sal-export]').click(); await T.until(() => document.querySelector('[data-testid=sal-export-accountant]'), 3000);
    document.querySelector('[data-testid=sal-export-accountant]').click(); await T.until(() => wb, 5000); XLSX.writeFile = orig;
    await ManagerBridge.setPeriod('week');
    if(!wb) return {none: true};
    const sum = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1});
    const avi = sum.find(r => r[0] === 'Avi Cohen') || [], tot = sum.find(r => r[0] === 'Total') || [];
    const e = salaryEntriesFor('all').byWorker.w1;
    return {name, sheets: wb.SheetNames, pay: avi[10], want: Math.round(e.total * 100) / 100, hours: avi[9], days: avi[5], total: tot[12],
      shifts: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], {header: 1}).length};
  });
  ok(!acc.none && /^accountant-all-/.test(acc.name) && acc.sheets.length === 2 && acc.pay === acc.want && acc.pay > 0 && acc.hours > 0 && acc.days >= 1 && acc.total >= acc.pay && acc.shifts > 1,
    'accountant report: Summary = Salary figures, total row, Shifts sheet ' + JSON.stringify(acc));
  // Stage 6e: the numbers of the React Accounting tab = the old tab's code (tests/accounting/legacy.mjs, run here
  // on the page's own data) — every Salary row and total, the figures, the alerts, the billing rows and their
  // details, the pay window, and the tables the exports write (salary Excel / CSV, the accountant workbook).
  await p.addScriptTag({content: require('fs').readFileSync(require('path').join(__dirname, '..', 'accounting', 'legacy.mjs'), 'utf8').replace(/^export function /gm, 'function ') + '\nwindow.legacyAccounting = legacyAccounting;'});
  const nums = await p.evaluate(async () => {
    const out = {diffs: [], checked: 0};
    const eq = (a, b, what) => { out.checked++; if (JSON.stringify(a) !== JSON.stringify(b)) out.diffs.push(what + ': ' + JSON.stringify(a) + ' vs old ' + JSON.stringify(b)); };
    const root = document.getElementById('accountingRoot'), wait = ms => new Promise(r => setTimeout(r, ms));
    const keepClients = JSON.parse(JSON.stringify(clients));
    clients.forEach((c, i) => { c.billRate = 70; c.rateMode = i ? 'fixed' : 'tiered'; c.fixedBillRate = 55; });  // billing rates, so Billable by client has rows
    const w1 = workers.find(w => w.id === 'w1'), keepW1 = JSON.parse(JSON.stringify(w1)); w1.travelAllowance = 12.5;
    render();
    await loadXlsx();
    const money2 = n => '₪' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US'), money0 = n => '₪' + n.toFixed(0), hrs1 = h => tr('{h}h', {h: h.toFixed(1)});
    for (const period of ['week', 'month', 'all']) {
      switchTab('accounting'); setAccTab('salary'); await ManagerBridge.setPeriod(period); await wait(100);
      const O = legacyAccounting({workers, clients, suppliers, log: getPunchLog(), tr, uiLocale: uiLocale(), session: null, hrUsers: hrUsers(), isFirmAdmin: isFirmAdminSession(), Payroll});
      const F = O.salaryFigures(period, '');
      // Salary: the rows (Data Table) and the totals.
      const rows = [...root.querySelectorAll('[data-testid=sal-table] tbody tr')].map(tr0 => { const c = [...tr0.cells].map(x => x.innerText.trim()); return {id: tr0.dataset.rowId, worker: c[0], hours: c[1], days: c[3], pay: c[5], travel: c[6], total: c[7]}; });
      eq(rows.map(r => r.id), F.rows.map(r => r.workerId), period + ' salary rows');
      F.rows.forEach((r, i) => { const d = rows[i] || {};
        eq([d.worker, d.hours, d.days, d.pay, d.travel, d.total], [r.worker, hrs1(r.hours), String(r.days), r.pay > 0 ? money2(r.pay) : '—', r.travel > 0 ? money2(r.travel) : '—', r.total > 0 ? money2(r.total) : '—'], period + ' row ' + r.workerId); });
      const sum = [...root.querySelectorAll('[data-testid=sal-sum] [data-slot=figures] b')].map(b => b.innerText.trim());
      if (F.rows.length) eq(sum, [hrs1(F.totals.hours), money2(F.totals.pay), F.totals.travel > 0 ? money2(F.totals.travel) : '—', money2(F.totals.total)], period + ' salary totals');
      const foot = [...root.querySelectorAll('[data-testid=sal-table] tfoot td')].map(x => x.innerText.trim());
      if (F.rows.length) eq([foot[1], foot[5], foot[7]], [hrs1(F.totals.hours), money2(F.totals.pay), money2(F.totals.total)], period + ' table totals');
      // The figures on top (shown on the other tabs) and the alerts.
      setAccTab('alerts'); await wait(50);
      eq([...root.querySelectorAll('[data-testid=acc-figs] [data-slot=figures] b')].slice(0, 2).map(b => b.innerText.trim()), [String(F.figs.hours), '₪' + F.figs.payroll.toLocaleString('en-US')], period + ' figures');
      eq([...root.querySelectorAll('[data-testid=alert-row]')].map(a => a.innerText.replace(/\s+/g, ' ').trim()), F.alerts.map(a => (a.title + ' ' + a.sub).replace(/\s+/g, ' ').trim()), period + ' alerts');
      // Billing: Payable by supplier (and its detail windows), by HR, Billable by client (and its details).
      setAccTab('billing'); await wait(50);
      const SP = O.supplierPayableFigures(F.entries);
      eq([...root.querySelectorAll('[data-testid=payable-row]')].map(r => [r.dataset.sid, r.innerText.replace(/\s+/g, ' ').trim()]), SP.rows.map(r => [r.id, (suppliers.find(x => x.id === r.id).name + ' ' + hrs1(r.hours) + ' ' + r.shown)]), period + ' payable by supplier');
      for (const d of SP.details) {
        T.tap(root.querySelector('[data-testid=payable-row][data-sid="' + d.id + '"]')); await wait(250);
        const lines = [...document.querySelectorAll('[data-testid=acc-detail] .grid-cols-\\[1fr_auto_auto\\]')].map(x => [...x.children].map(c => c.innerText.trim()));
        eq(lines, [...d.rows.map(r => [r.n, r.h, r.m]), [tr('Total'), d.total.h, d.total.m]], period + ' supplier detail ' + d.id);
        T.esc(); await wait(250);
      }
      eq([...root.querySelectorAll('[data-testid=hr-payable-row]')].length, O.hrPayableFigures(F.entries).length, period + ' payable by HR');
      const CB = O.clientBillableFigures(F.clientBillEntries, F.entries);
      eq([...root.querySelectorAll('[data-testid=billable-row]')].map(r => [r.dataset.cid, r.innerText.replace(/\s+/g, ' ').trim()]), CB.map(r => [r.id, clients.find(x => x.id === r.id).name + ' ' + hrs1(r.hours) + ' · ' + r.mode + ' ' + r.shown]), period + ' billable by client');
      for (const c of CB) {
        T.tap(root.querySelector('[data-testid=billable-row][data-cid="' + c.id + '"]')); await wait(250);
        const lines = [...document.querySelectorAll('[data-testid=acc-detail] .grid-cols-\\[1fr_auto_auto\\]')].map(x => [...x.children].map(e => e.innerText.trim()));
        eq(lines, [...c.detail.rows.map(r => [r.n, r.h, '']), [tr('Total'), c.detail.total.h, c.detail.total.m]], period + ' client detail ' + c.id);
        T.esc(); await wait(250);
      }
      // The pay window: the days counted (a daily worker) and the client's rate in the placeholder.
      const w2 = workers.find(w => w.id === 'w2'); w2.payMode = 'daily';
      openPayModal('w2'); await wait(80);
      const pw = O.payWindowFigures('w2', period, F.entries);
      eq(document.getElementById('payDays').placeholder, String(pw.counted), period + ' pay window: days counted');
      closeModal('payOverlay'); await wait(50); delete w2.payMode;
      // The exports: the tables written (the aoa SheetJS gets), every format, and the accountant workbook.
      const sheets = []; const origA = XLSX.utils.aoa_to_sheet, origW = XLSX.writeFile;
      XLSX.utils.aoa_to_sheet = aoa => { sheets.push(JSON.parse(JSON.stringify(aoa))); return origA(aoa); }; XLSX.writeFile = () => {};
      setAccTab('salary'); await wait(50);
      root.querySelector('[data-testid=sal-export]').click(); await T.until(() => document.querySelector('[data-testid=sal-export-excel]'), 3000);
      document.querySelector('[data-testid=sal-export-excel]').click(); await T.until(() => sheets.length === 1, 3000);
      eq(sheets[0], JSON.parse(JSON.stringify(O.salaryExportAoa(period))), period + ' salary export');
      root.querySelector('[data-testid=sal-export]').click(); await T.until(() => document.querySelector('[data-testid=sal-export-accountant]'), 3000);
      document.querySelector('[data-testid=sal-export-accountant]').click(); await T.until(() => sheets.length >= 3, 5000); await wait(200);
      const month = O.salaryMonthOf(period), docs = month ? await hourApprovalsOf(month, true) : null;
      const AS = O.accountantSheets(period, docs, (activeTenantProfile() || {}).companyName || '');
      eq(sheets.slice(1), JSON.parse(JSON.stringify([AS.summary, AS.shifts, ...(AS.approvals ? [AS.approvals] : [])])), period + ' accountant workbook');
      if (SP.rows.length) {
        setAccTab('billing'); await wait(50); sheets.length = 0;
        root.querySelector('[data-testid=payable-excel]').click(); await T.until(() => sheets.length, 3000);
        eq(sheets[0], JSON.parse(JSON.stringify(O.payableAoa(SP.exportRows))), period + ' payable summary export');
      }
      XLSX.utils.aoa_to_sheet = origA; XLSX.writeFile = origW;
      out[period] = {rows: F.rows.length, pay: F.totals.total, payable: SP.rows.length, billable: CB.length, alerts: F.alerts.length};
    }
    clients.forEach((c, i) => { Object.keys(c).forEach(k => { if (!(k in keepClients[i])) delete c[k]; }); Object.assign(c, keepClients[i]); });
    Object.keys(w1).forEach(k => { if (!(k in keepW1)) delete w1[k]; }); Object.assign(w1, keepW1);
    await ManagerBridge.setPeriod('week'); setAccTab('salary'); render();
    return out;
  });
  ok(!nums.diffs.length && nums.checked > 30 && nums.all && nums.all.rows >= 2 && nums.all.payable >= 1 && nums.all.billable >= 1,
    'accounting numbers: the React tab and its exports equal the old tab\'s code on the e2e data (' + nums.checked + ' figures) ' + JSON.stringify(nums));
  // Workers search: by ID / passport number (dashes ignored) and by client.
  const srch = await p.evaluate(async () => {
    const avi = workers.find(w => w.id === 'w1'), keep = avi.docId; avi.docId = '12345678-2';
    switchTab('workers'); render(); await new Promise(r => setTimeout(r, 50));
    const box = document.querySelector('#workersRoot [data-testid="workers-search"]');
    const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const find = async q => { setVal.call(box, q); box.dispatchEvent(new Event('input', {bubbles: true})); await new Promise(r => setTimeout(r, 50));
      return ' ' + document.querySelectorAll('#workersRoot [data-testid="worker-plate"]').length; };
    const out = {id: await find('123456782'), client: await find('site a'), none: await find('99999')};
    await find(''); if(keep === undefined) delete avi.docId; else avi.docId = keep; render();
    return out;
  });
  ok(/ 1$/.test(srch.id) && / 1$/.test(srch.client) && / 0$/.test(srch.none), 'workers search: by ID / passport number and by client ' + JSON.stringify(srch));
  // "NEW" for 3 days after a worker is added: on the worker cards, not on an older worker.
  const nw = await p.evaluate(async () => {
    const a = workers.find(w => w.id === 'w1'), d = workers.find(w => w.id === 'w2');
    const keep = [a.createdAt, d.createdAt];
    a.createdAt = new Date(Date.now() - 2 * 864e5).toISOString(); d.createdAt = new Date(Date.now() - 4 * 864e5).toISOString();
    switchTab('workers'); await new Promise(r => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('#workersRoot [data-testid="worker-plate"]')].map(c => ({name: c.querySelector('[data-testid="worker-name"]').title, isNew: !!c.querySelector('[data-testid="new-badge"]')}));
    a.createdAt = keep[0]; d.createdAt = keep[1];
    return cards;
  });
  ok(nw.some(c => /Avi/.test(c.name) && c.isNew) && nw.some(c => /Dana/.test(c.name) && !c.isNew), 'worker cards: NEW for 3 days after the worker was added ' + JSON.stringify(nw));
  // The worker plate (redesign stage 3): notice chips → the notices sheet → the worker card with Info / Docs / Hours; Delete → Undo → deleted after 5 s; Select → a bulk status.
  const wp = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const w1 = workers.find(w => w.id === 'w1');
    window.__wpKeep = {failed: w1.docUploadFailed, status: w1.status};
    w1.docUploadFailed = true;
    // A clean start: an earlier step's window (the worker form opened from a card) can still be on its way back
    // (__returnTo brings the card back ~60 ms after it closes) and would open the card under this step.
    await wait(300);
    for (let i = 0; i < 5 && document.querySelector('.overlay.open'); i++) {
      document.querySelectorAll('.overlay').forEach(o => { o.__returnTo = null; o.classList.remove('open'); });
      await wait(300);
    }
    switchTab('workers'); render(); await wait(200);
    const plate = document.querySelector('#workersRoot [data-testid="worker-plate"][data-wid="w1"]'), r = {};
    const chip = plate.querySelector('[data-testid="worker-chip1"] [data-testid="notice-chip"]');
    r.chip = chip && chip.dataset.lvl; r.more = !!plate.querySelector('[data-testid="notice-more"]'); r.bar = plate.querySelector('.og-plate').style.getPropertyValue('--bar');
    chip.click(); await wait(150);
    r.sheet = document.getElementById('noticesOverlay').classList.contains('open'); r.notices = [...document.querySelectorAll('#noticesModal [data-testid="notice"] b')].map(b => b.textContent);
    r.head = document.querySelector('#noticesModal [data-testid="worker-head-name"]').textContent; r.card0 = document.getElementById('workerCardOverlay').classList.contains('open');
    document.querySelector('#noticesModal [data-testid="notices-open-card"]').click(); await wait(300);
    r.card = document.getElementById('workerCardOverlay').classList.contains('open') && !document.getElementById('noticesOverlay').classList.contains('open');
    const panes = () => [...document.querySelectorAll('#workerCardModal [data-p]')].filter(x => x.tagName === 'DIV' && !x.hidden).map(x => x.dataset.p).join();
    const pane = async k => { document.querySelector('#workerCardModal [data-testid="card-panes"] [data-p="' + k + '"]').click(); await wait(50); };
    r.panes = [panes()]; await pane('docs'); r.panes.push(panes()); await pane('hours'); r.panes.push(panes());
    r.hoursStatus = !!document.querySelector('#workerCardModal [data-testid="card-hours"]');
    r.edit = !!document.getElementById('workerCardEdit'); await pane('info');
    // closing the card brings the notices sheet back; on a slow runner that takes longer than a fixed 200 ms, so up to 3 s
    closeModal('workerCardOverlay');
    for (let i = 0; i < 20 && !document.getElementById('noticesOverlay').classList.contains('open'); i++) await wait(150);
    r.backToNotices = document.getElementById('noticesOverlay').classList.contains('open'); closeModal('noticesOverlay'); w1.docUploadFailed = window.__wpKeep.failed;
    workers.push({id:'wtmp', name:'Temp Worker Del', colorIdx:1, clientIds:[], schedule:[]}); render(); await wait(100);
    return r;
  });
  // Delete: Undo keeps the worker; a second Delete removes it only after 5 s.
  const tmpSel = '#workersRoot [data-testid="worker-plate"][data-wid="wtmp"]';
  const delTmp = async () => { await p.click(tmpSel + ' button[aria-label="Actions"]'); await sleep(150);
    const menu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
    await p.click('[role="menuitem"]:has-text("Delete")'); await sleep(400); return menu; };
  wp.menu = await delTmp();
  Object.assign(wp, await p.evaluate(sel => ({pendingHidden: !document.querySelector(sel), stillThere: workers.some(w => w.id === 'wtmp')}), tmpSel));
  await p.click('[data-testid="undo-snack"] button'); await sleep(400);
  wp.undone = await p.evaluate(sel => !!document.querySelector(sel) && workers.some(w => w.id === 'wtmp'), tmpSel);
  await delTmp();
  Object.assign(wp, await p.evaluate(sel => { render(); return {leftOut: !document.querySelector(sel), notYet: workers.some(w => w.id === 'wtmp')}; }, tmpSel));
  await sleep(5400); wp.deleted = await p.evaluate(() => !workers.some(w => w.id === 'wtmp'));
  // Select: a Select button above the plates and no boxes; after it "0 selected · Select all", a tick → Vacation.
  const wsel = '#workersRoot [data-testid="workers-select"]';
  wp.selHead = await p.evaluate(sel => { const h = document.querySelector(sel); return !!h && /^Select$/.test(h.innerText.trim()) && !document.querySelector('#workersRoot .og-box') && !document.querySelector('[data-testid="select-bar"]'); }, wsel);
  await p.click(wsel + ' button:has-text("Select")'); await sleep(100);
  wp.selOn = await p.evaluate(sel => /0 selected/.test(document.querySelector(sel).innerText) && /Select all/.test(document.querySelector(sel).innerText), wsel);
  await p.click('#workersRoot [data-testid="worker-plate"][data-wid="w1"] [role="button"]', {position: {x: 30, y: 14}}); await sleep(100);
  wp.sel = await p.evaluate(() => (document.querySelector('[data-testid="select-bar"] b') || {}).textContent);
  await p.click('[data-testid="sel-vacation"]'); await sleep(150);
  wp.vac = await p.evaluate(sel => workers.find(w => w.id === 'w1').status === 'vacation' && !document.querySelector('[data-testid="select-bar"]') && /^Select$/.test(document.querySelector(sel).innerText.trim()), wsel);
  await p.evaluate(() => { workers.find(w => w.id === 'w1').status = window.__wpKeep.status; render(); autoSave(); });
  ok(wp.chip === 'red' && wp.more && wp.bar === 'var(--red)' && wp.sheet && wp.notices.includes('Upload failed') && wp.head === 'Avi Cohen' && wp.card && wp.backToNotices, 'worker plate: a red notice chip opens the notices sheet; "Open worker card" opens the card, closing it goes back to the sheet ' + JSON.stringify(wp));
  ok(wp.panes.join('|') === 'info|docs|hours' && wp.hoursStatus && wp.edit, 'worker card: Info / Docs / Hours switch, one Edit button ' + JSON.stringify(wp.panes));
  ok(wp.menu === 'Edit,Open card,Pay,Punch link,Delete' && wp.pendingHidden && wp.stillThere && wp.undone && wp.leftOut && wp.notYet && wp.deleted, 'workers: Delete never asks — Undo keeps the worker, otherwise it is removed after 5 s ' + JSON.stringify(wp));
  ok(wp.selHead && wp.selOn && wp.sel === '1 selected' && wp.vac, 'workers: a Select button, boxes only after it; a tick, the bulk bar sets Vacation and Select ends ' + JSON.stringify({selHead: wp.selHead, selOn: wp.selOn, sel: wp.sel, vac: wp.vac}));
  // Worker documents (stage 13): plates with Select in the card's Docs pane; bulk Delete through Undo; closing the card ends Select and the workers list keeps its own.
  const wd = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const w = workers[0]; window.__wdKeep = w.docs;
    w.docs = [{id:'d1', type:'contract', name:'contract.pdf', url:'#', uploadedAt:'2026-01-02'}, {id:'d2', type:'other', name:'visa.jpg', url:'#', uploadedAt:'2026-01-01'}];
    switchTab('workers'); await wait(100);
    openWorkerCard(0); await wait(300);
    document.querySelector('#workerCardModal [data-testid="card-panes"] [data-p="docs"]').click(); await wait(100);
    const docs = () => [...document.querySelectorAll('#workerCardModal [data-testid="worker-doc"]')];
    r.plates = docs().length; r.boxes0 = !document.querySelector('#workerCardModal .og-box');
    const head = () => document.querySelector('#workerCardModal [data-testid="card-docs"]');
    [...head().querySelectorAll('button')].find(b => b.textContent.trim() === 'Select').click(); await wait(100);
    r.head = /0 selected/.test(head().textContent) && document.querySelectorAll('#workerCardModal .og-box').length === 2;
    [...head().querySelectorAll('.sel-head button')].find(b => /Select all/.test(b.textContent)).click(); await wait(100);
    r.bar = (document.querySelector('[data-testid="select-bar"] b') || {}).textContent;
    [...document.querySelectorAll('[data-testid="select-bar"] button')].find(b => /Delete/.test(b.textContent)).click(); await wait(400);
    r.pending = w.docs.length === 2 && !docs().length && /2 documents/.test(document.querySelector('[data-testid="undo-snack"]').textContent);
    document.querySelector('[data-testid="undo-snack"] button').click(); await wait(400);
    r.undone = docs().length === 2 && w.docs.length === 2;
    return r;
  });
  await p.click('#workerCardModal [data-testid="worker-doc"][data-doc="d2"] button[aria-label="Actions"]'); await sleep(200);
  wd.menu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => (/red-soft/.test(b.className) ? '!' : '') + b.innerText.trim()).join());
  await p.click('[role="menuitem"]:has-text("Delete")'); await sleep(5600);
  Object.assign(wd, await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {}, w = workers[0];
    r.deleted = w.docs.map(d => d.id).join();
    const head = document.querySelector('#workerCardModal [data-testid="card-docs"]');
    [...head.querySelectorAll('button')].find(b => b.textContent.trim() === 'Select').click(); await wait(100);
    r.barOn = !!document.querySelector('[data-testid="select-bar"]');
    closeModal('workerCardOverlay'); await wait(200);
    r.back = !document.querySelector('[data-testid="select-bar"]') && !!document.querySelector('#workersRoot [data-testid="workers-select"] button');
    w.docs = window.__wdKeep; render();
    return r;
  }));
  ok(wd.plates === 2 && wd.boxes0 && wd.head && wd.bar === '2 selected' && wd.pending && wd.undone && wd.menu === 'Open,!Delete' && wd.deleted === 'd1' && wd.barOn && wd.back, 'worker documents: plates with Select, bulk Delete through Undo, ⋮ Delete after 5 s, Select ends when the card closes and the workers list keeps its Select ' + JSON.stringify(wd));
  // Editors as section plates (redesign stage 4): worker, client, supplier, user.
  const ed = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const secs = id => [...document.querySelectorAll('#' + id + ' .og-sec')].filter(x => x.style.display !== 'none').map(x => x.dataset.sec + (x.classList.contains('open') ? '*' : ''));
    // The worker editor is React (stage 6c-2): its section plates are Accordion items.
    openEditWorker(workers.findIndex(w => w.id === 'w2')); await wait(200);
    const wsec = k => document.querySelector('#workerModal [data-sec="' + k + '"]');
    r.worker = [...document.querySelectorAll('#workerModal [data-sec]')].map(x => x.dataset.sec);
    r.personSum = wsec('person').querySelector('[data-slot="accordion-trigger"] small').textContent;
    r.sexSeg = document.getElementById('wSex').getAttribute('role') === 'radiogroup' && document.getElementById('wMaritalStatus').getAttribute('role') === 'combobox' && document.getElementById('wSpouseIncome').getAttribute('role') === 'radiogroup';
    document.querySelector('#wSex [data-v="F"]').click(); await wait(50); r.sexVal = T.val('wSex');
    const acc = wsec('access'), wasOpen = acc.dataset.state === 'open';
    acc.querySelector('[data-slot="accordion-trigger"]').click(); await wait(50); r.toggles = (acc.dataset.state === 'open') !== wasOpen;
    r.closedHidden = [...document.querySelectorAll('#workerModal [data-sec][data-state="closed"] [data-slot="accordion-content"]')].every(c => c.hidden) && !!document.getElementById('wCity');
    r.noSave = ![...document.querySelectorAll('#workerModal button')].some(b => /^\s*Save/.test(b.textContent));
    workers.find(w => w.id === 'w2').docSex = workers.find(w => w.id === 'w2').docSex; closeModal('workerOverlay');
    // The client and supplier windows are React (stage 6d): their section plates are Accordion items too.
    const rsecs = id => [...document.querySelectorAll('#' + id + ' [data-sec]')].map(x => x.dataset.sec + (x.dataset.state === 'open' ? '*' : ''));
    openEditClient(clients[0].id); await wait(100); r.client = rsecs('clientModal'); closeModal('clientOverlay');
    openAddSupplier(); await wait(100); r.supplier = rsecs('supplierModal'); r.supSave = !!document.querySelector('#supplierModal [data-testid="supplier-save"]');
    r.supNameAmber = document.querySelector('#supplierModal [data-sec="supplier"]').style.getPropertyValue('--c').trim(); closeModal('supplierOverlay');
    openEditSupplier(suppliers[0].id); await wait(100); r.supplierEdit = rsecs('supplierModal').map(x => x.replace('*', '')).join(); closeModal('supplierOverlay'); await wait(150);
    // the user window is React (stage 6f-2): the section plates Accordion items; no role switch (the template says the role)
    openCreateUserForm(); await wait(100); r.user = rsecs('userFormModal'); r.noRole = !document.querySelector('#userFormModal [data-testid="user-role"]'); closeModal('userFormOverlay');
    // closing one window brings back the one it was opened over: close them all
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    return r;
  });
  ok(ed.worker.join() === 'person,address,work,documents,form101,access' && /Dana/.test(ed.personSum) && ed.sexSeg && ed.sexVal === 'F' && ed.toggles && ed.closedHidden && ed.noSave,
    'editors: the worker editor is section plates (Person · Address · Work · Documents · Form 101 · Access), summaries, segmented choices, closed sections keep their fields, no Save ' + JSON.stringify(ed));
  ok(ed.client.join() === 'client,place,rates' && ed.supplier.join() === 'supplier*' && ed.supSave && /f5a623|--warn/.test(ed.supNameAmber) && ed.user[0] === 'person*' && ed.user.map(x => x.replace('*', '')).join() === 'person,sections' && ed.supplierEdit === 'supplier,commission,workers' && ed.noRole,
    'editors: client, supplier (one Save, an empty name amber) and user form as section plates ' + JSON.stringify(ed));
  // Redesign gaps: client billing by the day; the supplier editor's payable commission and editable portal ticks (saved at once).
  const gp = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    r.daily = [ManagerAcc.clientBillPay(5, {rateMode:'daily', dailyBillRate:300}), ManagerAcc.clientBillPay(0, {rateMode:'daily', dailyBillRate:300}), ManagerAcc.clientBillPay(11, {rateMode:'daily', dailyBillRate:300}, true)].join();
    openEditClient(clients[0].id); await wait(100);
    document.querySelector('#cPayUnit [data-unit="day"]').click(); await wait(50);
    r.dayRow = !!document.getElementById('cBillDaily') && !document.getElementById('cHourlyBill') && !document.getElementById('cBillMain');
    document.querySelector('#cPayUnit [data-unit="hour"]').click(); await wait(50);
    r.hourBack = !document.getElementById('cBillDaily') && !!document.getElementById('cHourlyBill'); closeModal('clientOverlay'); await wait(150);
    openEditSupplier('s-1'); await wait(150);
    const m = document.getElementById('supplierModal');
    r.payable = /commission/.test(m.querySelector('[data-sec="commission"]').textContent);
    // its logins are made in Admin → Users only: no login section, no New login button here
    r.noLogins = !m.querySelector('[data-sec="portal"]') && !m.querySelector('[data-testid="new-login"]');
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    return r;
  });
  ok(gp.daily === '300,0,300' && gp.dayRow && gp.hourBack, 'clients: billing by the day — one day rate per worked shift, the By day / By hour switch ' + JSON.stringify(gp));
  ok(gp.payable && gp.noLogins, 'supplier editor: commission payable this month; no login section (logins are made in Admin → Users) ' + JSON.stringify(gp));
  // Stage 13: the supplier's own commission rate, set in the supplier window by the owner (per hour / per day, applies from).
  const scom = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const SP = () => suppliers.find(x => x.id === 's-1'), keep = SP().commission;
    const mine = Object.values(salaryEntriesFor('month').byWorker).filter(e => (workers.find(w => w.id === e.workerId) || {}).supplierId === 's-1');
    const hours = mine.reduce((t, e) => t + e.hours, 0), days = mine.reduce((t, e) => t + e.dayKeys.size, 0);
    r.def = Math.round(supplierMonthPayable(SP())) === Math.round(hours * 5);
    // "Applies from" is a Date Picker: the 1st of this month is picked in its calendar.
    const first = localYMD(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const pickFirst = async () => { document.getElementById('sComFrom').click(); await T.until(() => document.querySelector('[data-day="' + first + '"] button'), 3000);
      document.querySelector('[data-day="' + first + '"] button').click(); await wait(100); };
    const save = () => document.querySelector('#supplierModal [data-testid="supplier-save"]').click();
    openEditSupplier('s-1'); await wait(150);
    r.fields = !!document.getElementById('sComRate') && !!document.getElementById('sComFrom') && !!document.getElementById('sComMode');
    T.fill('sComRate', '10'); await pickFirst(); r.from = document.getElementById('sComFrom').innerText.trim();
    save(); await wait(200);
    r.saved = JSON.stringify(SP().commission);
    r.hour = Math.round(supplierMonthPayable(SP())) === Math.round(hours * 10);
    openEditSupplier('s-1'); await wait(150);
    document.querySelector('#sComMode [data-m="day"]').click(); await wait(50); T.fill('sComRate', '50'); await pickFirst();
    save(); await wait(200);
    r.day = Math.round(supplierMonthPayable(SP())) === days * 50;
    // A rate from tomorrow on does not change this month's shifts so far.
    SP().commission = [{from: localYMD(new Date(Date.now() + 864e5)), mode: 'hour', rate: 99}];
    r.future = Math.round(supplierMonthPayable(SP())) === Math.round(hours * 5);
    const sp0 = SP(); if(keep === undefined) delete sp0.commission; else sp0.commission = keep; render(); autoSave(); await wait(800);
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    r.hours = hours; r.days = days;
    return r;
  });
  ok(scom.def && scom.fields && scom.hour && scom.day && scom.future && scom.hours > 0, 'supplier commission: the supplier window sets per hour / per day from a date; Payable follows it shift by shift ' + JSON.stringify(scom));
  // Stage 11a: a "no punch" notice has WhatsApp next to Call — wa.me with the phone in international form and the firm's template.
  const wa = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    r.phones = [waPhone('050-123 4567'), waPhone('+972 50 1234567'), waPhone('00972501234567'), waPhone('12')].join();
    const w = workers.find(x => x.id === 'w2'), keep = {phone: w.phone, ds: w.dateShifts, status: w.status};
    w.phone = '052-765 4321'; w.status = 'active'; w.dateShifts = Object.assign({}, w.dateShifts, {[localYMD(new Date())]: {type:'work', start:'00:01', end:'23:59'}});
    await loadFirmMessages(true);
    r.defLink = decodeURIComponent(waLink(w, {start:'00:01'}));
    openMyFirmForm(); await wait(800);
    r.field = !!document.querySelector('#firmModal [data-testid="firm-wa"]') && /full name/.test(document.getElementById('fWa').value);
    // the reminder is saved on its own when it changes (on leaving the field)
    const ta = document.getElementById('fWa'); ta.focus(); T.fill(ta, 'Hello {first name}, shift at {start} · {site}'); await wait(50); ta.blur();
    await T.until(() => __firmMsgs && __firmMsgs.waTemplate === 'Hello {first name}, shift at {start} · {site}', 4000);
    closeModal('editFirmOverlay'); await wait(200);
    __firmMsgs = null; await loadFirmMessages(true);
    r.saved = __firmMsgs.waTemplate;
    const n = notifList().find(x => x.id.includes('nopunch:w2:'));
    r.bellActs = n ? n.acts.map(a => a.label).join() : 'none';
    openNotices('w2'); await wait(200);
    const btn = document.querySelector('#noticesModal [data-testid="notice-act"][data-wa]');
    r.sheetBtn = !!btn && /Call/.test(document.getElementById('noticesModal').innerText);
    let opened = null; const wo = window.open; window.open = u => { opened = u; return null; };
    if(btn) btn.click(); window.open = wo;
    r.link = opened ? decodeURIComponent(opened) : '';
    closeModal('noticesOverlay');
    await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'saveFirmMessages', waTemplate:''})})).json();
    __firmMsgs = null;
    Object.assign(w, {phone: keep.phone, status: keep.status}); w.dateShifts = keep.ds;
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    return r;
  });
  ok(wa.phones === '972501234567,972501234567,972501234567,' && /^https:\/\/wa\.me\/972527654321\?text=Hi .+, you have not punched in today \(shift 00:01 · /.test(wa.defLink), 'WhatsApp: the phone in international form, the default message ' + JSON.stringify(wa));
  ok(wa.field && wa.saved === 'Hello {first name}, shift at {start} · {site}' && wa.bellActs === 'Call,WhatsApp' && wa.sheetBtn && /^https:\/\/wa\.me\/972527654321\?text=Hello \S+, shift at 00:01 · /.test(wa.link),
    'WhatsApp: the firm template saved in the firm form; Call + WhatsApp on a no-punch notice (bell and notices sheet) open wa.me with it ' + JSON.stringify(wa));
  // Worker list header (the owner's fixed structure): "Workers N", glass New, ⋮; tabs Active / Vacation / Pending.
  const wh = await p.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    switchTab('workers'); await wait(50);
    const crumb = () => document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim();
    const chips = () => [...document.querySelectorAll('#workersRoot [data-testid="workers-chips"] button')].map(b => b.dataset.key + ':' + b.innerText.trim()).join();
    const tabs = () => [...document.querySelectorAll('#workersRoot #workersTabs button')], r = {tabs: tabs().map(b => b.textContent).join(), count: crumb()};
    tabs()[1].click(); await wait(50); r.vac = chips() === 'status:On vacation' && tabs()[1].classList.contains('on'); r.crumbVac = crumb();
    tabs()[1].click(); await wait(50); r.cleared = chips() === '' && !tabs().some(b => b.classList.contains('on'));
    tabs()[2].click(); await wait(50); r.pending = chips() === 'docs:Documents incomplete'; tabs()[2].click(); await wait(50);
    const scan = document.querySelector('#workersRoot [data-testid="workers-scan"]');
    r.scan = !!scan && /Scan passport/.test(scan.textContent) && scan.classList.contains('og-btn') && !!document.querySelector('#workersRoot [data-testid="workers-new"].og-new');
    // Filters: hidden until the button, its count, the open state kept on this device
    const fb = document.querySelector('#workersRoot [data-testid="workers-filters-btn"]');
    r.filtersHidden = !document.querySelector('#workersRoot [data-testid="workers-filters"]');
    fb.click(); await wait(50);
    r.filtersOpen = document.querySelectorAll('#workersRoot [data-testid="workers-filters"] [data-testid^="wf-"]').length === 5 && localStorage.getItem('workersFiltersOpen') === '1';
    fb.click(); await wait(50);
    return r;
  });
  ok(wh.tabs === 'Active,Vacation,Pending' && /^Workers \d+$/.test(wh.count) && wh.vac && /^Workers \d+ Vacation$/.test(wh.crumbVac) && wh.cleared && wh.pending && wh.scan && wh.filtersHidden && wh.filtersOpen,
    'workers: the breadcrumb "Workers N › <tab>", New and a glass Scan passport, tabs Active / Vacation / Pending set the filters (a chip each), the Filters open on their button ' + JSON.stringify(wh));
  // Workers filters (stage 6c-1): a filter picked in its select shows as a chip; Group by client draws a section per
  // site; the list view is a table on a computer — a tap on a row opens the worker card.
  await p.evaluate(() => { switchTab('workers'); document.querySelector('#workersRoot [data-testid="workers-filters-btn"]').click(); });
  await sleep(100);
  await p.click('#workersRoot [data-testid="wf-group"]'); await p.click('[role="option"]:has-text("Group by client")'); await sleep(150);
  const wf = await p.evaluate(() => ({
    chips: [...document.querySelectorAll('#workersRoot [data-testid="workers-chips"] button')].map(b => b.dataset.key).join(),
    groups: [...document.querySelectorAll('#workersRoot [data-testid="workers-group"] > div > button')].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
  }));
  await p.click('#workersRoot [data-testid="workers-chips"] button[data-key="group"]');
  await p.click('#workersRoot [data-testid="workers-view"] [aria-label="List"]'); await sleep(150);
  wf.table = await p.evaluate(() => document.querySelectorAll('#workersRoot [data-testid="workers-table"] tbody tr').length);
  await p.click('#workersRoot [data-testid="workers-table"] tbody tr[data-row-id="w2"] td >> nth=2'); await sleep(400);
  wf.card = await p.evaluate(() => document.getElementById('workerCardOverlay').classList.contains('open') && /Dana Levi/.test(document.getElementById('workerCardModal').innerText));
  await p.evaluate(() => { closeModal('workerCardOverlay'); document.querySelector('#workersRoot [data-testid="workers-view"] [aria-label="Cards"]').click(); document.querySelector('#workersRoot [data-testid="workers-filters-btn"]').click(); });
  await sleep(300);
  ok(wf.chips === 'group' && wf.groups.length >= 1 && wf.groups.every(g => /\d$/.test(g)) && wf.table === 2 && wf.card,
    'workers: a filter picked in its select shows as a chip, Group by client draws a section per site, the list view is a table whose row opens the card ' + JSON.stringify(wf));
  // Accounting (stage 6e, React): the period ‹ select ›, figures, Salary / Billing / Approvals / Alerts tabs.
  const ac = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), root = document.getElementById('accountingRoot'), vis = sel => !!root.querySelector(sel);
    switchTab('accounting'); await ManagerBridge.setPeriod('week'); await wait(200);
    setAccTab('billing'); await wait(100);
    const r = {inNav: !!root.querySelector('[data-testid=acc-period-nav] [data-testid=acc-period]'), figs: [...root.querySelectorAll('[data-testid=acc-figs] [data-slot=figures] span.truncate')].map(x => x.textContent).join()};
    r.tabs = [...root.querySelectorAll('#accTabs button')].map(b => b.dataset.k).join();
    r.billingTab = !vis('#accSecSalary') && (vis('[data-testid=acc-billing]') || vis('[data-testid=acc-billing-empty]'));
    setAccTab('salary'); await wait(100); r.salaryTab = vis('#accSecSalary') && !vis('[data-testid=acc-billing]') && !vis('#accSecPending');
    setAccTab('approvals'); await wait(100); r.approvalsTab = !vis('#accSecSalary') && vis('#accSecPending') && !vis('#accSecAlerts');
    // Alerts (stage 13): the accounting-only warnings in three sections, a count on the tab, a tap opens the fix place.
    const w1 = workers.find(w => w.id === 'w1'), keepBank = [w1.bank, w1.bankBranch, w1.bankAccountNumber];
    w1.bank = w1.bankBranch = w1.bankAccountNumber = ''; render();
    setAccTab('alerts'); await wait(100);
    r.alertsTab = !vis('#accSecSalary') && vis('#accSecAlerts');
    r.secs = [...root.querySelectorAll('[data-testid=alerts-sec]')].map(x => x.dataset.sec).join();
    const n = root.querySelectorAll('[data-testid=alert-row]').length;
    r.tabN = (root.querySelector('#accTabs button[data-k="alerts"] .tab-n') || {}).textContent === String(n) && n > 0;
    const bankLine = [...root.querySelectorAll('[data-testid=alert-row]')].find(l => /No bank details/.test(l.textContent) && /Avi/.test(l.textContent));
    if(bankLine){ T.tap(bankLine); await wait(200); r.opensPay = document.getElementById('payOverlay').classList.contains('open') && !!document.querySelector('#payModal [data-testid=pay-window]'); closeModal('payOverlay'); await wait(200); }
    // Select on the Salary rows (after the Select button): a tick exports only that worker.
    setAccTab('salary'); await wait(100);
    const selBtn = [...root.querySelectorAll('[data-testid=sal-select] button')].find(b => /Select/.test(b.textContent));
    r.salSelect = !!selBtn;
    if(selBtn){ selBtn.click(); await wait(100);
      const tick = root.querySelector('[data-testid=sal-tick]'); const wid = tick && tick.closest('tr').dataset.rowId;
      if(tick){ tick.click(); await wait(100); }
      r.salBar = /1 selected/.test((document.querySelector('[data-testid=select-bar] b') || {}).textContent || '') && !document.getElementById('payOverlay').classList.contains('open');
      await loadXlsx(); let wb = null; const orig = XLSX.writeFile; XLSX.writeFile = w => { wb = w; };
      document.querySelector('[data-testid=sal-sel-excel]').click(); await T.until(() => wb, 3000); XLSX.writeFile = orig;
      const rows = wb ? XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1}).slice(1, -1) : [];
      r.salRows = rows.length > 0 && rows.every(x => x[0] === (workers.find(w => w.id === wid) || {}).name);
      r.selOff = !document.querySelector('[data-testid=select-bar]'); }
    [w1.bank, w1.bankBranch, w1.bankAccountNumber] = keepBank; render();
    const period = () => root.querySelector('[data-testid=acc-period]').innerText.trim(), p0 = period();
    root.querySelector('[data-testid=acc-earlier]').click(); await wait(400); r.stepped = period() === 'This Month' && accPeriod === 'month';
    root.querySelector('[data-testid=acc-later]').click(); await wait(400); r.back = period() === p0 && accPeriod === 'week';
    return r;
  });
  ok(ac.inNav && ac.figs === 'Hours,Payroll,To approve' && ac.tabs === 'salary,billing,approvals,alerts' && ac.salaryTab && ac.billingTab && ac.approvalsTab && ac.alertsTab && /pay/.test(ac.secs) && ac.tabN && ac.opensPay && ac.salSelect && ac.salBar && ac.salRows && ac.selOff && ac.stepped && ac.back, 'accounting: period ‹ select ›, figures, Salary / Billing / Approvals / Alerts tabs show their sections; Alerts in sections with a count, a tap opens the pay window; Select exports the ticked worker ' + JSON.stringify(ac));
  // Worker photos are gone (owner 2026-10-13): an old avatarB64 is dropped after a load and never saved again.
  const ph = await p.evaluate(() => { const w = workers[0]; w.avatarB64 = 'AAAA'; const r = {dropped: dropWorkerPhotos(), gone: !('avatarB64' in w), again: dropWorkerPhotos()}; return r; });
  ok(ph.dropped && ph.gone && !ph.again, 'workers: an old photo is dropped from the record (dropWorkerPhotos) ' + JSON.stringify(ph));
  // Greeting and notifications (redesign stage 5): the greeting by time of day; the bell, its panel, "Mark all read" kept on the account.
  const nt = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    switchTab('dashboard'); await wait(100);
    const g = document.querySelector('[data-testid=shell-greeting]'); r.greet = g ? g.querySelector('[data-testid=shell-greet-text]').textContent : ''; r.icon = !!(g && g.querySelector('svg.gic'));
    const w2 = workers.find(w => w.id === 'w2'), keep = w2.docExpiry; w2.docExpiry = '01/01/2020'; render(); await wait(50);
    const bell = () => document.querySelector('[data-testid=shell-bell]');
    const count = () => { const c = bell() && bell().querySelector('.og-bell-n'); return c ? Number(c.textContent) : 0; };
    r.bell = !!bell(); r.before = count();
    bell().click(); await wait(100);
    const items = [...document.querySelectorAll('#bellPanel .og-ni')];
    r.item = items.some(b => /ID \/ passport expired/.test(b.textContent) && /Dana/.test(b.textContent) && b.classList.contains('new'));
    document.querySelector('#bellPanel .og-npop-all').click(); await wait(800);
    r.after = count(); r.noNew = !document.querySelector('#bellPanel .og-ni.new');
    __notifRead = new Set(); __notifReadLoaded = false; await loadNotifReads(); r.kept = count();
    const it = [...document.querySelectorAll('#bellPanel .og-ni')].find(b => /Dana/.test(b.textContent)); if(it) it.click(); await wait(200);
    r.opens = document.getElementById('noticesOverlay').classList.contains('open') && !document.getElementById('bellPanel');
    closeModal('noticesOverlay'); w2.docExpiry = keep; render();
    return r;
  });
  ok(/^Good (morning|afternoon|evening|night)/.test(nt.greet) && nt.icon, 'today: the greeting by time of day with its icon ' + JSON.stringify(nt));
  ok(await waitFor(p, () => { const g = document.querySelector('[data-testid=shell-greeting]'); return !!g && /14°/.test(g.textContent) && !!g.querySelector('svg.gic .drop'); }), 'today: the greeting shows the weather at the firm\'s main site — the rain icon and 14°');
  ok(nt.bell && nt.before >= 1 && nt.item && nt.after === 0 && nt.noNew && nt.kept === 0 && nt.opens, 'notifications: the bell counts, the panel lists the expired ID as new, Mark all read is kept on the account, a tap opens the worker\'s notices ' + JSON.stringify(nt));
  // Worker card: a click only reads; a double click, a long touch or its ✎ opens the edit form;
  // closing it (a tap outside saves it) brings the card back.
  const cardSpot = '#workerCardModal [data-testid="card-kv"] >> nth=0';
  await p.evaluate(() => openWorkerCard(1)); await sleep(400);
  await p.click(cardSpot, {position:{x:5, y:5}}); await sleep(500);
  const bk0 = await p.evaluate(() => !document.getElementById('workerOverlay').classList.contains('open') && document.getElementById('workerCardOverlay').classList.contains('open'));
  const lp = await p.evaluate(async () => {
    const el = document.querySelector('#workerCardModal [data-testid="card-kv"]');
    const r = el.getBoundingClientRect(), o = {bubbles:true, pointerType:'touch', clientX:r.left + 5, clientY:r.top + 5};
    el.dispatchEvent(new PointerEvent('pointerdown', o)); await new Promise(res => setTimeout(res, 250));
    el.dispatchEvent(new PointerEvent('pointerup', o)); await new Promise(res => setTimeout(res, 400));
    const shortTouch = document.getElementById('workerOverlay').classList.contains('open');
    el.dispatchEvent(new PointerEvent('pointerdown', o)); await new Promise(res => setTimeout(res, 700));
    const longTouch = document.getElementById('workerOverlay').classList.contains('open');
    el.dispatchEvent(new PointerEvent('pointerup', o));
    return {shortTouch, longTouch};
  });
  ok(!lp.shortTouch && lp.longTouch, 'worker card: a short touch only reads, a long touch opens the edit form ' + JSON.stringify(lp));
  await p.mouse.click(5, 450); await sleep(1200);
  await p.evaluate(() => { closeModal('workerCardOverlay'); openWorkerCard(1); }); await sleep(400);
  await p.dblclick(cardSpot, {position:{x:5, y:5}}); await sleep(400);
  const dbl = await p.evaluate(() => document.getElementById('workerOverlay').classList.contains('open'));
  ok(dbl, 'worker card: a double click opens the edit form');
  await p.mouse.click(5, 450); await sleep(1200);
  await p.evaluate(() => { closeModal('workerCardOverlay'); openWorkerCard(1); }); await sleep(400);
  await p.click('#workerCardEdit'); await sleep(400);
  const bk1 = await p.evaluate(() => document.getElementById('workerOverlay').classList.contains('open'));
  await p.evaluate(() => { T.fill('wNotes', 'back-to-card'); });
  await p.mouse.click(5, 450); await sleep(1200);
  const bk = await p.evaluate(() => ({edit: document.getElementById('workerOverlay').classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open'), notes: workers[1].notes}));
  await p.mouse.click(5, 450); await sleep(300);
  ok(bk0 && bk1 && !bk.edit && bk.card && bk.notes === 'back-to-card', 'worker card: a click only reads, ✎ edits; the form saves on close and goes back to the card ' + JSON.stringify({bk0, bk1, bk}));
  // Phone: a swipe down on a window closes it the same way as a tap outside; a short one does not.
  await p.setViewportSize({width: 390, height: 844});
  await p.evaluate(() => openWorkerCard(1)); await sleep(400);
  const swipe = await p.evaluate(async () => {
    const m = document.getElementById('workerCardModal'), r = m.getBoundingClientRect(), x = r.left + 40, y = r.top + 20;
    const t = (type, dy) => { const tp = new Touch({identifier: 1, target: m, clientX: x, clientY: y + dy}); m.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [tp], changedTouches: [tp]})); };
    const drag = async dy => { t('touchstart', 0); for (let d = 10; d <= dy; d += 20) t('touchmove', d); t('touchend', dy); await new Promise(r => setTimeout(r, 400)); };
    await drag(40); const short = document.getElementById('workerCardOverlay').classList.contains('open');
    await drag(200); const long = document.getElementById('workerCardOverlay').classList.contains('open');
    return {short, long, locked: getComputedStyle(document.body).overflow};
  });
  ok(swipe.short && !swipe.long, 'phone: a swipe down closes a window, a short one does not ' + JSON.stringify(swipe));
  await p.setViewportSize({width: 1280, height: 900}); await sleep(300);
  // Any window opened from the worker card goes back to it: Pay → tap outside → the card again.
  await p.evaluate(() => openWorkerCard(1)); await sleep(300);
  await p.click('#workerCardModal [data-testid="card-more"]'); await sleep(200);
  await p.click('[role="menuitem"]:has-text("Pay")'); await sleep(400);
  const pay1 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  await p.mouse.click(5, 450); await sleep(600);
  const pay2 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  ok(pay1.pay && !pay1.card && !pay2.pay && pay2.card, 'back: closing Pay opened from the worker card shows the card again ' + JSON.stringify({pay1, pay2}));
  await p.mouse.click(5, 450); await sleep(400);
  // The Clients and Suppliers tabs are React (stage 6d, src/manager/Clients.tsx): a client plate's single click
  // or double click opens its window (no card to read first); the breadcrumb counts them; no side panel.
  await p.evaluate(() => switchTab('clients')); await sleep(400);
  await p.click('#clientsRoot [data-testid="client-plate"] [data-testid="client-name"] >> nth=0'); await sleep(500);
  const cl1 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open') && !!document.querySelector('#clientModal [data-testid="client-editor"]'));
  await p.evaluate(() => closeModal('clientOverlay')); await sleep(200);
  await p.dblclick('#clientsRoot [data-testid="client-plate"] [data-testid="client-name"] >> nth=0'); await sleep(500);
  const cl2 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open'));
  ok(cl1 && cl2, 'clients: a single click or a double click opens the editor ' + JSON.stringify({cl1, cl2}));
  await p.evaluate(() => closeModal('clientOverlay')); await sleep(200);
  // Plates: notices, ⋮ (Edit, Manual punch, Delete), Delete → Undo, Select → Delete after 5 s; supplier plates.
  const crumbNow = () => p.evaluate(() => document.querySelector('[data-testid=shell-crumb]').innerText.replace(/\s+/g, ' ').trim());
  await p.evaluate(() => { clients.push({id:'ctmp', name:'Temp Client', color:'#60a5fa'}); switchTab('clients'); renderClientsPage(); });
  const ctmp = '#clientsRoot [data-testid="client-plate"][data-cid="ctmp"]';
  await p.waitForSelector(ctmp);
  const cpl = await p.evaluate(sel => ({noRate: !!document.querySelector(sel + ' [data-testid="client-norate"]'), sidebar: !document.querySelector('.sidebar'),
    old: !document.getElementById('clientsGrid') && !document.querySelector('#sectionClients .page-title')}), ctmp);
  cpl.crumb = await crumbNow();
  await p.click(ctmp + ' button[aria-label="Actions"]'); await p.waitForSelector('[role="menuitem"]');
  cpl.menu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
  await p.click('[role="menuitem"]:has-text("Delete")'); await sleep(400);
  cpl.pending = await p.evaluate(sel => !document.querySelector(sel) && clients.some(c => c.id === 'ctmp') && /Temp Client/.test(document.querySelector('[data-testid="undo-snack"]').textContent), ctmp);
  await p.click('[data-testid="undo-snack"] button'); await sleep(400);
  cpl.undone = await p.evaluate(sel => !!document.querySelector(sel) && clients.some(c => c.id === 'ctmp'), ctmp);
  await p.click('#clientsRoot [data-testid="clients-select"] button:has-text("Select")'); await sleep(100);
  await p.click(ctmp + ' [role="button"]', {position: {x: 30, y: 14}}); await sleep(100);
  cpl.sel = await p.evaluate(() => (document.querySelector('[data-testid="select-bar"] b') || {}).textContent);
  cpl.noWindow = await p.evaluate(() => !document.getElementById('clientOverlay').classList.contains('open'));
  await p.click('[data-testid="select-bar"] button:has-text("Delete")'); await sleep(400);
  cpl.notYet = await p.evaluate(() => clients.some(c => c.id === 'ctmp'));
  await sleep(5300);
  cpl.deleted = await p.evaluate(() => !clients.some(c => c.id === 'ctmp'));
  await p.evaluate(() => switchTab('suppliers')); await sleep(300);
  cpl.supplier = await p.evaluate(() => { const sp = document.querySelector('#suppliersRoot [data-testid="supplier-plate"]'); return !!sp && !!sp.querySelector('[data-testid="supplier-hours"]') && !!sp.querySelector('button[aria-label="Actions"]') && !document.querySelector('.sidebar'); });
  cpl.crumbS = await crumbNow();
  await p.click('#suppliersRoot [data-testid="supplier-plate"] button[aria-label="Actions"] >> nth=0'); await p.waitForSelector('[role="menuitem"]');
  cpl.supMenu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
  await p.keyboard.press('Escape'); await sleep(150);
  await p.click('#suppliersRoot [data-testid="supplier-plate"] [data-testid="supplier-name"] >> nth=0'); await sleep(400);
  cpl.supWindow = await p.evaluate(() => document.getElementById('supplierOverlay').classList.contains('open') && !!document.querySelector('#supplierModal [data-testid="supplier-editor"]'));
  await p.evaluate(() => { closeModal('supplierOverlay'); switchTab('clients'); }); await sleep(200);
  ok(cpl.noRate && /^Clients \d+$/.test(cpl.crumb) && /^Suppliers \d+$/.test(cpl.crumbS) && cpl.sidebar && cpl.old && cpl.menu === 'Edit,Manual punch,Delete' && cpl.pending && cpl.undone && cpl.sel === '1 selected' && cpl.noWindow && cpl.notYet && cpl.deleted
    && cpl.supplier && cpl.supMenu === 'Edit,Delete' && cpl.supWindow,
    'clients / suppliers (React): plates with notices, the breadcrumb count, no side panel, ⋮, Delete → Undo, Select → Delete after 5 s; supplier plates open the supplier window ' + JSON.stringify(cpl));
  // The client window: a tap outside saves it; an empty new client is not created; the rates block; manual punch from the window and back.
  const cs = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const tap = () => { const ov = document.getElementById('clientOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click(); };
    const keep = JSON.parse(JSON.stringify(clients.find(c => c.id === 'c1')));
    openEditClient('c1'); await wait(100);
    const m = document.getElementById('clientModal');
    const noClose = ![...m.querySelectorAll('button')].some(b => /^\s*(Cancel|Close)\s*$/.test(b.textContent));
    // Stage 5a: the window is laid out left to right (no dir="rtl" inside) and its note goes through tr().
    const ltr = {noRtl: !m.querySelector('[dir="rtl"]'), note: /Changes are saved when the window closes/.test(m.innerText)};
    T.fill('cBillMain', '130'); T.fill('cDefRate', '52'); await wait(50);
    // The rates block: the margin per hour, the mode buttons (by law shows OT / Shabbat inline).
    const rates = {margin: document.getElementById('cBillMargin').innerText.replace(/\s+/g, ' '), extra: !!document.getElementById('cBillExtra'), sum: m.querySelector('[data-sec="rates"] [data-slot="accordion-trigger"] small').textContent};
    document.querySelector('#cRateMode [data-mode="fixed"]').click(); await wait(50); rates.fixedHidesExtra = !document.getElementById('cBillExtra');
    document.querySelector('#cRateMode [data-mode="tiered"]').click(); await wait(50);
    tap();
    await wait(300);
    const c = clients.find(x => x.id === 'c1'), out = {rates, ltr, noClose, closed: !document.getElementById('clientOverlay').classList.contains('open'), d: c.defaultHourlyRate, b: c.billRate};
    const n = clients.length; openAddClient(); await wait(100); tap(); await wait(300); out.noNew = clients.length === n;
    // "Manual punch" from the client window: saves it, opens the punch; closing the punch brings the client back.
    out.noPunchOnCard = ![...document.querySelectorAll('#clientsRoot [data-testid="client-plate"] button')].some(b => /Manual punch/.test(b.textContent));
    openEditClient('c1'); await wait(100); punchFromClientModal(); await wait(150);
    out.punch = document.getElementById('manualPunchOverlay').classList.contains('open') && !document.getElementById('clientOverlay').classList.contains('open') && !!document.querySelector('#manualPunchModal [data-testid="manual-punch"]');
    closeModal('manualPunchOverlay');
    out.back = await T.until(() => document.getElementById('clientOverlay').classList.contains('open') && !!document.querySelector('#clientModal [data-testid="client-editor"]'), 3000);
    // The small map opens the map picker; the place picked there comes back into the window.
    document.getElementById('cMapMini').click(); await wait(100);
    out.mapOpen = document.getElementById('mapPickOverlay').classList.contains('open');
    out.mapReact = !!document.querySelector('#mapPickModal [data-testid="map-picker"]'); ManagerIsland.mapPickAt(32.0712345, 34.7798765); document.getElementById('mapPickRadius').value = '150'; document.getElementById('mapPickSave').click(); await wait(100);
    out.picked = {loc: document.getElementById('cLocStatus').innerText, radius: document.getElementById('cRadius').value, url: document.getElementById('cMapsUrl').value, mapClosed: !document.getElementById('mapPickOverlay').classList.contains('open')};
    // A pasted link is read too; a link that is not recognised says so.
    T.fill('cMapsUrl', 'https://www.google.com/maps/@31.5,35.1,15z'); await wait(50); out.link = document.getElementById('cLocStatus').innerText;
    T.fill('cMapsUrl', 'https://example.com/nothing-here'); await wait(50); out.badLink = document.getElementById('cLocStatus').innerText;
    closeModal('clientOverlay'); await wait(150);
    Object.assign(c, keep); delete c.defaultOtRate; delete c.defaultShabbatRate; await gsSave(getDataObj());
    return out;
  });
  ok(cs.ltr.noRtl && cs.ltr.note, 'clients: the client window is left to right and its note is English through tr() ' + JSON.stringify(cs.ltr));
  ok(/₪78.*60%/.test(cs.rates.margin) && cs.rates.extra && cs.rates.fixedHidesExtra && /₪52 worker · ₪130 client · hourly/.test(cs.rates.sum), 'clients: the rates block shows the margin per hour; fixed mode hides OT / Shabbat ' + JSON.stringify(cs.rates));
  ok(cs.mapOpen && cs.mapReact && /32\.0712\d, 34\.7798\d/.test(cs.picked.loc) && cs.picked.radius === '150' && cs.picked.url === 'https://www.google.com/maps?q=32.071235,34.779877' && cs.picked.mapClosed && /31\.50000, 35\.10000/.test(cs.link) && /not recognised/.test(cs.badLink),
    'clients: the small map opens the map picker and the place comes back; a pasted Google Maps link is read ' + JSON.stringify({mapOpen: cs.mapOpen, picked: cs.picked, link: cs.link, badLink: cs.badLink}));
  // Editors per mockup 04: the client head's ⋮ (Manual punch, Delete) and the small map; the user editor's head; glass fields.
  await p.evaluate(() => openEditClient('c1')); await sleep(200);
  await p.click('#clientModal [data-testid="editor-menu"]'); await p.waitForSelector('[role="menuitem"]');
  const ed4items = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()));
  await p.keyboard.press('Escape'); await sleep(150);
  const ed4 = await p.evaluate(async items => {
    const map = !!document.getElementById('cMapMini');
    const fieldRadius = getComputedStyle(document.getElementById('cName')).borderTopLeftRadius;
    closeModal('clientOverlay'); await T.tick(150);
    openCreateUserForm(); T.fill('uFullName', 'Rina Mizrahi'); await T.tick(50);
    const head = document.querySelector('#userFormModal [data-testid="editor-head"]');
    const user = {title: head.querySelector('[data-testid="editor-title"]').textContent, av: head.firstElementChild.textContent};
    closeModal('userFormOverlay');
    return {items, map, fieldRadius, user};
  }, ed4items);
  ok(ed4.items.join() === 'Manual punch,Delete' && ed4.map && ed4.fieldRadius === '12px' && ed4.user.title === 'Rina Mizrahi' && ed4.user.av === 'RM', 'editors: the client head ⋮ (Manual punch, Delete), the small map, glass fields, the user editor head ' + JSON.stringify(ed4));
  ok(cs.noClose && cs.closed && cs.d === 52 && cs.b === 130 && cs.noNew && cs.noPunchOnCard && cs.punch && cs.back, 'clients: no Cancel / Close, a tap outside saves; an empty new client is not created; manual punch from the window and back ' + JSON.stringify(cs));
  // The manual punch (React): a worker, OUT, saved as a manual punch of this client, not GPS-verified (sent through gsSavePunch).
  await sleep(300);
  await p.evaluate(() => { window.__mpSent = []; window.__mpKeep = gsSavePunch; gsSavePunch = e => { window.__mpSent.push(e); }; openManualPunch('c1'); });
  await p.waitForSelector('#manualPunchModal [data-testid="manual-punch"]');
  await p.click('[data-testid="mp-save"]'); await sleep(150);
  const mpNoWorker = await p.evaluate(() => !window.__mpSent.length && document.getElementById('manualPunchOverlay').classList.contains('open'));
  await p.click('#mpWorker'); await p.click('[role="option"] >> nth=0'); await sleep(100);
  await p.click('#manualPunchModal [data-type="out"]'); await p.fill('#mpNote', 'Approved by phone');
  await p.click('[data-testid="mp-save"]'); await sleep(200);
  const mpu = await p.evaluate(() => {
    const e = window.__mpSent[0] || {}, inLog = getPunchLog().some(x => x.id === e.id);
    const r = {n: window.__mpSent.length, manual: e.manual === true && e.gpsVerified === false && e.dist === null, type: e.type, client: e.clientId, site: e.site, notes: e.notes, warn: (e.gpsWarnings || []).join(),
      date: /^\d{2}\/\d{2}\/\d{4}$/.test(e.date) && !isNaN(Date.parse(e.ts)), inLog, closed: !document.getElementById('manualPunchOverlay').classList.contains('open')};
    savePunchLog(getPunchLog().filter(x => x.id !== e.id)); gsSavePunch = window.__mpKeep; render();
    return r;
  });
  ok(mpNoWorker && mpu.n === 1 && mpu.manual && mpu.type === 'out' && mpu.client === 'c1' && mpu.notes === 'Approved by phone' && mpu.warn === 'Manual entry by manager' && mpu.date && mpu.inLog && mpu.closed,
    'manual punch: a worker must be picked; the punch is manual, not GPS-verified, of this client, in the log and sent ' + JSON.stringify({mpNoWorker, ...mpu}));
  await p.mouse.click(5, 450); await sleep(400);
  ok(external.filter(u=>/script\.google\.com/.test(u)).length === 0, 'no request to script.google.com');
  ok(p.errs.length === 0, 'owner: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── Super-admin: cross-firm summary uses each firm's own clients ──
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'boss', 'boss-pass-1');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => document.getElementById('firmsScreen').style.display === 'block' && __firmsCache.length === 2 && document.querySelectorAll('#firmsScreenRoot [data-testid="firm-row"]').length === 2), 'boss: firms list (listTenants)');
  // The firms list (React, stage 6f-2): ✎ and a bare ⋮ (Edit, Disable, Delete last via Undo); Select; a tap opens the firm (below).
  const fl = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const row = () => document.querySelector('#firmsScreenRoot [data-testid="firm-row"][data-tid="tenant-two"]');
    const out = {pencil: !!row().querySelector('[data-testid="firm-edit"]'), select: !!document.querySelector('#firmsScreenRoot [data-testid="firms-select"] button'),
      incomplete: /profile incomplete/.test(row().innerText) === (firmProfileMissing(__firmsCache.find(t => t.tenantId === 'tenant-two')).length > 0)};
    row().querySelector('[data-testid="firm-edit"]').click(); await wait(300);
    const win = document.querySelector('#firmModal [data-testid="firm-window"]');
    out.edit = document.getElementById('editFirmOverlay').classList.contains('open') && !!win && win.dataset.mode === 'edit' && document.getElementById('fCompanyName').value === 'Firm Two' && !document.querySelector('#firmModal [data-testid="firm-wa"]');
    out.hebrew = /שם המעסיק/.test(win.innerText) && /מספר תיק ניכויים/.test(win.innerText);
    closeModal('editFirmOverlay'); await wait(200);
    let calls = 0; const f = window.fetch; window.fetch = (u, o) => { if(o && /deleteTenant/.test(o.body)) calls++; return f(u, o); };
    window.__fl = {calls: () => calls, restore: () => { window.fetch = f; }};
    return out;
  });
  await p.click('#firmsScreenRoot [data-testid="firm-row"][data-tid="tenant-two"] .og-kb');
  await p.waitForSelector('[role="menuitem"]');
  const flMenu = await p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
  await p.click('[role="menuitem"]:has-text("Delete")');
  await sleep(300);
  const fl2 = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const out = {snack: !!document.querySelector('[data-testid="undo-snack"]') && !document.querySelector('#firmsScreenRoot [data-testid="firm-row"][data-tid="tenant-two"]')};
    document.querySelector('[data-testid="undo-snack"] .og-snack-u').click(); await wait(400);
    out.kept = window.__fl.calls() === 0 && __firmsCache.length === 2 && !!document.querySelector('#firmsScreenRoot [data-testid="firm-row"][data-tid="tenant-two"]');
    window.__fl.restore();
    return out;
  });
  ok(fl.pencil && fl.select && fl.incomplete && fl.edit && fl.hebrew && flMenu === 'Edit,Disable,Delete' && fl2.snack && fl2.kept,
    'firms: ✎ edits (the Form 101 labels Hebrew), ⋮ holds Edit, Disable and Delete (Undo, no confirm), Select ' + JSON.stringify({fl, flMenu, fl2}));
  // A new firm through the firm window: owner name, login and the employer block; the list then shows it.
  const nf = await p.evaluate(async () => {
    openCreateFirmForm(); await T.tick(150);
    const r = {mode: document.querySelector('#firmModal [data-testid="firm-window"]').dataset.mode, login: !!document.getElementById('fUsername')};
    document.querySelector('#firmModal [data-testid="firm-save"]').click(); await T.tick(100);
    r.needLogin = /Username and password/.test(document.querySelector('#firmModal [data-testid="firm-error"]').textContent);
    T.fill('fOwnerName', 'Nir Third'); T.fill('fUsername', 'owner3'); T.fill('fPassword', 'owner-pass-3'); T.fill('fCompanyName', 'Firm Three');
    await T.tick(50);
    document.querySelector('#firmModal [data-testid="firm-save"]').click();
    r.closed = await T.until(() => !document.getElementById('editFirmOverlay').classList.contains('open'), 15000);
    r.listed = await T.until(() => [...document.querySelectorAll('#firmsScreenRoot [data-testid="firm-row"]')].some(x => /Firm Three/.test(x.innerText)), 10000);
    return r;
  });
  ok(nf.mode === 'create' && nf.login && nf.needLogin && nf.closed && nf.listed, 'firms: a new firm with its owner login through the firm window ' + JSON.stringify(nf));
  // Disable / Enable from Select, then the new firm deleted (its Undo time runs out).
  const fd = await p.evaluate(async () => {
    const row = id => document.querySelector('#firmsScreenRoot [data-testid="firm-row"][data-tid="' + id + '"]');
    const t3 = __firmsCache.find(t => t.companyName === 'Firm Three').tenantId;
    document.querySelector('#firmsScreenRoot [data-testid="firms-select"] button').click(); await T.tick(50);
    T.tap(row(t3)); await T.tick(50);
    document.querySelector('[data-testid="select-bar"] [data-testid="sel-disable"]').click();
    const off = await T.until(() => (__firmsCache.find(t => t.tenantId === t3) || {}).active === false && /disabled/.test(row(t3).innerText), 10000);
    await setTenantsActive([t3], true);
    const on = (__firmsCache.find(t => t.tenantId === t3) || {}).active !== false;
    await deleteTenantsNow([t3]);
    return {off, on, gone: !__firmsCache.some(t => t.tenantId === t3) && !row(t3)};
  });
  ok(fd.off && fd.on && fd.gone, 'firms: Select → Disable, Enable, and delete (deleteTenant) ' + JSON.stringify(fd));
  await p.evaluate(() => { T.tap(document.querySelector('#firmsScreenRoot [data-testid="firm-row"][data-tid="tenant-one"]')); });
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => workers.length === 2), 'boss: viewing Firm One (a tap on its plate)');
  await p.evaluate(() => { switchTab('admin'); switchAdminPane('firms'); });
  await p.waitForSelector('#adminRoot [data-testid="firms-payable"]');
  await p.click('#adminRoot [data-testid="firms-payable"]');
  ok(await waitFor(p, () => document.querySelectorAll('#adminRoot [data-testid="payable-row"]').length === 2, 20000), 'boss: summary rendered');
  const sum = await p.evaluate(() => [...document.querySelectorAll('#adminRoot [data-testid="payable-row"]')].map(r => r.innerText.replace(/\s+/g, ' ')).join(' | '));
  ok(/Firm Two Hours \(this week\): 2\.0h ₪200/.test(sum), 'summary: Firm Two pays 2h × its own client rate 100 = ₪200 ' + sum);
  ok(await p.evaluate(() => clients.length === 2 && clients[0].id === 'c1'), 'summary: the loaded firm\'s clients are back');
  // Permission templates: the super-admin's Users section lists the one set of every firm; it creates and edits them.
  await p.evaluate(() => { switchTab('admin'); switchAdminPane('users'); });
  await p.waitForSelector('#adminRoot [data-testid="template-row"][data-tid="client"]');
  const tpA = await p.evaluate(() => ({rows: [...document.querySelectorAll('#adminRoot [data-testid="template-row"]')].map(x => x.dataset.tid).join(),
    newBtn: !!document.querySelector('#adminRoot [data-testid="template-new"]'), link: !!document.querySelector('#adminRoot [data-testid="templates-link"]')}));
  await p.click('#adminRoot [data-testid="template-row"][data-tid="client"]');
  await p.waitForSelector('[data-testid="template-window"]');
  await (await p.$('#adminRoot [data-testid="templates"]')).screenshot({path: SP + '/templates.png'}).catch(()=>{});
  await (await p.$('[data-testid="window"]')).screenshot({path: SP + '/template-window.png'}).catch(()=>{});
  const capd = await p.evaluate(() => { const t = k => document.querySelector('[data-testid="template-window"] [data-k="' + k + '"]');
    return {clients: t('clients').disabled && t('clients').dataset.cap === 'no', pay: t('seePay').disabled, hours: !t('hours').disabled}; });
  await p.click('[data-testid="template-window"] [data-testid="rights-tabs"] [data-k="schedule"]');
  await p.click('[data-testid="template-save"]');
  const tpB = await p.evaluate(async () => {
    const r = {closed: await T.until(() => !document.querySelector('[data-testid="template-window"]'), 8000)};
    const j = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'listTemplates'})})).json();
    const t = j.templates.find(t => t.id === 'client');
    r.old = Object.keys(t).filter(k => ['permissions', 'hourPerms', 'editPerms', 'supplierSections', 'showPay'].includes(k)).join();
    r.rights = t.rights.join();
    await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'saveTemplate', id: t.id, name: t.name, role: t.role, rights: t.rights.filter(k => k !== 'schedule')})});
    return r;
  });
  // "Who gets what": every tick down the side, the templates side by side.
  await p.click('#adminRoot [data-testid="rights-table"] button[aria-expanded]');
  const rmx = await p.evaluate(async () => {
    await T.until(() => document.querySelectorAll('#adminRoot [data-testid="rights-row"]').length > 0, 3000);
    const rows = [...document.querySelectorAll('#adminRoot [data-testid="rights-row"]')];
    const head = [...document.querySelectorAll('#adminRoot [data-testid="rights-table"] thead th')].map(x => x.textContent.trim());
    const row = l => rows.find(x => x.dataset.label === l), col = n => head.findIndex(h => h.includes(n));
    const cell = (l, n) => row(l).children[col(n)].textContent.trim();
    return {n: rows.length, shifts: cell('Edit shifts', 'Dispatcher'), sup: cell('Edit shifts', 'Supplier'), ownHr: cell('Only own workers', 'HR with pay'), today: cell('Today', 'Supplier'),
      hrToday: cell('Today', 'HR with pay'), com: cell('Commission', 'HR with pay'), pay: cell('Edit pay', 'Accountant'), payD: cell('Edit pay', 'Dispatcher')};
  });
  ok(rmx.n === 19 && rmx.shifts === "✓" && rmx.sup === "" && rmx.ownHr === "✓" && rmx.today === "✓" && rmx.hrToday === "" && rmx.com === "✓" && rmx.pay === "✓" && rmx.payD === "—",
    "boss: Who gets what — the flat ticks by template (blank: never for that role) " + JSON.stringify(rmx));
  // A staff login on a template without its edit ticks: the Schedule, Workers, card and punch log only read.
  const vo = await p.evaluate(() => {
    const keep = JSON.stringify(getSession()), s = JSON.parse(keep), B = ManagerBridge;
    const tabs = ['today', 'schedule', 'workers', 'clients', 'suppliers', 'punchlog'];
    saveSession(Object.assign({}, s, {role: 'staff', rights: tabs}));
    const r = {sched: B.schedule().canEdit, workers: B.workers().canEdit, add: B.today().canAddWorker, punches: B.admin().canEditPunches, punch: B.clients().canPunch};
    saveSession(Object.assign({}, s, {role: 'staff', rights: [...tabs, 'editSchedule']}));
    r.schedOnly = B.schedule().canEdit && !B.workers().canEdit;
    saveSession(Object.assign({}, s, {role: 'staff', rights: [...tabs, 'editSchedule', 'editWorkers', 'editPunches']}));
    r.all = B.schedule().canEdit && B.workers().canEdit && B.admin().canEditPunches;
    saveSession(JSON.parse(keep));
    return r;
  });
  ok(!vo.sched && !vo.workers && !vo.add && !vo.punches && !vo.punch && vo.schedOnly && vo.all, 'edit ticks: without them Schedule, Workers and punches only read; with all three it changes all ' + JSON.stringify(vo));
  ok(tpA.newBtn && tpA.link && /dispatcher/.test(tpA.rows) && /client/.test(tpA.rows) && tpB.closed && tpB.old === '' && /schedule,hours/.test(tpB.rights) && capd.clients && capd.pay && capd.hours,
    'boss: Users lists the permission templates with New template and Put them on templates; a client template greys Clients and pay; a tick changed in a template is saved for every firm ' + JSON.stringify({tpA, tpB, capd}));
  // Admin → Scanner (docs/hf-plan.md): the training figures, the versions, the document type model's mode
  // (Off / Shadow / Mixed) and the per-firm switch of the full-document collection — all through scan_feedback.
  const sfCalls = [];
  const SFCORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST'};
  let sfSet = {doctypeMode: 'shadow', collect: {'tenant-one': true}};
  await p.route(/cloudfunctions\.net\/scan_feedback$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status:204, headers:SFCORS});
    const b = JSON.parse(r.request().postData() || '{}'); sfCalls.push(b);
    if (b.action === 'stats') return r.fulfill({status:200, contentType:'application/json', headers:SFCORS, body: JSON.stringify({ok: true, due: false, edgesSince: 42, doctypesDue: false,
      doctypes: {id_front: 30, id_back: 12, sefach: 20, passport: 8, contract: 5}, stats: {documents: 7, fieldsCorrected: 3, shadowPages: 10, shadowModelRight: 9, shadowHaikuRight: 8}})});
    if (b.action === 'setSettings') { if (b.doctypeMode) sfSet.doctypeMode = b.doctypeMode; Object.assign(sfSet.collect, b.collect || {}); }
    return r.fulfill({status:200, contentType:'application/json', headers:SFCORS, body: JSON.stringify({ok: true, ...sfSet})});
  });
  await p.evaluate(() => { switchTab('admin'); switchAdminPane('scanner'); });
  const sa = {shown: await waitFor(p, () => !!document.querySelector('#adminRoot [data-testid="scan-collect"] [data-firm="tenant-one"]'), 10000)};
  Object.assign(sa, await p.evaluate(() => {
    const root = document.querySelector('#adminRoot [data-testid="scan-admin"]');
    return {figs: [...root.querySelectorAll('[data-slot="figures"] b')].map(b => b.textContent).join(','),
      mode: (root.querySelector('[data-testid="scan-doctype-mode"] [data-state="on"]') || {dataset: {}}).dataset.v,
      shadow: root.querySelector('[data-testid="scan-shadow"]').textContent,
      on: root.querySelector('[data-testid="scan-collect"] [data-firm="tenant-one"]').getAttribute('data-state')};
  }));
  await p.screenshot({path: SP + '/scan-admin.png'});
  await p.click('#adminRoot [data-testid="scan-doctype-mode"] [data-v="mixed"]');
  await p.click('#adminRoot [data-testid="scan-collect"] [data-firm="tenant-one"]');
  sa.after = await waitFor(p, () => { const r = document.querySelector('#adminRoot [data-testid="scan-admin"]');
    return (r.querySelector('[data-testid="scan-doctype-mode"] [data-state="on"]') || {dataset: {}}).dataset.v === 'mixed'
      && r.querySelector('[data-testid="scan-collect"] [data-firm="tenant-one"]').getAttribute('data-state') === 'unchecked'; }, 8000);
  sa.sent = sfCalls.filter(c => c.action === 'setSettings').map(c => JSON.stringify(c.doctypeMode || c.collect)).join(' ');
  await p.unroute(/cloudfunctions\.net\/scan_feedback$/);
  ok(sa.shown && sa.figs === '42/20,5/20,7,3' && sa.mode === 'shadow' && /10 pages/.test(sa.shadow) && /90%/.test(sa.shadow) && /80%/.test(sa.shadow) && sa.on === 'checked'
    && sa.after && /"mixed"/.test(sa.sent) && /"tenant-one":false/.test(sa.sent),
    'Admin → Scanner: the figures, the shadow, the document type model set to Mixed and a firm\'s full documents turned off (scan_feedback) ' + JSON.stringify(sa));
  // Admin lists draw 10 rows at first (Errors, Timings), at phone and desktop sizes
  await p.evaluate(async () => {
    const items = [];
    for (let i = 0; i < 40; i++) items.push({type:'error', page:'x', role:'superadmin', message:'test error ' + i, source:'e2e'});
    for (let i = 0; i < 40; i++) items.push({type:'timing', kind:'appOpen', totalMs:1000 + i, tenantId:'tenant-one', user:'boss', role:'superadmin', details:{}});
    await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'logBatch', items})});
  });
  for (const [w, h] of [[1280, 800], [390, 800]]) {
    await p.setViewportSize({width:w, height:h});
    await p.evaluate(() => { switchTab('admin'); switchAdminPane('errors'); });
    await waitFor(p, () => document.querySelectorAll('#adminRoot [data-testid="error-row"]').length >= 10);
    await sleep(1500);
    const er = await p.evaluate(() => [document.querySelectorAll('#adminRoot [data-testid="error-row"]').length, !!document.querySelector('#adminRoot [data-testid="errors-list"] [data-slot="paged-more"]')]);
    await p.evaluate(() => switchAdminPane('timings'));
    await waitFor(p, () => document.querySelectorAll('#adminRoot [data-testid="timing-row"]').length >= 10);
    await sleep(1500);
    const tm = await p.evaluate(() => [document.querySelectorAll('#adminRoot [data-testid="timing-row"]').length, !!document.querySelector('#adminRoot [data-testid="timing-rows"] [data-slot="paged-more"]')]);
    await p.screenshot({path: SP + '/shot_timings_' + w + '.png'});
    console.log('LISTS', w, 'errors', JSON.stringify(er), 'timings', JSON.stringify(tm));
    ok(er[0] === 10 && er[1] && tm[0] === 10 && tm[1], `admin lists: exactly 10 rows at first at ${w}px (errors ${er[0]}, timings ${tm[0]})`);
  }
  await p.setViewportSize({width:1280, height:800});
  // Period picker: a past month has none of today's rows; Copy all takes only the period
  const per = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const rowsOf = kind => (ManagerBridge.admin().logs || {}).rows || [];
    switchAdminPane('timings'); await wait(800);
    const opts = logPeriodOptions().map(o => o[0]);
    const cur = rowsOf('timings').length, kinds = document.querySelectorAll('#adminRoot [data-testid="timing-kind"]').length;
    let copied = ''; const keep = copyTextToClipboard; copyTextToClipboard = t => { copied = t; };
    document.querySelector('#adminRoot [data-testid="log-copy"]').click();
    ManagerBridge.setLogPeriod('timings', opts[3]); await wait(1200);   // last month
    const past = rowsOf('timings').length, text = document.querySelector('#adminRoot [data-testid="timings"]').innerText, shownPeriod = document.querySelector('#adminRoot [data-testid="timings"]').dataset.period;
    ManagerBridge.setLogPeriod('timings', '30d'); await wait(800);
    switchAdminPane('errors'); await wait(800);
    ManagerBridge.setLogPeriod('errors', opts[3]); await wait(1200);
    const epast = rowsOf('errors').length;
    ManagerBridge.setLogPeriod('errors', '30d'); await wait(1200);
    copyTextToClipboard = keep;
    return {opts: opts.length, first: opts.slice(0, 3), cur, past, shownPeriod, text: text.slice(0, 80), epast, enow: rowsOf('errors').length, kinds, copied: copied.slice(0, 60), copiedRows: (copied.match(/\n\n/g) || []).length};
  });
  console.log('PERIOD', JSON.stringify(per));
  ok(per.opts === 14 && per.cur >= 20 && per.past === 0 && per.shownPeriod !== '30d' && per.epast === 0 && per.enow >= 40 && per.kinds >= 1 && /median/.test(per.copied), 'errors/timings: period picker loads one period at a time; Copy all ' + JSON.stringify(per));
  // Reset (Timings / Errors): behind the Alert Dialog; every error and measurement is deleted, the panes show none.
  await p.evaluate(() => switchAdminPane('timings')); await sleep(800);
  await p.click('#adminRoot [data-testid="log-reset"]');
  await p.waitForSelector('[data-testid="reset-logs"]');
  await p.click('[data-testid="reset-submit"]');
  await sleep(1500);
  const rst = await p.evaluate(async () => {
    const t = await (await fetch(API_URL + '?action=loadTimings' + gsAuthQuery())).json();
    const e = await (await fetch(API_URL + '?action=loadErrors' + gsAuthQuery())).json();
    return {dialogGone: !document.querySelector('[data-testid="reset-logs"]'), timings: (t.rows || []).length, errors: (e.rows || []).length, shown: ((ManagerBridge.admin().logs || {}).rows || []).length, empty: !!document.querySelector('#adminRoot [data-testid="timings-empty"]')};
  });
  ok(rst.dialogGone && rst.timings === 0 && rst.errors === 0 && rst.shown === 0 && rst.empty, 'timings: Reset deletes every error and measurement ' + JSON.stringify(rst));
  ok(p.errs.length === 0, 'boss: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── A supplier stays in the manager app (permissions plan, stage 3): its portal's screens in the frame ──
  // The screens are the portal's React code (src/supplier/, drawn by src/manager/Portal.tsx): the checks read their DOM and the supplier function's replies.
  const supReady = () => !!document.querySelector('[data-testid="supplier-portal"][data-ready="1"]');
  ctx = await newCtx(); p = await page(ctx);
  // Nothing reads Firestore for a supplier: every request to the Firestore emulator is counted.
  const fsReqs = []; p.on('request', r => { if (/:8080\//.test(r.url())) fsReqs.push(r.url()); });
  await login(p, BASE + 'schedule-manager.html', 'sup1', 'sup-pass-11');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && !!document.querySelector('[data-testid="supplier-portal"][data-ready="1"]'), 15000), 'supplier: a login on the main site stays in the manager app, its portal screens drawn');
  await sleep(1500);
  const sm = await p.evaluate(() => ({role: (getSession() || {}).role, workers: typeof workers === 'undefined' ? -1 : workers.length,
    tabs: [...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim()).join()}));
  ok(sm.role === 'supplier' && sm.workers === 0 && sm.tabs === 'Today,Workers,Commission,Hours' && fsReqs.length === 0,
    'supplier: the same frame with its own tabs (Today, Workers, Commission, Hours), no firm data loaded, not one Firestore request ' + JSON.stringify({sm, fs: fsReqs.slice(0, 3)}));
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
  // the frame's side menu: Today (the dashboard), Workers, Commission (its hours and pay), Hours (the review)
  const tabTo = async label => { await p.click(`[data-testid="shell-menu"] button:has-text("${label}")`); await sleep(250); };
  const sched = () => JSON.parse((supReplies.filter(x => x.action === 'loadSchedule').pop() || {text: '{}'}).text);
  const s0 = sched();
  ok((s0.workers || []).length === 1 && s0.workers[0].name === 'Avi Cohen' && !('token' in s0.workers[0]) && !('docUrl' in s0.workers[0]) && s0.workers[0].hourlyRate === 50 && s0.showPay === true
    && !JSON.stringify(s0.clients).includes('billRate') && !supReplies.some(x => /tok-|billRate|gpsAccuracy|"lat"/.test(x.text)), 'supplier: own worker only; no token or file link; sees pay by default (own rate), never client billing or GPS');
  const s_sp0 = await p.evaluate(() => ({tabs: [...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim()).join()}));
  ok(s_sp0.tabs === 'Today,Workers,Commission,Hours', 'supplier: its tabs in the manager frame (Hours with an hours tick) ' + JSON.stringify(s_sp0));
  // Dashboard: figures (on site, my workers, punches today) and today's punches.
  const db = await p.evaluate(() => ({figs: document.querySelectorAll('[data-testid="dashboard"] [data-slot="figures"] > button').length, text: document.querySelector('[data-testid="dashboard"]').innerText}));
  ok(db.figs === 3 && /My workers/i.test(db.text) && /Today's log/i.test(db.text), 'supplier dashboard: three figures and today\'s log ' + JSON.stringify(db));
  // My Hours → Pay (a Data Table on a computer): Avi 8h × own rate 50 = ₪400, commission 8 × 5 = ₪40.
  await tabTo('Commission');
  const payRow = () => p.evaluate(() => { const t = document.querySelector('[data-testid="pay-table"]'); return t ? t.innerText.replace(/\s+/g, ' ') : ''; });
  const pt = await payRow();
  ok(/Avi Cohen 8\.0 1 ₪50\/h ₪400 ₪40/.test(pt) && /Total 8\.0 1 ₪400 ₪40/.test(pt) && await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] [data-slot="data-table"][data-kind="table"]')),
    'supplier pay: a Data Table — 8h × own rate 50 = ₪400, commission 8 × 5 = ₪40, with totals ' + JSON.stringify(pt));
  await p.click('[data-testid="pay-table"] th button:has-text("Pay")');
  ok(await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] th[aria-sort]')), 'supplier pay: a tap on a column head sorts by it');
  // A daily-paid worker with a ₪/day commission (the reply rewritten): the commission is ₪/day × days.
  supTweak = j => { Object.assign(j.workers[0], {payMode: 'daily', supplierDayRate: 90}); };
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('Commission');
  const ptd = await payRow();
  supTweak = null;
  ok(/Avi Cohen 8\.0 1 ₪50\/day ₪50 ₪90/.test(ptd), 'supplier pay: a daily worker — pay by the day, commission ₪/day × days ' + JSON.stringify(ptd));
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('Commission');
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
  await tabTo('Workers');
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
  spl.noWindow = !(await p.$('[data-testid="window"]'));
  spl.gone = !(await p.$(plateOf(wt1))); spl.snack = await p.evaluate(() => (document.querySelector('[data-testid="undo-snack"]') || {}).innerText || '');
  await p.click('[data-testid="undo-snack"] .og-snack-u'); await sleep(400);
  spl.back = !!(await p.$(plateOf(wt1)));
  await sleep(5300);
  spl.noDelete = !supReplies.some(x => x.action === 'supplierDeleteWorker');
  ok(spl.menu === 'Edit,Delete' && spl.nb && spl.noWindow && spl.gone && /Tmpa Temp deleted/.test(spl.snack) && spl.back && spl.noDelete, 'supplier lists: a NEW badge; ⋮ Edit / Delete; Delete (no window opens) → Undo snack; Undo keeps the worker ' + JSON.stringify(spl));
  await p.click('[data-testid="workers"] button:has-text("Select")');
  await p.click(plateOf(wt2) + ' .og-plate b'); await p.click(plateOf(wt3) + ' .og-plate b');
  const s_sel = {count: await p.evaluate(() => document.querySelector('[data-testid="select-bar"] b').innerText.trim()), noEditor: !(await p.$('[data-testid="worker-form"]'))};
  await p.click('[data-testid="select-bar"] button:has-text("Delete")'); await sleep(300);
  s_sel.barGone = !(await p.$('[data-testid="select-bar"]')); s_sel.snack = await p.evaluate(() => (document.querySelector('[data-testid="undo-snack"]') || {}).innerText || '');
  s_sel.notYet = supReplies.filter(x => x.action === 'supplierDeleteWorker').length === 0;
  await sleep(5600);
  for (let i = 0; i < 40 && supReplies.filter(x => x.action === 'supplierDeleteWorker').length < 2; i++) await sleep(150);
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('Workers');
  s_sel.deleted = !(await p.$(plateOf(wt2))) && !(await p.$(plateOf(wt3))) && !!(await p.$(plateOf(wt1)));
  ok(s_sel.count === '2 selected' && s_sel.noEditor && s_sel.barGone && /2 workers deleted/.test(s_sel.snack) && s_sel.notYet && s_sel.deleted, 'supplier lists: Select two, Delete → Undo snack, deleted on the server only after 5 s ' + JSON.stringify(s_sel));
  await p.click(plateOf(wt1) + ' button[aria-label="Actions"]'); await p.click('[role="menuitem"]:has-text("Delete")');
  await sleep(5600); for (let i = 0; i < 40 && supReplies.filter(x => x.action === 'supplierDeleteWorker').length < 3; i++) await sleep(150);
  // Hours approval tab (hours ticks hours, approve, export): only its own workers; no dispute / fix; the month approved at once.
  await tabTo('Hours');
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
  await tabTo('Commission');
  const nLoadsS = supReplies.filter(x => x.action === 'loadSchedule').length;
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("עברית")');
  const sl = {he: await waitFor(p, () => document.documentElement.lang === 'he' && localStorage.getItem('uiLang') === 'he', 10000)};
  // the page is redrawn in the new language: wait for its tabs to be back before reading them
  const heCom = await p.evaluate(() => I18N['Commission']);
  await p.waitForFunction(h => ([...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim())[2] || '') === h, heCom, {timeout: 5000}).catch(() => {});
  sl.tab = await p.evaluate(() => [...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim())[2]); sl.want = heCom;
  sl.stayed = await p.evaluate(() => document.querySelector('[data-testid="supplier-portal"]').dataset.tab); sl.loads = supReplies.filter(x => x.action === 'loadSchedule').length - nLoadsS;
  ok(sl.he && sl.tab === sl.want && sl.stayed === 'hours' && sl.loads === 0, 'supplier: the header Language button switches the portal to Hebrew in place — the tab and the data stay ' + JSON.stringify(sl));
  await p.reload();
  ok(await waitFor(p, () => document.documentElement.lang === 'he' && [...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim())[0] === I18N['Today'], 15000), 'supplier: a reopened app keeps the chosen language');
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("English")');
  await waitFor(p, () => document.documentElement.lang === 'en', 10000);
  // The theme: the account menu of the portal carries the switch; Light and back to Dark.
  await p.click('header [data-testid="account-btn"]');
  await p.click('[data-testid="account-menu"] [data-testid="theme-light"]');
  const stl = await p.evaluate(() => ({look: document.documentElement.dataset.theme, stored: localStorage.getItem('uiTheme')}));
  await p.reload();
  stl.kept = await waitFor(p, () => document.documentElement.dataset.theme === 'light' && !!document.querySelector('[data-testid="supplier-portal"]'), 15000);
  await p.click('header [data-testid="account-btn"]');
  await p.click('[data-testid="account-menu"] [data-testid="theme-dark"]');
  await p.keyboard.press('Escape');
  stl.dark = await p.evaluate(() => document.documentElement.dataset.theme === 'dark' && localStorage.getItem('uiTheme') === 'dark');
  ok(stl.look === 'light' && stl.stored === 'light' && stl.kept && stl.dark, 'supplier: the account menu\'s theme switch turns the light theme on (kept after a reload) and back to Dark ' + JSON.stringify(stl));
  // A phone: the bottom bar; the pay table becomes plates; the worker window opens from the bottom.
  await p.setViewportSize({width: 390, height: 844}); await sleep(300);
  await p.click('nav.og-bar button:has-text("Commission")').catch(() => {}); await sleep(300);
  const s_ph = {cards: await p.evaluate(() => !!document.querySelector('[data-testid="pay-table"] [data-slot="data-table"][data-kind="cards"]')),
    plate: await p.evaluate(() => ((document.querySelector('[data-pay-row="w1"]') || {}).innerText || '').replace(/\s+/g, ' '))};
  await p.click('nav.og-bar button:has-text("Workers")').catch(() => {}); await sleep(300);
  await p.click(plateOf('w1') + ' .og-plate b'); await p.waitForSelector('[data-testid="worker-form"]');
  s_ph.sheet = await p.evaluate(() => document.querySelector('[data-testid="window"]').dataset.kind);
  await p.screenshot({path: SP + '/supplier-portal-phone.png'}).catch(()=>{});
  await p.keyboard.press('Escape'); await sleep(300);
  await p.setViewportSize({width: 1280, height: 720});
  ok(s_ph.cards && /Avi Cohen 8\.0h · 1 day · ₪50\/h · Pay ₪400 ₪40/.test(s_ph.plate) && s_ph.sheet === 'sheet', 'supplier portal: on a phone the pay table is plates and a window opens from the bottom ' + JSON.stringify(s_ph));
  // The account menu: the name, "Supplier", Sign out.
  await p.click('[data-testid="account-btn"]'); await p.waitForSelector('[data-testid="account-menu"]');
  const am = await p.evaluate(() => document.querySelector('[data-testid="account-menu"]').innerText);
  ok(/sup1/.test(am) && /supplier/i.test(am) && /Sign out/.test(am), 'supplier: the account menu holds the name and Sign out ' + JSON.stringify(am));
  await p.click('[role="menuitem"]:has-text("Sign out")');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && document.getElementById('loginScreen').style.display !== 'none' && !localStorage.getItem('supplierPortal_session') && !localStorage.getItem('schedMgr_session'), 15000), 'supplier: Sign out opens the one login page');
  ok(p.errs.length === 0, 'supplier: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── Client portal (client1 → client c2: Avi's shift yesterday) — a React page (src/client/, stage 3) with the hours review (src/hours-review/) ──
  ctx = await newCtx(); p = await page(ctx);
  const hoursReplies = [];
  p.on('response', async r => { if (/cloudfunctions\.net\/hours$/.test(r.url()) && r.request().method() === 'POST') { try { hoursReplies.push(await r.text()); } catch (e) {} } });
  await login(p, BASE + 'client-portal.html', 'client1', 'client-pass-1');
  const hrvReady = () => !!document.querySelector('[data-testid="hours-review"][data-ready="1"]') && document.querySelectorAll('[data-day-key]').length >= 1;
  ok(await waitFor(p, hrvReady, 15000), 'client: sees its workers\' shifts of the month');
  // The helpers below read the React page through its DOM: a day plate by its worker|day key and state.
  const dayOf = key => `[data-day-key="${key}"]`;
  const stateOf = key => p.evaluate(k => { const d = document.querySelector(`[data-day-key="${k}"]`); return d ? d.dataset.state : 'none'; }, key);
  const waitState = async (key, st) => { for (let i = 0; i < 60 && (await stateOf(key)) !== st; i++) await sleep(150); return stateOf(key); };
  const menuOf = async key => { await p.click(dayOf(key) + ' button[aria-label="Actions"]'); await p.waitForSelector('[role="menuitem"]'); return p.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(m => m.innerText.trim())); };
  const pick = async label => { await p.click(`[role="menuitem"]:has-text("${label}")`); await sleep(200); };
  const tapOutside = async () => { await p.mouse.click(8, 400); await sleep(300); };
  const cp = await p.evaluate(() => ({text: document.querySelector('[data-testid="client-portal"]').innerText, workers: [...document.querySelectorAll('[data-slot="section"] .og-label > span:first-child')].map(b => b.textContent),
    inApp: /schedule-manager/.test(location.pathname), workersLoaded: typeof workers === 'undefined' ? -1 : workers.length,
    tabs: [...document.querySelectorAll('[data-testid="shell-menu"] button')].map(b => b.innerText.trim()).join(), plate: !!document.querySelector('[data-day-key] .og-plate')}));
  const avi = await p.evaluate(() => [...document.querySelectorAll('[data-day-key]')].map(d => d.dataset.dayKey).find(k => k.startsWith('w1|')));
  const acts = await menuOf(avi); await p.keyboard.press('Escape'); await sleep(150);
  ok(cp.workers.includes('Avi Cohen') && acts.join() === 'Approve this day,Dispute this day,Propose a fix' && hoursReplies.length >= 1 && !/₪|Agency|hourlyRate|billRate|gpsAccuracy|"dist"|tok-|supplier|docUrl|0501/i.test(cp.text + hoursReplies.join('')),
    'client: only hours of its workers, per-day approve / dispute / fix under ⋮ — no money, supplier, GPS, files or tokens ' + JSON.stringify({workers: cp.workers, acts, replies: hoursReplies.length}));
  ok(cp.inApp && cp.workersLoaded === 0 && cp.tabs === 'Hours' && /Site B/.test(cp.text) && cp.plate, 'client: in the manager app with one tab, Hours (its client named on top), no firm data, days as plates ' + JSON.stringify({inApp: cp.inApp, w: cp.workersLoaded, tabs: cp.tabs, plate: cp.plate}));
  // Select mode: Select shows the tick boxes, a tap ticks a day, the glass bar approves the ticked days.
  await p.click('[data-testid="hours-review"] button:has-text("Select")');
  await p.click(dayOf(avi) + ' .og-plate b');
  const sb = await p.evaluate(() => ({bar: (document.querySelector('[data-testid="select-bar"]') || {}).innerText || '', box: !!document.querySelector('[data-day-key] .og-box'), kb: !!document.querySelector('[data-day-key] button[aria-label="Actions"]')}));
  await p.click('[data-testid="approve-selected"]');
  const ca = {st: await waitState(avi, 'approved'), status: await p.evaluate(() => document.querySelector('[data-testid="hours-status"]').innerText), sel: sb,
    barGone: await p.evaluate(() => !document.querySelector('[data-testid="select-bar"]'))};
  ok(ca.st === 'approved' && /approved/i.test(ca.status) && /1 selected/.test(sb.bar) && sb.box && !sb.kb && ca.barGone, 'client: Select → tick a day → Approve approves it ' + JSON.stringify(ca));
  // The owner sees it in Accounting → Hours approvals (This Month), not changed (the same lines).
  const octx = await newCtx(); const q = await page(octx);
  await login(q, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await q.waitForNavigation().catch(()=>{});
  await waitFor(q, () => typeof workers !== 'undefined' && workers.length === 2);
  // Accounting → Approvals (React): opening the tab reads the month's documents afresh.
  const appr = async (until) => q.evaluate(async until => { switchTab('dashboard'); switchTab('accounting'); await ManagerBridge.setPeriod('month'); setAccTab('approvals');
    const t = () => (document.querySelector('#accountingRoot [data-testid=hour-approvals]') || {}).innerText || '';
    await T.until(() => t() && (!until || new RegExp(until).test(t())), 8000); await T.tick(200); const text = t(); setAccTab('salary'); return text; }, until);
  const oa = await appr('approved');
  ok(/Site B/.test(oa) && /Client/.test(oa) && /1 of \d days approved/.test(oa) && !/Changed after approval/.test(oa), 'owner: the client\'s approval in Accounting, not "changed" ' + JSON.stringify(oa));
  // The client disputes the day (the window sends on a tap outside); the owner sees the comment.
  await menuOf(avi); await pick('Dispute this day');
  await p.waitForSelector('[data-testid="dispute-text"]');
  const dWin = await p.evaluate(() => ({kind: document.querySelector('[data-testid="window"]').dataset.kind, save: [...document.querySelectorAll('[data-testid="window"] button')].map(b => b.innerText.trim()).filter(Boolean)}));
  await p.fill('[data-testid="dispute-text"]', 'Left at 15:00');
  await tapOutside();
  const cd = {st: await waitState(avi, 'disputed'), text: await p.evaluate(() => document.querySelector('[data-testid="hours-review"]').innerText), win: dWin};
  ok(cd.st === 'disputed' && /Left at 15:00/.test(cd.text) && dWin.kind === 'dialog' && !dWin.save.length, 'client: disputes a day with a comment — a window with no buttons, sent on a tap outside ' + JSON.stringify({st: cd.st, win: dWin}));
  const od = await appr('Disputed');
  ok(/Disputed/.test(od) && /Left at 15:00/.test(od) && /Avi Cohen/.test(od), 'owner: sees the disputed day and its comment ' + JSON.stringify(od));
  // The client proposes a fix (a tap on the day opens it); the owner accepts it — the shift's punches move to the new times.
  await p.click(dayOf(avi) + ' .og-plate b');
  await p.waitForSelector('[data-testid="fix-in"]');
  await p.fill('[data-testid="fix-in"]', '05:30'); await p.fill('[data-testid="fix-out"]', '13:30'); await p.fill('[data-testid="fix-text"]', 'Came early');
  await tapOutside();
  const cf = await waitState(avi, 'fix');
  ok(cf === 'fix', 'client: proposes a fix for a day ' + cf);
  const of = await appr('Fix proposed');
  ok(/Fix proposed/.test(of) && /05:30–13:30/.test(of) && /Accept/.test(of), 'owner: sees the proposed fix with Accept / Reject ' + JSON.stringify(of));
  await q.evaluate(async () => { setAccTab('approvals'); await T.until(() => document.querySelector('#accountingRoot [data-testid=fix-accept]'), 8000); });
  await (await q.$('#accSecApprovals')).screenshot({path: SP + '/hours-approvals-owner.png'}).catch(()=>{});
  const fxa = await q.evaluate(async () => {
    const month = localYMD(new Date()).slice(0, 7);
    const docs = await hourApprovalsOf(month, true), doc = docs.find(d => d.kind === 'client');
    const key = Object.keys(doc.days).find(k => doc.days[k].status === 'fix');
    // Accept (it asks first: the test accepts the confirm).
    document.querySelector('#accountingRoot [data-testid=fix-accept]').click();
    await T.until(() => !document.querySelector('#accountingRoot [data-testid=fix-accept]'), 8000);
    // The proposed times are Israel time (as the punch page writes them).
    const il = e => e && new Date(e.ts).toLocaleTimeString('en-GB', {timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit'});
    for(let i = 0; i < 60 && il(getPunchLog().find(e => e.id === 'p1')) !== '05:30'; i++) await new Promise(r => setTimeout(r, 150));
    const p1 = getPunchLog().find(e => e.id === 'p1'), p2 = getPunchLog().find(e => e.id === 'p2');
    setAccTab('salary');
    return {in: il(p1), out: il(p2), after: (await hourApprovalsOf(month, true)).find(d => d.kind === 'client').days[key].status};
  });
  ok(fxa.in === '05:30' && fxa.out === '13:30' && fxa.after === 'fixed', 'owner: accepting a fix moves the shift\'s punches ' + JSON.stringify(fxa));
  await p.reload(); await waitFor(p, hrvReady, 15000);
  const cfx = await stateOf(avi);
  ok(cfx === 'fixed', 'client: the accepted fix shows as done ' + cfx);
  // Stage 5c: "Approve the month" (the days still waiting) opens the signature at once — or, with every day already
  // done (the seed's other day in the month before), "Sign the month"; the PDF is stored with the client's documents.
  const viaApprove = await p.evaluate(() => !!document.querySelector('[data-testid="approve-month"]'));
  if (viaApprove) { await p.click('[data-testid="approve-month"]'); await p.click('[data-testid="approve-month-ok"]'); }
  else { await p.waitForSelector('[data-testid="sign-month"]', {timeout: 10000}); await p.click('[data-testid="sign-month"]'); }
  await p.waitForSelector('[data-testid="signature-pad"]', {timeout: 10000});
  const sgOkOff = await p.evaluate(() => document.querySelector('[data-testid="sign-ok"]').disabled);
  const box = await (await p.$('[data-testid="signature-pad"]')).boundingBox();
  await p.mouse.move(box.x + 30, box.y + box.height / 2); await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(box.x + 30 + i * 20, box.y + box.height / 2 + (i % 2 ? -25 : 25));
  await p.mouse.up();
  const sgInk = await p.evaluate(() => document.querySelector('[data-testid="signature-pad"]').dataset.ink === '1' && !document.querySelector('[data-testid="sign-ok"]').disabled);
  const nReplies = hoursReplies.length;
  await p.click('[data-testid="sign-ok"]');
  const sgNote = await waitFor(p, () => !document.querySelector('[data-testid="signature-pad"]') && /Signed/.test((document.querySelector('[data-testid="signed-note"]') || {}).textContent || ''), 15000);
  const stored = await srv('/signed');
  for (let i = 0; i < 25 && hoursReplies.length === nReplies; i++) await sleep(200);
  const signReply = hoursReplies.slice(nReplies).join('');
  ok(sgOkOff && sgInk && sgNote && stored.signed && /^tenants\/.+\/clients\/c2\/documents\/hours-\d{4}-\d{2}-signed\.pdf$/.test(stored.signed.path) && stored.head.startsWith('%PDF-') && stored.pages >= 1 && stored.jpegs === stored.pages && stored.size > 5000,
    'client: signs the approved month with a finger' + (viaApprove ? ' (opened by Approve the month)' : '') + ' — the PDF (the days and the signature) is stored with its documents ' + JSON.stringify({sgOkOff, sgInk, sgNote, stored}));
  ok(signReply && !/documents\/|path|₪|Agency|hourlyRate|billRate|gpsAccuracy|tok-/.test(signReply), 'client: the sign reply says when and by whom — no file path, money, supplier, GPS or token ' + signReply);
  await p.reload(); await waitFor(p, hrvReady, 15000);
  ok(await waitFor(p, () => /Signed/.test((document.querySelector('[data-testid="signed-note"]') || {}).textContent || '') && /Sign again/.test(document.querySelector('[data-testid="sign-month"]').textContent), 10000), 'client: after a reload the month shows as signed (Sign again)');
  const osg = await q.evaluate(async path => { switchTab('dashboard'); switchTab('accounting'); setAccTab('approvals');
    await T.until(() => document.querySelector('#accountingRoot [data-testid=approval-signed]'), 8000);
    const el = document.querySelector('#accountingRoot [data-testid=approval-signed]'), r = {text: el ? el.innerText : '', btn: !!(el && el.querySelector('button'))};
    try { r.url = await (await loadFirestoreBackend()).storageUrl(path); } catch (e) { r.err = String(e); }
    setAccTab('salary'); return r; }, stored.signed.path);
  ok(/Signed/.test(osg.text) && osg.btn && /signed\.pdf/.test(decodeURIComponent(osg.url || '')), 'owner: the client\'s signed month in Hours approvals, with the PDF to open ' + JSON.stringify(osg));
  // Admin → Users (React, stage 6f-2): the owner is pinned first; the client login shows its client and hours ticks.
  const ul = await q.evaluate(async () => { switchTab('admin'); switchAdminPane('users');
    await T.until(() => document.querySelectorAll('#adminRoot [data-testid="user-row"]').length >= 2, 9000);
    return [...document.querySelectorAll('#adminRoot [data-testid="user-row"]')].map(r => r.innerText.replace(/\s+/g, ' ')); });
  ok(ul.length >= 2 && /\bowner\b/.test(ul[0]) && ul.some(t => /\bclient\b/.test(t) && /Site B/.test(t) && /Approve/.test(t) && /Fix/.test(t)), 'users: the owner pinned first; a client login shows its client and hours ticks ' + JSON.stringify(ul.slice(0, 3)));
  // Lists: a plate per user, the ⋮ menu (Edit, Delete), Delete takes the plate behind the Undo snack and Undo brings it back; Select mode.
  const clientRow = '#adminRoot [data-testid="user-row"][data-role="client"]';
  const lsA = await q.evaluate(sel => ({plate: !!document.querySelector(sel + ' .og-plate'), uid: document.querySelector(sel).dataset.uid}), clientRow);
  await q.click(clientRow + ' .og-kb'); await q.waitForSelector('[role="menuitem"]');
  const lsPop = await q.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.innerText.trim()).join());
  let delCalls = 0; await q.exposeFunction('__countDel', () => { delCalls++; });
  await q.evaluate(() => { const f = window.fetch; window.__fetchKeep = f; window.fetch = (u, o) => { if(o && /"deleteUser"/.test(o.body)) window.__countDel(); return f(u, o); }; });
  await q.click('[role="menuitem"]:has-text("Delete")'); await sleep(400);
  const ls = await q.evaluate(async ({sel, uid}) => {
    const r = {gone: !document.querySelector('#adminRoot [data-testid="user-row"][data-uid="' + uid + '"]'), snack: !!document.querySelector('[data-testid="undo-snack"]')};
    document.querySelector('[data-testid="undo-snack"] .og-snack-u').click(); await T.tick(400);
    r.back = !!document.querySelector(sel) && !document.querySelector('[data-testid="undo-snack"]');
    window.fetch = window.__fetchKeep;
    document.querySelector('#adminRoot [data-testid="users-select"] button').click(); await T.tick(50);
    const rows = [...document.querySelectorAll('#adminRoot [data-testid="user-row"]')];
    r.n = rows.length; r.ownerNoBox = !rows[0].querySelector('.og-box') && rows.slice(1).every(x => !!x.querySelector('.og-box'));
    [...document.querySelectorAll('#adminRoot [data-testid="select-head"] button')].pop().click(); await T.tick(50);
    r.all = document.querySelector('[data-testid="select-bar"] b').innerText.trim();
    T.tap(document.querySelector(sel)); await T.tick(50);
    r.unpicked = document.querySelector('[data-testid="select-bar"] b').innerText.trim() === (r.n - 2) + ' selected' && !document.getElementById('userFormOverlay').classList.contains('open');
    [...document.querySelectorAll('[data-testid="select-bar"] button')].pop().click(); await T.tick(50);
    r.ended = !document.querySelector('[data-testid="select-bar"]') && !document.querySelector('#adminRoot .og-box');
    return r;
  }, {sel: clientRow, uid: lsA.uid});
  ok(lsA.plate && lsPop === 'Edit,Delete' && ls.gone && ls.snack && ls.back && delCalls === 0, 'lists: a plate per user; ⋮ opens Edit / Delete; Delete takes it behind the Undo snack, Undo brings it back ' + JSON.stringify({lsPop, ls, delCalls}));
  ok(ls.ownerNoBox && ls.all === (ls.n - 1) + ' selected' && ls.unpicked && ls.ended, 'lists: Select — boxes (none for the owner), Select all, a tap unticks, ✕ ends ' + JSON.stringify(ls));
  // The user form: the template picked says the role and shows its flat ticks read-only; "Only own workers" locked on for a supplier and a client.
  await q.evaluate(async () => { openCreateUserForm(); await T.tick(100); document.querySelector('#userFormModal [data-sec="sections"] [data-slot="accordion-trigger"]').click(); await T.tick(50); });
  const uf = {};
  for (const tid of ['accountant', 'hr', 'supplier', 'client']) {
    await q.click('#userFormModal [data-testid="user-template"]'); await q.click('[role="option"][data-tid="' + tid + '"]'); await sleep(150);
    uf[tid] = await q.evaluate(() => {
      const tiles = id => [...document.querySelectorAll('#userFormModal [data-testid="' + id + '"] [data-k]')].filter(x => x.getAttribute('data-state') === 'checked').map(x => x.dataset.k).join(',');
      const own = document.querySelector('#userFormModal button[data-testid="rights-own"]');
      return {role: document.querySelector('#userFormModal [data-testid="user-window"]').dataset.role, tabs: tiles('rights-tabs'), shown: tiles('rights-shown'),
        locked: !!own && own.disabled && own.dataset.state === 'checked', ro: [...document.querySelectorAll('#userFormModal [data-testid="rights-tiles"] [data-k]')].every(x => x.disabled),
        commission: !!document.querySelector('#userFormModal [data-sec="commission"]'), supplier: !!document.getElementById('uSupplier'), client: !!document.getElementById('uClient')};
    });
  }
  ok(uf.accountant.role === 'staff' && uf.accountant.tabs === 'today,workers,accounting,punchlog' && !uf.accountant.locked && uf.accountant.ro
      && uf.hr.role === 'hr' && uf.hr.locked && uf.hr.commission && uf.hr.shown === 'seePay'
      && uf.supplier.role === 'supplier' && uf.supplier.locked && uf.supplier.supplier && uf.supplier.tabs === 'today,workers,commission,hours'
      && uf.client.role === 'client' && uf.client.locked && uf.client.client && uf.client.tabs === 'hours' && uf.client.shown === '',
    'user form: the template picked sets the role and shows its flat ticks read-only ' + JSON.stringify(uf));
  await sleep(150);
  await (await q.$('#userFormOverlay .modal')).screenshot({path: SP + '/user-form-supplier.png'}).catch(()=>{});
  // On a phone the window stays inside the screen: a long Rights summary truncates instead of widening it.
  await q.click('#userFormModal [data-testid="user-template"]'); await q.click('[role="option"][data-tid="supplier"]'); await sleep(150);
  const vp0 = q.viewportSize();
  await q.setViewportSize({width: 360, height: 800}); await sleep(300);
  const ufw = await q.evaluate(() => { const w = document.querySelector('#userFormModal [data-testid="user-window"]'); return {sw: w.scrollWidth, cw: w.clientWidth}; });
  await q.setViewportSize(vp0); await sleep(150);
  ok(ufw.sw <= ufw.cw, 'user form: on a phone the window is no wider than the screen ' + JSON.stringify(ufw));
  await q.evaluate(() => closeModal('userFormOverlay'));
  // A kept login opens the portal at once: the login screen never shows on a reload.
  await p.reload({waitUntil: 'domcontentloaded'});
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000), 'client: a reload with a kept login stays in its Hours tab');
  // The language: the Language button switches the portal to Hebrew in place — the month stays loaded (no new load).
  // The reload's own hours reply can still land after data-ready (its body is read asynchronously), so the count is
  // taken once it has stayed the same for 1 s (at most 5 s), not straight away.
  for (let n = -1, still = 0, end = Date.now() + 5000; still < 1000 && Date.now() < end; ) {
    if (hoursReplies.length === n) still += 200; else { n = hoursReplies.length; still = 0; }
    await sleep(200);
  }
  const nLoads = hoursReplies.length;
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("עברית")');
  const cl = {he: await waitFor(p, () => document.documentElement.lang === 'he' && localStorage.getItem('uiLang') === 'he' && document.querySelector('[data-testid="shell-menu"] button').innerText.trim() === I18N['Hours'], 10000)};
  cl.days = await p.evaluate(() => document.querySelectorAll('[data-day-key]').length); cl.loads = hoursReplies.length - nLoads;
  cl.ltr = await p.evaluate(() => getComputedStyle(document.body).direction);
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("English")');
  cl.en = await waitFor(p, () => document.documentElement.lang === 'en' && document.querySelector('[data-testid="shell-menu"] button').innerText.trim() === 'Hours', 10000);
  ok(cl.he && cl.days >= 1 && cl.loads === 0 && cl.ltr === 'ltr' && cl.en, 'client portal: the Language button switches to Hebrew and back in place, the month stays, left to right ' + JSON.stringify(cl));
  await p.screenshot({path: SP + '/client-portal-hours.png', fullPage: true}).catch(()=>{});
  ok(p.errs.length === 0 && q.errs.length === 0, 'client portal: no page errors ' + p.errs.concat(q.errs).join(' | '));
  await octx.close(); await ctx.close();
  // Sign out (the account menu): ends the portal's sign-in and opens the one login page.
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'client-portal.html', 'client1', 'client-pass-1');
  await waitFor(p, () => !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000);
  await p.click('[data-testid="account-btn"]'); await p.waitForSelector('[data-testid="account-menu"]');
  const menu = await p.evaluate(() => ({text: document.querySelector('[data-testid="account-menu"]').innerText, lang: !document.querySelector('[data-testid="account-menu"] [data-testid="lang-btn"]') && !!document.querySelector('header [data-testid="lang-btn"] + [data-testid="account-btn"]')}));
  ok(menu.lang && /Site B manager/.test(menu.text) && /client/i.test(menu.text) && /Sign out/.test(menu.text), 'client: the account menu holds the person\'s name, the role and Sign out, the Language button beside it ' + JSON.stringify(menu));
  // A phone: the dispute window opens from the bottom (a sheet).
  await p.keyboard.press('Escape'); await p.setViewportSize({width: 390, height: 800}); await sleep(300);
  const k2 = await p.evaluate(() => [...document.querySelectorAll('[data-day-key]')].map(d => d.dataset.dayKey).find(k => k.startsWith('w1|')));
  await menuOf(k2); await pick('Dispute this day'); await p.waitForSelector('[data-testid="dispute-text"]');
  const sheet = await p.evaluate(() => document.querySelector('[data-testid="window"]').dataset.kind);
  await p.screenshot({path: SP + '/client-portal-phone-dispute.png'}).catch(()=>{});
  await p.keyboard.press('Escape'); await sleep(300); await p.setViewportSize({width: 1280, height: 720});
  ok(sheet === 'sheet', 'client portal: on a phone a window opens from the bottom ' + sheet);
  await p.click('[data-testid="account-btn"]'); await p.waitForSelector('[data-testid="account-menu"]');
  await p.click('[role="menuitem"]:has-text("Sign out")');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && document.getElementById('loginScreen').style.display !== 'none' && !localStorage.getItem('clientPortal_session'), 15000), 'client: Sign out opens the one login page');
  // The old portal pages only send to the manager app.
  for (const pg of ['supplier-portal.html', 'client-portal.html']) {
    await p.goto(BASE + pg);
    ok(await waitFor(p, () => /schedule-manager/.test(location.pathname), 10000), 'portals: ' + pg + ' sends to the manager app');
  }
  // A session kept by an old portal page is taken over by the manager app (bookmarks, installed apps).
  await login(p, BASE + 'schedule-manager.html', 'client1', 'client-pass-1');
  await waitFor(p, () => !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000);
  await p.evaluate(() => { localStorage.removeItem('schedMgr_session'); });
  await p.goto(BASE + 'client-portal.html');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000), 'client: an old portal session opens the manager app signed in');
  // A session signed in before the flat rights (no rights) goes to the sign-in: its token has no rt claim.
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('schedMgr_session')); delete s.rights; localStorage.setItem('schedMgr_session', JSON.stringify(s)); });
  await p.reload();
  ok(await waitFor(p, () => document.getElementById('loginScreen').style.display !== 'none' && !localStorage.getItem('schedMgr_session') && !localStorage.getItem('clientPortal_session'), 15000),
    'a session from before the flat rights is sent to the sign-in');
  await ctx.close();

  // ── Worker punch page without a personal link: a message, no worker picker ──
  // The punch page is a React page (src/punch/, stage 5): the checks read its DOM, localStorage and the punch function's replies.
  ctx = await newCtx(); p = await page(ctx);
  await p.goto(BASE + 'worker-punch.html');
  ok(await waitFor(p, () => /Open your personal link/.test(document.body.innerText), 10000), 'punch: without a personal link the page asks for it');
  await ctx.close();

  // ── Worker punch link ──
  ctx = await newCtx(); p = await page(ctx);
  const punchReplies = [];
  // The punch function's replies; `punchTweak` (when set) rewrites a `load` reply on its way to the page.
  let punchTweak = null;
  await p.route(/cloudfunctions\.net\/punch$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fallback();
    const body = r.request().postData() || '{}', action = JSON.parse(body).action;
    const res = await fetch('http://127.0.0.1:5055/punch', {method: 'POST', body});
    let text = await res.text();
    punchReplies.push({action, text});
    if (punchTweak && action === 'load') { const j = JSON.parse(text); punchTweak(j); text = JSON.stringify(j); }
    return r.fulfill({status: res.status, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, body: text});
  });
  const punchReady = () => { const s = document.getElementById('screenPunch'), b = document.getElementById('bigPunchBtn'); return !!s && !s.classList.contains('hidden') && !!b && (b.dataset.state === 'in' || b.dataset.state === 'out'); };
  const before = (await srv('/punches')).n;
  await p.goto(BASE + 'worker-punch.html?t=tok-avi');
  ok(await waitFor(p, punchReady, 15000), 'punch: link verified, on site');
  ok(await p.evaluate(() => typeof Payroll === 'undefined' && typeof locOk === 'undefined' && typeof getPunchLog === 'undefined' && !!document.querySelector('#screenPunch [data-testid="lang-btn"]')),
    'punch: a React page (no old globals; the shared Language button in its top bar)');
  // The PWA manifest: built by Vite under a hashed name, absolute paths, the app's id; its icons and start page load.
  const mfc = await p.evaluate(async () => { const href = document.querySelector('link[rel="manifest"]').getAttribute('href'), m = await (await fetch(href)).json();
    const st = async u => (await fetch(u)).status;
    return {href, id: m.id, start: m.start_url, startSt: await st(m.start_url), icons: await Promise.all(m.icons.map(i => st(i.src)))}; });
  ok(/^\/assets\/manifest-punch-.+\.json$/.test(mfc.href) && mfc.id === '/worker-punch.html' && mfc.start === '/worker-punch.html' && mfc.startSt === 200 && mfc.icons.length && mfc.icons.every(s => s === 200),
    'punch: the manifest is a built file with absolute paths and an id; its icons and start page load ' + JSON.stringify(mfc));
  // Hold to punch: a short press rolls back and sends nothing; about a second punches.
  const pbb = await (await p.$('#bigPunchBtn')).boundingBox(), cx = pbb.x + pbb.width / 2, cy = pbb.y + pbb.height / 2;
  await p.mouse.move(cx, cy); await p.mouse.down(); await sleep(300); await p.mouse.up(); await sleep(600);
  const shortPress = await p.evaluate(() => ({log: JSON.parse(localStorage.getItem('punchLog') || '[]').length, result: document.getElementById('punchResult').textContent}));
  await p.mouse.down(); await sleep(1300); await p.mouse.up();
  ok(await waitFor(p, () => /Punched in at \d\d:\d\d · have a good shift/.test(document.getElementById('punchResult').textContent) && !document.getElementById('screenPunch').classList.contains('hidden')), 'punch: a hold of about a second punches in; the line under the button says so');
  ok(shortPress.result === '' && shortPress.log === 0, 'punch: a short press sends nothing ' + JSON.stringify(shortPress));
  const tiles = await p.evaluate(() => ({next: document.getElementById('tileNextShift').textContent, hours: document.getElementById('tileMonthHours').textContent, greet: document.getElementById('punchGreeting').innerHTML}));
  ok(tiles.next !== '—' && /Avi/.test(tiles.greet) && /gic/.test(tiles.greet), 'punch: greeting with the first name and its icon; My Schedule tile shows the next shift ' + JSON.stringify(tiles));
  ok(await waitFor(p, () => /14°/.test(document.getElementById('punchGreeting').textContent) && !!document.querySelector('#punchGreeting svg.gic .drop')), 'punch: the greeting shows the weather at the worker\'s site — the rain icon and 14°');
  ok(await waitFor(p, () => document.getElementById('bigPunchBtn').dataset.state === 'out', 5000), 'punch: after punching in the button offers Punch out');
  await sleep(1500);
  const after = await srv('/punches');
  ok(after.n === before + 1, 'punch: saved through the punch function (' + before + ' → ' + after.n + ')');
  ok(!after.days.includes(null), 'punch: the new punch has a day');
  const load0 = JSON.parse((punchReplies.find(x => x.action === 'load') || {text: '{}'}).text);
  await p.click('[data-testid="tile-schedule"]');
  await waitFor(p, () => !document.getElementById('screenSchedule').classList.contains('hidden'));
  await sleep(1200);
  const ms = await p.evaluate(() => ({shown: !document.getElementById('screenSchedule').classList.contains('hidden'), days: document.querySelectorAll('#scheduleContent .sched-cell').length, empty: /No shifts planned yet/.test(document.getElementById('scheduleContent').innerText)}));
  ms.n = (load0.workers || []).length; ms.sched = (load0.workers || [{}])[0] && 'schedule' in load0.workers[0];
  ok(ms.shown && (ms.days >= 35 || ms.empty) && ms.n === 1 && ms.sched, 'punch: My Schedule shows the worker\'s own week ' + JSON.stringify(ms));
  // The sheet has no ✕ Close: a swipe down from its top closes it (stage 13).
  const shc = await p.evaluate(async () => {
    const s = document.getElementById('screenSchedule'), r = {noClose: !/Close/.test(s.querySelector('.top-bar').innerText), grab: !!s.querySelector('.sheet-grab')};
    const t = (type, dy) => { const tp = new Touch({identifier: 1, target: s, clientX: 100, clientY: 120 + dy}); s.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [tp], changedTouches: [tp]})); };
    t('touchstart', 0); for(let d = 10; d <= 200; d += 20) t('touchmove', d); t('touchend', 200);
    await new Promise(res => setTimeout(res, 400)); r.closed = s.classList.contains('hidden') && !document.getElementById('screenPunch').classList.contains('hidden'); return r; });
  ok(shc.noClose && shc.grab && shc.closed, 'punch: My Schedule has no ✕ Close; a swipe down closes the sheet ' + JSON.stringify(shc));
  // My Schedule's plates: a roster of work every day and tonight changed to a night shift (the load reply rewritten; "today" is the page's clock, E2E_NOW).
  punchTweak = j => { const t = new Date(process.env.E2E_NOW || Date.now()), k = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    j.workers[0].schedule = [0, 1, 2, 3, 4, 5, 6].map(() => ({type: 'work', start: '09:00', end: '17:00'})); j.workers[0].dates = {[k]: {type: 'work', start: '22:00', end: '06:00'}}; };
  await p.reload(); await waitFor(p, punchReady, 15000);
  await p.click('[data-testid="tile-schedule"]'); await sleep(1500);
  const mp = await p.evaluate(() => { const c = document.getElementById('scheduleContent'), first = c.querySelector('.sp-plate');
    return {top: !!c.querySelector('.sched-sum.top + .sched-grid'), plates: c.querySelectorAll('.sp-plate').length, more: !!c.querySelector('.sp-more'),
      first: first ? first.innerText.replace(/\s+/g, ' ') : '', today: !!(first && first.classList.contains('today')), dot: !!c.querySelector('.shift-bar.dated')}; });
  ok(mp.top && mp.plates >= 1 && mp.plates <= 10 && mp.today && /22:00 – 06:00/.test(mp.first) && /Night shift/.test(mp.first) && /changed/.test(mp.first) && mp.dot,
    'punch: My Schedule — figures on top, day plates from today (10 at a time), a changed night day tagged ' + JSON.stringify(mp));
  await p.keyboard.press('Escape'); await sleep(400);
  punchTweak = null;
  // A schedule change since this device last saw it: a notice that stays on the punch screen until My Schedule is opened.
  await p.evaluate(() => localStorage.setItem('schedSeen_w1', 'old'));
  await p.reload(); await waitFor(p, punchReady, 15000);
  const vis = () => p.evaluate(() => getComputedStyle(document.getElementById('schedNotice')).display !== 'none');
  const sn = {shown: await vis(), tag: await p.evaluate(() => !!document.getElementById('schedBadge'))};
  await sleep(4500); sn.still = await vis();
  await p.click('#schedNotice'); await sleep(300);
  sn.sheet = await p.evaluate(() => !document.getElementById('screenSchedule').classList.contains('hidden'));
  sn.after = await vis(); sn.tagAfter = await p.evaluate(() => !!document.getElementById('schedBadge'));
  ok(sn.shown && sn.tag && sn.still && sn.sheet && !sn.after && !sn.tagAfter, 'punch: a schedule change shows a notice that stays until My Schedule is opened ' + JSON.stringify(sn));
  await p.keyboard.press('Escape'); await sleep(400);
  // My Hours and Pay: yesterday's seeded 8h shift (hourly 50) from the punch function's myMonth, priced like Salary.
  await p.click('[data-testid="tile-hours"]');
  const back = await p.evaluate(() => { const y = new Date(); y.setDate(y.getDate() - 1); const now = new Date(); return (y.getFullYear() - now.getFullYear()) * 12 + y.getMonth() - now.getMonth(); });
  if (back) await p.click('#hoursContent .sched-nav[aria-label="Previous month"]');
  await waitFor(p, () => !!document.querySelector('#hoursContent .hours-shift'), 10000);
  const mh = await p.evaluate(() => ({text: document.getElementById('hoursContent').innerText.slice(0, 160),
    card: ((document.querySelector('#hoursContent .pay-card .pay-r.tot') || {}).innerText || '').replace(/\s+/g, ' ')}));
  const months = punchReplies.filter(x => x.action === 'myMonth');
  mh.leak = months.some(x => /gpsAccuracy|gpsWarnings|billRate|tok-/.test(x.text)); mh.replies = months.length;
  ok(mh.replies >= 1 && !mh.leak && /8\.0h/.test(mh.text), "punch: My Hours — own shift, from the punch function's month, no GPS or billing " + JSON.stringify(mh));
  ok(/Total ₪(400|600)/.test(mh.card), 'punch: My Hours — the Pay card totals the month, priced like Salary ' + JSON.stringify(mh.card));
  // My History is merged in: a tap on a shift opens its punches (in / out, time, site).
  const mx = await p.evaluate(async () => {
    const sh = [...document.querySelectorAll('#hoursContent .hours-shift')].find(x => x.querySelectorAll('.hp').length === 2); if(!sh) return {}; // a full shift (today's may be open)
    const before = getComputedStyle(sh.querySelector('.hours-punches')).display; sh.click(); await new Promise(r => setTimeout(r, 100));
    return {before, after: getComputedStyle(sh.querySelector('.hours-punches')).display, tags: [...sh.querySelectorAll('.hp .tag')].map(t => t.textContent).join(','), dist: /12 m/.test(sh.innerText),
      noHistory: !document.getElementById('screenHistory') && !/My History/.test(document.getElementById('screenPunch').innerText)};
  });
  ok(mx.before === 'none' && mx.after === 'block' && mx.tags === 'IN,OUT' && mx.dist && mx.noHistory, 'punch: My Hours shows each shift\'s punches on a tap; no separate My History ' + JSON.stringify(mx));
  await p.keyboard.press('Escape'); await sleep(400);
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('punchQueue') || '[]').length === 0 && !document.getElementById('offlineBadge')), 'punch: nothing queued');
  // Without a connection: the page opens from this device (the service worker's copy and the cached worker), a punch is
  // kept in the queue with the badge, and it is sent when the connection returns.
  await p.reload(); await waitFor(p, punchReady, 15000); await sleep(1500);
  const n0 = (await srv('/punches')).n;
  await ctx.setOffline(true);
  await p.reload().catch(() => {});
  const offOpen = await waitFor(p, punchReady, 15000);
  const off = {open: offOpen, onLine: await p.evaluate(() => navigator.onLine)};
  const obb = await (await p.$('#bigPunchBtn')).boundingBox();
  await p.mouse.move(obb.x + obb.width / 2, obb.y + obb.height / 2); await p.mouse.down(); await sleep(1300); await p.mouse.up();
  off.result = await waitFor(p, () => /Punched out at/.test(document.getElementById('punchResult').textContent), 5000);
  off.badge = await waitFor(p, () => /Offline — 1 punch queued/.test((document.getElementById('offlineBadge') || {}).textContent || ''), 5000);
  off.queue = await p.evaluate(() => JSON.parse(localStorage.getItem('punchQueue') || '[]').map(e => e.type + ':' + !!e.workerToken).join());
  off.notSent = (await srv('/punches')).n === n0;
  ok(off.open && !off.onLine && off.result && off.badge && off.queue === 'out:true' && off.notSent, 'punch: without a connection the page opens from this device and a punch goes to the queue with the badge ' + JSON.stringify(off));
  await ctx.setOffline(false);
  const on = {flushed: await waitFor(p, () => JSON.parse(localStorage.getItem('punchQueue') || '[]').length === 0 && !document.getElementById('offlineBadge'), 15000)};
  on.toast = await waitFor(p, () => /Synced 1 offline punch/.test(document.body.innerText), 5000);
  on.sent = (await srv('/punches')).n === n0 + 1;
  ok(on.flushed && on.toast && on.sent, 'punch: when the connection returns the queued punch is sent and the badge goes ' + JSON.stringify(on));
  await srv('/revoke');
  await p.goto(BASE + 'worker-punch.html?t=tok-avi');
  ok(await waitFor(p, () => /Invalid Link/.test(document.body.innerText)), 'punch: a regenerated link is revoked even from the cache');
  await p.goto(BASE + 'worker-punch.html?t=nope');
  ok(await waitFor(p, () => /Invalid Link/.test(document.body.innerText)), 'punch: unknown link refused');
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  await waitFor(p, () => !document.getElementById('screenPunch').classList.contains('hidden'), 15000);
  await p.click('#screenPunch [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("עברית")');
  ok(await waitFor(p, () => document.documentElement.lang === 'he' && localStorage.getItem('uiLang') === 'he' && /שלום|טוב/.test(document.getElementById('punchGreeting').textContent)), 'punch: the Language button and its sheet switch the page');
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  ok(await waitFor(p, () => document.documentElement.lang === 'he' && !document.getElementById('screenPunch').classList.contains('hidden') && /החתמת/.test(document.getElementById('bigPunchBtn').innerText) && /טוב/.test(document.getElementById('punchGreeting').textContent), 15000), 'punch: the page shows the chosen language (Hebrew)');
  await p.goto(BASE + 'worker-punch.html?t=nope');
  ok(await waitFor(p, () => /קישור לא תקין/.test(document.body.innerText)), 'punch: the chosen language is kept on the device');
  await p.evaluate(() => localStorage.setItem('uiLang', 'en'));
  // The theme on the punch page (no account): the bare button beside the Language button opens the switch.
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  await waitFor(p, () => !document.getElementById('screenPunch').classList.contains('hidden'), 15000);
  await p.click('#screenPunch [data-testid="theme-btn"]'); await p.click('[data-testid="window"] [data-testid="theme-light"]');
  const ptl = {on: await waitFor(p, () => document.documentElement.dataset.theme === 'light' && localStorage.getItem('uiTheme') === 'light', 5000)};
  await p.keyboard.press('Escape');
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  ptl.kept = await waitFor(p, () => document.documentElement.dataset.theme === 'light' && !document.getElementById('screenPunch').classList.contains('hidden'), 15000);
  await p.screenshot({path: SP + '/theme-light-punch.png'});
  await p.click('#screenPunch [data-testid="theme-btn"]'); await p.click('[data-testid="window"] [data-testid="theme-dark"]');
  ptl.dark = await waitFor(p, () => document.documentElement.dataset.theme === 'dark' && localStorage.getItem('uiTheme') === 'dark', 5000);
  await p.keyboard.press('Escape');
  ok(ptl.on && ptl.kept && ptl.dark, 'punch: the theme button turns the light theme on (kept on the device) and back to Dark ' + JSON.stringify(ptl));
  // GPS (docs/punch.md → GPS off or blocked): on the first entry a window says GPS is needed and its button asks; a refusal
  // opens the steps for this phone by itself (Android here, an iPhone below), a question only closed is asked again at once,
  // the location off has its own step; a reading that comes brings the punch back.
  const gpsStub = () => {
    const at = {coords:{latitude:32.0, longitude:34.8, accuracy:10, speed:null, altitude:null}};
    if (!localStorage.getItem('gpsPerm')) localStorage.setItem('gpsPerm', 'prompt');
    navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => {
      const m = localStorage.getItem('gpsMode') || 'ok';
      if (m === 'ok') { localStorage.setItem('gpsPerm', 'granted'); ok(Object.assign({}, at, {timestamp: Date.now()})); }
      else { if (m === 'denied') localStorage.setItem('gpsPerm', 'denied'); err({code: m === 'off' ? 2 : 1, message: m}); }
    }, 900);
  };
  const gpw = await page(ctx);
  await gpw.setViewportSize({width: 390, height: 844});
  await gpw.addInitScript(gpsStub);
  const gpsKind = pg => pg.evaluate(() => { const e = document.querySelector('[data-testid="gps-steps"]'); return e ? e.dataset.kind : ''; });
  const gpsBack = pg => waitFor(pg, () => !document.querySelector('[data-testid="gps-steps"]') && document.getElementById('bigPunchBtn').dataset.state !== 'gps' && !document.querySelector('[data-testid="gps-notice"]'), 8000);
  await gpw.goto(BASE + 'worker-punch.html?t=tok-new');
  await gpw.evaluate(() => { localStorage.removeItem('gpsPerm'); localStorage.removeItem('gpsMode'); localStorage.removeItem('gpsOk'); });
  await gpw.reload();
  await waitFor(gpw, () => !document.getElementById('screenPunch').classList.contains('hidden'), 15000);
  const gq = {intro: await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'ask' && document.getElementById('bigPunchBtn').dataset.state === 'gps', 8000)};
  await sleep(600); await gpw.screenshot({path: SP + '/gps-intro.png'});
  await gpw.click('[data-testid="gps-enable"]');
  gq.allowed = await gpsBack(gpw);
  // refused ("Don't allow" kept): the steps open by themselves, every tap on Turn on GPS opens them again
  await gpw.evaluate(() => { localStorage.setItem('gpsPerm', 'denied'); localStorage.setItem('gpsMode', 'denied'); });
  await gpw.reload();
  gq.denied = await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'denied', 15000);
  gq.chip = await gpw.textContent('#locChip'); gq.notice = await gpw.isVisible('[data-testid="gps-notice"]');
  gq.steps = await gpw.evaluate(() => document.querySelectorAll('[data-testid="gps-steps"] li').length);
  gq.retry = await gpw.textContent('[data-testid="gps-enable"]');
  await sleep(600); await gpw.screenshot({path: SP + '/gps-steps.png'});
  await gpw.keyboard.press('Escape');
  await waitFor(gpw, () => !document.querySelector('[data-testid="gps-steps"]'), 3000);
  await gpw.click('#bigPunchBtn');
  gq.again = await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'denied', 5000);
  await gpw.evaluate(() => { localStorage.setItem('gpsPerm', 'granted'); localStorage.setItem('gpsMode', 'ok'); });
  await gpw.click('[data-testid="gps-enable"]');
  gq.back = await gpsBack(gpw);
  // the question only closed (no "Don't allow" kept): "Ask again" asks at once
  await gpw.evaluate(() => { localStorage.setItem('gpsPerm', 'prompt'); localStorage.setItem('gpsMode', 'dismiss'); });
  await gpw.reload();
  await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'ask', 15000);
  await gpw.click('[data-testid="gps-enable"]');
  gq.dismissed = await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'denied' && /Ask again/.test(document.querySelector('[data-testid="gps-enable"]').textContent), 8000);
  await gpw.evaluate(() => localStorage.setItem('gpsMode', 'ok'));
  await gpw.click('[data-testid="gps-enable"]');
  gq.askedAgain = await gpsBack(gpw);
  // the phone's location off
  await gpw.evaluate(() => localStorage.setItem('gpsMode', 'off'));
  await gpw.reload();
  gq.off = await waitFor(gpw, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'off' && /GPS is off on this phone/.test(document.getElementById('locChip').textContent), 15000);
  await sleep(600); await gpw.screenshot({path: SP + '/gps-off-steps.png'});
  await gpw.evaluate(() => { localStorage.removeItem('gpsMode'); localStorage.removeItem('gpsPerm'); });
  await gpw.close();
  // an iPhone: Safari asks again when the page opens anew — "Ask again" reloads; the steps cover Location Services and Safari's setting
  const ictx = await newCtx({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: {width: 390, height: 844}});
  const ip = await page(ictx);
  await ip.addInitScript(gpsStub);
  await ip.goto(BASE + 'worker-punch.html?t=tok-new');
  await ip.evaluate(() => { localStorage.setItem('gpsPerm', 'denied'); localStorage.setItem('gpsMode', 'denied'); });
  await ip.reload();
  gq.ios = await waitFor(ip, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'denied' && !!document.querySelector('[data-testid="gps-reopen"]'), 15000);
  gq.iosSteps = await ip.evaluate(() => [...document.querySelectorAll('[data-testid="gps-steps"] li')].map(x => x.textContent).join(' | '));
  await sleep(600); await ip.screenshot({path: SP + '/gps-steps-iphone.png'});
  await ip.evaluate(() => { localStorage.setItem('gpsPerm', 'prompt'); localStorage.setItem('gpsMode', 'ok'); });
  await ip.click('[data-testid="gps-reopen"]');
  gq.iosReopen = await waitFor(ip, () => document.querySelector('[data-testid="gps-steps"]')?.dataset.kind === 'ask', 15000);
  await ictx.close();
  ok(gq.intro && gq.allowed && gq.denied && /blocked for this app/.test(gq.chip) && gq.notice && gq.steps === 2 && /Try again/.test(gq.retry) && gq.again && gq.back
    && gq.dismissed && gq.askedAgain && gq.off && gq.ios && /Location Services/.test(gq.iosSteps) && /Safari/.test(gq.iosSteps) && gq.iosReopen,
    'punch: GPS — the first entry says it is needed and asks; a refusal opens the steps for this phone (Android / iPhone), a closed question is asked again, location off has its step; a reading brings the punch back ' + JSON.stringify(gq));
  // ── Stage 5b: a day the worker can't work, a shift offered to a colleague and confirmed by the manager, the pay estimate ──
  await srv('/swapSetup');
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  await waitFor(p, () => !document.getElementById('screenPunch').classList.contains('hidden'), 15000);
  // A day from the server's today on (the browser's clock is E2E_NOW, which can be days behind), in the shown month or the next.
  const sd = new Date(Date.now() + 86400000), rqKey = sd.getFullYear() + '-' + String(sd.getMonth() + 1).padStart(2, '0') + '-' + String(sd.getDate()).padStart(2, '0');
  const openDay = async () => {
    await p.evaluate(k => { window.__rqKey = k; }, rqKey);
    await p.click('[data-testid="tile-schedule"]');
    await waitFor(p, () => !document.getElementById('screenSchedule').classList.contains('hidden'));
    for (let i = 0; i < 2 && !(await p.$(`.sp-plate[data-date="${rqKey}"]`)); i++) { await p.click('#scheduleContent .sched-nav[aria-label="Next month"]'); await sleep(200); }
    await p.click(`.sp-plate[data-date="${rqKey}"]`);
    return waitFor(p, () => !!document.getElementById('naToggle'), 8000);
  };
  const plateText = () => p.evaluate(k => (document.querySelector(`.sp-plate[data-date="${k}"]`) || {}).innerText || '', rqKey);
  const rq5 = {open: await openDay()};
  await p.click('#naToggle');
  rq5.na = await waitFor(p, () => /Can't work/.test((document.querySelector('.sp-plate[data-date="' + window.__rqKey + '"]') || {}).innerText || ''), 8000);
  rq5.na = rq5.na || /Can't work/.test(await plateText());
  await p.click('#offerOpen'); await p.click('#offerTo');
  await p.click('[cmdk-item]:has-text("Dana Levi")');
  await p.click('#offerSend');
  await waitFor(p, () => /Sent to your manager/.test(document.body.innerText), 8000);
  rq5.offered = /Offered to Dana Levi · waiting for the manager/.test(await plateText());
  let st5 = await srv('/swapState');
  const reqU = st5.requests['u_w1_' + rqKey] || {}, reqS = st5.requests['s_w1_' + rqKey] || {};
  rq5.stored = reqU.kind === 'unavailable' && reqS.status === 'pending' && reqS.toWorkerId === 'w2' && reqS.start === '08:00' && reqS.end === '16:00';
  rq5.unchanged = !(st5.dateShifts.w1 || {})[rqKey] && !(st5.dateShifts.w2 || {})[rqKey];
  ok(rq5.open && rq5.na && rq5.offered && rq5.stored && rq5.unchanged, 'punch: the worker marks a day they can\'t work and offers its shift to a colleague; the schedule is unchanged until the manager confirms ' + JSON.stringify(rq5));
  // The manager sees both on the Schedule tab and confirms the offer with one tap.
  const mctx5 = await newCtx(), mp5 = await page(mctx5);
  await login(mp5, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await mp5.waitForNavigation().catch(() => {});
  await waitFor(mp5, () => typeof workers !== 'undefined' && workers.length === 2, 15000);
  await mp5.evaluate(() => switchTab('schedule'));
  const mgr = {list: await waitFor(mp5, () => document.querySelectorAll('#scheduleRoot [data-testid="shift-req"]').length === 2, 15000)};
  mgr.text = await mp5.evaluate(() => document.querySelector('#scheduleRoot [data-testid="sched-requests"]').innerText.replace(/\s+/g, ' '));
  // the day the worker can't work shows on its day line too
  await mp5.click('#scheduleRoot [data-testid="sched-worker"][data-id="w1"] > [data-slot="plate"] > [role="button"]', {position: {x: 30, y: 14}}).catch(() => {});
  mgr.dayLine = await mp5.evaluate(k => (document.querySelector(`#scheduleRoot [data-testid="sched-worker"][data-id="w1"] [data-testid="sched-day"][data-date="${k}"]`) || {}).innerText || 'not this week', rqKey);
  await mp5.click('#scheduleRoot [data-testid="sr-ok"]');
  mgr.toast = await waitFor(mp5, () => /Shift handed over/.test(document.body.innerText), 8000);
  mgr.saved = await waitFor(mp5, () => !document.querySelector('#scheduleRoot [data-testid="sr-ok"]'), 8000);
  await sleep(2500);  // autoSave's debounce
  st5 = await srv('/swapState');
  mgr.status = (st5.requests['s_w1_' + rqKey] || {}).status;
  mgr.avi = JSON.stringify((st5.dateShifts.w1 || {})[rqKey]); mgr.dana = JSON.stringify((st5.dateShifts.w2 || {})[rqKey]);
  ok(mgr.list && /Avi Cohen → Dana Levi/.test(mgr.text) && /Can't work/.test(mgr.text) && (/Can't work/.test(mgr.dayLine) || mgr.dayLine === 'not this week') && mgr.toast && mgr.status === 'confirmed'
    && /"type":"off"/.test(mgr.avi) && /"type":"work"/.test(mgr.dana) && /08:00/.test(mgr.dana) && /16:00/.test(mgr.dana),
    'schedule: the manager sees the day off and the offer, one tap hands the shift over (Avi off, Dana works that date) ' + JSON.stringify(mgr));
  ok(mp5.errs.length === 0, 'schedule: no page errors with the workers\' requests ' + mp5.errs.join(' | '));
  await mctx5.close();
  // Back on the punch page: the offer shows as handed over and the day as a day off.
  await p.evaluate(() => document.querySelector('.sheet-grab').click());
  const after5 = {open: await openDay()};
  after5.text = await waitFor(p, () => /Handed over to Dana Levi/.test((document.querySelector('.sp-plate[data-date="' + window.__rqKey + '"]') || {}).innerText || ''), 10000);
  after5.plate = await plateText();
  ok(/Handed over to Dana Levi/.test(after5.plate) && /Day off/.test(after5.plate), 'punch: the worker sees the shift handed over and the day off ' + JSON.stringify(after5));
  await p.evaluate(() => document.querySelector('#screenSchedule .sheet-grab').click());
  // The pay estimate: the same figures as My Hours, from the one payroll copy.
  await p.click('[data-testid="tile-hours"]');
  ok(await waitFor(p, () => !!document.getElementById('payslipBtn'), 10000), 'punch: My Hours has "Download for the month"');
  const payTot = await p.evaluate(() => document.querySelector('#hoursContent .pay-r.tot b').textContent);
  const [pop] = await Promise.all([p.waitForEvent('popup'), p.click('#payslipBtn')]);
  await pop.evaluate(() => { window.print = () => {}; }).catch(() => {});
  await pop.waitForSelector('#payslipSum', {timeout: 5000}).catch(() => {});
  const slip = await pop.evaluate(() => ({tot: (document.querySelector('#payslipSum .tot td:last-child') || {}).textContent, title: document.title, note: /estimate before deductions/.test(document.body.innerText)})).catch(e => ({err: String(e)}));
  ok(slip.tot && slip.tot === payTot && /Pay estimate/.test(slip.title) && slip.note, 'punch: the month\'s pay estimate has the same total as My Hours and says it is before deductions ' + JSON.stringify({payTot, slip}));
  await pop.close().catch(() => {});
  ok(p.errs.length === 0, 'punch: no page errors ' + p.errs.join(' | '));
  ok(external.filter(u=>/script\.google\.com/.test(u)).length === 0, 'still no request to script.google.com');
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
