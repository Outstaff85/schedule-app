const { chromium } = require('playwright');
const fs = require('fs');
// Screenshots go to E2E_OUT (default: tests/e2e/out, git-ignored).
const SP = process.env.E2E_OUT || (__dirname + '/out');
fs.mkdirSync(SP, {recursive: true});
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
const BUNDLE = fs.readFileSync(__dirname + '/build/firebase-all.js', 'utf8');
const BASE = 'http://127.0.0.1:8765/';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
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
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|client|ai_read)$/) || [])[1];
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
  const idle = await p.evaluate(() => { switchTab('admin'); return {none: document.getElementById('adminPane_none').style.display !== 'none', rows: document.querySelectorAll('#adminTableBody > tr').length, log: document.getElementById('adminPane_punchlog').style.display}; });
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
    const row = [...document.querySelectorAll('#dashSalary .salary-rows tr')].find(r => r.textContent.includes(w.name));
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
    const r = {def: I18N_LANG, sel: document.querySelector('.titlebar-actions select.lang-select').value, firmField: !!document.getElementById('firmEditLanguage')};
    const setLang = async l => {
      const sel = document.querySelector('.titlebar-actions select.lang-select');
      sel.value = l; sel.dispatchEvent(new Event('change'));
      for(let i = 0; i < 40 && I18N_LANG !== l; i++) await new Promise(res => setTimeout(res, 150));
      switchTab('accounting'); await new Promise(res => setTimeout(res, 300));
      return {lang: I18N_LANG, tab: document.getElementById('tabAccounting').innerText.trim(),
        head: document.querySelector('#dashSalary th') && document.querySelector('#dashSalary th').innerText.trim(),
        sec: document.querySelector('#accSecSalary span[data-i18n]').textContent.trim(),
        period: document.getElementById('salaryPeriod').options[0].text,
        stored: localStorage.getItem('uiLang'), selects: [...document.querySelectorAll('select.lang-select')].every(x => x.value === l)};
    };
    r.he = await setLang('he');
    r.ru = await setLang('ru');
    r.en = await setLang('en');
    return r;
  });
  ok(lg.he.lang === 'he' && lg.he.tab === 'חשבונות' && lg.he.head === 'עובד' && lg.he.sec === 'חישוב שכר' && lg.he.period === 'השבוע' && lg.he.stored === 'he' && lg.he.selects && lg.def === 'en' && lg.sel === 'en' && !lg.firmField, 'language: English by default; the header select switches to Hebrew sees Accounting in Hebrew ' + JSON.stringify(lg.he));
  ok(lg.ru.lang === 'ru' && lg.ru.tab === 'Accounting' && lg.ru.head === 'Worker', 'language: Russian with an empty dictionary shows English ' + JSON.stringify(lg.ru));
  ok(lg.en.lang === 'en' && lg.en.tab === 'Accounting' && lg.en.sec === 'Salary Calculation' && lg.en.period === 'This Week', 'language: back to English ' + JSON.stringify(lg.en));
  // One select per page; the user's last choice follows them to a new device.
  await p.evaluate(() => setLanguage('he')); await sleep(1500);
  {
    const c2 = await newCtx(); const p2 = await page(c2);
    await p2.goto(BASE + 'schedule-manager.html'); await p2.waitForSelector('#loginScreen', {state:'visible'});
    const onLogin = await p2.evaluate(() => ({n: document.querySelectorAll('select.lang-select').length, inLogin: !!document.querySelector('#loginScreen #langSelect'), lang: I18N_LANG}));
    await p2.fill('#loginUsername', 'owner1'); await p2.fill('#loginPassword', 'owner-pass-1'); await p2.click('#loginBtn');
    await p2.waitForNavigation().catch(()=>{});
    const after = await waitFor(p2, () => I18N_LANG === 'he' && !!document.querySelector('.titlebar-actions #langSelect') && document.getElementById('langSelect').value === 'he' && document.querySelectorAll('select.lang-select').length === 1, 15000);
    ok(onLogin.n === 1 && onLogin.inLogin && onLogin.lang === 'en' && after, 'language: one select per page (login screen, then the title bar); the user\'s last choice comes back on a new device ' + JSON.stringify(onLogin));
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
        const sel = view === 'cards' ? '#workersCards > .wcard' : '#workersTableBody > tr:not(.paged-more)';
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
      const rows = document.querySelectorAll('#adminTableBody > tr:not(.paged-more)').length;
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
  const pay = await p.evaluate(() => document.getElementById('supplierPayableWrap').innerText);
  ok(!/No supplier assigned/.test(pay), 'Payable by supplier: no row for workers without a supplier');
  const bill = await p.evaluate(() => ({shown: document.getElementById('accSecBillable').style.display !== 'none', rows: document.querySelectorAll('#clientBillableWrap tbody tr').length}));
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
    const row = [...document.querySelectorAll('#dashSalary .salary-rows tr')].find(r => r.textContent.includes('Dana Levi'));
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
    closeModal('hoursImportOverlay');
    delete workers.find(w => w.id === 'w2').payMode;
    openHoursImportModal('w2');
    [...document.querySelectorAll('#hoursImportModal button')].find(b => /Add shift/.test(b.textContent)).click();
    const before2 = await pend();
    const toasts = []; const orig = window.showToast; window.showToast = (m) => { toasts.push(m); };
    click('#hoursImportSubmitBtn');
    await new Promise(res => setTimeout(res, 800));
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
    const find = q => { document.getElementById('workersSearch').value = q; renderWorkersPage(); return document.getElementById('workersCount').textContent; };
    const out = {id: find('123456782'), client: find('site a'), none: find('99999')};
    find(''); if(keep === undefined) delete avi.docId; else avi.docId = keep;
    return out;
  });
  ok(/^1 /.test(srch.id) && /^1 /.test(srch.client) && /^0 /.test(srch.none), 'workers search: by ID / passport number and by client ' + JSON.stringify(srch));
  // "NEW" for 3 days after a worker is added: on the worker cards, not on an older worker.
  const nw = await p.evaluate(async () => {
    const a = workers.find(w => w.id === 'w1'), d = workers.find(w => w.id === 'w2');
    const keep = [a.createdAt, d.createdAt];
    a.createdAt = new Date(Date.now() - 2 * 864e5).toISOString(); d.createdAt = new Date(Date.now() - 4 * 864e5).toISOString();
    switchTab('workers'); setWorkersView('cards'); renderWorkersPage(); await new Promise(r => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('.wcard')].map(c => ({name: c.innerText.split('\n').find(x => /Avi|Dana/.test(x)) || '', isNew: !!c.querySelector('.new-badge')}));
    a.createdAt = keep[0]; d.createdAt = keep[1];
    return cards;
  });
  ok(nw.some(c => /Avi/.test(c.name) && c.isNew) && nw.some(c => /Dana/.test(c.name) && !c.isNew), 'worker cards: NEW for 3 days after the worker was added ' + JSON.stringify(nw));
  // Worker card: a plain click only reads; a double click (or a long touch) opens the edit form;
  // closing it (a tap outside saves it) brings the card back.
  const cardSpot = '#workerCardModal div[style*="flex-direction:column"] >> nth=0';
  await p.evaluate(() => openWorkerCard(1)); await sleep(400);
  await p.click(cardSpot, {position:{x:5, y:5}}); await sleep(400);
  const bk0 = await p.evaluate(() => !document.getElementById('workerOverlay').classList.contains('open') && document.getElementById('workerCardOverlay').classList.contains('open'));
  const lp = await p.evaluate(async () => {
    const el = document.querySelector('#workerCardModal div[style*="flex-direction:column"]');
    const r = el.getBoundingClientRect(), o = {bubbles:true, pointerType:'touch', clientX:r.left + 5, clientY:r.top + 5};
    el.dispatchEvent(new PointerEvent('pointerdown', o)); await new Promise(res => setTimeout(res, 250));
    el.dispatchEvent(new PointerEvent('pointerup', o)); await new Promise(res => setTimeout(res, 400));
    const shortTouch = document.getElementById('workerOverlay').classList.contains('open');
    el.dispatchEvent(new PointerEvent('pointerdown', o)); await new Promise(res => setTimeout(res, 700));
    const longTouch = document.getElementById('workerOverlay').classList.contains('open');
    el.dispatchEvent(new PointerEvent('pointerup', o));
    return {shortTouch, longTouch};
  });
  ok(bk0 && !lp.shortTouch && lp.longTouch, 'worker card: a click or short touch only reads, a long touch opens the edit form ' + JSON.stringify(lp));
  await p.mouse.click(5, 450); await sleep(1200);
  await p.evaluate(() => { closeModal('workerCardOverlay'); openWorkerCard(1); }); await sleep(400);
  await p.dblclick(cardSpot, {position:{x:5, y:5}}); await sleep(400);
  const bk1 = await p.evaluate(() => document.getElementById('workerOverlay').classList.contains('open'));
  await p.evaluate(() => { document.getElementById('wNotes').value = 'back-to-card'; });
  await p.mouse.click(5, 450); await sleep(1200);
  const bk = await p.evaluate(() => ({edit: document.getElementById('workerOverlay').classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open'), notes: workers[1].notes}));
  await p.mouse.click(5, 450); await sleep(300);
  ok(bk1 && !bk.edit && bk.card && bk.notes === 'back-to-card', 'worker card: a double click edits; the form saves on close and goes back to the card ' + JSON.stringify(bk));
  // Any window opened from the worker card goes back to it: Pay → tap outside → the card again.
  await p.evaluate(() => openWorkerCard(1)); await sleep(300);
  await p.evaluate(() => { [...document.querySelectorAll('#workerCardModal button')].find(b => /Pay/.test(b.textContent)).click(); }); await sleep(400);
  const pay1 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  await p.mouse.click(5, 450); await sleep(600);
  const pay2 = await p.evaluate(() => ({pay: document.getElementById('payOverlay')?.classList.contains('open'), card: document.getElementById('workerCardOverlay').classList.contains('open')}));
  ok(pay1.pay && !pay1.card && !pay2.pay && pay2.card, 'back: closing Pay opened from the worker card shows the card again ' + JSON.stringify({pay1, pay2}));
  await p.mouse.click(5, 450); await sleep(400);
  // A client card: a single click only hints, a double click opens its editor.
  await p.evaluate(() => switchTab('clients')); await sleep(400);
  await p.click('#clientsGrid .client-card .client-card-name >> nth=0'); await sleep(500);
  const cl1 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open'));
  await p.dblclick('#clientsGrid .client-card .client-card-name >> nth=0'); await sleep(400);
  const cl2 = await p.evaluate(() => document.getElementById('clientOverlay').classList.contains('open'));
  ok(!cl1 && cl2, 'clients: a single click does not edit, a double click does ' + JSON.stringify({cl1, cl2}));
  // The client window has no Save button: a tap outside saves it; an empty new client is not created.
  const cs = await p.evaluate(async () => {
    const tap = () => { const ov = document.getElementById('clientOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click(); };
    const keep = JSON.parse(JSON.stringify(clients.find(c => c.id === 'c1')));
    openEditClient('c1');
    const noSave = ![...document.querySelectorAll('#clientModal button')].some(b => /שמירה|הוספת לקוח/.test(b.textContent));
    document.getElementById('cBillMain').value = '130'; onClientBillMainInput('130'); document.getElementById('cDefRate').value = '52'; tap();
    await new Promise(r => setTimeout(r, 300));
    const c = clients.find(x => x.id === 'c1'), out = {noSave, closed: !document.getElementById('clientOverlay').classList.contains('open'), d: c.defaultHourlyRate, b: c.billRate};
    const n = clients.length; openAddClient(); tap(); await new Promise(r => setTimeout(r, 300)); out.noNew = clients.length === n;
    // "Manual punch" from the client window: saves it, opens the punch; closing the punch brings the client back.
    out.noPunchOnCard = !document.querySelector('#clientsGrid .client-card button[onclick*="openManualPunch"]');
    openEditClient('c1'); punchFromClientModal(); await new Promise(r => setTimeout(r, 100));
    out.punch = document.getElementById('manualPunchOverlay').classList.contains('open') && !document.getElementById('clientOverlay').classList.contains('open');
    closeModal('manualPunchOverlay'); await new Promise(r => setTimeout(r, 200));
    out.back = document.getElementById('clientOverlay').classList.contains('open'); closeModal('clientOverlay');
    Object.assign(c, keep); delete c.defaultOtRate; delete c.defaultShabbatRate; await gsSave(getDataObj());
    return out;
  });
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
  // The firms list: no pencil, a corner ✕; a double click edits; a single click switches (below).
  const fl = await p.evaluate(async () => {
    const row = document.querySelector('#firmsList .row.tap-edit');
    const out = {pencil: !!document.querySelector('#firmsList .ti-pencil'), del: !!(row && row.querySelector('.wcard-del')), trash: !!document.querySelector('#firmsList .ti-trash')};
    row.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 2})); await new Promise(r => setTimeout(r, 200));
    out.edit = document.getElementById('editFirmOverlay').classList.contains('open'); closeModal('editFirmOverlay');
    return out;
  });
  ok(!fl.pencil && fl.del && !fl.trash && fl.edit, 'firms: no pencil or trash, a corner ✕, a double click edits ' + JSON.stringify(fl));
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
    await waitFor(p, () => document.querySelectorAll('#adminErrorsList .errors-rows > .log-row').length >= 10);
    await sleep(1500);
    const er = await p.evaluate(() => [document.querySelectorAll('#adminErrorsList .errors-rows > .log-row').length, !!document.querySelector('#adminErrorsList .errors-rows > .paged-more')]);
    await p.evaluate(() => switchAdminPane('timings'));
    await waitFor(p, () => document.querySelectorAll('#timingsLatestList > .log-row').length >= 10);
    await sleep(1500);
    const tm = await p.evaluate(() => [document.querySelectorAll('#timingsLatestList > .log-row').length, !!document.querySelector('#timingsLatestList > .paged-more')]);
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
    return {opts: opts.length, first: opts.slice(0, 3), cur, past, text: text.slice(0, 80), epast, enow: (__errorsRowsByTarget.adminErrorsList || []).length, cards: document.querySelectorAll('.tm-card').length};
  });
  console.log('PERIOD', JSON.stringify(per));
  ok(per.opts === 14 && per.cur >= 20 && per.past === 0 && per.epast === 0 && per.enow >= 40, 'errors/timings: period picker loads one period at a time');
  ok(p.errs.length === 0, 'boss: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── A supplier signing in on the main site is taken to its portal ──
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'sup1', 'sup-pass-11');
  ok(await waitFor(p, () => /supplier-portal\.html/.test(location.href) && typeof myWorkers !== 'undefined' && myWorkers.length === 1, 15000), 'supplier: a login on the main site lands in the supplier portal, signed in');
  ok(await p.evaluate(() => !localStorage.getItem('schedMgr_session')), 'supplier: no manager-app session is left behind');
  await ctx.close();

  // ── Supplier portal ──
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'supplier-portal.html', 'sup1', 'sup-pass-11');
  ok(await waitFor(p, () => typeof myWorkers !== 'undefined' && myWorkers.length === 1), 'supplier: own worker only');
  ok(await p.evaluate(() => myWorkers[0].name === 'Avi Cohen' && !('token' in myWorkers[0]) && !('docUrl' in myWorkers[0]) && myWorkers[0].hourlyRate === 50 && showPay === true
    && !JSON.stringify(myClients).includes('billRate')), 'supplier: no token or file link; sees pay by default (own rate), never client billing');
  const sp = await p.evaluate(() => {
    switchTab('hours');
    const y = new Date(Date.now() - 864e5), sel = document.getElementById('hoursExportMonthSel');
    sel.value = y.getFullYear() + '-' + y.getMonth(); renderPayTable();
    return document.getElementById('payTable').innerText;
  });
  ok(/Avi Cohen\s+8\.0\s+1\s+₪50\/h\s+₪400\s+₪40/.test(sp), 'supplier pay: 8h × own rate 50 = ₪400, commission 8 × 5 = ₪40 ' + JSON.stringify(sp));
  const spd = await p.evaluate(() => {
    const w = myWorkers[0], keep = {...w};
    w.supplierDayRate = 90; w.payMode = 'daily';
    renderPayTable(); const t = document.getElementById('payTable').innerText;
    Object.keys(w).forEach(k => delete w[k]); Object.assign(w, keep); renderPayTable();
    return {t, mc: myCommission({supplierDayRate: 90, supplierRate: 5}, 8, 2), mh: myCommission({supplierDayRate: null, supplierRate: 5}, 8, 2)};
  });
  ok(/₪90\s*$/m.test(spd.t) && spd.mc === 180 && spd.mh === 40, 'supplier pay: a daily worker\'s commission is ₪/day × days ' + JSON.stringify(spd));
  const ts = await p.evaluate(async () => {
    const lazy = typeof XLSX === 'undefined'; await loadXlsx();
    const aoa = [['Worker', 'Date', 'In', 'Out'], ['Avi Cohen', '01/10/2026', '08:00', '16:30'], ['Someone Else', '01/10/2026', '09:00', '17:00'], ['avi cohen', '2026-10-02', '7:30', '15:00']];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'T');
    const file = new File([XLSX.write(wb, {type: 'array', bookType: 'xlsx'})], 'sheet.xlsx');
    sendHoursRows = []; renderSendHoursRows();
    await loadTimesheetFile({files: [file], value: ''});
    const rows = sendHoursRows.map(r => [r.date, r.inTime, r.outTime].join(' '));
    sendHoursRows = []; renderSendHoursRows();
    return lazy ? rows : ['xlsx loaded with the page'];
  });
  ok(ts.length === 2 && ts[0] === '2026-10-01 08:00 16:30' && ts[1] === '2026-10-02 07:30 15:00', 'supplier: an Excel timesheet fills the picked worker\'s shifts, other workers\' rows are left out ' + JSON.stringify(ts));
  const sh = await p.evaluate(async () => {
    addSendHoursRow(); sendHoursRows[0] = {date: '2026-10-02', inTime: '09:00', outTime: '13:00'};
    await submitSendHours();
    for(let i = 0; i < 40 && !/Sent for review/i.test(document.getElementById('sentHoursList').innerText); i++) await new Promise(res => setTimeout(res, 150));
    return document.getElementById('sentHoursList').innerText;
  });
  ok(/Avi Cohen · 1 shift\(s\): 02\/10\/2026/.test(sh) && /Sent for review/i.test(sh), 'supplier: hours sent for approval are listed as pending ' + JSON.stringify(sh));
  ok(await p.evaluate(async () => { const r = await supplierCall({action:'supplierUpdateWorker', workerId:'w1', worker:{phone:'0509'}}); await loadData(); return r.ok && myWorkers[0].phone === '0509'; }), 'supplier: update through the supplier function');
  // the firm's language reaches the portal with loadSchedule
  const sl = await p.evaluate(async () => { const def = I18N_LANG; const sel = document.querySelector('#appRoot select.lang-select');
    sel.value = 'he'; sel.dispatchEvent(new Event('change'));
    for(let i = 0; i < 40 && I18N_LANG !== 'he'; i++) await new Promise(res => setTimeout(res, 150));
    return {def, lang: I18N_LANG, tab: document.getElementById('tabBtn_hours').textContent.trim(), stored: localStorage.getItem('uiLang')}; });
  ok(sl.def === 'en' && sl.lang === 'he' && sl.tab === 'השעות שלי' && sl.stored === 'he', 'supplier: English by default; the header select switches the portal to Hebrew ' + JSON.stringify(sl));
  await p.reload();
  ok(await waitFor(p, () => I18N_LANG === 'he' && document.getElementById('tabBtn_dashboard').textContent.trim() === 'לוח בקרה', 15000), 'supplier: a reopened portal keeps the chosen language');
  await p.evaluate(() => setLanguage('en'));
  ok(p.errs.length === 0, 'supplier: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── Client portal (client1 → client c2: Avi's shift yesterday) ──
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'client-portal.html', 'client1', 'client-pass-1');
  ok(await waitFor(p, () => typeof __data !== 'undefined' && __data && __data.punches && document.querySelectorAll('#sectionHours .card').length >= 1, 15000), 'client: sees its workers\' shifts of the month');
  const cp = await p.evaluate(() => ({text: document.body.innerText, data: JSON.stringify(__data), cards: [...document.querySelectorAll('#sectionHours .card b')].map(b => b.textContent), status: document.querySelector('#sectionHours .status').className}));
  ok(cp.cards.includes('Avi Cohen') && /pending/.test(cp.status) && !/₪|Agency|hourlyRate|billRate|gpsAccuracy|"dist"|tok-|supplier|docUrl|0501/i.test(cp.text + cp.data),
    'client: only hours of its workers — no money, supplier, GPS, files or tokens ' + JSON.stringify({cards: cp.cards, status: cp.status}));
  const ca = await p.evaluate(async () => { await approveMonth(); return document.querySelector('#sectionHours .status').className; });
  ok(/approved/.test(ca), 'client: approves the month ' + ca);
  // The owner sees it in Accounting → Client approvals (This Month), not changed (the same shift lines).
  const octx = await newCtx(); const q = await page(octx);
  await login(q, BASE + 'schedule-manager.html', 'owner1', 'owner-pass-1');
  await q.waitForNavigation().catch(()=>{});
  await waitFor(q, () => typeof workers !== 'undefined' && workers.length === 2);
  const appr = async () => q.evaluate(async () => { switchTab('accounting'); const sel = document.getElementById('salaryPeriod'); sel.value = 'month'; await onSalaryPeriodChange();
    for(let i = 0; i < 40 && !/Site B/.test(document.getElementById('clientApprovalsWrap').innerText); i++) await new Promise(r => setTimeout(r, 150));
    await renderClientApprovals('month'); return document.getElementById('clientApprovalsWrap').innerText; });
  const oa = await appr();
  ok(/Site B/.test(oa) && /Approved/.test(oa) && /Site B manager/.test(oa) && !/Changed after approval/.test(oa), 'owner: the client\'s approval in Accounting, not "changed" ' + JSON.stringify(oa));
  // The client disputes a day (the window saves on a tap outside); the owner sees the comment.
  const cd = await p.evaluate(async () => {
    const sh = monthShifts()[0]; openDispute(sh.workerId, sh.day);
    document.getElementById('disputeText').value = 'Left at 15:00';
    const ov = document.getElementById('disputeOverlay'); ov.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); ov.click();
    for(let i = 0; i < 40 && !/disputed/.test(document.querySelector('#sectionHours .status').className); i++) await new Promise(r => setTimeout(r, 150));
    return {status: document.querySelector('#sectionHours .status').className, text: document.getElementById('sectionHours').innerText};
  });
  ok(/disputed/.test(cd.status) && /Left at 15:00/.test(cd.text), 'client: disputes a day with a comment ' + JSON.stringify(cd.status));
  const od = await appr();
  ok(/Disputed/.test(od) && /Left at 15:00/.test(od) && /Avi Cohen/.test(od), 'owner: sees the disputed day and its comment ' + JSON.stringify(od));
  // Admin → Users: the owner is pinned first; the client login shows its client and ticks.
  const ul = await q.evaluate(async () => { switchTab('admin'); switchAdminPane('users');
    for(let i = 0; i < 60 && document.querySelectorAll('.admin-users-rows > div').length < 2; i++) await new Promise(r => setTimeout(r, 150));
    return [...document.querySelectorAll('.admin-users-rows > div')].map(r => r.innerText.replace(/\s+/g, ' ')); });
  ok(ul.length >= 2 && /\(owner\)/.test(ul[0]) && ul.some(t => /\(client\)/.test(t) && /Site B/.test(t) && /Approve/.test(t)), 'users: the owner pinned first; a client login shows its client and ticks ' + JSON.stringify(ul.slice(0, 3)));
  // A kept login opens the portal at once: the login screen never shows on a reload.
  await p.reload({waitUntil: 'domcontentloaded'});
  const flash = await p.evaluate(() => getComputedStyle(document.getElementById('loginScreen')).display);
  ok(flash === 'none' && await waitFor(p, () => typeof __data !== 'undefined' && !!__data, 15000), 'client: a reload with a kept login shows no login screen ' + flash);
  ok(p.errs.length === 0 && q.errs.length === 0, 'client portal: no page errors ' + p.errs.concat(q.errs).join(' | '));
  await octx.close(); await ctx.close();
  // "Manager" in the portal header: ends the portal's sign-in and opens the manager app's login.
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'client-portal.html', 'client1', 'client-pass-1');
  await waitFor(p, () => typeof __data !== 'undefined' && !!__data, 15000);
  await p.evaluate(() => goToManager());
  ok(await waitFor(p, () => /schedule-manager/.test(location.pathname) && document.getElementById('loginScreen').style.display !== 'none' && !localStorage.getItem('clientPortal_session'), 15000), 'client portal: "Manager" goes back to the manager app\'s login');
  await ctx.close();
  // A client login on the main site goes to its portal.
  ctx = await newCtx(); p = await page(ctx);
  await login(p, BASE + 'schedule-manager.html', 'client1', 'client-pass-1');
  ok(await waitFor(p, () => /client-portal/.test(location.pathname) && typeof __data !== 'undefined' && !!__data, 15000), 'client: a client login on the main site is taken to its portal');
  await ctx.close();

  // ── Worker punch link ──
  ctx = await newCtx(); p = await page(ctx);
  const before = (await srv('/punches')).n;
  await p.goto(BASE + 'worker-punch.html?t=tok-avi');
  ok(await waitFor(p, () => !document.getElementById('screenPunch').classList.contains('hidden') && locOk === true, 15000), 'punch: link verified, on site');
  await p.click('#bigPunchBtn');
  ok(await waitFor(p, () => !document.getElementById('screenSuccess').classList.contains('hidden')), 'punch: success screen');
  await sleep(1500);
  const after = await srv('/punches');
  ok(after.n === before + 1, 'punch: saved through the punch function (' + before + ' → ' + after.n + ')');
  ok(!after.days.includes(null), 'punch: the new punch has a day');
  const ms = await p.evaluate(async () => { openSchedule(); await new Promise(r => setTimeout(r, 1500));
    return {shown: !document.getElementById('screenSchedule').classList.contains('hidden'), days: document.querySelectorAll('#scheduleContent .sched-cell').length, empty: /No shifts planned yet/.test(document.getElementById('scheduleContent').innerText), sched: JSON.stringify(selectedWorker.schedule), n: workers.length, keys: Object.keys(selectedWorker).sort().join(',')}; });
  ok(ms.shown && (ms.days >= 35 || ms.empty) && ms.n === 1 && ms.keys.includes('schedule'), 'punch: My Schedule shows the worker\'s own week ' + JSON.stringify(ms));
  await p.evaluate(() => closeHistory());
  // My Hours and Pay: yesterday's seeded 8h shift (hourly 50) from the punch function's myMonth, priced like Salary.
  const mh = await p.evaluate(async () => {
    const link = getComputedStyle(document.getElementById('myHoursLink')).display !== 'none';
    const y = new Date(); y.setDate(y.getDate() - 1);
    const now = new Date(), back = (y.getFullYear() - now.getFullYear()) * 12 + y.getMonth() - now.getMonth();
    openMyHours(); if(back) shiftHoursMonth(back);
    const key = hoursMonthKey();
    for(let i = 0; i < 50 && !_hoursData[key]; i++) await new Promise(r => setTimeout(r, 100));
    const d = _hoursData[key] || {}, f = d.punches ? myMonthFigures(d, key) : {};
    const sh = (f.shifts || []).find(s => s.h > 0) || {};
    const raw = JSON.stringify(d);
    return {link, hours: f.hours, total: f.total, sat: sh.date && sh.date.getDay() === 6, text: document.getElementById('hoursContent').innerText.slice(0, 120),
      leak: /gpsAccuracy|dist|billRate|tok-/.test(raw), pay: d.pay};
  });
  ok(mh.link && mh.hours === 8 && mh.total === (mh.sat ? 600 : 400) && !mh.leak && /8\.0h/.test(mh.text), "punch: My Hours and Pay — own shift, priced like Salary, no GPS or billing " + JSON.stringify(mh));
  await p.evaluate(() => closeHistory());
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('punchQueue')||'[]').length === 0), 'punch: nothing queued');
  await srv('/revoke');
  await p.goto(BASE + 'worker-punch.html?t=tok-avi');
  ok(await waitFor(p, () => /Invalid Link/.test(document.body.innerText)), 'punch: a regenerated link is revoked even from the cache');
  await p.goto(BASE + 'worker-punch.html?t=nope');
  ok(await waitFor(p, () => /Invalid Link/.test(document.body.innerText)), 'punch: unknown link refused');
  await p.evaluate(() => setLanguage('he'));
  await p.goto(BASE + 'worker-punch.html?t=tok-new');
  ok(await waitFor(p, () => I18N_LANG === 'he' && !document.getElementById('screenPunch').classList.contains('hidden') && /החתמת/.test(document.getElementById('bigPunchBtn').innerText) && /טוב/.test(document.getElementById('punchGreeting').textContent), 15000), 'punch: the page shows the chosen language (Hebrew)');
  await p.goto(BASE + 'worker-punch.html?t=nope');
  ok(await waitFor(p, () => /קישור לא תקין/.test(document.body.innerText)), 'punch: the chosen language is kept on the device');
  await p.goto(BASE + 'worker-punch.html?t=nope'); await p.evaluate(() => setLanguage('en'));
  ok(p.errs.length === 0, 'punch: no page errors ' + p.errs.join(' | '));
  ok(external.filter(u=>/script\.google\.com/.test(u)).length === 0, 'still no request to script.google.com');
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
