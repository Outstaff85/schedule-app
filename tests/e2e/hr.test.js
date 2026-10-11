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
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|hours|ai_read)$/) || [])[1];
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
    openCreateUserForm();
    const role = document.getElementById('userFormRole'); role.value = 'hr'; role.dispatchEvent(new Event('change'));
    const r = {hrFields: document.getElementById('userFormHrFields').style.display !== 'none',
      perms: [...document.querySelectorAll('.userFormPermCb:checked')].map(c => c.value).join(','),
      own: document.getElementById('userFormOwnOnly').checked};
    userFormUsername.value = 'hr1'; userFormPassword.value = 'hr-pass-111';
    userFormFullName.value = 'Rina HR'; userFormPhone.value = '0521112233';
    r.showPayTile = document.getElementById('userFormShowPayGrid').style.display !== 'none'; userFormCommission.value = '4';
    document.querySelector('.userFormPermCb[value="accounting"]').checked = true; // the reduced pay view
    ['hours', 'approve', 'dispute'].forEach(v => { document.querySelector('.userFormHourPermCb[value="' + v + '"]').checked = true; }); // hours review
    await submitUserForm();
    for(let i = 0; i < 40 && !document.getElementById('adminUsersWrap').innerText.includes('Rina HR'); i++) await new Promise(res => setTimeout(res, 150));
    r.listed = document.getElementById('adminUsersWrap').innerText;
    return r;
  });
  ok(made.hrFields && made.perms === 'workers' && made.own && !made.showPayTile, 'owner: HR form shows name/phone, Workers only, own-only on ' + JSON.stringify(made).slice(0, 120));
  ok(/Rina HR HR\nlogin: hr1 · 0521112233\n.*0 workers/.test(made.listed), 'owner: user row: name first, login and phone below, worker count ' + JSON.stringify(made.listed));
  const me = await p.evaluate(async () => {
    const before = document.getElementById('accountLabelCenter').innerText;
    window.prompt = () => 'Avi Owner';
    await editMyName();
    return {before, after: document.getElementById('accountLabelCenter').innerText, sess: getSession().fullName};
  });
  ok(/owner1/.test(me.before) && /Avi Owner/.test(me.after) && me.sess === 'Avi Owner', 'owner: header shows the login until a name is set, then the name ' + JSON.stringify(me));
  const asg = await p.evaluate(async () => {
    const hr = hrUsers()[0];
    await openEditUserForm(hr.id);
    const r = {cardWorkers: document.getElementById('userFormHrWorkersField').style.display !== 'none', roleLocked: userFormRole.disabled};
    openHrAssignModal();
    r.choices = document.querySelectorAll('#hrAssignList input[type=checkbox]').length;
    const box = [...document.querySelectorAll('#hrAssignList label')].find(l => /Dana/.test(l.textContent)).querySelector('input');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await submitHrAssign();
    r.hr = hr.id;
    r.dana = workers.find(w => w.id === 'w2').hrId;
    r.inCard = document.getElementById('userFormHrWorkers').innerText;
    await new Promise(res => setTimeout(res, 1500));
    const b = await loadFirestoreBackend();
    const ps = await b.punchesBetween(fsTenantId(), new Date(Date.now() - 30*864e5), new Date(Date.now() + 864e5));
    r.punchHr = ps.filter(x => x.workerId === 'w2').map(x => x.hrId);
    r.otherHr = ps.filter(x => x.workerId === 'w1').map(x => x.hrId || null);
    closeModal('userFormOverlay');
    // Worker modal: HR select; card: HR name
    openEditWorker(workers.findIndex(w => w.id === 'w2'));
    r.select = document.getElementById('wHrId') && document.getElementById('wHrId').value;
    closeModal('workerOverlay');
    openWorkerCard(workers.findIndex(w => w.id === 'w2'));
    r.cardLine = /HR: Rina HR/.test(document.getElementById('workerCardModal').innerText);
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
    await openEditUserForm(id);
    const r = {label: userFormPasswordLabel.textContent, shown: userFormPasswordField.style.display !== 'none', empty: userFormPassword.value === '',
      noKey: !document.querySelector('#adminUsersWrap .ti-key')};
    userFormPassword.value = 'short';
    await submitUserForm();
    r.shortErr = userFormError.textContent;
    userFormPassword.value = 'hr-pass-222';
    await submitUserForm();
    r.closed = !document.getElementById('userFormOverlay').classList.contains('open');
    return r;
  }, hrUid);
  ok(pw.shown && /New password/.test(pw.label) && pw.empty && pw.noKey && pw.shortErr && pw.closed, 'owner: password changed in the user form, no key button ' + JSON.stringify(pw));

  // ── HR session ──
  let hctx = await newCtx(); let h = await page(hctx);
  await login(h, BASE + 'schedule-manager.html', 'hr1', 'hr-pass-222');
  await h.waitForNavigation().catch(()=>{});
  ok(await waitFor(h, () => typeof workers !== 'undefined' && workers.length === 1), 'hr: loads only its own workers');
  ok(await h.evaluate(() => /Rina HR/.test(document.getElementById('accountLabelCenter').innerText) && !/hr1/.test(document.getElementById('accountLabelCenter').innerText)), 'hr: header shows its name, not the login');
  await waitFor(h, () => getPunchLog().length >= 2);
  const hv = await h.evaluate(() => {
    const vis = id => document.getElementById(id).style.display !== 'none';
    return {tab: currentTab, today: vis('tabDashboard'), admin: vis('tabAdmin'), workersTab: vis('tabWorkers'), sched: vis('tabSchedule'),
      acc: vis('tabAccounting'), name: workers[0].name, punches: getPunchLog().map(e => e.workerId)};
  });
  ok(hv.tab === 'workers' && !hv.today && !hv.admin && hv.workersTab && !hv.sched && hv.acc, 'hr: the Workers tab and, with Accounting ticked, its pay view; lands on Workers ' + JSON.stringify(hv));
  const pv = await h.evaluate(async () => {
    switchTab('accounting'); const sel = document.getElementById('salaryPeriod'); sel.value = 'all'; await onSalaryPeriodChange();
    const vis = id => document.getElementById(id).style.display !== 'none';
    const txt = document.getElementById('dashSalary').innerText;
    return {rows: __lastSalaryEntries.map(e => e.workerId), com: /My commission/.test(txt), rates: vis('accSecRates'), sup: vis('accSecSupplierRates'),
      payable: vis('accSecPayable'), bill: vis('accSecBillable'), pend: vis('accSecPending'), ro: document.getElementById('dashSalary').classList.contains('salary-ro'),
      hours: __lastSalaryEntries.reduce((t, e) => t + e.hours, 0), comText: txt};
  });
  ok(pv.rows.length === 1 && pv.rows[0] === 'w2' && pv.com && pv.ro && !pv.rates && !pv.sup && !pv.payable && !pv.bill && !pv.pend,
    'hr pay view: own worker only, read-only, its commission, nothing else of Accounting ' + JSON.stringify(pv).slice(0, 200));
  ok(pv.comText.includes('₪' + (pv.hours * 4).toFixed(0)), 'hr pay view: commission = hours × 4 ' + pv.hours);
  // Hours approval in Accounting (hours ticks): its own worker's days; approve one.
  const hrv = await h.evaluate(async () => {
    switchTab('accounting');
    for(let i = 0; i < 60 && !(typeof __hrv !== 'undefined' && __hrv.data && __hrv.data.punches); i++) await new Promise(r => setTimeout(r, 150));
    if(!hrvMonthDays().length){ hrvShiftMonth(-1); for(let i = 0; i < 60 && !(__hrv.data && __hrv.data.month === hrvMonthKey() && !__hrv.loading); i++) await new Promise(r => setTimeout(r, 150)); }
    const r = {shown: document.getElementById('accSecReview').style.display !== 'none', names: (__hrv.data.workers || []).map(w => w.name), days: hrvMonthDays().length};
    const d = hrvMonthDays()[0];
    if(d){ hrvApproveDay(d.key); for(let i = 0; i < 40 && hrvDayState(hrvRow(d.key)).st !== 'approved'; i++) await new Promise(res => setTimeout(res, 150)); r.st = hrvDayState(hrvRow(d.key)).st; }
    return r;
  });
  await (await h.$('#accSecReview')).screenshot({path: SP + '/hr-hours-review.png'}).catch(()=>{});
  ok(hrv.shown && hrv.names.join() === 'Dana Levi' && hrv.days >= 1 && hrv.st === 'approved', 'hr: Hours approval in Accounting — own workers only, approves a day ' + JSON.stringify(hrv));
  const mh = await h.evaluate(async () => {
    const r = {};
    openHoursImportModal('w2');
    addHoursManualRow(); __hoursManualRows[0] = {date: '2026-10-02', inTime: '09:00', outTime: '13:00'};
    addHoursManualRow(); __hoursManualRows[1] = {date: '2026-10-03', inTime: '', outTime: ''};
    r.hourly = hoursManualEntries();
    const w = workers.find(x => x.id === 'w2'); w.payMode = 'daily';
    r.daily = hoursManualEntries(); delete w.payMode;
    __hoursManualRows.splice(1, 1); // an hourly worker's date-only row would be refused (explained, not sent)
    await submitHoursImportBatch();
    for(let i = 0; i < 40 && !/Sent for review/i.test(document.getElementById('hoursSentList').innerText); i++) await new Promise(res => setTimeout(res, 150));
    r.list = document.getElementById('hoursSentList').innerText;
    closeModal('hoursImportOverlay');
    return r;
  });
  ok(mh.hourly.length === 1 && mh.hourly[0].date === '02/10/2026' && mh.daily.length === 2 && mh.daily[1].inTime === '08:00'
    && /entered by hand/.test(mh.list) && /Sent for review/i.test(mh.list), 'hr: shifts entered by hand are sent for review and listed with their status ' + JSON.stringify(mh));
  const pm = await h.evaluate(async () => {
    const r = {};
    workers.find(w => w.id === 'w2').bank = 'Hapoalim';
    switchTab('accounting');
    r.cards = [...document.querySelectorAll('#dashSalary .salary-rows .sal-row')].map(c => c.textContent.replace(/\s+/g, ' '));
    r.own = __lastSalaryEntries.length;
    openPayModal('w2');
    r.modal = document.getElementById('payOverlay').classList.contains('open');
    r.allDisabled = [...document.querySelectorAll('#payModal input, #payModal select')].every(el => el.disabled);
    r.noSave = ![...document.querySelectorAll('#payModal button')].some(b => /Save/.test(b.textContent));
    r.canEdit = canEditPay();
    closeModal('payOverlay'); delete workers.find(w => w.id === 'w2').bank;
    return r;
  });
  ok(pm.cards.length === Math.min(pm.own, 10) && pm.own >= 1 && pm.cards.some(t => /Hapoalim/.test(t)) && pm.modal && pm.allDisabled && pm.noSave && !pm.canEdit, 'hr: sees its workers\' Salary rows with the bank, the pay window read-only ' + JSON.stringify(pm));
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
    await openEditUserForm(id);
    const chip = document.getElementById('userFormPayEditChip'); const r = {shown: chip.style.display !== 'none'};
    chip.querySelector('input').checked = true;
    await submitUserForm();
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
    openPayModal('w2');
    r.enabled = !document.getElementById('payRate').disabled;
    document.getElementById('payRate').value = '52'; document.getElementById('payBank').value = 'Discount'; document.getElementById('payBankAccount').value = '777';
    savePayModal('w2');
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
    openAddWorker(); wGiven.value = 'Dup'; wSurname.value = 'Person'; wDocId.value = '000000018';
    await saveWorker();
    r.afterDup = workers.length;
    closeModal('workerOverlay');
    openAddWorker(); wGiven.value = 'New'; wSurname.value = 'Hire'; wDocId.value = '000000026';
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
    await openEditUserForm(hrUid);
    userFormFullName.value = 'Rina Cohen';
    await submitUserForm();
    r.hrErr = userFormError.textContent;
    const own = (await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers'})})).json()).users.find(u=>u.role==='tenant_admin');
    await openEditUserForm(own.id);
    r.ownerRoleHidden = document.getElementById('userFormRoleField').style.display==='none' && document.getElementById('userFormPermsField').style.display==='none';
    userFormFullName.value = 'Avi Boss';
    await submitUserForm();
    r.ownerErr = userFormError.textContent;
    r.header = document.getElementById('accountLabelCenter').innerText;
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
    await openEditUserForm(sup.id);
    r.enabled = !userFormRole.disabled;
    userFormRole.value = 'staff'; userFormRole.dispatchEvent(new Event('change'));
    document.querySelector('.userFormPermCb[value="workers"]').checked = true;
    await submitUserForm();
    r.err = userFormError.textContent;
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
  ok(await p.evaluate(() => /Avi Boss/.test(document.getElementById('accountLabelCenter').innerText)), 'owner: name kept after reload');
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
