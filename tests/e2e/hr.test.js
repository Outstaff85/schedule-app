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
      if (/fonts\.g|cdnjs|tabler|jsdelivr|unpkg/.test(u)) return r.fulfill({status:200, body:''});
      external.push(u);
      return r.fulfill({status:200, body:''});
    });
    await ctx.addInitScript(() => {
      // The worker windows are React (stage 6c-2): a field is filled as a person types (the input event).
      window.T = {
        tick: (ms = 0) => new Promise(r => setTimeout(r, ms)),
        // the user window (React, stage 6f-2): a tile's tick box, the role switch, Save and its error line
        q: sel => document.querySelector('#userFormModal ' + sel),
        tile: (group, k) => document.querySelector('#userFormModal [data-testid="' + group + '"] [data-k="' + k + '"]'),
        ticked: group => [...document.querySelectorAll('#userFormModal [data-testid="' + group + '"] [data-k]')].filter(x => x.dataset.state === 'checked').map(x => x.dataset.k).join(','),
        role: r => document.querySelector('#userFormModal [data-testid="user-role"] [data-v="' + r + '"]').click(),
        // Save: the click, then the save running (the button off), then the window closed or the button back with its error
        // (React draws after a microtask: a test ticks before it clicks Save, so Save sees the last change)
        async save(){ const open = () => document.getElementById('userFormOverlay').classList.contains('open'), btn = () => document.querySelector('#userFormModal [data-testid="user-save"]');
          btn().click(); await T.tick(50);
          await T.until(() => !open() || !btn() || !btn().disabled, 15000); await T.tick(100); },
        err: () => { const e = document.querySelector('#userFormModal [data-testid="user-error"]'); return e ? e.textContent : ''; },
        async until(fn, ms = 8000){ const end = Date.now() + ms; while (Date.now() < end){ if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return !!fn(); },
        fill(sel, v){ const el = typeof sel === 'string' ? (document.getElementById(sel) || document.querySelector(sel)) : sel;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); },
      };
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

  const reload = async p => { await p.reload(); await sleep(300); };

  // ── Owner creates an HR login and assigns Dana (w2) to it ──
  let ctx = await newCtx(); let p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => typeof workers !== 'undefined' && workers.length === 2), 'owner: workers load');
  const made = await p.evaluate(async () => {
    workers[0].docId = '000000018'; await gsSave(getDataObj());
    switchTab('admin'); switchAdminPane('users');
    openCreateUserForm(); await T.tick(100);
    T.role('hr'); await T.tick(50);
    const own = T.q('button[data-testid="user-own-only"]');
    const r = {hrFields: !!own && !own.disabled, perms: T.ticked('user-perms'), own: !!own && own.dataset.state === 'checked'};
    T.fill('uUsername', 'hr1'); T.fill('uPassword', 'hr-pass-111');
    T.fill('uFullName', 'Rina HR'); T.fill('uPhone', '0521112233');
    r.showPayTile = !!T.q('[data-testid="user-show-pay"]'); T.fill('uCommission', '4');
    T.tile('user-perms', 'accounting').click(); await T.tick(50); // the reduced pay view (a React draw before the next step)
    // hours review: a new HR starts with the default ticks (Hours, Approve, Dispute, Fix)
    r.ticks = T.ticked('user-hours');
    await T.save();
    await T.until(() => [...document.querySelectorAll('#adminRoot [data-testid="user-row"]')].some(x => x.innerText.includes('Rina HR')), 9000);
    const row = [...document.querySelectorAll('#adminRoot [data-testid="user-row"]')].find(x => x.innerText.includes('Rina HR'));
    r.listed = row ? row.innerText : document.querySelector('#adminRoot').innerText;
    return r;
  });
  ok(made.hrFields && made.perms === 'workers' && made.own && !made.showPayTile && made.ticks === 'hours,approve,dispute,fix', 'owner: HR form shows name/phone, Workers only, own-only on ' + JSON.stringify(made).slice(0, 160));
  ok(/Rina HR HR\s*\nlogin: hr1 · 0521112233\n.*0 workers/.test(made.listed), 'owner: user row: name first, login and phone below, worker count ' + JSON.stringify(made.listed));
  const me = await p.evaluate(async () => {
    const before = document.querySelector('[data-testid=account-btn]').innerText;
    window.prompt = () => 'Avi Owner';
    await editMyName();
    return {before, after: document.querySelector('[data-testid=account-btn]').innerText, sess: getSession().fullName};
  });
  ok(/owner1/.test(me.before) && /Avi Owner/.test(me.after) && me.sess === 'Avi Owner', 'owner: header shows the login until a name is set, then the name ' + JSON.stringify(me));
  const asg = await p.evaluate(async () => {
    const hr = hrUsers()[0];
    await openEditUserForm(hr.id); await T.tick(150);
    const r = {cardWorkers: !!T.q('[data-sec="workers"]'), roleLocked: !T.q('[data-testid="user-role"]')};
    T.q('[data-testid="user-add-workers"]').click(); await T.tick(300);
    r.choices = document.querySelectorAll('#hrAssignModal [data-testid="assign-worker"]').length;
    document.querySelector('#hrAssignModal [data-testid="assign-worker"][data-wid="w2"]').click(); await T.tick(50);
    document.querySelector('#hrAssignModal [data-testid="assign-save"]').click();
    await T.until(() => !document.getElementById('hrAssignOverlay').classList.contains('open'), 8000); await T.tick(300);
    r.hr = hr.id;
    r.dana = workers.find(w => w.id === 'w2').hrId;
    r.inCard = T.q('[data-testid="user-team"]').textContent;
    await new Promise(res => setTimeout(res, 1500));
    const b = await loadFirestoreBackend();
    const ps = await b.punchesBetween(fsTenantId(), new Date(Date.now() - 30*864e5), new Date(Date.now() + 864e5));
    r.punchHr = ps.filter(x => x.workerId === 'w2').map(x => x.hrId);
    r.otherHr = ps.filter(x => x.workerId === 'w1').map(x => x.hrId || null);
    closeModal('userFormOverlay');
    // Worker modal: HR select; card: HR name
    openEditWorker(workers.findIndex(w => w.id === 'w2'));
    r.select = document.getElementById('wHrId') && document.getElementById('wHrId').dataset.value;
    closeModal('workerOverlay');
    openWorkerCard(workers.findIndex(w => w.id === 'w2'));
    r.cardLine = /HR\s*Rina HR/.test(document.getElementById('workerCardModal').innerText);
    closeModal('workerCardOverlay');
    return r;
  });
  ok(asg.cardWorkers && !asg.roleLocked && asg.choices === 2, 'owner: HR card has the workers list and the add-workers picker');
  ok(asg.dana === asg.hr && /Dana Levi/.test(asg.inCard), 'owner: bulk assign sets hrId and lists the worker in the HR card');
  ok(asg.punchHr.length === 2 && asg.punchHr.every(h => h === asg.hr) && asg.otherHr.every(h => h === null), 'owner: assigned worker\'s past punches carry the HR, others not ' + JSON.stringify(asg.punchHr));
  ok(asg.select === asg.hr && asg.cardLine, 'owner: worker modal HR select and card show the HR');
  ok(p.errs.length === 0, 'owner: no page errors ' + p.errs.join(' | '));
  const hrUid = asg.hr;
  const pw = await p.evaluate(async (id) => {
    await openEditUserForm(id); await T.tick(150);
    const pw = document.getElementById('uPassword');
    const r = {label: document.querySelector('label[for="uPassword"]').textContent, shown: !!pw, empty: pw.value === '',
      noKey: !document.querySelector('#adminRoot [data-testid="users"] .ti-key')};
    T.fill('uPassword', 'short');
    await T.save();
    r.shortErr = T.err();
    T.fill('uPassword', 'hr-pass-222');
    await T.save();
    r.closed = !document.getElementById('userFormOverlay').classList.contains('open');
    return r;
  }, hrUid);
  ok(pw.shown && /New password/.test(pw.label) && pw.empty && pw.noKey && pw.shortErr && pw.closed, 'owner: password changed in the user form, no key button ' + JSON.stringify(pw));

  // ── HR session ──
  let hctx = await newCtx(); let h = await page(hctx);
  await login(h, BASE + 'schedule-manager.html', 'hr1', 'hr-pass-222');
  await h.waitForNavigation().catch(()=>{});
  ok(await waitFor(h, () => typeof workers !== 'undefined' && workers.length === 1), 'hr: loads only its own workers');
  ok(await h.evaluate(() => { const a = document.querySelector('[data-testid=account-btn]').innerText; return /Rina HR/.test(a) && !/hr1/.test(a); }), 'hr: header shows its name, not the login');
  await waitFor(h, () => getPunchLog().length >= 2);
  const hv = await h.evaluate(() => {
    // the React frame's side menu shows only the sections this login may see
    const vis = k => !!document.querySelector('[data-testid=shell-menu] [data-testid=tab-' + k + ']');
    return {tab: currentTab, today: vis('dashboard'), admin: vis('admin'), workersTab: vis('workers'), sched: vis('schedule'),
      acc: vis('accounting'), name: workers[0].name, punches: getPunchLog().map(e => e.workerId)};
  });
  ok(hv.tab === 'workers' && !hv.today && !hv.admin && hv.workersTab && !hv.sched && hv.acc, 'hr: the Workers tab and, with Accounting ticked, its pay view; lands on Workers ' + JSON.stringify(hv));
  const pv = await h.evaluate(async () => {
    switchTab('accounting'); await ManagerBridge.setPeriod('all'); await T.tick(100);
    const root = document.getElementById('accountingRoot'), vis = sel => !!root.querySelector(sel);
    const txt = (root.querySelector('#accSecSalary') || {}).innerText || '';
    const rows = [...root.querySelectorAll('[data-testid=sal-table] tbody tr')].map(r => r.dataset.rowId);
    const e = ManagerAcc.salaryEntriesFor(accData(), 'all').byWorker;
    return {rows, com: /My commission/.test(txt), tabs: vis('#accTabs'), payable: vis('[data-testid=acc-billing]'), pend: vis('#accSecPending'),
      alerts: vis('#accSecAlerts'), view: (root.querySelector('[data-testid=accounting]') || {dataset: {}}).dataset.view, noExport: !vis('[data-testid=sal-export]'), noSelect: !vis('[data-testid=sal-select]'),
      hours: rows.reduce((t, id) => t + e[id].hours, 0), comText: txt};
  });
  ok(pv.rows.length === 1 && pv.rows[0] === 'w2' && pv.com && pv.view === 'pay' && !pv.tabs && !pv.payable && !pv.pend && !pv.alerts && pv.noExport && pv.noSelect,
    'hr pay view: own worker only, its commission, no tabs, no export, nothing else of Accounting ' + JSON.stringify(pv).slice(0, 300));
  ok(pv.comText.includes('₪' + (pv.hours * 4).toFixed(0)), 'hr pay view: commission = hours × 4 ' + pv.hours);
  // Hours approval in Accounting (hours ticks): its own worker's days; approve one.
  // The HR's Hours approval: the shared React screen (src/hours-review/) on top of Accounting.
  const hrReady = () => !!document.querySelector('#accSecReview [data-testid="hours-review"][data-ready="1"]');
  await h.evaluate(() => switchTab('accounting'));
  await waitFor(h, hrReady, 15000);
  if (!(await h.evaluate(() => document.querySelectorAll('#accSecReview [data-day-key]').length))) {
    await h.click('#accSecReview button[aria-label="Previous month"]'); await sleep(300); await waitFor(h, hrReady, 15000);
  }
  const hrv0 = await h.evaluate(() => ({shown: !!document.getElementById('accSecReview'), names: [...document.querySelectorAll('#accSecReview [data-slot="section"] .og-label > span:first-child')].map(b => b.textContent),
    days: document.querySelectorAll('#accSecReview [data-day-key]').length, key: (document.querySelector('#accSecReview [data-day-key]') || {dataset: {}}).dataset.dayKey}));
  if (hrv0.key) {
    await h.click(`#accSecReview [data-day-key="${hrv0.key}"] button[aria-label="Actions"]`); await h.waitForSelector('[role="menuitem"]');
    await h.click('[role="menuitem"]:has-text("Approve this day")'); await sleep(200);
    for (let i = 0; i < 50 && (await h.evaluate(k => (document.querySelector(`#accSecReview [data-day-key="${k}"]`) || {dataset: {}}).dataset.state, hrv0.key)) !== 'approved'; i++) await sleep(150);
  }
  const hrv = {...hrv0, st: await h.evaluate(k => (document.querySelector(`#accSecReview [data-day-key="${k}"]`) || {dataset: {}}).dataset.state, hrv0.key)};
  await (await h.$('#accSecReview')).screenshot({path: SP + '/hr-hours-review.png'}).catch(()=>{});
  ok(hrv.shown && hrv.names.join() === 'Dana Levi' && hrv.days >= 1 && hrv.st === 'approved', 'hr: Hours approval in Accounting — own workers only, approves a day ' + JSON.stringify(hrv));
  const mh = await h.evaluate(async () => {
    const r = {};
    openHoursImportModal('w2');
    document.querySelector('#hoursImportModal [data-testid="hours-add-row"]').click(); await T.tick();
    const times = [...document.querySelectorAll('#hoursManualRows [data-row="0"] input[type=time]')];
    T.fill(times[0], '09:00'); T.fill(times[1], '13:00'); await T.tick();
    r.date = document.querySelector('#hoursManualRows [data-row="0"]').dataset.date;
    document.getElementById('hoursImportSubmitBtn').click();
    for(let i = 0; i < 40 && !/Sent for review/i.test(document.getElementById('hoursSentList').innerText); i++) await new Promise(res => setTimeout(res, 150));
    r.list = document.getElementById('hoursSentList').innerText;
    closeModal('hoursImportOverlay');
    return r;
  });
  ok(/^\d{4}-\d{2}-\d{2}$/.test(mh.date) && /entered by hand/.test(mh.list) && /Sent for review/i.test(mh.list), 'hr: shifts entered by hand are sent for review and listed with their status ' + JSON.stringify(mh));
  const pm = await h.evaluate(async () => {
    const r = {};
    workers.find(w => w.id === 'w2').bank = 'Hapoalim';
    switchTab('accounting'); await T.tick(50);
    const row = document.querySelector('#accountingRoot [data-testid=sal-table] tbody tr');
    r.own = Object.keys(ManagerAcc.salaryEntriesFor(accData(), accPeriod).byWorker).filter(id => (workers.find(w => w.id === id) || {}).hrId).length;
    if (row) { row.querySelector('td:nth-child(2)').click(); await T.tick(250); }
    r.cards = [...document.querySelectorAll('#accountingRoot [data-testid=sal-table] tbody tr')].map(c => c.textContent.replace(/\s+/g, ' ') + ' ' + ((document.querySelector('[data-testid=window] [data-testid=sal-det]') || {}).textContent || ''));
    r.noPayBtn = !document.querySelector('[data-testid=window] [data-testid=sal-pay]');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await T.tick(250);
    openPayModal('w2'); await T.tick(50);
    r.modal = document.getElementById('payOverlay').classList.contains('open');
    r.allDisabled = [...document.querySelectorAll('#payModal input, #payModal button[role=combobox]')].every(el => el.disabled);
    r.noSave = ![...document.querySelectorAll('#payModal button')].some(b => /Save/.test(b.textContent));
    r.canEdit = canEditPay();
    closeModal('payOverlay'); delete workers.find(w => w.id === 'w2').bank;
    return r;
  });
  ok(pm.cards.length === Math.min(pm.own, 10) && pm.own >= 1 && pm.cards.some(t => /Hapoalim/.test(t)) && pm.noPayBtn && pm.modal && pm.allDisabled && pm.noSave && !pm.canEdit, 'hr: sees its workers\' Salary rows with the bank, the pay window read-only ' + JSON.stringify(pm));
  // Without "Edit own workers' pay" the server refuses a pay change too.
  const nope = await h.evaluate(async () => {
    const w = workers.find(x => x.id === 'w2'), keep = w.hourlyRate, keepBank = w.bank;
    w.hourlyRate = 99; const r1 = await gsSave(getDataObj());
    w.hourlyRate = keep; w.bank = 'Fake'; const r2 = await gsSave(getDataObj());
    if(keepBank === undefined) delete w.bank; else w.bank = keepBank;
    w.phone = (w.phone || '') + '1'; const r3 = await gsSave(getDataObj()); // a non-money edit still saves
    return {rate: r1, bank: r2, other: r3};
  });
  ok(nope.rate === false && nope.bank === false && nope.other === true, 'hr: without "Edit own workers\' pay" the server refuses a rate or bank change, other edits save ' + JSON.stringify(nope));
  // The owner ticks "Edit own workers' pay"; the HR signs in again.
  const tick = await p.evaluate(async (id) => {
    await openEditUserForm(id); await T.tick(150);
    const chip = T.tile('user-perms', 'payEdit'); const r = {shown: !!chip};
    if(chip) chip.click(); await T.tick(50);
    await T.save();
    r.closed = !document.getElementById('userFormOverlay').classList.contains('open');
    return r;
  }, hrUid);
  ok(tick.shown && tick.closed, 'owner: ticks "Edit own workers\' pay" for the HR ' + JSON.stringify(tick));
  await hctx.close(); hctx = await newCtx(); h = await page(hctx);
  await login(h, BASE + 'schedule-manager.html', 'hr1', 'hr-pass-222');
  await h.waitForNavigation().catch(()=>{});
  await waitFor(h, () => typeof workers !== 'undefined' && workers.length === 1);
  await waitFor(h, () => getPunchLog().length >= 2);
  const pe = await h.evaluate(async () => {
    const r = {};
    r.canEdit = canEditPay(workers.find(w => w.id === 'w2'));
    r.notOthers = !canEditPay({id: 'x', hrId: 'someone-else'});
    switchTab('accounting');
    openPayModal('w2'); await T.tick(50);
    r.enabled = !document.getElementById('payRate').disabled;
    T.fill('payRate', '52'); T.fill('payBank', 'Discount'); T.fill('payBankAccount', '777'); await T.tick(20);
    document.querySelector('#payModal [data-testid=pay-save]').click(); await T.tick(50);
    r.saved = await gsSave(getDataObj());
    const d = await (await loadFirestoreBackend()).loadSchedule(fsTenantId(), false);
    const w = d.workers.find(x => x.id === 'w2'); r.stored = w && [w.hourlyRate, w.bank, w.bankAccountNumber].join('|');
    switchTab('workers');
    return r;
  });
  ok(pe.canEdit && pe.notOthers && pe.enabled && pe.saved && pe.stored === '52|Discount|777', 'hr: with "Edit own workers\' pay" edits its own worker\'s rate and bank, not other workers ' + JSON.stringify(pe));
  // An edit made by the owner reaches the HR's open app without a reload.
  await p.evaluate(async () => {
    await loadData();
    const w = workers.find(x => x.id === 'w2'); w.phone = '0520000999';
    await gsSave(getDataObj());
  });
  ok(await waitFor(h, () => (workers.find(w => w.id === 'w2') || {}).phone === '0520000999', 15000), 'hr: an owner\'s edit of its worker arrives live (no reload)');
  ok(hv.name === 'Dana Levi' && hv.punches.length === 2 && hv.punches.every(w => w === 'w2'), 'hr: sees only its workers\' punches ' + JSON.stringify(hv));
  const add = await h.evaluate(async () => {
    window.autoUploadWithRetry = async () => {};
    const r = {};
    // duplicate document number of a worker it can't see → refused
    openAddWorker(); T.fill('wGiven', 'Dup'); T.fill('wSurname', 'Person'); T.fill('wDocId', '000000018');
    await saveWorker();
    r.afterDup = workers.length;
    closeModal('workerOverlay');
    openAddWorker(); T.fill('wGiven', 'New'); T.fill('wSurname', 'Hire'); T.fill('wDocId', '000000026');
    r.noHrField = !document.getElementById('wHrId');
    await saveWorker();
    await new Promise(res => setTimeout(res, 1500));
    const nw = workers.find(w => w.name === 'New Hire');
    r.newHr = nw && nw.hrId;
    const b = await loadFirestoreBackend();
    const d = await b.loadSchedule(fsTenantId(), false);
    r.saved = d.workers.map(w => w.name).sort().join(',');
    // edit rates of its worker
    const di = workers.findIndex(w => w.id === 'w2'); workers[di].hourlyRate = 47;
    r.saveOk = await gsSave(getDataObj());
    // a manual punch is stamped with the HR
    await b.savePunch(fsTenantId(), {id: 'man-1', workerId: nw.id, workerName: 'New Hire', type: 'in', time: '08:00', date: '01/10/2026', ts: new Date().toISOString()});
    r.manual = (await b.punchesBetween(fsTenantId(), new Date(Date.now() - 864e5), new Date(Date.now() + 864e5))).filter(x => x.id === 'man-1').map(x => x.hrId);
    // a file for its worker: upload and read back its link
    const up = await uploadWorkerFile({action: 'saveWorkerFile', workerId: nw.id, fileName: 'visa.jpg', fileBase64: btoa('img'), mimeType: 'image/jpeg'}, () => {});
    r.upload = !!(up && up.ok && up.url);
    // hours upload goes to the queue as pending; reading it shows only its own batches
    const s1 = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'savePendingHoursBatch', entries: [{workerId: 'w2', date: '01/10/2026', inTime: '08:00', outTime: '12:00'}]})})).json();
    const q = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'loadPendingHours'})})).json();
    r.queue = s1.ok && q.batches && q.batches.length === 2; // + the one entered by hand above
    return r;
  });
  ok(add.afterDup === 1, 'hr: a document number already in the firm is refused (server check)');
  ok(add.noHrField && add.newHr === hrUid && add.saved === 'Dana Levi,New Hire', 'hr: a new worker is its own (hrId set), no HR select ' + JSON.stringify(add));
  ok(add.saveOk, 'hr: edits its worker\'s rate');
  ok(add.manual.length === 1 && add.manual[0] === hrUid, 'hr: a manual punch carries the HR');
  ok(add.upload, 'hr: uploads a file and gets its link');
  ok(add.queue, 'hr: hours go to the queue; it sees only its own batch');
  ok(h.errs.length === 0, 'hr: no page errors ' + h.errs.join(' | '));

  // ── Stage 1 fixes ──
  const s1 = await p.evaluate(async (hrUid) => {
    const r = {};
    // editing only the HR's name keeps its session; the owner row edits name only
    await openEditUserForm(hrUid); await T.tick(150);
    T.fill('uFullName', 'Rina Cohen');
    await T.save();
    r.hrErr = T.err();
    const own = (await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers'})})).json()).users.find(u=>u.role==='tenant_admin');
    await T.tick(300);
    await openEditUserForm(own.id); await T.tick(150);
    r.ownerRoleHidden = !T.q('[data-testid="user-role"]') && !T.q('[data-testid="user-perms"]') && !T.q('[data-sec="sections"]');
    T.fill('uFullName', 'Avi Boss');
    await T.save();
    r.ownerErr = T.err();
    r.header = document.querySelector('[data-testid=account-btn]').innerText;
    return r;
  }, hrUid);
  ok(!s1.hrErr && s1.ownerRoleHidden && !s1.ownerErr && /Avi Boss/.test(s1.header), 'owner: edits an HR name and the owner row (name only) ' + JSON.stringify(s1));
  ok(await h.evaluate(async () => { const r = await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'checkWorkerDoc',docId:'X1'})})).json(); return r && r.ok === true; }), 'hr: session still valid (not revoked) after its name was changed');
  const ord = await h.evaluate(async () => {
    const w = workers.find(x => x.id === 'w2'); w.hourlyRate = 51;
    await gsSave(getDataObj());
    return true;
  });
  const ownerOrder = await p.evaluate(async () => { const d = await (await loadFirestoreBackend()).loadSchedule(fsTenantId(), false); return d.workers.map(w => w.id).join(','); });
  ok(ownerOrder.indexOf('w1') < ownerOrder.indexOf('w2'), 'owner order kept after an HR save ' + ownerOrder);
  const rc = await p.evaluate(async () => {
    const r = {};
    const sup = (await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers'})})).json()).users.find(u=>u.role==='supplier');
    await openEditUserForm(sup.id); await T.tick(150);
    r.enabled = !!T.q('[data-testid="user-role"]');
    T.role('staff'); await T.tick(50);
    if(T.ticked('user-perms') !== 'workers') T.tile('user-perms', 'workers').click(); await T.tick(50);
    await T.save();
    r.err = T.err();
    const u2 = (await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers'})})).json()).users.find(u=>u.id===sup.id);
    r.role = u2.role; r.perms = u2.permissions;
    return r;
  });
  ok(rc.enabled && !rc.err && rc.role === 'staff' && JSON.stringify(rc.perms) === '["workers"]', 'owner: changes a supplier login to staff in the user form ' + JSON.stringify(rc));
  const sc = await p.evaluate(async () => {
    const up = await uploadWorkerFile({action:'saveWorkerAssets', workerId:'w1', scanB64:'', sigPng:'data:image/png;base64,QUJD', fileNameBase:'sig'}, () => {});
    const back = await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadWorkerAssets', fileId: up.id})})).json();
    return {ok: up.ok, sig: back.sigPng, scan: back.scanB64};
  });
  ok(sc.ok && sc.sig === 'data:image/png;base64,QUJD' && !sc.scan, 'owner: a signature-only sidecar is stored and read back ' + JSON.stringify(sc));

  // ── Owner sees everything, approves the HR's hours; unassigns Dana ──
  await reload(p);
  ok(await waitFor(p, () => typeof workers !== 'undefined' && workers.length === 3), 'owner: sees all three workers');
  ok(await p.evaluate(() => /Avi Boss/.test(document.querySelector('[data-testid=account-btn]').innerText)), 'owner: name kept after reload');
  const fin = await p.evaluate(async (hrUid) => {
    const r = {};
    const q = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'loadPendingHours'})})).json();
    const bid = q.batches.find(b => b.status === 'pending').batchId;
    await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'approvePendingHours', batchId: bid})})).json();
    const b = await loadFirestoreBackend();
    r.approved = (await b.punchesOfBatch(fsTenantId(), bid)).map(x => x.hrId);
    await assignWorkersToHr(['w2'], null);
    await new Promise(res => setTimeout(res, 1500));
    r.dana = workers.find(w => w.id === 'w2').hrId || null;
    return r;
  }, hrUid);
  ok(fin.approved.length === 2 && fin.approved.every(x => x === hrUid), 'owner: approved hours of an HR worker carry the HR');
  // Live, without a reload: the unassigned worker leaves the HR's list, a newly assigned one appears.
  ok(await waitFor(h, () => !workers.some(w => w.id === 'w2')), 'hr: an unassigned worker leaves its list live');
  await p.evaluate(async (hrUid) => { await assignWorkersToHr(['w1'], hrUid); }, hrUid);
  ok(await waitFor(h, () => workers.some(w => w.id === 'w1')), 'hr: a newly assigned worker appears live');
  await p.evaluate(async () => { await assignWorkersToHr(['w1'], null); });
  ok(await waitFor(h, () => !workers.some(w => w.id === 'w1')), 'hr: and leaves again live');
  await reload(h);
  ok(await waitFor(h, () => typeof workers !== 'undefined' && workers.length === 1 && workers[0].name === 'New Hire'), 'hr: an unassigned worker is gone from its view');
  ok(await waitFor(h, () => getPunchLog().every(e => e.workerId !== 'w2')), 'hr: and so are its punches');
  ok(h.errs.length === 0 && p.errs.length === 0, 'no page errors ' + h.errs.concat(p.errs).join(' | '));
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
