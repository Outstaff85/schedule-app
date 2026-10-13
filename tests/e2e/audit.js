const { chromium } = require('playwright');
const fs = require('fs');
// Screenshots go to E2E_OUT (default: tests/e2e/out, git-ignored).
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
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|hours|ai_read)$/) || [])[1];
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
      ['accounting-salary', () => { switchTab('accounting'); setAccTab('salary'); }],
      ['accounting-billing', () => { switchTab('accounting'); setAccTab('billing'); }],
      ['accounting-approvals', () => { switchTab('accounting'); setAccTab('approvals'); }],
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
    // Select mode on the worker plates
    await step(p, w, 'manager-workers-select', () => { switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); document.querySelector('#workersCards .t3-cb').click(); });
    await ctx.close();
    // Super-admin: firms, errors, timings
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await login(p, BASE + 'schedule-manager.html', 'boss', 'boss-pass-1'); await p.waitForNavigation().catch(() => {}); await sleep(2500);
    await shoot(p, 'superadmin-firms-' + w);
    await ctx.close();
    // Supplier portal
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await login(p, BASE + 'supplier-portal.html', 'sup1', 'sup-pass-11'); await sleep(3000);
    for(const t of ['dashboard', 'workers', 'hours', 'review']) await step(p, w, 'supplier-' + t, new Function(`switchTab('${t}')`));
    await step(p, w, 'supplier-worker-editor', () => { switchTab('workers'); openAddWorkerModal(); });
    await ctx.close();
    // Client portal
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await p.goto(BASE + 'client-portal.html'); await p.waitForSelector('#loginScreen', {state: 'visible'}).catch(() => {}); await shoot(p, 'client-signin-' + w);
    await login(p, BASE + 'client-portal.html', 'client1', 'client-pass-1'); await sleep(3500); await shoot(p, 'client-hours-' + w);
    await ctx.close();
    // Punch page
    ctx = await newCtx({viewport: vp}); p = await page(ctx);
    await p.goto(BASE + 'worker-punch.html?t=tok-avi'); await sleep(3500); await shoot(p, 'punch-main-' + w);
    await step(p, w, 'punch-schedule', () => openSchedule());
    await p.evaluate(() => closeHistory && closeHistory());
    await p.evaluate(() => openMyHours()); await sleep(2500); await shoot(p, 'punch-hours-' + w);
    await ctx.close();
  }
  console.log(shots.length + ' screenshots in ' + SP);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
