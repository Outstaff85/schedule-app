const { chromium } = require('playwright');
const fs = require('fs');
// Screenshots go to E2E_OUT (default: tests/e2e/out, git-ignored); E2E_THEME=light takes them in the light theme.
const SP = process.env.E2E_OUT || (__dirname + '/out/audit');
fs.mkdirSync(SP, {recursive: true});
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
const BUNDLE = fs.readFileSync(__dirname + '/build/firebase-all.js', 'utf8');
const BASE = 'http://127.0.0.1:8765/';
let fails = 0;
// A failed check is also printed as a GitHub annotation (::error::), so CI shows it without the log.
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c){ fails++; if (process.env.GITHUB_ACTIONS) console.log('::error::' + String(m).replace(/\r?\n/g, ' ').slice(0, 900)); } };
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
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|hours|ai_read|weather|contract_templates|sign_documents)$/) || [])[1];
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
    await ctx.addInitScript(THEME => {
      localStorage.setItem('fsEmulator', '127.0.0.1');
      // E2E_THEME=light: every screen in the light theme (docs/redesign.md → Light theme).
      if (THEME) localStorage.setItem('uiTheme', THEME);
      window.FIREBASE_WEB_CONFIG = {apiKey:'fake-key', projectId:'demo-schedule', authDomain:'demo-schedule.firebaseapp.com', storageBucket:'demo-schedule.appspot.com'};
      // A real-looking geolocation reply: not instant (the page flags < 800 ms).
      const pos = {coords:{latitude:32.0, longitude:34.8, accuracy:10, speed:null, altitude:null}, timestamp:Date.now()};
      Object.defineProperty(navigator, 'geolocation', {value:{getCurrentPosition:(ok)=>setTimeout(()=>ok(Object.assign({}, pos, {timestamp:Date.now()})), 900)}});
      // The location permission: given (a worker who allowed GPS before); localStorage gpsPerm changes it.
      const pq = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);
      if (pq) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({state: localStorage.getItem('gpsPerm') || 'granted', onchange: null}) : pq(d);
    }, process.env.E2E_THEME || "");
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


  // ── Design audit (docs/redesign.md → stage 13, method step 2): every screen and
  // window of every page, on a phone (390) and a computer (1280), saved as
  // <page>-<screen>-<width>.png in E2E_OUT. Not a test: `npm run audit`.
  const shots = [];
  const shoot = async (p, name) => { await sleep(500); const f = SP + '/' + name + '.png'; await p.screenshot({path: f, fullPage: false}); shots.push(name); };
  const closeAll = async p => { for(let i = 0; i < 3; i++){ await p.evaluate(() => { document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); if(typeof closeBell === 'function') closeBell(); if(typeof closeLangSheet === 'function') closeLangSheet(); if(typeof closePopover === 'function') closePopover(); }); await sleep(150); } };
  const step = async (p, w, name, fn) => { try{ await p.evaluate(fn); await shoot(p, name + '-' + w); }catch(e){ console.log('skip ' + name + '-' + w + ': ' + e.message.split('\n')[0]); } await closeAll(p); };
  for(const w of [390, 1280]){
    const vp = {width: w, height: w === 390 ? 844 : 900};
    // Sign in
    let ctx = await newCtx({viewport: vp}); let p = await page(ctx);
    await p.goto(BASE + 'schedule-manager.html'); await p.waitForSelector('#loginScreen', {state: 'visible'}); await shoot(p, 'manager-signin-' + w);
    await login(p, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
    await p.waitForNavigation().catch(() => {});
    await waitFor(p, () => typeof workers !== 'undefined' && workers.length === 2, 15000); await sleep(1500);
    const M = [
      ['today', () => switchTab('dashboard')],
      ['schedule', () => switchTab('schedule')],
      ['workers', () => switchTab('workers')],
      ['worker-card', () => { switchTab('workers'); openWorkerCard(0); }],
      ['worker-editor', () => { switchTab('workers'); openEditWorker(0); }],
      ['worker-new', () => { switchTab('workers'); openAddWorker(); }],
      ['notices', () => { switchTab('workers'); openNotices(workers[0].id); }],
      ['clients', () => switchTab('clients')],
      ['client-editor', () => { switchTab('clients'); openEditClient(clients[0].id); }],
      ['suppliers', () => switchTab('suppliers')],
      ['supplier-editor', () => { switchTab('suppliers'); openEditSupplier(suppliers[0].id); }],
      ['supplier-editor-commission', () => { switchTab('suppliers'); openEditSupplier(suppliers[0].id); document.querySelector('#supplierModal [data-sec="commission"] [data-slot="accordion-trigger"]').click(); }],
      ['accounting-salary', () => { switchTab('accounting'); setAccTab('salary'); }],
      ['accounting-billing', () => { switchTab('accounting'); setAccTab('billing'); }],
      ['accounting-approvals', () => { switchTab('accounting'); setAccTab('approvals'); }],
      ['accounting-alerts', () => { switchTab('accounting'); setAccTab('alerts'); }],
      ['pay-window', () => { switchTab('accounting'); openPayModal(workers[0].id); }],
      ['admin', () => { switchTab('admin'); switchAdminPane(null); }],
      ['admin-punchlog', () => { switchTab('admin'); switchAdminPane('punchlog'); }],
      ['admin-firms', () => { switchTab('admin'); switchAdminPane('firms'); }],
      ['admin-users', () => { switchTab('admin'); switchAdminPane('users'); }],
      ['user-form', () => { switchTab('admin'); openCreateUserForm(); }],
      ['firm-form', () => { openMyFirmForm(); }],
      ['bell', () => { switchTab('dashboard'); toggleBell(); }],
      ['language', () => { openLangSheet(); }],
    ];
    for(const [n, fn] of M){ await step(p, w, 'manager-' + n, fn); }
    // The scan window (src/scan/Scanner.tsx): the full-screen scanner with a shot's pages in its strip (given to the
    // session with no camera: ManagerScan.hooks().inject), a photo grown in the strip, then a page opened large
    try {
      await p.evaluate(async () => {
        window.__scanGoing = startNewScan();
        for (let i = 0; i < 100 && !document.querySelector('[data-testid="scanner"] [data-testid="scan-status"]'); i++) await new Promise(r => setTimeout(r, 100));
        const c = document.createElement('canvas'); c.width = 300; c.height = 400;
        const g = c.getContext('2d'); g.fillStyle = '#e8e4d8'; g.fillRect(0, 0, 300, 400); g.fillStyle = '#556'; g.fillRect(30, 40, 240, 30); g.fillRect(30, 100, 160, 16);
        const pic = c.toDataURL('image/jpeg').split(',')[1];
        const H = await ManagerScan.hooks();
        await H.inject({pics: [{b64: pic, doctype: {doctype: 'id_front', conf: 0.97, turn: 0, turnConf: 0.99}}, {b64: pic}]});
      });
      await sleep(2500); await shoot(p, 'manager-scanner-camera-' + w);
      await p.evaluate(() => { const t = document.querySelector('[data-testid="scan-thumb"]'); if (t) t.click(); });
      await sleep(800); await shoot(p, 'manager-scanner-grown-' + w);
      await p.evaluate(() => { const o = document.querySelector('[data-testid="scan-thumb-open"]'); if (o) o.click(); });
      await sleep(800); await shoot(p, 'manager-scanner-page-' + w);
      await p.keyboard.press('Escape'); await sleep(300); await p.keyboard.press('Escape'); await sleep(500);
    } catch (e) { console.log('skip manager-scanner-' + w + ': ' + e.message.split('\n')[0]); }
    // Select mode on the worker plates (after the scan window: Select mode stays on)
    await step(p, w, 'manager-workers-select', () => { switchTab('workers'); document.querySelector('#workersRoot [data-testid="workers-select"] button').click(); });
    await ctx.close();
    // Super-admin: firms, errors, timings
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await login(p, BASE + 'schedule-manager.html', 'boss', 'boss-pass-1'); await p.waitForNavigation().catch(() => {}); await sleep(2500);
    await shoot(p, 'superadmin-firms-' + w);
    await ctx.close();
    // Supplier portal
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await login(p, BASE + 'schedule-manager.html', 'sup1', 'sup-pass-11'); await sleep(3000);
    // a React page (src/supplier/): its tabs are buttons of the Shell (the tabs on a computer, the bottom bar on a phone)
    for(const [t, label] of [['dashboard', 'Dashboard'], ['workers', 'My Workers'], ['hours', 'My Hours'], ['review', 'Approvals']])
      await step(p, w, 'supplier-' + t, new Function(`[...document.querySelectorAll('[data-slot="shell"] button')].find(b => b.innerText.trim() === '${label}').click()`));
    await step(p, w, 'supplier-worker-editor', () => { [...document.querySelectorAll('[data-slot="shell"] button')].find(b => b.innerText.trim() === 'My Workers').click(); setTimeout(() => document.querySelector('[data-testid="workers"] button.og-new').click(), 300); });
    await ctx.close();
    // Client portal
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await p.goto(BASE + 'schedule-manager.html'); await p.waitForSelector('#loginScreen', {state: 'visible'}).catch(() => {}); await shoot(p, 'client-signin-' + w);
    await login(p, BASE + 'schedule-manager.html', 'client1', 'client-pass-1'); await sleep(3500); await shoot(p, 'client-hours-' + w);
    await ctx.close();
    // Punch page
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await p.goto(BASE + 'worker-punch.html?t=tok-avi'); await sleep(3500); await shoot(p, 'punch-main-' + w);
    // The React punch page (stage 5): the tiles open the sheets; a reload closes them.
    await step(p, w, 'punch-schedule', () => document.querySelector('[data-testid="tile-schedule"]').click());
    await p.reload(); await sleep(3000);
    await step(p, w, 'punch-hours', () => document.querySelector('[data-testid="tile-hours"]').click());
    await ctx.close();
  }
  console.log(shots.length + ' screenshots in ' + SP);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
