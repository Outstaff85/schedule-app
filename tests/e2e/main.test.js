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

  // ── Manager app, firm owner ──
  let ctx = await newCtx(); let p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => typeof workers !== 'undefined' && workers.length === 2), 'owner: workers load from Firestore');
  const idle = await p.evaluate(() => { switchTab('admin'); return {none: document.getElementById('adminPane_none').style.display !== 'none', rows: document.querySelectorAll('#adminTableBody > .t3-line').length, log: document.getElementById('adminPane_punchlog').style.display}; });
  ok(idle.none && idle.rows === 0 && idle.log === 'none', 'admin opens with no section: punch log not drawn until tapped');
  ok(await p.evaluate(() => typeof BACKEND === 'undefined' && typeof API_SECRET === 'undefined' && API_URL === 'api://app'), 'no BACKEND switch, no API_SECRET');
  ok(await waitFor(p, () => getPunchLog().length >= 2), 'owner: punches load (live window)');
  // save round-trip
  ok(await p.evaluate(async () => { clients[1].name = 'Site B2'; const ok = await gsSave(getDataObj()); const d = await (await loadFirestoreBackend()).loadSchedule(fsTenantId(), false); return ok && d.clients.find(c=>c.id==='c2').name === 'Site B2'; }), 'owner: save reaches Firestore');
  // Finance lives in Accounting → Worker pay: the worker modal has no rate; the pay modal sets it all.
  const rt = await p.evaluate(async () => {
    const out = {};
    const c1 = clients.find(c => c.id === 'c1'); c1.defaultHourlyRate = 60;
    const wi = workers.findIndex(w => w.id === 'w2'); const keep = JSON.parse(JSON.stringify(workers[wi]));
    openEditWorker(wi);
    out.noRateInModal = !document.getElementById('wRate') && !document.getElementById('wBank') && !document.getElementById('wTravelAllowance');
    closeModal('workerOverlay');
    switchTab('accounting');
    out.listed = !document.getElementById('accSecWorkerPay') && !document.getElementById('workerPayWrap');  // one Salary section, no Worker pay
    openPayModal('w2');
    out.open = document.getElementById('payOverlay').classList.contains('open');
    document.getElementById('payMode').value = 'daily'; onPayModeChange();
    out.otHidden = document.getElementById('payOtRow').style.display === 'none';
    document.getElementById('payRate').value = '400';
    document.getElementById('payTravelDay').value = '20';
    document.getElementById('payTravelMonth').value = '150';
    document.getElementById('payBank').value = 'Leumi'; document.getElementById('payBankAccount').value = '123';
    savePayModal('w2');
    const w = workers[wi];
    out.saved = {mode: w.payMode, rate: w.hourlyRate, td: w.travelAllowance, tm: w.travelMonthly, bank: w.bank, acc: w.bankAccountNumber};
    out.travel = travelPay(w, 3, 2);
    const sel = document.getElementById('salaryPeriod'); sel.value = 'all'; await onSalaryPeriodChange();
    const row = [...document.querySelectorAll('#dashSalary .salary-rows .sal-row')].find(r => r.textContent.includes(w.name));
    out.card = row ? row.textContent.replace(/\s+/g, ' ') : '';
    sel.value = 'week'; await onSalaryPeriodChange();
    // An edit in the worker modal keeps the pay fields.
    openEditWorker(wi); await saveWorker();
    out.keptAfterEdit = workers[wi].hourlyRate === 400 && workers[wi].travelMonthly === 150 && workers[wi].bank === 'Leumi';
    // Moved to a client with its own rate: an hourly worker's own rate gives way to the client's.
    delete workers[wi].payMode; workers[wi].hourlyRate = 70;
    const c2 = clients.find(c => c.id === 'c2'); c2.defaultHourlyRate = 55;
    openEditWorker(wi); removeWClient('c2'); await saveWorker();
    openEditWorker(wi); addWClient('c2'); await saveWorker();
    out.moved = workers[wi].hourlyRate; delete c2.defaultHourlyRate;
    delete c1.defaultHourlyRate; workers[wi] = keep; await gsSave(getDataObj());
    switchTab('schedule');
    return out;
  });
  ok(rt.noRateInModal && rt.listed && rt.open && rt.otHidden, 'worker pay: no money fields in the worker modal; one Salary section; the pay modal opens', JSON.stringify(rt));
  ok(rt.saved.mode === 'daily' && rt.saved.rate === 400 && rt.saved.td === 20 && rt.saved.tm === 150 && rt.saved.bank === 'Leumi' && rt.saved.acc === '123' && rt.travel === 360 && /₪400\/day/.test(rt.card) && /Leumi/.test(rt.card), 'worker pay: the pay modal saves mode, rate, travel per day and per month, bank; the Salary row shows them', JSON.stringify(rt));
  // Salary: one compact line per worker; a tap opens its details. The header: one account menu.
  const sc = await p.evaluate(async () => {
    switchTab('accounting'); const sel = document.getElementById('salaryPeriod'); sel.value = 'all'; await onSalaryPeriodChange();
    const row0 = document.querySelector('#dashSalary .sal-row'); if(!row0) return {};
    const wid = row0.dataset.wid, row = row0;
    const det = () => getComputedStyle(document.querySelector('#dashSalary .sal-row[data-wid="' + wid + '"] .sal-det')).display;
    const r = {h: row.getBoundingClientRect().height, before: det()};
    row.dispatchEvent(new MouseEvent('click', {bubbles: true})); await new Promise(res => setTimeout(res, 450)); r.after = det();
    sel.value = 'week'; await onSalaryPeriodChange();
    toggleAccountMenu(); const m = document.getElementById('accountMenu');
    r.menu = {open: getComputedStyle(m).display !== 'none', lang: !m.querySelector('.lang-btn, select') && !!document.querySelector('.titlebar-actions > .lang-btn + #accountControl'), out: /Sign out/.test(m.innerText), name: /My name/.test(m.innerText)};
    closeAccountMenu(); r.closed = getComputedStyle(m).display === 'none';
    return r;
  });
  ok(sc.h > 0 && sc.h < 60 && sc.before === 'none' && sc.after === 'grid', 'salary: one compact line per worker, a tap opens the details ' + JSON.stringify(sc));
  ok(sc.menu && sc.menu.open && sc.menu.lang && sc.menu.out && sc.menu.name && sc.closed, 'header: one account menu with my name and sign out; the Language button beside it ' + JSON.stringify(sc.menu));
  // An inactive worker leaves the everyday lists and comes back when set Active; a contract warning shows a notice at the top.
  const ia = await p.evaluate(async () => {
    const w = workers.find(x => x.id === 'w2'), keep = JSON.parse(JSON.stringify(w)), r = {};
    switchTab('workers'); document.getElementById('workersFilterStatus').value = ''; renderWorkersPage();
    w.status = 'fired'; render(); renderWorkersPage();
    const names = () => document.getElementById('sectionWorkers').innerText + ' ' + [...document.querySelectorAll('#sectionWorkers .wp-n')].map(x => x.title).join(' ');
    r.hidden = !/Dana Levi/.test(names()) && /Inactive: 1/.test(document.getElementById('workersCount').innerText);
    r.sidebar = !/Dana Levi/.test(document.getElementById('workerList').innerText);
    showInactiveWorkers(); r.shown = /Dana Levi/.test(names());
    w.status = 'active'; document.getElementById('workersFilterStatus').value = ''; render(); renderWorkersPage(); r.back = /Dana Levi/.test(names());
    const d = new Date(); d.setMonth(d.getMonth() - 2);
    Object.assign(w, {expiryEnabled: true, expiryMonths: 1, expiryWarnMonths: 1, startDate: localYMD(d)});
    try{ sessionStorage.removeItem('contractNoticeClosed'); }catch(e){}
    showContractNotice(); const n = document.getElementById('contractNotice');
    r.notice = n.style.display !== 'none' && /Contracts: 1 expired/.test(n.innerText);
    closeContractNotice(); r.closed = n.style.display === 'none';
    Object.keys(w).forEach(k => delete w[k]); Object.assign(w, keep); render();
    return r;
  });
  ok(ia.hidden && ia.sidebar && ia.shown && ia.back, 'workers: an inactive worker leaves the lists, "Inactive: N — show" brings them, Active returns them ' + JSON.stringify(ia));
  ok(ia.notice && ia.closed, 'contracts: an expired contract shows a notice at the top until closed ' + JSON.stringify(ia));
  // Template 3 on a phone: Today (figures, colored lines), Workers, Accounting — screenshots for review.
  await p.setViewportSize({width: 390, height: 844});
  const t3 = await p.evaluate(async () => { switchTab('dashboard'); await new Promise(r => setTimeout(r, 300));
    return {stats: document.querySelectorAll('#dashStats > div').length, lines: document.querySelectorAll('#sectionDashboard .t3-line').length}; });
  await p.screenshot({path: SP + '/t3-today.png'}).catch(()=>{});
  // The phone bottom bar (variant 11): Today, Schedule, Workers, Accounting, More; More opens a sheet with the other tabs.
  const bb = await p.evaluate(async () => {
    const shown = [...document.querySelectorAll('.top-tabs .ttab')].filter(t => getComputedStyle(t).display !== 'none').map(t => t.querySelector('.lb').textContent.trim());
    const bar = document.querySelector('.top-tabs').getBoundingClientRect(), fixed = Math.abs(bar.bottom - innerHeight) < 2 && Math.abs(bar.width - innerWidth) < 2;
    const todayColor = getComputedStyle(document.getElementById('tabDashboard')).color;
    document.getElementById('tabMore').click(); await new Promise(r => setTimeout(r, 200));
    const sheet = document.getElementById('moreOverlay').classList.contains('open'), items = [...document.querySelectorAll('#moreModal .t3-line b')].map(b => b.textContent.trim());
    document.querySelectorAll('#moreModal .t3-line')[0].click(); await new Promise(r => setTimeout(r, 200));
    const r = {shown, fixed, todayColor, sheet, items, tab: currentTab, moreOn: document.getElementById('tabMore').classList.contains('active'), closed: !document.getElementById('moreOverlay').classList.contains('open')};
    switchTab('dashboard'); r.moreOff = !document.getElementById('tabMore').classList.contains('active');
    return r;
  });
  ok(bb.shown.join() === 'Today,Schedule,Workers,Accounting,More' && bb.fixed && bb.todayColor === 'rgb(34, 211, 238)' && bb.sheet && bb.items.join() === 'Clients,Suppliers,Admin' && bb.tab === 'clients' && bb.moreOn && bb.closed && bb.moreOff,
    'phone bottom bar: Today, Schedule, Workers, Accounting, More (the active one in its color); More opens Clients, Suppliers, Admin ' + JSON.stringify(bb));
  // Today, variant A: a figure shows only its section; the arrow folds a section (kept); the salary search opens from its icon.
  const tf = await p.evaluate(async () => {
    let r_figs = '', r_sections = false;
    const vis = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    const listShown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    dashFilterTo('log');
    const only = vis('dashLogWrap') && !vis('dashMissingWrap') && !vis('dashOnSiteWrap') && !vis('dashSuppliersWrap') && /Show all/.test(document.getElementById('dashFilterNote').innerText);
    dashFilterTo('log');
    const all = vis('dashSuppliersWrap') || vis('dashLogWrap');
    document.querySelector('#dashLogWrap .dash-sec').click();
    const folded = !listShown('dashLog'), kept = JSON.parse(localStorage.getItem('dashFolded') || '[]').includes('log');
    document.querySelector('#dashLogWrap .dash-sec').click();
    const open = listShown('dashLog');
    // Screens.md: the figures are On shift, Late, No punch, Notices; the sections are worker plates.
    r_figs = [...document.querySelectorAll('#dashStats > div')].map(d => d.childNodes[1] ? d.childNodes[1].textContent.trim() : '').join();
    r_sections = ['dashOnSiteWrap','dashLateWrap','dashMissingWrap','dashNoticesWrap'].every(id => !!document.getElementById(id));
    switchTab('accounting'); await new Promise(r => setTimeout(r, 300));
    const sr = document.getElementById('salarySearch'), hidden = sr.style.display === 'none';
    toggleSalarySearch(); const shown = sr.style.display !== 'none'; toggleSalarySearch();
    switchTab('dashboard');
    return {only, all, folded, kept, open, hidden, shown, closed: sr.style.display === 'none', figs: r_figs === 'On shift,Late,No punch,Notices', sections: r_sections};
  });
  ok(Object.values(tf).every(Boolean), 'today: a figure filters to its section, the arrow folds one (kept); salary search opens from its icon ' + JSON.stringify(tf));
  // Schedule, variant 6: a line per worker with its week; the arrow opens 7 days, a day opens the shift editor.
  const sch = await p.evaluate(async () => {
    const w0 = workers.find(w => isActiveWorker(w)), keep = JSON.stringify(w0.schedule || []);
    w0.schedule = [{type:'off'}, {type:'work', start:'09:00', end:'17:00'}, {type:'off'}, {type:'off'}, {type:'off'}, {type:'off'}, {type:'off'}];
    switchTab('schedule'); render(); await new Promise(r => setTimeout(r, 200));
    const line = document.querySelector('#ganttBody .sched-line'), sum = line.querySelector('small').innerText;
    line.click(); await new Promise(r => setTimeout(r, 100));
    const days = document.querySelectorAll('#ganttBody .sched-day').length;
    document.querySelector('#ganttBody .sched-day').click(); await new Promise(r => setTimeout(r, 200));
    const editor = !!document.querySelector('.overlay.open');
    document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
    document.querySelector('#ganttBody .sched-line').click();
    const closedNow = document.querySelectorAll('#ganttBody .sched-day').length === 0;
    w0.schedule = JSON.parse(keep); render();
    return {sum, days, editor, closedNow, week: document.getElementById('schedWeekRange').innerText};
  });
  ok(/shift/.test(sch.sum) && /h/.test(sch.sum) && sch.days === 7 && sch.editor && sch.closedNow && /–/.test(sch.week), 'schedule: a line per worker, the arrow opens its 7 days, a day opens the shift editor ' + JSON.stringify(sch));
  await p.screenshot({path: SP + '/t3-schedule.png'}).catch(()=>{});
  // Schedule (redesign stage 6): glass week arrows, site tabs, 7 day marks per worker, opened days under it.
  const sc6 = await p.evaluate(async () => {
    const w0 = workers.find(w => isActiveWorker(w)), keep = JSON.stringify(w0.schedule || []);
    w0.schedule = [{type:'off'}, {type:'work', start:'09:00', end:'17:00'}, {type:'work', start:'22:00', end:'06:00'}, {type:'off'}, {type:'off'}, {type:'off'}, {type:'off'}];
    switchTab('schedule'); render(); await new Promise(r => setTimeout(r, 100));
    const line = document.querySelector('#ganttBody .sched-line'), r = {arrows: document.querySelectorAll('.sched-nav .gbtn.sched-arrow').length, marks: line.querySelectorAll('.daymarks i').length, hrs: (line.querySelector('.r') || {}).textContent};
    const tabs = [...document.querySelectorAll('#schedSiteTabs button')]; r.tabs = tabs.map(b => b.textContent);
    if(tabs[1]){ tabs[1].click(); r.filtered = selectedClientId === clients[0].id && document.querySelector('#schedSiteTabs button.on').textContent === clients[0].name; filterByClient(null); }
    line.click(); await new Promise(r => setTimeout(r, 50));
    r.dayrows = document.querySelectorAll('#ganttBody .dayrows .sched-day').length; document.querySelector('#ganttBody .sched-line').click();
    r.kinds = [...document.querySelector('#ganttBody .sched-line').querySelectorAll('.daymarks i')].map(i => i.className.replace(' t', '') || '-').join('');
    w0.schedule = JSON.parse(keep); render();
    return r;
  });
  ok(sc6.arrows === 2 && sc6.marks === 7 && /h$/.test(sc6.hrs) && sc6.tabs[0] === 'All sites' && sc6.filtered && sc6.dayrows === 7 && sc6.kinds === '-wn----', 'schedule: glass arrows, site tabs filter, 7 day marks and the week\'s hours per worker, its days open under it ' + JSON.stringify(sc6));
  await p.evaluate(async () => { switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); await new Promise(r => setTimeout(r, 300)); });
  await p.screenshot({path: SP + '/t3-workers.png'}).catch(()=>{});
  await p.evaluate(async () => { switchTab('accounting'); const sel = document.getElementById('salaryPeriod'); sel.value = 'all'; await onSalaryPeriodChange();
    const r = document.querySelector('#dashSalary .sal-row'); if(r) toggleSalRow(r); window.scrollTo(0, 0); document.querySelector('#sectionAccounting').scrollIntoView(); await new Promise(res => setTimeout(res, 300)); });
  await p.screenshot({path: SP + '/t3-accounting.png'}).catch(()=>{});
  await p.evaluate(async () => { const sel = document.getElementById('salaryPeriod'); sel.value = 'week'; await onSalaryPeriodChange(); });
  await p.setViewportSize({width: 1280, height: 720});
  ok(t3.stats === 4 && t3.lines >= 1, 'today: figures on top and colored lines (template 3) ' + JSON.stringify(t3));
  // On a phone a worker card is compact: one summary line instead of the detail rows.
  await p.setViewportSize({width: 390, height: 800});
  const wc = await p.evaluate(async () => { switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); await new Promise(r => setTimeout(r, 200));
    const c = document.querySelector('#workersCards .wplate'); return c ? {h: c.getBoundingClientRect().height, name: c.querySelector('.wp-n').textContent, full: c.querySelector('.wp-n').title, hrs: (c.querySelector('.r') || {}).textContent, kb: !!c.querySelector('.t3-kb'), sw: !!c.closest('.sw')} : {}; });
  await p.setViewportSize({width: 1280, height: 720});
  ok(wc.h > 0 && wc.h < 100 && wc.name && wc.name === wc.full && /h$/.test(wc.hrs) && wc.kb && wc.sw, 'workers: on a phone a worker is one plate — the full name (… when it does not fit), the month\'s hours, ⋮, swipe ' + JSON.stringify(wc));
  ok(rt.keptAfterEdit, 'worker pay: an edit in the worker modal keeps the pay fields', JSON.stringify(rt));
  ok(rt.moved === 0, "worker pay: moved to a client with a rate, the worker takes the client's rate", JSON.stringify(rt));
  // Commission for a worker paid by the day: a fixed ₪ per day when set, else hours × ₪/h.
  const dc = await p.evaluate(() => {
    const w = {id: 'x', payMode: 'daily', supplierRates: {s1: {rate: 6, dayRate: 70}}};
    const e = {hours: 20, daysUsed: 3};
    return {
      sup: commissionFor(w, e, supplierCommissionRate(w, 's1'), supplierDayCommission(w, 's1')),
      noDay: commissionFor({...w, supplierRates: {s1: {rate: 6}}}, e, 6, supplierDayCommission({supplierRates: {s1: {rate: 6}}}, 's1')),
      hourly: commissionFor({id: 'y'}, e, 6, 70),
      hr: commissionFor(w, e, 4, 40)};
  });
  ok(dc.sup === 210 && dc.noDay === 120 && dc.hourly === 120 && dc.hr === 120, 'commission: a daily worker counts days × ₪/day when set, else hours × ₪/h ' + JSON.stringify(dc));
  // Hours sent for review: a live count on the Accounting tab and the latest status on the worker card.
  const hb = await p.evaluate(async () => {
    const r = {};
    const wait = async (fn) => { for(let i = 0; i < 60 && !fn(); i++) await new Promise(res => setTimeout(res, 150)); };
    const badge = () => document.getElementById('accPendingBadge');
    const before = (__hoursBatches || []).filter(b => b.status === 'pending').length;
    await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'savePendingHoursBatch', fileName: 'e2e', entries: [{workerId: 'w2', date: '03/10/2026', inTime: '08:00', outTime: '12:00'}]})});
    await wait(() => badge() && badge().textContent === String(before + 1) && badge().style.display !== 'none');
    r.badge = badge() && badge().style.display !== 'none' ? badge().textContent : null; r.before = before;
    openWorkerCard(workers.findIndex(w => w.id === 'w2'));
    r.card = document.getElementById('cardHoursStatus').innerText;
    const b = latestHoursBatch('w2');
    await rejectHoursBatch(b.batchId);
    await wait(() => /Rejected/.test(document.getElementById('cardHoursStatus').innerText));
    r.after = document.getElementById('cardHoursStatus').innerText;
    r.badgeAfter = badge().style.display === 'none' ? 0 : Number(badge().textContent);
    closeModal('workerCardOverlay');
    return r;
  });
  ok(hb.badge === String(hb.before + 1) && /Sent for review/.test(hb.card) && /Rejected/.test(hb.after) && hb.badgeAfter === hb.before, 'hours review: a live count on the Accounting tab and the status on the worker card ' + JSON.stringify(hb));
  // The worker window saves itself when closed by a tap outside.
  const as = await p.evaluate(async () => {
    const r = {}, tap = () => { const ov = document.getElementById('workerOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click(); };
    const wi = workers.findIndex(w => w.id === 'w2'), keepPhone = workers[wi].phone;
    openEditWorker(wi); r.noSaveBtn = ![...document.querySelectorAll('#workerModal button')].some(b => /שמור|צור עובד/.test(b.textContent));
    document.getElementById('wPhone').value = '0547770000'; tap();
    await new Promise(res => setTimeout(res, 300));
    r.saved = workers[wi].phone; r.closed = !document.getElementById('workerOverlay').classList.contains('open');
    openEditWorker(wi); document.getElementById('wPhone').value = keepPhone || ''; tap(); await new Promise(res => setTimeout(res, 300));
    openEditWorker(wi); document.getElementById('wGiven').value = ''; document.getElementById('wSurname').value = ''; tap(); await new Promise(res => setTimeout(res, 300));
    r.nameKept = workers[wi].name; r.closedEmpty = !document.getElementById('workerOverlay').classList.contains('open');
    const n = workers.length; openAddWorker(); tap(); await new Promise(res => setTimeout(res, 300));
    r.noNew = workers.length === n && !document.getElementById('workerOverlay').classList.contains('open');
    return r;
  });
  ok(as.noSaveBtn && as.saved === '0547770000' && as.closed, 'worker window: no Save button; a tap outside saves and closes ' + JSON.stringify(as));
  ok(as.nameKept === 'Dana Levi' && as.closedEmpty && as.noNew, 'worker window: an empty name is not saved; an empty new worker is not created ' + JSON.stringify(as));
  // The header's language select: English by default; Hebrew from i18n/he.json, Russian (an empty dictionary) falls back to English.
  const lg = await p.evaluate(async () => {
    const r = {def: I18N_LANG, sel: document.querySelector('.titlebar-actions .lang-btn .lang-btn-name').textContent, firmField: !!document.getElementById('firmEditLanguage')};
    document.getElementById('langBtn').click();
    const sh = document.getElementById('langSheet'), inp = sh.querySelector('input');
    r.sheet = {open: sh.classList.contains('open'), all: [...sh.querySelectorAll('.lang-li')].map(b => b.querySelector('b').textContent + '/' + b.querySelector('small').textContent).join(), ticked: sh.querySelector('.lang-li.on').dataset.lang};
    inp.value = 'hebr'; inp.dispatchEvent(new Event('input')); r.sheet.found = [...sh.querySelectorAll('.lang-li')].map(b => b.dataset.lang).join();
    inp.value = 'zz'; inp.dispatchEvent(new Event('input')); r.sheet.none = sh.querySelectorAll('.lang-li').length === 0 && !!sh.querySelector('.lang-none');
    sh.dispatchEvent(new MouseEvent('click', {bubbles: true})); r.sheet.closed = !sh.classList.contains('open');
    const setLang = async l => {
      document.getElementById('langBtn').click();
      const li = document.querySelector('#langSheet .lang-li[data-lang="' + l + '"]') || document.querySelector('#langSheet .lang-li.on');
      if(li) li.click();
      for(let i = 0; i < 40 && I18N_LANG !== l; i++) await new Promise(res => setTimeout(res, 150));
      switchTab('accounting'); await new Promise(res => setTimeout(res, 300));
      return {lang: I18N_LANG, tab: document.getElementById('tabAccounting').innerText.trim(),
        head: document.querySelector('#dashSalary .sal-head .c-name') && document.querySelector('#dashSalary .sal-head .c-name').innerText.trim(),
        sec: document.querySelector('#accSecSalary span[data-i18n]').textContent.trim(),
        period: document.getElementById('salaryPeriod').options[0].text,
        stored: localStorage.getItem('uiLang'), selects: [...document.querySelectorAll('.lang-btn .lang-btn-name')].every(x => x.textContent === I18N_LANGS[l]) && !document.getElementById('langSheet').classList.contains('open')};
    };
    r.he = await setLang('he');
    r.ru = await setLang('ru');
    r.en = await setLang('en');
    return r;
  });
  ok(lg.sheet.open && lg.sheet.all === 'English/English,עברית/Hebrew,Русский/Russian' && lg.sheet.ticked === 'en' && lg.sheet.found === 'he' && lg.sheet.none && lg.sheet.closed, 'language: the Language button opens a sheet with every language (own name + English), the current one ticked, a search, closes on a tap outside ' + JSON.stringify(lg.sheet));
  ok(lg.he.lang === 'he' && lg.he.tab === 'חשבונות' && lg.he.head === 'עובד' && lg.he.sec === 'חישוב שכר' && lg.he.period === 'השבוע' && lg.he.stored === 'he' && lg.he.selects && lg.def === 'en' && lg.sel === 'English' && !lg.firmField, 'language: English by default; the header Language button switches to Hebrew sees Accounting in Hebrew ' + JSON.stringify(lg.he));
  ok(lg.ru.lang === 'ru' && lg.ru.tab === 'Accounting' && lg.ru.head === 'Worker', 'language: Russian with an empty dictionary shows English ' + JSON.stringify(lg.ru));
  ok(lg.en.lang === 'en' && lg.en.tab === 'Accounting' && lg.en.sec === 'Salary Calculation' && lg.en.period === 'This Week', 'language: back to English ' + JSON.stringify(lg.en));
  // One Language button per page; the user's last choice follows them to a new device.
  await p.evaluate(() => setLanguage('he')); await sleep(1500);
  {
    const c2 = await newCtx(); const p2 = await page(c2);
    await p2.goto(BASE + 'schedule-manager.html'); await p2.waitForSelector('#loginScreen', {state:'visible'});
    const onLogin = await p2.evaluate(() => ({card: (() => { const c = document.querySelector('.login-card'), cs = getComputedStyle(c); return cs.position === 'fixed' && cs.borderRadius === '22px' && !!c.querySelector('.og-mark') && /gbtn/.test(document.getElementById('loginBtn').className); })(), n: document.querySelectorAll('.lang-btn').length, selects: document.querySelectorAll('select.lang-select').length, inLogin: !!document.querySelector('#loginScreen #langBtn.on-cover'), lang: I18N_LANG}));
    await p2.fill('#loginUsername', 'owner1'); await p2.fill('#loginPassword', 'owner-pass-1'); await p2.click('#loginBtn');
    await p2.waitForNavigation().catch(()=>{});
    const after = await waitFor(p2, () => I18N_LANG === 'he' && !!document.querySelector('.titlebar-actions #langBtn') && document.querySelector('#langBtn .lang-btn-name').textContent === 'עברית' && document.querySelectorAll('.lang-btn').length === 1, 15000);
    ok(onLogin.card, 'sign-in: a compact glass card pinned over the site, with the logo and a glass Sign in ' + JSON.stringify(onLogin));
    ok(onLogin.n === 1 && !onLogin.selects && onLogin.inLogin && onLogin.lang === 'en' && after, 'language: one Language button per page (login screen, then the title bar); the user\'s last choice comes back on a new device ' + JSON.stringify(onLogin));
    await p2.evaluate(() => setLanguage('en')); await sleep(1000);
    await c2.close();
  }
  await p.evaluate(() => setLanguage('en', {save:false}));
  // Schedule: a shift for one date only wins over the weekly roster on that date
  const ds = await p.evaluate(async () => {
    switchTab('schedule'); await new Promise(r => setTimeout(r, 200));
    const wi = workers.findIndex(w => w.id === 'w1'), di = 3;
    const weekly = JSON.stringify(workers[wi].schedule[di]);
    openEditShift(wi, di);
    document.getElementById('eScope').value = 'date'; document.getElementById('eType').value = 'work';
    document.getElementById('eStart').value = '10:00'; document.getElementById('eEnd').value = '14:00';
    saveShift(wi, di);
    const d = new Date(weekStart); d.setDate(d.getDate() + di);
    const r = {weeklySame: JSON.stringify(workers[wi].schedule[di]) === weekly, dated: (workers[wi].dateShifts || {})[localYMD(d)], week: weekShifts(workers[wi])[di]};
    const next = new Date(d); next.setDate(next.getDate() + 7); r.nextWeek = shiftOn(workers[wi], next);
    clearDateShift(wi, di); r.cleared = !(workers[wi].dateShifts || {})[localYMD(d)];
    closeModal('editOverlay');
    return r;
  });
  ok(ds.weeklySame && ds.dated && ds.dated.start === '10:00' && ds.week.dated && ds.week.end === '14:00' && !ds.nextWeek.dated && ds.cleared, 'schedule: a one-date shift overrides the weekly day only on that date; back to weekly removes it ' + JSON.stringify(ds));
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
    document.getElementById('wGiven').value = 'Typed';
    document.getElementById('wCity').value = '';
    document.getElementById('wPhone').value = 'P-123';
    await rescanFromWorkerModal();
    const scanOpen = document.getElementById('aiScanOverlay').classList.contains('open');
    openWorkerModalFromScan({type:'israeli_id', given:'FromScan', surname:'Scan', city:'Haifa'});
    const r = {scanOpen, given:wGiven.value, city:wCity.value, phone:wPhone.value, rescanned: window.__aiRescannedWorkerId === workers[0].id, draft: window.__wDraft};
    closeModal('workerOverlay'); window.__aiRescannedWorkerId = null;
    openWorkerCard(0);
    r.card = document.getElementById('workerCardModal').innerHTML.includes('rescanFromWorkerCard');
    closeModal('workerCardOverlay');
    return r;
  });
  ok(rs.scanOpen && rs.given === 'Typed' && rs.city === 'Haifa' && rs.phone === 'P-123' && rs.rescanned && rs.draft === null && rs.card, 'scan again from the worker modal keeps typed values, fills empty ones; card has the button');
  // Field search: the card's missing rows and the modal's marked fields search the saved scan
  const fs = await p.evaluate(async () => {
    const a = await uploadWorkerFile({action:'saveWorkerAssets', workerId:'w1', scanB64:'SCAN', scanMediaType:'image/jpeg', sigPng:null, extraPages:[{b64:'SEF', mediaType:'image/jpeg'}], fileNameBase:'x'}, ()=>{});
    const w = workers[0]; w.assetsFileId = a.id; w.docType = 'israeli_id'; w.city = ''; w.address = '';
    openWorkerCard(0);
    const rowsBefore = ['city','address'].map(k => !!document.getElementById('cardMiss_'+k));
    await findScanFieldFromCard(0, 'city');
    const r = {rowsBefore, city: w.city, cityRowGone: !document.getElementById('cardMiss_city'), addrRow: !!document.getElementById('cardMiss_address')};
    closeModal('workerCardOverlay');
    openEditWorker(0);
    const addr = document.getElementById('wAddress');
    r.marked = addr.classList.contains('scan-missing') && !document.getElementById('wCity').classList.contains('scan-missing');
    addr.click();
    const end = Date.now() + 8000;
    while (Date.now() < end && !addr.parentElement.querySelector('.scan-missing-hint')) await new Promise(res => setTimeout(res, 100));
    r.hint = !!addr.parentElement.querySelector('.scan-missing-hint') && addr.value === '';
    addr.value = 'Typed'; addr.dispatchEvent(new Event('input'));
    r.cleared = !addr.classList.contains('scan-missing') && !addr.parentElement.querySelector('.scan-missing-hint');
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
  ok(fs.rowsBefore.every(Boolean) && fs.city === 'חיפה' && fs.cityRowGone && fs.addrRow, 'card: tapping a missing row finds the city in the saved scan and saves it');
  ok(fs.marked && fs.hint && fs.cleared, 'modal: empty scan field marked; not found shows a hint; typing clears the mark');
  // A field whose zoomed re-read disagreed is framed "check this" until edited
  const uc = await p.evaluate(() => {
    window.__aiPageParsed = [{type:'israeli_id', given:'Avi', city:'חיפה', __uncertain:['city']}];
    window.__aiRescanWorkerId = workers[1].id;
    openWorkerModalFromScan({type:'israeli_id', given:'Avi', city:'חיפה', __uncertain:['city']});
    const c = document.getElementById('wCity');
    const r = {marked: c.classList.contains('scan-check') && !!c.parentElement.querySelector('.scan-check-hint'), given: document.getElementById('wGiven').classList.contains('scan-check')};
    c.value = 'Haifa'; c.dispatchEvent(new Event('input'));
    r.cleared = !c.classList.contains('scan-check') && !c.parentElement.querySelector('.scan-check-hint');
    closeModal('workerOverlay'); window.__aiRescannedWorkerId = null; window.__aiPageParsed = [];
    return r;
  });
  ok(uc.marked && !uc.given && uc.cleared, 'modal: a field the two scan reads disagree on is marked "check" until edited');
  // Second pass right after a scan: empty fields are searched for on their own
  await srv('/aicalls');
  const af = await p.evaluate(async () => {
    await ensureScanPipelineLoaded();
    window.__aiRescanWorkerId = null; window.__aiPageParsed = [];
    window.__aiScanImage = {b64:'FRONT', mediaType:'image/jpeg'}; window.__aiPacketOtherPages = [{b64:'SEF', mediaType:'image/jpeg'}];
    openWorkerModalFromScan({type:'israeli_id', given:'Neo', surname:'Test', dob:'01/01/1990', sex:'M'});
    const city = document.getElementById('wCity'), addr = document.getElementById('wAddress');
    const end = Date.now() + 8000;
    while (Date.now() < end && !(city.value && addr.parentElement.querySelector('.scan-missing-hint'))) await new Promise(r => setTimeout(r, 100));
    const r = {city: city.value, addrHint: !!addr.parentElement.querySelector('.scan-missing-hint'), given: document.getElementById('wGiven').value};
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
      for (const k in __pagedLists) delete __pagedLists[k];
      const out = {};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      switchTab('workers');
      for (const view of ['cards', 'list']) {
        setWorkersView(view); renderWorkersPage(); await wait(400);
        const sel = view === 'cards' ? '#workersCards > .sw' : '#workersTableBody > tr:not(.paged-more)';
        const first = document.querySelectorAll(sel).length;
        await wait(600);
        const stillFirst = document.querySelectorAll(sel).length;
        const pm = document.querySelector(view === 'cards' ? '#workersCards > .paged-more' : '#workersTableBody > .paged-more');
        if (!pm) { out.dbg = JSON.stringify(Object.fromEntries(Object.entries(__pagedLists).map(([k,v]) => [k, {sig:v.sig, shown:v.shown, more:!!v.more}]))) + ' view=' + getWorkersView() + ' wrap=' + document.getElementById('workersTableWrap').style.display; out[view] = [first, stillFirst, -1, document.getElementById(view === 'cards' ? 'workersCards' : 'workersTableBody').children.length, workers.length]; continue; }
        pm.scrollIntoView({block:'end'});
        window.dispatchEvent(new WheelEvent('wheel'));
        window.dispatchEvent(new Event('scroll'));
        await wait(400);
        out[view] = [first, stillFirst, document.querySelectorAll(sel).length];
      }
      switchTab('schedule'); render(); await wait(300);
      out.gantt = document.querySelectorAll('#ganttBody > .gantt-row').length;
      out.side = document.querySelectorAll('#workerList > .worker-chip').length;
      workers.length = 0; real.forEach(x => workers.push(x)); render();
      return out;
    });
    console.log('PAGING', w, JSON.stringify(pg));
    ok(pg.cards[0] === 10 && pg.cards[1] === 10 && pg.cards[2] === 20 && pg.list[0] === 10 && pg.list[1] === 10 && pg.list[2] === 20,
      `workers at ${w}px: 10 at first, no auto pre-load, +10 after scrolling to the end`);
    ok(pg.gantt === 10 && pg.side === 10, `schedule rows and sidebar workers: 10 at first at ${w}px`);
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
    const btns = [...document.querySelectorAll('#adminPaneBar button')].filter(b => b.style.display !== 'none').map(b => b.id.replace('adminPaneBtn_', ''));
    switchAdminPane('firms');
    await new Promise(r => setTimeout(r, 2500));
    const txt = document.getElementById('adminFirmsList').innerText;
    const prof = await refreshTenantProfile(0);
    return {btns, txt: txt.slice(0, 200), superBar: document.getElementById('adminFirmsSuperBar').style.display, prof: prof && prof.companyName, profile: !!document.getElementById('adminPane_profile')};
  });
  console.log('FIRMS', JSON.stringify(fm));
  ok(fm.btns.includes('firms') && !fm.btns.includes('profile') && !fm.profile && /Firm One/.test(fm.txt) && /012345678/.test(fm.txt) && fm.superBar === 'none' && fm.prof === 'Firm One',
    'owner: Firms shows own firm card (Form 101 fields), no Profile pane; profile refreshes from the server');
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
  // Admin pane: users through the dispatcher
  ok(await p.evaluate(async () => { const j = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'listUsers'})})).json(); return (j.users||[]).some(u=>u.username==='sup1'); }), 'owner: listUsers via the dispatcher');
  ok(await p.evaluate(async () => (await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'nope'})})).json()).error === 'Unknown action: nope'), 'unknown action answers an error');
  // A supplier login's card in Users: its supplier's workers, add and unassign
  const sw = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    switchTab('admin'); switchAdminPane('users'); await wait(1500);
    const sup = loadAdminCache('users_' + activeTenantIdForAdmin()).find(u => u.username === 'sup1');
    await openEditUserForm(sup.id); await wait(300);
    const r = {shown: document.getElementById('userFormHrWorkersField').style.display !== 'none', before: document.getElementById('userFormHrWorkers').innerText};
    openHrAssignModal(); await wait(200);
    r.offered = document.getElementById('hrAssignList').innerText;
    toggleHrAssignPick('w2', true); await submitHrAssign(); await wait(300);
    r.after = document.getElementById('userFormHrWorkers').innerText;
    r.w2 = workers.find(w => w.id === 'w2').supplierId;
    await unassignHrWorker('w2'); await wait(300);
    r.back = workers.find(w => w.id === 'w2').supplierId; r.end = document.getElementById('userFormHrWorkers').innerText;
    closeModal('userFormOverlay');
    return r;
  });
  ok(sw.shown && /Avi Cohen/.test(sw.before) && !/Dana Levi/.test(sw.before) && /Dana Levi/.test(sw.offered) && !/Avi Cohen/.test(sw.offered)
     && /Dana Levi/.test(sw.after) && sw.w2 === 's-1' && !sw.back && !/Dana Levi/.test(sw.end), 'users: a supplier login lists its supplier\'s workers; add and unassign ' + JSON.stringify(sw));
  // load whole history, then the punch log
  await p.evaluate(() => ensureAllPunches());
  ok(await waitFor(p, () => getPunchLog().length === 4), 'owner: all punches after ensureAllPunches');
  // Punch log draws 10 rows at first even with many punches
  for (const [w, h] of [[1280, 800], [390, 800]]) {
    await p.setViewportSize({width:w, height:h});
    const pl = await p.evaluate(async () => {
      const base = getPunchLog().slice();
      const now = Date.now(), extra = [];
      for (let i = 0; i < 60; i++) extra.push({id: 'x' + i, workerId: 'w1', workerName: 'Avi Cohen', type: i % 2 ? 'out' : 'in', time: '08:00', ts: now - i * 3600e3, date: '', site: '', clientId: 'c1'});
      __punchLogMem = null;
      try { savePunchLog(base.concat(extra)); } catch (e) {}
      switchTab('admin'); switchAdminPane('punchlog');
      await new Promise(r => setTimeout(r, 1500));
      const rows = document.querySelectorAll('#adminTableBody > .t3-line').length;
      const more = !!document.querySelector('#adminTableBody > .paged-more');
      try { savePunchLog(base); } catch (e) {}
      return [rows, more, getPunchLog().length];
    });
    console.log('PUNCHLOG', w, JSON.stringify(pl));
  }
  for (const [w, h] of [[390, 760], [1280, 720]]) {
    await p.setViewportSize({width:w, height:h});
    await p.evaluate(() => { switchTab('admin'); window.scrollTo(0,0); });
    await sleep(300);
    await p.screenshot({path: SP + '/shot_admin_idle_' + w + '.png'});
    await p.evaluate(() => switchAdminPane('punchlog'));
    await sleep(400);
    await p.screenshot({path: SP + '/shot_admin_log_' + w + '.png'});
  }
  await p.setViewportSize({width:1280, height:720});
  await p.evaluate(() => switchAdminPane('punchlog'));
  const dates = await p.evaluate(() => [...document.querySelectorAll('#adminFilterDate option')].slice(1).map(o=>o.value));
  const asTime = d => { const [dd,mm,yy] = d.split('/'); return new Date(+yy, mm-1, +dd).getTime(); };
  ok(dates.length === 2 && asTime(dates[0]) > asTime(dates[1]), 'date filter: newest day first (' + dates.join(', ') + ')');
  const c2rows = await p.evaluate(() => { document.getElementById('adminFilterClient').value='c2'; renderAdmin(); return document.getElementById('adminCount').textContent; });
  ok(c2rows === '4 records', 'client filter uses the punch clientId (Site B2 → ' + c2rows + ')');
  // The punch log: a bare ⋮ (Edit, Delete) instead of ✕; Select — no boxes until the Select button, then tick two, Delete → Undo keeps them.
  const pls = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)); document.getElementById('adminFilterClient').value = ''; renderAdmin();
    const lines = [...document.querySelectorAll('#adminTableBody > .t3-line, #adminTableBody > .sw > .t3-line')];
    const r = {x: !!document.querySelector('#adminTableBody .t3-x'), kb: !!lines[0].querySelector('.t3-kb'), head: !!(document.querySelector('#adminTableBody').previousElementSibling || document.body).querySelector('[data-h="on"]') && lines[0].querySelector('.t3-cb').offsetWidth === 0};
    lines[0].querySelector('.t3-kb').click(); await wait(50);
    r.menu = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.textContent.trim()).join(); closePopover();
    const n0 = getPunchLog().length;
    document.querySelector('#adminTableBody').previousElementSibling.querySelector('[data-h="on"]').click(); await wait(300);
    r.shown = lines[0].querySelector('.t3-cb').offsetWidth > 0;
    lines[0].click(); lines[1].querySelector('.t3-cb').click();
    r.count = (document.querySelector('.sel-bar b') || {}).textContent; r.key = __selState && __selState.key; r.btns = [...document.querySelectorAll('.sel-bar .gbtn')].map(b => b.dataset.a).join();
    const del = [...document.querySelectorAll('.sel-bar .gbtn')].find(b => b.dataset.a === 'del'); if(!del) return r; del.click(); await wait(300);
    r.snack = /2 punches deleted/.test(document.getElementById('undoSnack').innerText);
    document.querySelector('#undoSnack .og-snack-u').click(); await wait(300);
    r.kept = getPunchLog().length === n0;
    return r;
  });
  ok(!pls.x && pls.kb && pls.head && pls.shown && pls.menu === 'Edit,!Delete' && pls.count === '2 selected' && pls.snack && pls.kept, 'punch log: ⋮ (Edit, Delete) instead of ✕; no boxes until Select, then a tap on a plate or its box ticks it, Delete two through Undo ' + JSON.stringify(pls));
  const c1rows = await p.evaluate(() => { document.getElementById('adminFilterClient').value='c1'; renderAdmin(); return document.getElementById('adminCount').textContent; });
  ok(c1rows === '0 records', 'client filter: Avi\'s current client has no punches (' + c1rows + ')');
  // CSV columns
  const csv = await p.evaluate(async () => { let txt=''; const orig=URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t=>txt=t); return 'blob:x'; }; HTMLAnchorElement.prototype.click = function(){}; await exportPunchCSV(); await new Promise(r=>setTimeout(r,300)); URL.createObjectURL=orig; return txt; });
  const lines = csv.split('\n').map(l => l.split('","').length);
  ok(lines.length === 5 && lines.every(n => n === lines[0]) && lines[0] === 10, 'CSV: every row has the 10 header columns');
  ok(/"8","n-p\d"/.test(csv), 'CSV: GPS Accuracy is filled (8) and Notes follow it');
  // payable by supplier
  await p.evaluate(() => switchTab('accounting'));
  await p.evaluate(async () => { const sel=document.getElementById('salaryPeriod'); sel.value='all'; await onSalaryPeriodChange(); });
  await sleep(500);
  const pay = await p.evaluate(() => { setAccTab('billing'); const t = document.getElementById('supplierPayableWrap').innerText; setAccTab('salary'); return t; });
  ok(!/No supplier assigned/.test(pay), 'Payable by supplier: no row for workers without a supplier');
  const bill = await p.evaluate(() => ({shown: document.getElementById('accSecBillable').style.display !== 'none', rows: document.querySelectorAll('#clientBillableWrap .t3-line').length}));
  ok(!bill.shown && bill.rows === 0, 'Billable by client: hidden when no client has a billing rate ' + JSON.stringify(bill));
  ok(/Agency\s+8\.0h\s+₪40/.test(pay), 'Agency row: 8h × default commission 5 = ₪40');
  // Daily pay: Dana (1 day, 4h, own rate 40) paid by the day; then 5 days set by hand.
  // The days are set by hand in the pay window (period 'all' picked in Salary).
  const dp = await p.evaluate(() => {
    const dana = () => __lastSalaryEntries.find(e => e.workerId === 'w2'), w2 = workers.find(w => w.id === 'w2');
    const sum = () => buildSalaryExportRows('all').filter(r => r.worker === 'Dana Levi').reduce((s, r) => s + r.pay, 0);
    const out = {hourly: dana().total, hourlyExport: sum()};
    w2.payMode = 'daily'; renderSalary(); out.daily = dana().total; out.dailyExport = sum(); out.days = dana().countedDays;
    openPayModal('w2'); out.daysField = getComputedStyle(document.getElementById('payDaysRow')).display !== 'none' && document.getElementById('payDays').placeholder === '1';
    document.getElementById('payDays').value = '5'; savePayModal('w2'); out.over = dana().total; out.overExport = sum();
    const row = [...document.querySelectorAll('#dashSalary .salary-rows .sal-row')].find(r => r.textContent.includes('Dana Levi'));
    out.cellInput = out.daysField && !!row && !row.querySelector('input') && /punches: 1/.test(row.textContent); out.aviDays = __lastSalaryEntries.find(e => e.workerId === 'w1').countedDays;
    delete w2.dayOverrides; delete w2.payMode; renderSalary(); out.back = dana().total;
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
    const addBtn = [...document.querySelectorAll('#hoursImportModal button')].find(b => /Add shift/.test(b.textContent));
    addBtn.click(); addBtn.click(); addBtn.click();
    r.dates = [...document.querySelectorAll('#hoursManualRows input[type=date]')].map(i => i.value);
    r.btnOn = !document.getElementById('hoursImportSubmitBtn').disabled;
    const before = await pend();
    click('#hoursImportSubmitBtn');
    for(let i = 0; i < 40 && await pend() === before; i++) await new Promise(res => setTimeout(res, 150));
    r.sentDaily = (await pend()) - before;
    // The first send is done only when its reply cleared the rows; reopening sooner lets that reply clear the next row.
    for(let i = 0; i < 40 && __hoursManualRows.length; i++) await new Promise(res => setTimeout(res, 100));
    closeModal('hoursImportOverlay');
    delete workers.find(w => w.id === 'w2').payMode;
    openHoursImportModal('w2');
    [...document.querySelectorAll('#hoursImportModal button')].find(b => /Add shift/.test(b.textContent)).click();
    const before2 = await pend();
    const toasts = []; const orig = window.showToast; window.showToast = (m) => { toasts.push(m); };
    click('#hoursImportSubmitBtn');
    for(let i = 0; i < 40 && !toasts.length; i++) await new Promise(res => setTimeout(res, 100));
    await new Promise(res => setTimeout(res, 300));
    window.showToast = orig;
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
    exportSalary('accountant', 'all'); XLSX.writeFile = orig;
    if(!wb) return {none: true};
    const sum = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1});
    const avi = sum.find(r => r[0] === 'Avi Cohen') || [], tot = sum.find(r => r[0] === 'Total') || [];
    const e = salaryEntriesFor('all').byWorker.w1;
    return {name, sheets: wb.SheetNames, pay: avi[10], want: Math.round(e.total * 100) / 100, hours: avi[9], days: avi[5], total: tot[12],
      shifts: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], {header: 1}).length};
  });
  ok(!acc.none && /^accountant-all-/.test(acc.name) && acc.sheets.length === 2 && acc.pay === acc.want && acc.pay > 0 && acc.hours > 0 && acc.days >= 1 && acc.total >= acc.pay && acc.shifts > 1,
    'accountant report: Summary = Salary figures, total row, Shifts sheet ' + JSON.stringify(acc));
  // Workers search: by ID / passport number (dashes ignored) and by client.
  const srch = await p.evaluate(async () => {
    const avi = workers.find(w => w.id === 'w1'), keep = avi.docId; avi.docId = '12345678-2';
    switchTab('workers'); setWorkersView('list');
    const find = q => { document.getElementById('workersSearch').value = q; renderWorkersPage(); return ' ' + document.getElementById('workersTitleCount').textContent; };
    const out = {id: find('123456782'), client: find('site a'), none: find('99999')};
    find(''); if(keep === undefined) delete avi.docId; else avi.docId = keep;
    return out;
  });
  ok(/ 1$/.test(srch.id) && / 1$/.test(srch.client) && / 0$/.test(srch.none), 'workers search: by ID / passport number and by client ' + JSON.stringify(srch));
  // "NEW" for 3 days after a worker is added: on the worker cards, not on an older worker.
  const nw = await p.evaluate(async () => {
    const a = workers.find(w => w.id === 'w1'), d = workers.find(w => w.id === 'w2');
    const keep = [a.createdAt, d.createdAt];
    a.createdAt = new Date(Date.now() - 2 * 864e5).toISOString(); d.createdAt = new Date(Date.now() - 4 * 864e5).toISOString();
    switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); await new Promise(r => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('#workersCards .wplate')].map(c => ({name: c.querySelector('.wp-n').title, isNew: !!c.querySelector('.new-badge')}));
    a.createdAt = keep[0]; d.createdAt = keep[1];
    return cards;
  });
  ok(nw.some(c => /Avi/.test(c.name) && c.isNew) && nw.some(c => /Dana/.test(c.name) && !c.isNew), 'worker cards: NEW for 3 days after the worker was added ' + JSON.stringify(nw));
  // The worker plate (redesign stage 3): notice chips → the notices sheet → the worker card with Info / Docs / Hours; Delete → Undo → deleted after 5 s; Select → a bulk status.
  const wp = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const w1 = workers.find(w => w.id === 'w1'), keep = {failed: w1.docUploadFailed, status: w1.status};
    w1.docUploadFailed = true;
    // A clean start: an earlier step's window (the worker form opened from a card) can still be on its way back
    // (__returnTo brings the card back ~60 ms after it closes) and would open the card under this step.
    for (let i = 0; i < 5 && document.querySelector('.overlay.open'); i++) {
      document.querySelectorAll('.overlay').forEach(o => { o.__returnTo = null; o.classList.remove('open'); });
      await wait(300);
    }
    switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); await wait(200);
    const plate = document.querySelector('#workersCards .wplate[data-wid="w1"]'), r = {};
    r.chip = plate.querySelector('.wp-chip1 .nchip') && plate.querySelector('.wp-chip1 .nchip').className; r.more = !!plate.querySelector('.n b .nchip.more'); r.bar = plate.style.getPropertyValue('--c');
    plate.querySelector('.wp-chip1 .nchip').click(); await wait(150);
    r.sheet = document.getElementById('noticesOverlay').classList.contains('open'); r.notices = [...document.querySelectorAll('#noticesModal .t3-line b')].map(b => b.textContent);
    r.head = document.querySelector('#noticesModal .wc-hn h4').textContent; r.card0 = document.getElementById('workerCardOverlay').classList.contains('open');
    [...document.querySelectorAll('#noticesModal .modal-actions .gbtn')].find(b => /Open worker card/.test(b.textContent)).click(); await wait(300);
    r.card = document.getElementById('workerCardOverlay').classList.contains('open') && !document.getElementById('noticesOverlay').classList.contains('open');
    const panes = () => [...document.querySelectorAll('#workerCardModal .wc-pane')].filter(x => !x.hidden).map(x => x.dataset.p).join();
    r.panes = [panes()]; workerCardPane('docs'); r.panes.push(panes()); workerCardPane('hours'); r.panes.push(panes());
    r.hoursStatus = !!document.querySelector('#workerCardModal .wc-pane[data-p="hours"] #cardHoursStatus');
    r.edit = !!document.getElementById('workerCardEdit'); workerCardPane('info');
    // closing the card brings the notices sheet back; on a slow runner that takes longer than a fixed 200 ms, so up to 3 s
    closeModal('workerCardOverlay');
    for (let i = 0; i < 20 && !document.getElementById('noticesOverlay').classList.contains('open'); i++) await wait(150);
    r.backToNotices = document.getElementById('noticesOverlay').classList.contains('open'); closeModal('noticesOverlay'); w1.docUploadFailed = keep.failed;
    // Delete: Undo keeps the worker; a second Delete removes it only after 5 s.
    workers.push({id:'wtmp', name:'Temp Worker Del', colorIdx:1, clientIds:[], schedule:[]}); renderWorkersPage(); await wait(100);
    const tmp = () => document.querySelector('#workersCards .wplate[data-wid="wtmp"]');
    tmp().querySelector('.t3-kb').click(); await wait(50);
    r.menu = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.innerText.trim()).join();
    document.querySelector('#ogPop .og-pop-it.del').click(); await wait(400);
    r.pendingHidden = !tmp() || !!tmp().closest('.sw.gone'); r.stillThere = workers.some(w => w.id === 'wtmp');
    document.querySelector('#undoSnack .og-snack-u').click(); await wait(400);
    r.undone = !!tmp() && !tmp().closest('.sw.gone') && workers.some(w => w.id === 'wtmp');
    tmp().querySelector('.t3-kb').click(); await wait(50); document.querySelector('#ogPop .og-pop-it.del').click(); await wait(300);
    renderWorkersPage(); r.leftOut = !tmp(); r.notYet = workers.some(w => w.id === 'wtmp');
    await wait(5400); r.deleted = !workers.some(w => w.id === 'wtmp');
    // Select: a Select button above the plates and no boxes; after it "0 selected · Select all · Done", a tick → Vacation.
    renderWorkersPage(); await wait(50);
    const wh = document.querySelector('#workersCards').previousElementSibling || {};
    r.selHead = wh.className === 'sel-head' && !!wh.querySelector('[data-h="on"]') && !/selected/.test(wh.textContent) && !document.querySelector('.sel-bar');
    wh.querySelector('[data-h="on"]').click(); await wait(50);
    r.selOn = /0 selected/.test(wh.textContent) && !!wh.querySelector('[data-h="all"]') && !!wh.querySelector('[data-h="off"]');
    document.querySelector('#workersCards .wplate[data-wid="w1"] .t3-cb').click();
    r.sel = document.querySelector('.sel-bar b').textContent;
    [...document.querySelectorAll('.sel-bar .gbtn')].find(b => /Vacation/.test(b.textContent)).click(); await wait(100);
    r.vac = w1.status === 'vacation' && !document.querySelector('.sel-bar') && !!wh.querySelector('[data-h="on"]');
    w1.status = keep.status; render(); autoSave();
    return r;
  });
  ok(/red/.test(wp.chip) && wp.more && wp.bar === 'var(--bad)' && wp.sheet && wp.notices.includes('Upload failed') && wp.head === 'Avi Cohen' && wp.card && wp.backToNotices, 'worker plate: a red notice chip opens the notices sheet; "Open worker card" opens the card, closing it goes back to the sheet ' + JSON.stringify(wp));
  ok(wp.panes.join('|') === 'info|docs|hours' && wp.hoursStatus && wp.edit, 'worker card: Info / Docs / Hours switch, one Edit button ' + JSON.stringify(wp.panes));
  ok(wp.menu === 'Open card,Edit,Pay,Punch link,!Delete' && wp.pendingHidden && wp.stillThere && wp.undone && wp.leftOut && wp.notYet && wp.deleted, 'workers: Delete never asks — Undo keeps the worker, otherwise it is removed after 5 s ' + JSON.stringify(wp));
  ok(wp.selHead && wp.selOn && wp.sel === '1 selected' && wp.vac, 'workers: a Select button, boxes only after it; a tick, the bulk bar sets Vacation and Select ends ' + JSON.stringify({selHead: wp.selHead, selOn: wp.selOn, sel: wp.sel, vac: wp.vac}));
  // Worker documents (stage 13): plates with Select in the card's Docs pane; bulk Delete through Undo; closing the card gives Select back to the workers list.
  const wd = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const w = workers[0], keep = w.docs;
    w.docs = [{id:'d1', type:'contract', name:'contract.pdf', url:'#', uploadedAt:'2026-01-02'}, {id:'d2', type:'other', name:'visa.jpg', url:'#', uploadedAt:'2026-01-01'}];
    switchTab('workers'); await wait(100);
    openWorkerCard(0); await wait(300); workerCardPane('docs'); await wait(50);
    const rows = () => document.querySelector('#workerCardModal .worker-docs-rows');
    r.plates = rows().querySelectorAll('.t3-line .t3-cb').length;
    r.head = (rows().previousElementSibling || {}).className === 'sel-head' && !!rows().previousElementSibling.querySelector('[data-h="on"]');
    rows().previousElementSibling.querySelector('[data-h="on"]').click(); await wait(50);
    rows().previousElementSibling.querySelector('[data-h="all"]').click(); await wait(50);
    r.bar = (document.querySelector('.sel-bar b') || {}).textContent;
    document.querySelector('.sel-bar .gbtn.del').click(); await wait(400);
    r.pending = w.docs.length === 2 && /2 documents deleted/.test(document.querySelector('#undoSnack').textContent);
    document.querySelector('#undoSnack .og-snack-u').click(); await wait(400);
    r.undone = rows() && rows().querySelectorAll('.t3-line:not(.gone)').length === 2 && w.docs.length === 2;
    rows().querySelector('.t3-line .t3-kb').click(); await wait(50);
    r.menu = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.innerText.trim()).join();
    document.querySelector('#ogPop .og-pop-it.del').click(); await wait(5400);
    r.deleted = w.docs.map(d => d.id).join();
    closeModal('workerCardOverlay'); await wait(200);
    const wl = document.querySelector('#workersCards');
    r.back = !!wl && (wl.previousElementSibling || {}).className === 'sel-head' && __selState && __selState.key === 'workers';
    w.docs = keep; render();
    return r;
  });
  ok(wd.plates === 2 && wd.head && wd.bar === '2 selected' && wd.pending && wd.undone && wd.menu === 'Open,!Delete' && wd.deleted === 'd2' && wd.back, 'worker documents: plates with Select, bulk Delete through Undo, ⋮ Delete after 5 s, Select back to the workers list on close ' + JSON.stringify(wd));
  // Editors as section plates (redesign stage 4): worker, client, supplier, user.
  const ed = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const secs = id => [...document.querySelectorAll('#' + id + ' .og-sec')].filter(x => x.style.display !== 'none').map(x => x.dataset.sec + (x.classList.contains('open') ? '*' : ''));
    openEditWorker(workers.findIndex(w => w.id === 'w2')); await wait(200);
    r.worker = secs('workerModal');
    const person = document.querySelector('#workerModal .og-sec[data-sec="person"]');
    r.personSum = person.querySelector('.og-sec-s').textContent;
    r.sexSeg = [...document.querySelectorAll('#workerModal .seg-sel')].length >= 2 && document.getElementById('wMaritalStatus').style.display !== 'none' && document.getElementById('wSex').style.display === 'none';
    const segBtn = document.getElementById('wSex').nextElementSibling.querySelector('button[data-v="F"]'); segBtn.click(); r.sexVal = document.getElementById('wSex').value;
    const addrSec = document.querySelector('#workerModal .og-sec[data-sec="address"]'); addrSec.classList.remove('open');
    document.getElementById('wCity').focus(); r.focusOpens = addrSec.classList.contains('open');
    const notes = document.querySelector('#workerModal .og-sec[data-sec="access"]'), wasOpen = notes.classList.contains('open');
    notes.querySelector('.og-sec-h').click(); r.toggles = notes.classList.contains('open') !== wasOpen;
    r.noSave = !document.querySelector('#workerModal .og-save');
    workers.find(w => w.id === 'w2').docSex = workers.find(w => w.id === 'w2').docSex; closeModal('workerOverlay');
    openEditClient(clients[0].id); await wait(100); r.client = secs('clientModal'); closeModal('clientOverlay');
    openAddSupplier(); await wait(100); r.supplier = secs('supplierModal'); r.supSave = !!document.querySelector('#supplierModal .og-save');
    r.supNameAmber = getComputedStyle(document.querySelector('#supplierModal .og-sec[data-sec="supplier"]')).getPropertyValue('--c').trim(); closeModal('supplierOverlay');
    openEditSupplier(suppliers[0].id); await wait(100); r.supplierEdit = secs('supplierModal').map(x => x.replace('*', '')).join(); closeModal('supplierOverlay'); await wait(150);
    openCreateUserForm(); await wait(100); const role = document.getElementById('userFormRole'); role.value = 'hr'; role.dispatchEvent(new Event('change')); await wait(50);
    r.userHr = secs('userFormOverlay').map(x => x.replace('*', '')).join(); r.roleSeg = !!document.querySelector('#userFormOverlay .seg-sel button.on[data-v="hr"]');
    role.value = 'staff'; role.dispatchEvent(new Event('change')); closeModal('userFormOverlay'); await wait(150);
    openCreateUserForm(); await wait(100); r.user = secs('userFormOverlay'); closeModal('userFormOverlay');
    // closing one window brings back the one it was opened over: close them all
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    return r;
  });
  ok(ed.worker.join() === 'person,address,work,documents,form101,access' && /Dana/.test(ed.personSum) && ed.sexSeg && ed.sexVal === 'F' && ed.focusOpens && ed.toggles && ed.noSave,
    'editors: the worker editor is section plates (Person · Address · Work · Documents · Form 101 · Access), summaries, segmented choices, a focused field opens its section, no Save ' + JSON.stringify(ed));
  ok(ed.client.join() === 'client,place,rates,approval' && ed.supplier.join() === 'supplier*' && ed.supSave && /f5a623|--warn/.test(ed.supNameAmber) && ed.user[0] === 'person*' && ed.user.map(x => x.replace('*', '')).join() === 'person,sections' && ed.supplierEdit === 'supplier,commission,portal,workers' && ed.userHr === 'person,sections,hours,commission' && ed.roleSeg,
    'editors: client, supplier (one Save, an empty name amber) and user form as section plates ' + JSON.stringify(ed));
  // Redesign gaps: client billing by the day; the supplier editor's payable commission and editable portal ticks (saved at once).
  const gp = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    r.daily = [clientBillPay(5, {rateMode:'daily', dailyBillRate:300}), clientBillPay(0, {rateMode:'daily', dailyBillRate:300}), clientBillPay(11, {rateMode:'daily', dailyBillRate:300}, true)].join();
    openEditClient(clients[0].id); await wait(100);
    document.querySelector('#cPayUnit button[data-unit="day"]').click();
    r.dayRow = document.getElementById('cDailyRow').style.display !== 'none' && document.getElementById('cHourlyBill').style.display === 'none';
    document.querySelector('#cPayUnit button:not([data-unit="day"])').click();
    r.hourBack = document.getElementById('cDailyRow').style.display === 'none'; closeModal('clientOverlay'); await wait(150);
    openEditSupplier('s-1'); await wait(150);
    const m = document.getElementById('supplierModal');
    r.payable = /commission/.test(m.querySelector('.og-sec[data-sec="commission"]').textContent);
    r.newLogin = !!m.querySelector('.og-sec[data-sec="portal"] button[onclick^="newLoginFor"]');
    const cb = m.querySelector('input[data-field="supplierSections"][value="dashboard"]');
    r.tick = !!cb && !cb.disabled;
    if(cb){ const was = cb.checked; cb.checked = !was; await saveLoginTicks(cb);
      const u = loadAdminCache('users_' + activeTenantIdForAdmin()).find(x => x.username === 'sup1');
      r.saved = (u.supplierSections || []).includes('dashboard') === !was;
      cb.checked = was; await saveLoginTicks(cb); }
    for(let i = 0; i < 3; i++){ await wait(150); document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open')); }
    return r;
  });
  ok(gp.daily === '300,0,300' && gp.dayRow && gp.hourBack, 'clients: billing by the day — one day rate per worked shift, the By day / By hour switch ' + JSON.stringify(gp));
  ok(gp.payable && gp.newLogin && gp.tick && gp.saved, 'supplier editor: commission payable this month, New portal login, portal tabs ticked and saved at once ' + JSON.stringify(gp));
  // Stage 13: the supplier's own commission rate, set in the supplier window by the owner (per hour / per day, applies from).
  const scom = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    const SP = () => suppliers.find(x => x.id === 's-1'), keep = SP().commission;
    const mine = Object.values(salaryEntriesFor('month').byWorker).filter(e => (workers.find(w => w.id === e.workerId) || {}).supplierId === 's-1');
    const hours = mine.reduce((t, e) => t + e.hours, 0), days = mine.reduce((t, e) => t + e.dayKeys.size, 0);
    r.def = Math.round(supplierMonthPayable(SP())) === Math.round(hours * 5);
    openEditSupplier('s-1'); await wait(150);
    r.fields = !!document.getElementById('sComRate') && !!document.getElementById('sComFrom') && !!document.getElementById('sComMode');
    document.getElementById('sComRate').value = '10'; document.getElementById('sComFrom').value = localYMD(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    saveSupplier(); await wait(200);
    r.saved = JSON.stringify(SP().commission);
    r.hour = Math.round(supplierMonthPayable(SP())) === Math.round(hours * 10);
    openEditSupplier('s-1'); await wait(150);
    document.querySelector('#sComMode button[data-m="day"]').click(); document.getElementById('sComRate').value = '50'; document.getElementById('sComFrom').value = localYMD(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    saveSupplier(); await wait(200);
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
    r.field = document.getElementById('firmEditWaField').style.display !== 'none' && /full name/.test(document.getElementById('firmEditWa').value);
    const ta = document.getElementById('firmEditWa'); ta.value = 'Hello {first name}, shift at {start} · {site}'; await saveFirmWaTemplate();
    closeModal('editFirmOverlay'); await wait(200);
    __firmMsgs = null; await loadFirmMessages(true);
    r.saved = __firmMsgs.waTemplate;
    const n = notifList().find(x => x.id.includes('nopunch:w2:'));
    r.bellActs = n ? n.acts.map(a => a.label).join() : 'none';
    openNotices('w2'); await wait(200);
    const btn = document.querySelector('#noticesModal .gbtn.nact.wa');
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
    switchTab('workers'); setWorkersView('cards'); renderWorkersPage();
    const tabs = () => [...document.querySelectorAll('#workersTabs button')], r = {tabs: tabs().map(b => b.textContent).join(), count: document.getElementById('workersTitleCount').textContent};
    tabs()[1].click(); r.vac = document.getElementById('workersFilterStatus').value === 'vacation' && tabs()[1].classList.contains('on');
    tabs()[1].click(); r.cleared = document.getElementById('workersFilterStatus').value === '';
    tabs()[2].click(); r.pending = document.getElementById('workersFilterDocs').value === 'incomplete'; tabs()[2].click();
    r.scan = /Scan passport/.test((document.getElementById('workersScanBtn') || {}).textContent || '') && document.getElementById('workersScanBtn').classList.contains('gbtn') && !document.getElementById('workersHeadMenu');
    return r;
  });
  ok(wh.tabs === 'Active,Vacation,Pending' && /^\d+$/.test(wh.count) && wh.vac && wh.cleared && wh.pending && wh.scan, 'workers: header count, New and a glass Scan passport next to it (no ⋮), tabs Active / Vacation / Pending set the filters ' + JSON.stringify(wh));
  // Accounting (redesign stage 7): the period in glass, figures, Salary / Billing / Approvals tabs, salary plates.
  const ac = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), vis = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    switchTab('accounting'); await wait(200);
    const sel0 = document.getElementById('salaryPeriod'); sel0.value = 'week'; await onSalaryPeriodChange();
    const sel = document.getElementById('salaryPeriod'), r = {inNav: !!document.querySelector('#accPeriodNav #salaryPeriod'), figs: [...document.querySelectorAll('#accFigs > div span')].map(x => x.textContent).join()};
    r.tabs = [...document.querySelectorAll('#accTabs button')].map(b => b.dataset.k).join();
    r.salaryTab = vis('accSecSalary') && !vis('accSecPayable') && !vis('accSecPending');
    setAccTab('billing'); await wait(100); r.billingTab = !vis('accSecSalary') && vis('accSecPayable');
    setAccTab('approvals'); await wait(100); r.approvalsTab = !vis('accSecSalary') && vis('accSecPending') && !vis('accSecAlerts');
    // Alerts (stage 13): the accounting-only warnings in three sections, a count on the tab, a tap opens the fix place.
    const w2 = workers.find(w => w.id === 'w1'), keepBank = [w2.bank, w2.bankBranch, w2.bankAccountNumber];
    w2.bank = w2.bankBranch = w2.bankAccountNumber = ''; renderSalary();
    setAccTab('alerts'); await wait(100);
    r.alertsTab = !vis('accSecSalary') && vis('accSecAlerts');
    r.secs = [...document.querySelectorAll('#accAlertsWrap .t3-sec')].map(x => x.firstChild.textContent.trim()).join();
    r.tabN = (document.querySelector('#accTabs button[data-k="alerts"] .tab-n') || {}).textContent === String(__accAlerts.length) && __accAlerts.length > 0;
    const bankLine = [...document.querySelectorAll('#accAlertsWrap .t3-line')].find(l => /No bank details/.test(l.textContent) && /Avi/.test(l.textContent));
    if(bankLine){ bankLine.click(); await wait(200); r.opensPay = document.getElementById('payOverlay').classList.contains('open'); closeModal('payOverlay'); await wait(200); }
    r.noBanner = !/to review before calculating/.test(document.getElementById('dashSalary').innerText);
    // Select on the Salary rows (after the Select button): a tick exports only that worker.
    setAccTab('salary'); await wait(100);
    const srow = document.querySelector('#dashSalary .sal-row[data-sel-id]');
    r.salSelect = !!document.querySelector('#dashSalary .sel-head') && !!srow && !!srow.querySelector('.t3-cb');
    if(srow){ (__selState.head.querySelector('[data-h="on"]') || {click(){}}).click(); srow.querySelector('.t3-cb').click(); r.salBar = /1 selected/.test((document.querySelector('.sel-bar b') || {}).textContent || '') && !document.getElementById('payOverlay').classList.contains('open');
      r.salRows = buildSalaryExportRows(document.getElementById('salaryPeriod').value, [srow.dataset.selId]).every(x => x.worker === (workers.find(w => w.id === srow.dataset.selId) || {}).name);
      const xb = [...document.querySelectorAll('.sel-bar .gbtn')].find(b => b.dataset.a === 'x'); if(xb) xb.click(); }
    [w2.bank, w2.bankBranch, w2.bankAccountNumber] = keepBank;
    setAccTab('salary'); await wait(100);
    const i0 = sel.selectedIndex; document.querySelector('#accPeriodNav .gbtn').click(); await wait(300); r.stepped = sel.selectedIndex === i0 + 1;
    document.querySelectorAll('#accPeriodNav .gbtn')[1].click(); await wait(300); r.back = sel.selectedIndex === i0;
    return r;
  });
  ok(ac.inNav && ac.figs === 'Hours,Payroll,To approve' && ac.tabs === 'salary,billing,approvals,alerts' && ac.salaryTab && ac.billingTab && ac.approvalsTab && ac.alertsTab && /Rates and pay/.test(ac.secs) && ac.tabN && ac.opensPay && ac.noBanner && ac.salSelect && ac.salBar && ac.salRows && ac.stepped && ac.back, 'accounting: glass period ‹ ›, figures, Salary / Billing / Approvals / Alerts tabs show their sections; Alerts in sections with a count, a tap opens the pay window ' + JSON.stringify(ac));
  // Worker photos are gone (owner 2026-10-13): an old avatarB64 is dropped after a load and never saved again.
  const ph = await p.evaluate(() => { const w = workers[0]; w.avatarB64 = 'AAAA'; const r = {dropped: dropWorkerPhotos(), gone: !('avatarB64' in w), again: dropWorkerPhotos()}; return r; });
  ok(ph.dropped && ph.gone && !ph.again, 'workers: an old photo is dropped from the record (dropWorkerPhotos) ' + JSON.stringify(ph));
  // Greeting and notifications (redesign stage 5): the greeting by time of day; the bell, its panel, "Mark all read" kept on the account.
  const nt = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    switchTab('dashboard'); await wait(100);
    const g = document.querySelector('#ogGreet h3'); r.greet = g ? g.textContent : ''; r.icon = !!(g && g.querySelector('svg.gic'));
    const w2 = workers.find(w => w.id === 'w2'), keep = w2.docExpiry; w2.docExpiry = '01/01/2020'; render(); await wait(50);
    const count = () => { const c = document.getElementById('bellCount'); return c.style.display === 'none' ? 0 : Number(c.textContent); };
    r.bell = getComputedStyle(document.getElementById('bellBtn')).display !== 'none'; r.before = count();
    document.getElementById('bellBtn').click(); await wait(100);
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
  ok(await waitFor(p, () => { const g = document.querySelector('#ogGreet h3'); return !!g && /14°/.test(g.textContent) && !!g.querySelector('svg.gic .drop'); }), 'today: the greeting shows the weather at the firm\'s main site — the rain icon and 14°');
  ok(nt.bell && nt.before >= 1 && nt.item && nt.after === 0 && nt.noNew && nt.kept === 0 && nt.opens, 'notifications: the bell counts, the panel lists the expired ID as new, Mark all read is kept on the account, a tap opens the worker\'s notices ' + JSON.stringify(nt));
  // Worker card: a click only reads; a double click, a long touch or its ✎ opens the edit form;
  // closing it (a tap outside saves it) brings the card back.
  const cardSpot = '#workerCardModal .wc-kv >> nth=0';
  await p.evaluate(() => openWorkerCard(1)); await sleep(400);
  await p.click(cardSpot, {position:{x:5, y:5}}); await sleep(500);
  const bk0 = await p.evaluate(() => !document.getElementById('workerOverlay').classList.contains('open') && document.getElementById('workerCardOverlay').classList.contains('open'));
  const lp = await p.evaluate(async () => {
    const el = document.querySelector('#workerCardModal .wc-kv');
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
  await p.evaluate(() => { document.getElementById('wNotes').value = 'back-to-card'; });
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
  // A drag on the scan crop editor (and the avatar crop) moves the photo, never the sheet.
  const crop = await p.evaluate(async () => {
    await ensureScanPipelineLoaded();
    const png = document.createElement('canvas'); png.width = 300; png.height = 200; png.getContext('2d').fillRect(0, 0, 300, 200);
    document.getElementById('aiScanOverlay').classList.add('open');
    renderScanQuadEditor(png.toDataURL('image/png').split(',')[1], 'image/png', {tl:{x:.1,y:.1}, tr:{x:.9,y:.1}, br:{x:.9,y:.9}, bl:{x:.1,y:.9}});
    await new Promise(r => setTimeout(r, 1500));
    const m = document.querySelector('#aiScanOverlay > .modal'), wrap = document.getElementById('scanEditWrap'), r = wrap.getBoundingClientRect(), x = r.left + 60, y = r.top + 30;
    const t = (type, dy) => { const tp = new Touch({identifier: 1, target: wrap, clientX: x, clientY: y + dy}); wrap.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [tp], changedTouches: [tp]})); };
    let moved = false;
    t('touchstart', 0); for (let d = 10; d <= 200; d += 20){ t('touchmove', d); if(m.style.transform) moved = true; } t('touchend', 200);
    await new Promise(r => setTimeout(r, 400));
    const res = {noSwipe: wrap.classList.contains('no-swipe'), moved, open: document.getElementById('aiScanOverlay').classList.contains('open'), touch: getComputedStyle(wrap).touchAction,
      avatar: document.getElementById('avatarCropBox').classList.contains('no-swipe')};
    document.getElementById('aiScanOverlay').classList.remove('open'); document.getElementById('aiScanStage').innerHTML = '';
    return res;
  });
  ok(crop.noSwipe && !crop.moved && crop.open && crop.touch === 'none' && crop.avatar, 'phone: a drag on the scan crop editor does not move or close the sheet ' + JSON.stringify(crop));
  await p.setViewportSize({width: 1280, height: 900}); await sleep(300);
  // Any window opened from the worker card goes back to it: Pay → tap outside → the card again.
  await p.evaluate(() => openWorkerCard(1)); await sleep(300);
  await p.evaluate(() => { document.querySelector('#workerCardModal .wc-more').click(); [...document.querySelectorAll('#ogPop .og-pop-it')].find(b => /Pay/.test(b.textContent)).click(); }); await sleep(400);
  const pay1 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  await p.mouse.click(5, 450); await sleep(600);
  const pay2 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  ok(pay1.pay && !pay1.card && !pay2.pay && pay2.card, 'back: closing Pay opened from the worker card shows the card again ' + JSON.stringify({pay1, pay2}));
  await p.mouse.click(5, 450); await sleep(400);
  // A client card: a single click opens its editor (no card to read first).
  await p.evaluate(() => switchTab('clients')); await sleep(400);
  await p.click('#clientsGrid .t3-line .wp-n >> nth=0'); await sleep(500);
  const cl1 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open'));
  await p.evaluate(() => closeModal('clientOverlay')); await sleep(200);
  await p.dblclick('#clientsGrid .t3-line .wp-n >> nth=0'); await sleep(500);
  const cl2 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open'));
  ok(cl1 && cl2, 'clients: a single click or a double click opens the editor ' + JSON.stringify({cl1, cl2}));
  await p.evaluate(() => closeModal('clientOverlay')); await sleep(200);
  // Clients and suppliers as plates (redesign stage 8): ⋮ (Edit, Manual punch, Delete), Delete → Undo, Select; supplier plates.
  const cpl = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), r = {};
    clients.push({id:'ctmp', name:'Temp Client', color:'#60a5fa'}); switchTab('clients'); renderClientsPage(); await wait(50);
    const line = () => document.querySelector('#clientsGrid .t3-line[data-cid="ctmp"]');
    r.noRate = /No rate/.test(line().textContent); r.count = document.getElementById('clientsTitleCount').textContent;
    line().querySelector('.t3-kb').click(); await wait(50);
    r.menu = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.textContent.trim()).join();
    document.querySelector('#ogPop .og-pop-it.del').click(); await wait(300);
    r.pending = clients.some(c => c.id === 'ctmp'); document.querySelector('#undoSnack .og-snack-u').click(); await wait(300);
    r.undone = !!line() && clients.some(c => c.id === 'ctmp');
    (__selState.head.querySelector('[data-h="on"]') || {click(){}}).click(); line().querySelector('.t3-cb').click(); r.sel = document.querySelector('.sel-bar b').textContent;
    [...document.querySelectorAll('.sel-bar .gbtn')].find(b => b.dataset.a === 'del').click(); await wait(5500);
    r.deleted = !clients.some(c => c.id === 'ctmp');
    switchTab('suppliers'); renderSuppliersPage(); await wait(50);
    const sp = document.querySelector('#suppliersGrid .t3-line'); r.supplier = !!sp && !!sp.querySelector('.r') && !!sp.querySelector('.t3-kb') && !!sp.closest('.sw');
    switchTab('clients');
    return r;
  });
  ok(cpl.noRate && /^\d+$/.test(cpl.count) && cpl.menu === 'Edit,Manual punch,!Delete' && cpl.pending && cpl.undone && cpl.sel === '1 selected' && cpl.deleted && cpl.supplier, 'clients / suppliers: plates with notices, ⋮, Delete → Undo, Select → Delete after 5 s; supplier plates ' + JSON.stringify(cpl));
  // The client window has no Save button: a tap outside saves it; an empty new client is not created.
  const cs = await p.evaluate(async () => {
    const tap = () => { const ov = document.getElementById('clientOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click(); };
    const keep = JSON.parse(JSON.stringify(clients.find(c => c.id === 'c1')));
    openEditClient('c1');
    const noSave = ![...document.querySelectorAll('#clientModal button')].some(b => /שמירה|הוספת לקוח/.test(b.textContent));
    // Stage 5a: the window is laid out left to right (no dir="rtl" inside) and its note goes through tr().
    const ltr = {noRtl: !document.querySelector('#clientModal [dir="rtl"]'), note: /Changes are saved when the window closes/.test(document.getElementById('clientModal').innerText)};
    document.getElementById('cBillMain').value = '130'; onClientBillMainInput('130'); document.getElementById('cDefRate').value = '52'; updateClientMargin();
    // The rates block: the margin per hour, the mode buttons (by law shows OT / Shabbat inline).
    const rates = {margin: document.getElementById('cBillMargin').innerText.replace(/\s+/g, ' '), extra: getComputedStyle(document.getElementById('cBillExtra')).display !== 'none'};
    setClientRateMode('fixed'); rates.fixedHidesExtra = getComputedStyle(document.getElementById('cBillExtra')).display === 'none'; setClientRateMode('tiered');
    tap();
    await new Promise(r => setTimeout(r, 300));
    const c = clients.find(x => x.id === 'c1'), out = {rates, ltr, noSave, closed: !document.getElementById('clientOverlay').classList.contains('open'), d: c.defaultHourlyRate, b: c.billRate};
    const n = clients.length; openAddClient(); tap(); await new Promise(r => setTimeout(r, 300)); out.noNew = clients.length === n;
    // "Manual punch" from the client window: saves it, opens the punch; closing the punch brings the client back.
    out.noPunchOnCard = !document.querySelector('#clientsGrid .t3-line button[onclick*="openManualPunch"]');
    openEditClient('c1'); punchFromClientModal(); await new Promise(r => setTimeout(r, 100));
    out.punch = document.getElementById('manualPunchOverlay').classList.contains('open') && !document.getElementById('clientOverlay').classList.contains('open');
    closeModal('manualPunchOverlay'); await new Promise(r => setTimeout(r, 200));
    out.back = document.getElementById('clientOverlay').classList.contains('open'); closeModal('clientOverlay');
    Object.assign(c, keep); delete c.defaultOtRate; delete c.defaultShabbatRate; await gsSave(getDataObj());
    return out;
  });
  ok(cs.ltr.noRtl && cs.ltr.note, 'clients: the client window is left to right and its note is English through tr() ' + JSON.stringify(cs.ltr));
  ok(/₪78.*60%/.test(cs.rates.margin) && cs.rates.extra && cs.rates.fixedHidesExtra, 'clients: the rates block shows the margin per hour; fixed mode hides OT / Shabbat ' + JSON.stringify(cs.rates));
  // Editors per mockup 04: the client head's ⋮ (Manual punch, Delete) and the small map; the user editor's head; glass fields.
  const ed4 = await p.evaluate(() => {
    openEditClient('c1');
    const head = document.querySelector('#clientModal .og-edh button.gbtn.icon'), map = !!document.getElementById('cMapMini');
    const fieldRadius = getComputedStyle(document.getElementById('cName')).borderTopLeftRadius;
    head.click(); const items = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => b.textContent.trim()); closePopover(); closeModal('clientOverlay');
    openCreateUserForm(); document.getElementById('userFormFullName').value = 'Rina Mizrahi'; drawUserFormHead();
    const user = {title: document.getElementById('userFormTitle').textContent, av: document.getElementById('userFormAv').textContent};
    closeModal('userFormOverlay');
    return {items, map, fieldRadius, user};
  });
  ok(ed4.items.length === 2 && ed4.map && ed4.fieldRadius === '12px' && ed4.user.title === 'Rina Mizrahi' && ed4.user.av === 'RM', 'editors: the client head ⋮ (Manual punch, Delete), the small map, glass fields, the user editor head ' + JSON.stringify(ed4));
  ok(cs.noSave && cs.closed && cs.d === 52 && cs.b === 130 && cs.noNew && cs.noPunchOnCard && cs.punch && cs.back, 'clients: no Save button, a tap outside saves; an empty new client is not created; manual punch from the window and back ' + JSON.stringify(cs));
  await p.mouse.click(5, 450); await sleep(400);
  ok(external.filter(u=>/script\.google\.com/.test(u)).length === 0, 'no request to script.google.com');
  ok(p.errs.length === 0, 'owner: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── Super-admin: cross-firm summary uses each firm's own clients ──
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'boss', 'boss-pass-1');
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => document.getElementById('firmsScreen').style.display === 'block' && __firmsCache.length === 2), 'boss: firms list (listTenants)');
  // The firms list: ✎ and a bare ⋮ (Disable, Delete last via Undo); Select; a single click switches (below).
  const fl = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const row = document.querySelector('#firmsList .row.tap-edit');
    const out = {pencil: !!row.querySelector('.ti-pencil'), x: !!row.querySelector('.t3-x'), pause: !!row.querySelector('.ti-player-pause, .ti-player-play'), box: !!row.querySelector('.t3-cb'), head: !!document.querySelector('#firmsList').previousElementSibling && document.querySelector('#firmsList').previousElementSibling.className === 'sel-head'};
    row.querySelector('.ti-pencil').parentElement.click(); await wait(200);
    out.edit = document.getElementById('editFirmOverlay').classList.contains('open'); closeModal('editFirmOverlay'); await wait(200);
    row.querySelector('.t3-kb').click(); await wait(50);
    out.menu = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.textContent.trim()).join();
    let calls = 0; const f = window.fetch; window.fetch = (u, o) => { if(o && /deleteTenant/.test(o.body)) calls++; return f(u, o); };
    document.querySelector('#ogPop .og-pop-it.del').click(); await wait(300);
    out.snack = document.getElementById('undoSnack').classList.contains('open') && !!row.closest('.gone, .sw.gone') || row.classList.contains('gone');
    document.querySelector('#undoSnack .og-snack-u').click(); await wait(400);
    out.kept = calls === 0 && __firmsCache.length === 2 && !!document.querySelector('#firmsList .row.tap-edit');
    window.fetch = f;
    return out;
  });
  ok(fl.pencil && !fl.x && !fl.pause && fl.box && fl.head && fl.edit && fl.menu === 'Disable,!Delete' && fl.snack && fl.kept, 'firms: ✎ edits, ⋮ holds Disable and Delete (Undo, no confirm), Select always on ' + JSON.stringify(fl));
  await p.evaluate(() => switchToTenant('tenant-one'));
  await p.waitForNavigation().catch(()=>{});
  ok(await waitFor(p, () => workers.length === 2), 'boss: viewing Firm One');
  await p.evaluate(() => { switchTab('admin'); switchAdminPane('firms'); toggleSuperadminAccounting(); });
  ok(await waitFor(p, () => /Firm Two/.test(document.getElementById('superadminAccountingWrap').innerText) && !/Loading/.test(document.getElementById('superadminAccountingWrap').innerText)), 'boss: summary rendered');
  const sum = await p.evaluate(() => document.getElementById('superadminAccountingWrap').innerText);
  ok(/Firm Two\s+2\.0h\s+₪200/.test(sum), 'summary: Firm Two pays 2h × its own client rate 100 = ₪200');
  ok(await p.evaluate(() => clients.length === 2 && clients[0].id === 'c1'), 'summary: the loaded firm\'s clients are back');
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
    await waitFor(p, () => document.querySelectorAll('#adminErrorsList .errors-rows > .t3-line').length >= 10);
    await sleep(1500);
    const er = await p.evaluate(() => [document.querySelectorAll('#adminErrorsList .errors-rows > .t3-line').length, !!document.querySelector('#adminErrorsList .errors-rows > .paged-more')]);
    await p.evaluate(() => switchAdminPane('timings'));
    await waitFor(p, () => document.querySelectorAll('#timingsLatestList > .t3-line').length >= 10);
    await sleep(1500);
    const tm = await p.evaluate(() => [document.querySelectorAll('#timingsLatestList > .t3-line').length, !!document.querySelector('#timingsLatestList > .paged-more')]);
    await p.screenshot({path: SP + '/shot_timings_' + w + '.png'});
    console.log('LISTS', w, 'errors', JSON.stringify(er), 'timings', JSON.stringify(tm));
    ok(er[0] === 10 && er[1] && tm[0] === 10 && tm[1], `admin lists: exactly 10 rows at first at ${w}px (errors ${er[0]}, timings ${tm[0]})`);
  }
  // Period picker: a past month has none of today's rows; Copy all takes only the period
  const per = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    switchAdminPane('timings'); await wait(800);
    const sel = document.getElementById('adminTimingsPeriod');
    const opts = [...sel.options].map(o => o.value);
    const cur = __timingsRows.length;
    sel.value = opts[3]; await loadTimingsPane();   // last month
    const past = __timingsRows.length, text = document.getElementById('adminTimingsWrap').innerText;
    sel.value = '30d'; await loadTimingsPane();
    switchAdminPane('errors'); await wait(800);
    const esel = document.getElementById('adminErrorsPeriod');
    esel.value = opts[3]; await loadErrorsList('adminErrorsList');
    const epast = (__errorsRowsByTarget.adminErrorsList || []).length;
    esel.value = '30d'; await loadErrorsList('adminErrorsList');
    return {opts: opts.length, first: opts.slice(0, 3), cur, past, text: text.slice(0, 80), epast, enow: (__errorsRowsByTarget.adminErrorsList || []).length, cards: document.querySelectorAll('#timingsCards > .t3-line').length};
  });
  console.log('PERIOD', JSON.stringify(per));
  ok(per.opts === 14 && per.cur >= 20 && per.past === 0 && per.epast === 0 && per.enow >= 40, 'errors/timings: period picker loads one period at a time');
  // Reset (Timings / Errors): every error and measurement is deleted, the panes show none.
  const rst = await p.evaluate(async () => {
    switchAdminPane('timings'); await new Promise(r => setTimeout(r, 800));
    const btn = !!document.getElementById('adminResetLogsBtn');
    await resetLogs(); await new Promise(r => setTimeout(r, 800));
    const t = await (await fetch(API_URL + '?action=loadTimings' + gsAuthQuery())).json();
    const e = await (await fetch(API_URL + '?action=loadErrors' + gsAuthQuery())).json();
    return {btn, timings: (t.rows || []).length, errors: (e.rows || []).length, shown: __timingsRows.length};
  });
  ok(rst.btn && rst.timings === 0 && rst.errors === 0 && rst.shown === 0, 'timings: Reset deletes every error and measurement ' + JSON.stringify(rst));
  ok(p.errs.length === 0, 'boss: no page errors ' + p.errs.join(' | '));
  await ctx.close();

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
  await p.reload(); await waitFor(p, supReady, 15000); await tabTo('My Workers');
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
  // the page is redrawn in the new language: wait for its tabs to be back before reading them
  await waitFor(p, () => ([...document.querySelectorAll('[data-testid="shell-tabs"] button')].map(b => b.innerText.trim())[2] || '') === 'השעות שלי', 5000);
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
  const cp = await p.evaluate(() => ({text: document.body.innerText, workers: [...document.querySelectorAll('[data-slot="section"] .og-label > span:first-child')].map(b => b.textContent),
    old: typeof Payroll !== 'undefined' || typeof hoursReviewMount !== 'undefined' || typeof __hrv !== 'undefined', mark: !!document.querySelector('header [data-testid="brand-mark"]'),
    sub: (document.querySelector('[data-testid="brand-sub"]') || {}).textContent || '', plate: !!document.querySelector('[data-day-key] .og-plate')}));
  const avi = await p.evaluate(() => [...document.querySelectorAll('[data-day-key]')].map(d => d.dataset.dayKey).find(k => k.startsWith('w1|')));
  const acts = await menuOf(avi); await p.keyboard.press('Escape'); await sleep(150);
  ok(cp.workers.includes('Avi Cohen') && acts.join() === 'Approve this day,Dispute this day,Propose a fix' && hoursReplies.length >= 1 && !/₪|Agency|hourlyRate|billRate|gpsAccuracy|"dist"|tok-|supplier|docUrl|0501/i.test(cp.text + hoursReplies.join('')),
    'client: only hours of its workers, per-day approve / dispute / fix under ⋮ — no money, supplier, GPS, files or tokens ' + JSON.stringify({workers: cp.workers, acts, replies: hoursReplies.length}));
  ok(!cp.old && cp.mark && /Site B/.test(cp.sub) && cp.plate, 'client portal: a React page (no old globals), the brand with its client in the title bar, days as plates ' + JSON.stringify({old: cp.old, mark: cp.mark, sub: cp.sub, plate: cp.plate}));
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
  const appr = async () => q.evaluate(async () => { switchTab('accounting'); const sel = document.getElementById('salaryPeriod'); sel.value = 'month'; await onSalaryPeriodChange();
    await renderHourApprovals('month'); setAccTab('approvals'); const t = document.getElementById('hourApprovalsWrap').innerText; setAccTab('salary'); return t; });
  const oa = await appr();
  ok(/Site B/.test(oa) && /Client/.test(oa) && /1 of \d days approved/.test(oa) && !/Changed after approval/.test(oa), 'owner: the client\'s approval in Accounting, not "changed" ' + JSON.stringify(oa));
  // The client disputes the day (the window sends on a tap outside); the owner sees the comment.
  await menuOf(avi); await pick('Dispute this day');
  await p.waitForSelector('[data-testid="dispute-text"]');
  const dWin = await p.evaluate(() => ({kind: document.querySelector('[data-testid="window"]').dataset.kind, save: [...document.querySelectorAll('[data-testid="window"] button')].map(b => b.innerText.trim()).filter(Boolean)}));
  await p.fill('[data-testid="dispute-text"]', 'Left at 15:00');
  await tapOutside();
  const cd = {st: await waitState(avi, 'disputed'), text: await p.evaluate(() => document.querySelector('[data-testid="hours-review"]').innerText), win: dWin};
  ok(cd.st === 'disputed' && /Left at 15:00/.test(cd.text) && dWin.kind === 'dialog' && !dWin.save.length, 'client: disputes a day with a comment — a window with no buttons, sent on a tap outside ' + JSON.stringify({st: cd.st, win: dWin}));
  const od = await appr();
  ok(/Disputed/.test(od) && /Left at 15:00/.test(od) && /Avi Cohen/.test(od), 'owner: sees the disputed day and its comment ' + JSON.stringify(od));
  // The client proposes a fix (a tap on the day opens it); the owner accepts it — the shift's punches move to the new times.
  await p.click(dayOf(avi) + ' .og-plate b');
  await p.waitForSelector('[data-testid="fix-in"]');
  await p.fill('[data-testid="fix-in"]', '05:30'); await p.fill('[data-testid="fix-out"]', '13:30'); await p.fill('[data-testid="fix-text"]', 'Came early');
  await tapOutside();
  const cf = await waitState(avi, 'fix');
  ok(cf === 'fix', 'client: proposes a fix for a day ' + cf);
  const of = await appr();
  ok(/Fix proposed/.test(of) && /05:30–13:30/.test(of) && /Accept/.test(of), 'owner: sees the proposed fix with Accept / Reject ' + JSON.stringify(of));
  await (await q.$('#accSecApprovals')).screenshot({path: SP + '/hours-approvals-owner.png'}).catch(()=>{});
  const fxa = await q.evaluate(async () => {
    const docs = await hourApprovalsOf(salaryMonthOf('month')), doc = docs.find(d => d.kind === 'client');
    const key = Object.keys(doc.days).find(k => doc.days[k].status === 'fix');
    await resolveHourFix(doc.id, key, true);
    // The proposed times are Israel time (as the punch page writes them).
    const il = e => e && new Date(e.ts).toLocaleTimeString('en-GB', {timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit'});
    for(let i = 0; i < 60 && il(getPunchLog().find(e => e.id === 'p1')) !== '05:30'; i++) await new Promise(r => setTimeout(r, 150));
    const p1 = getPunchLog().find(e => e.id === 'p1'), p2 = getPunchLog().find(e => e.id === 'p2');
    return {in: il(p1), out: il(p2), after: (await hourApprovalsOf(salaryMonthOf('month'))).find(d => d.kind === 'client').days[key].status};
  });
  ok(fxa.in === '05:30' && fxa.out === '13:30' && fxa.after === 'fixed', 'owner: accepting a fix moves the shift\'s punches ' + JSON.stringify(fxa));
  await p.reload(); await waitFor(p, hrvReady, 15000);
  const cfx = await stateOf(avi);
  ok(cfx === 'fixed', 'client: the accepted fix shows as done ' + cfx);
  // Admin → Users: the owner is pinned first; the client login shows its client and hours ticks.
  const ul = await q.evaluate(async () => { switchTab('admin'); switchAdminPane('users');
    for(let i = 0; i < 60 && document.querySelectorAll('.admin-users-rows > div').length < 2; i++) await new Promise(r => setTimeout(r, 150));
    return [...document.querySelectorAll('.admin-users-rows > div')].map(r => r.innerText.replace(/\s+/g, ' ')); });
  ok(ul.length >= 2 && /\bowner\b/.test(ul[0]) && ul.some(t => /\bclient\b/.test(t) && /Site B/.test(t) && /Approve/.test(t) && /Fix/.test(t)), 'users: the owner pinned first; a client login shows its client and hours ticks ' + JSON.stringify(ul.slice(0, 3)));
  // Lists (redesign stage 2): a plate per user, the ⋮ popover (Delete last, red, under a divider), Delete collapses the line behind the Undo snack and Undo brings it back; Select mode.
  const ls = await q.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const target = [...document.querySelectorAll('.admin-users-rows > .sw')].find(s => /\bclient\b/.test(s.innerText)), line = target.querySelector('.t3-line');
    const cs = getComputedStyle(line), r = {plate: /inset/.test(cs.boxShadow) && cs.borderRadius === '16px', swipe: target.querySelectorAll('.sw-acts button').length};
    line.querySelector('.t3-kb').click(); await wait(50);
    r.pop = [...document.querySelectorAll('#ogPop .og-pop-it')].map(b => (b.classList.contains('del') ? '!' : '') + b.innerText.trim()).join(); r.hr = !!document.querySelector('#ogPop .og-pop-hr');
    document.querySelector('#ogPop .og-pop-it.del').click(); await wait(400);
    r.gone = target.classList.contains('gone'); r.snack = document.getElementById('undoSnack').classList.contains('open') && /deleted/.test(document.getElementById('undoSnack').innerText);
    document.querySelector('#undoSnack .og-snack-u').click(); await wait(400);
    r.back = !target.classList.contains('gone') && !document.getElementById('undoSnack').classList.contains('open');
    const boxes = [...document.querySelectorAll('.admin-users-rows .t3-line')].map(l => !!l.querySelector('.t3-cb'));
    r.n = boxes.length; r.ownerNoBox = boxes[0] === false && boxes.slice(1).every(Boolean);
    const line2 = [...document.querySelectorAll('.admin-users-rows .t3-line')].find(l => /\bclient\b/.test(l.innerText));
    r.kbShown = getComputedStyle(line2.querySelector('.t3-kb')).opacity === '1';
    document.querySelector('.sel-head [data-h="on"]').click(); document.querySelector('.sel-head [data-h="all"]').click();
    r.all = document.querySelector('.sel-bar b').innerText.trim(); r.picked = document.querySelectorAll('.admin-users-rows .t3-line.picked').length;
    line2.querySelector('.t3-cb').click(); r.unpicked = !line2.classList.contains('picked') && !document.getElementById('userFormOverlay').classList.contains('open');
    [...document.querySelectorAll('.sel-bar .gbtn')].find(b => b.dataset.a === 'x').click();
    r.ended = !document.querySelector('.sel-bar') && !!document.querySelector('.sel-head') && !!document.querySelector('.sel-head [data-h="on"]') && !document.querySelector('.admin-users-rows .t3-line.picked');
    return r;
  });
  ok(ls.plate && ls.swipe === 2 && ls.pop === 'Edit,!Delete' && ls.hr && ls.gone && ls.snack && ls.back, 'lists: a plate per user; ⋮ opens Edit / Delete; Delete collapses it behind the Undo snack, Undo brings it back ' + JSON.stringify(ls));
  ok(ls.ownerNoBox && ls.kbShown && ls.picked === ls.n - 1 && ls.all === (ls.n - 1) + ' selected' && ls.unpicked && ls.ended, 'lists: Select — boxes (none for the owner), ⋮ stays, Select all, a box tick, ✕ clears the ticks ' + JSON.stringify(ls));
  // The user form: one Hours block for HR / supplier / client; "Only own workers" at the bottom, locked on for a supplier and a client.
  const uf = await q.evaluate(() => {
    openCreateUserForm(); const role = document.getElementById('userFormRole'), out = {};
    for(const r of ['staff', 'hr', 'supplier', 'client']){
      role.value = r; role.dispatchEvent(new Event('change'));
      const own = document.getElementById('userFormOwnOnly');
      out[r] = {hours: document.getElementById('userFormHourPermsField').style.display !== 'none', own: document.getElementById('userFormHrFields').style.display !== 'none',
        locked: own.disabled && own.checked, ticks: [...document.querySelectorAll('.userFormHourPermCb:checked')].map(c => c.value).join(','),
        secs: document.getElementById('userFormSupSectionsField').style.display !== 'none' ? [...document.querySelectorAll('.userFormSupSecCb:checked')].map(c => c.value).join(',') : null};
    }
    closeModal('userFormOverlay'); return out;
  });
  ok(!uf.staff.hours && !uf.staff.own && uf.hr.hours && uf.hr.own && !uf.hr.locked && uf.supplier.hours && uf.supplier.locked && uf.client.hours && uf.client.locked && uf.client.ticks === 'hours,approve,dispute,fix' && uf.supplier.secs === 'dashboard,workers,hours' && uf.client.secs === null,
    'user form: one Hours block for HR / supplier / client, own-only locked for supplier and client ' + JSON.stringify(uf));
  await q.evaluate(() => { openCreateUserForm(); const r = document.getElementById('userFormRole'); r.value = 'supplier'; r.dispatchEvent(new Event('change')); });
  await (await q.$('#userFormOverlay .modal')).screenshot({path: SP + '/user-form-supplier.png'}).catch(()=>{});
  await q.evaluate(() => closeModal('userFormOverlay'));
  // A kept login opens the portal at once: the login screen never shows on a reload.
  await p.reload({waitUntil: 'domcontentloaded'});
  ok(await waitFor(p, () => /client-portal/.test(location.pathname) && !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000), 'client: a reload with a kept login stays in the portal');
  // The language: the Language button switches the portal to Hebrew in place — the month stays loaded (no new load).
  // The reload's own hours reply can still land after data-ready (its body is read asynchronously), so the count is
  // taken once it has stayed the same for 1 s (at most 5 s), not straight away.
  for (let n = -1, still = 0, end = Date.now() + 5000; still < 1000 && Date.now() < end; ) {
    if (hoursReplies.length === n) still += 200; else { n = hoursReplies.length; still = 0; }
    await sleep(200);
  }
  const nLoads = hoursReplies.length;
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("עברית")');
  const cl = {he: await waitFor(p, () => document.documentElement.lang === 'he' && localStorage.getItem('uiLang') === 'he' && /פורטל/.test(document.querySelector('header').innerText), 10000)};
  cl.days = await p.evaluate(() => document.querySelectorAll('[data-day-key]').length); cl.loads = hoursReplies.length - nLoads;
  cl.ltr = await p.evaluate(() => getComputedStyle(document.body).direction);
  await p.click('header [data-testid="lang-btn"]'); await p.click('[data-testid="lang-list"] .lang-li:has-text("English")');
  cl.en = await waitFor(p, () => document.documentElement.lang === 'en' && /Client Portal/.test(document.querySelector('header').innerText), 10000);
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
  ok(menu.lang && /client1/.test(menu.text) && /Client/.test(menu.text) && /Sign out/.test(menu.text), 'client portal: the account menu holds the name and Sign out, the Language button beside it ' + JSON.stringify(menu));
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
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && document.getElementById('loginScreen').style.display !== 'none' && !localStorage.getItem('clientPortal_session'), 15000), 'client portal: Sign out opens the one login page');
  // The portals have no login of their own: opened without a session they send to the one login page.
  await p.goto(BASE + 'supplier-portal.html');
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname), 10000), 'portals: no session → the manager app\'s login page');
  await ctx.close();
  // A client login on the main site goes to its portal.
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'client1', 'client-pass-1');
  ok(await waitFor(p, () => /client-portal/.test(location.pathname) && !!document.querySelector('[data-testid="hours-review"][data-ready="1"]'), 15000), 'client: a client login on the main site is taken to its portal');
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
  const mgr = {list: await waitFor(mp5, () => document.querySelectorAll('#schedRequests .shift-req').length === 2, 15000)};
  mgr.text = await mp5.evaluate(() => document.getElementById('schedRequests').innerText.replace(/\s+/g, ' '));
  await mp5.click('#schedRequests .sr-ok');
  mgr.toast = await waitFor(mp5, () => /Shift handed over/.test(document.body.innerText), 8000);
  mgr.saved = await waitFor(mp5, () => !document.querySelector('#schedRequests .sr-ok'), 8000);
  await sleep(2500);  // autoSave's debounce
  st5 = await srv('/swapState');
  mgr.status = (st5.requests['s_w1_' + rqKey] || {}).status;
  mgr.avi = JSON.stringify((st5.dateShifts.w1 || {})[rqKey]); mgr.dana = JSON.stringify((st5.dateShifts.w2 || {})[rqKey]);
  ok(mgr.list && /Avi Cohen → Dana Levi/.test(mgr.text) && /Can't work/.test(mgr.text) && mgr.toast && mgr.status === 'confirmed'
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
