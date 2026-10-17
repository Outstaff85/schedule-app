// Accounting: the old page's figures vs src/manager/accounting.ts (docs/tests.md → Accounting).
// The old code (tests/accounting/legacy.mjs, the Accounting tab of
// schedule-manager.html before stage 6e — never edited) and accounting.ts
// (bundled here in memory with Vite, exactly what assets/manager.js carries)
// run on the same generated months inside one vm with a fixed clock, both on
// payroll.js, and every figure the tab shows or exports must be identical:
// the Salary rows and totals (also searched), the figures on top, the alerts,
// an HR's commission, Payable by supplier / by HR and its detail windows,
// Billable by client and its details, the pay window's figures, the salary
// export table (every period, Select), the accountant workbook, the payable
// summary, the hours-approval lines and counts.
//
//   node tests/accounting/compare.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

process.env.TZ = 'Asia/Jerusalem';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let failed = 0, passed = 0;
function run(label, fn) {
  try { const r = fn(); passed++; console.log(`PASS ${label}${r || ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${e.message.split('\n').slice(0, 6).join(' | ')}`); }
}

// accounting.ts → one IIFE with the global ManagerAcc (payroll.ts bundled in, the same source as payroll.js).
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false,
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2019',
    lib: { entry: path.join(ROOT, 'src/manager/accounting.ts'), formats: ['iife'], name: 'ManagerAcc', fileName: () => 'acc.js' } },
});
const accCode = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.type === 'chunk').code;

const NOW = Date.parse(process.env.PAYROLL_NOW || '2026-10-15T12:34:00Z');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
const ctx = vm.createContext({ Date: FixedDate, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'payroll.js'), 'utf8') + '\nthis.Payroll = Payroll;', ctx);
vm.runInContext(accCode + '\nthis.ManagerAcc = ManagerAcc;', ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, 'legacy.mjs'), 'utf8').replace(/^export function /gm, 'function ') + '\nthis.legacyAccounting = legacyAccounting;', ctx);
const { Payroll, ManagerAcc: A, legacyAccounting } = ctx;

const tr = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? String(p[k]) : m));

// ── A seeded generator ──
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
let R = rng(1);
const pick = a => a[Math.floor(R() * a.length)];
const chance = p => R() < p;
const hhmm = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
const rateVal = () => pick([null, undefined, '', 0, '0', 32.3, 40, '45', 52.5, '61.25', 38]);

function genClients() {
  return ['c1', 'c2', 'c3', 'c4'].map(id => ({
    id, name: 'Client ' + id, color: '#123456', object: chance(0.5) ? 'Object ' + id : '',
    rateMode: pick(['tiered', 'fixed', 'daily', undefined, 'tiered']),
    billRate: pick([null, '', 55, '60', undefined]), billOtRate: pick([null, '', undefined, 75]), billShabbatRate: pick([null, undefined, 90, '']),
    fixedBillRate: pick([0, 50, '58.5', null]), dailyBillRate: pick([0, 450, '520', null]),
    defaultHourlyRate: pick([null, '', 35, '42', 48.5, undefined]),
    defaultOtRate: pick([null, '', undefined, undefined, 60, '55.5']),
    defaultShabbatRate: pick([null, '', undefined, undefined, 70, '66']),
  }));
}
function genSuppliers() {
  return ['s1', 's2', 's3'].map(id => {
    const s = { id, name: 'Supplier ' + id, color: '#654321' };
    if (chance(0.7)) s.commission = Array.from({ length: 1 + Math.floor(R() * 3) }, () => ({
      from: pick(['', '2025-03-01', '2025-11-15', '2026-02-01', '2026-10-10']), mode: pick(['hour', 'day', undefined]), rate: pick([null, '', 6, '7.5', 300, 0]) }));
    return s;
  });
}
const HRS = [{ id: 'hr1', fullName: 'HR One', commissionRate: 3, commissionDayRate: 25 }, { id: 'hr2', username: 'hr2', commissionRate: '2.5' }, { id: 'hr3', fullName: 'HR Three' }];
function genWorker(i) {
  const w = { id: 'w' + i, name: pick(['Avi', 'Dana', 'Noa', 'Eli', 'avi', 'Zoe']) + ' ' + i, clientIds: [] };
  for (const c of ['c1', 'c2', 'c3', 'c4']) if (chance(0.3)) w.clientIds.push(c);
  if (chance(0.7)) w.hourlyRate = pick([0, '', 34.3, 40, '45', 50, 62.5]);
  if (chance(0.25)) w.regRate = pick(['', null, 41, '47.5']);
  if (chance(0.3)) w.otRate = rateVal();
  if (chance(0.3)) w.shabbatRate = rateVal();
  if (chance(0.4)) {
    w.clientRates = {};
    for (const c of ['c1', 'c2', 'c3']) if (chance(0.5)) w.clientRates[c] = { rate: rateVal(), otRate: chance(0.4) ? rateVal() : undefined, shabbatRate: chance(0.4) ? rateVal() : undefined };
  }
  if (chance(0.25)) w.payMode = 'daily';
  if (chance(0.4)) w.travelAllowance = pick([0, 11.8, '22.6', '', null]);
  if (chance(0.2)) w.travelMonthly = pick([0, 250, '400', '']);
  if (chance(0.3)) w.dayOverrides = { 'm:2026-10': pick(['', null, 12, '9', 0]), 'm:2026-09': pick([3, '', null]), 'w:2026-10-11': pick(['', 3, '4']), all: pick([undefined, 20, '']) };
  if (chance(0.6)) w.supplierId = pick(['s1', 's2', 's3', 'gone']);
  if (w.supplierId && chance(0.4)) w.supplierRates = { [w.supplierId]: { rate: pick([null, 4, 6.5, 0]), dayRate: pick([null, 0, 40, 55]) } };
  if (chance(0.5)) w.hrId = pick(['hr1', 'hr2', 'hr3']);
  if (chance(0.6)) { w.bank = pick(['', 'Leumi', 'Hapoalim']); w.bankBranch = pick(['', '12']); w.bankAccountNumber = pick(['', '123456']); }
  if (chance(0.5)) w.docId = String(100000000 + i); else if (chance(0.3)) w.address = 'Passport X' + i;
  return w;
}
// One worker's punches over a few months: day, night, split, Saturday shifts and the anomalies.
function genPunches(w, year, month) {
  const out = [];
  let n = 0;
  const push = (d, h, m, type, clientId, noTime) => {
    const dt = new RealDate(year, month, d, h, m, Math.floor(R() * 60));
    out.push({ id: w.id + '-' + year + month + '-' + (n++), workerId: w.id, workerName: w.name, type, ts: dt.toISOString(), time: noTime ? pick(['', null]) : hhmm(dt.getHours(), dt.getMinutes()), clientId });
  };
  const days = new RealDate(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    if (!chance(0.55)) continue;
    const c = pick(['c1', 'c2', 'c3', 'c4', '', undefined, 'gone']);
    const kind = R(), sh = 5 + Math.floor(R() * 12), sm = Math.floor(R() * 60);
    if (kind < 0.55) {
      const len = 4 * 60 + Math.floor(R() * 9 * 60), end = sh * 60 + sm + len;
      push(d, sh, sm, 'in', c);
      if (end < 1440) push(d, Math.floor(end / 60), end % 60, 'out', c);
      else if (d < days) push(d + 1, Math.floor((end - 1440) / 60), (end - 1440) % 60, 'out', c);
    } else if (kind < 0.7) { push(d, 20 + Math.floor(R() * 4), Math.floor(R() * 60), 'in', c); if (d < days) push(d + 1, 2 + Math.floor(R() * 6), Math.floor(R() * 60), 'out', c); }
    else if (kind < 0.8) { push(d, 6, Math.floor(R() * 60), 'in', c); push(d, 10, Math.floor(R() * 60), 'out', c); push(d, 14, Math.floor(R() * 60), 'in', c); push(d, 18 + Math.floor(R() * 3), Math.floor(R() * 60), 'out', c); }
    else if (kind < 0.85) { push(d, sh, sm, 'in', c); push(d, sh, Math.min(59, sm + 1), 'in', c); push(d, Math.min(23, sh + 8), sm, 'out', c); }
    else if (kind < 0.89) push(d, sh, sm, 'out', c);
    else if (kind < 0.92) { push(d, sh, sm, 'in', c, chance(0.5)); push(d, Math.min(23, sh + 7), sm, 'out', c, chance(0.5)); }
    else if (kind < 0.95) { push(d, sh, sm, 'in', c); out.push({ ...out[out.length - 1], id: w.id + '-z' + (n++), type: 'out' }); }
    else if (kind < 0.98) { push(d, 4, sm, 'in', c); push(d, 18 + Math.floor(R() * 5), sm, 'out', c); }
    else push(d, sh, sm, 'in', c);
  }
  return out;
}
// The month's approval documents: client, supplier, HR (own only or all), days in every state.
function genDocs(workers, log, month) {
  const docs = [];
  const daysOf = pickFn => {
    const days = {};
    log.filter(pickFn).forEach(e => {
      const day = new RealDate(e.ts); const ymd = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
      if (!ymd.startsWith(month) || !chance(0.3)) return;
      const k = e.workerId + '|' + ymd;
      days[k] = { status: pick(['approved', 'fixed', 'disputed', 'fix', 'rejected', undefined]), line: chance(0.5) ? 'stale' : undefined,
        comment: pick(['', 'late']), inT: chance(0.3) ? '08:00' : undefined, outT: '16:00', byName: pick(['', 'Ann']), at: chance(0.5) ? '2026-10-01T10:00:00Z' : undefined };
    });
    return days;
  };
  docs.push({ id: 'client_c2_' + month, kind: 'client', ownerId: 'c2', ownerName: 'Client c2', days: daysOf(e => e.clientId === 'c2') });
  docs.push({ id: 'supplier_s1_' + month, kind: 'supplier', ownerId: 's1', ownerName: 'Supplier s1', days: daysOf(e => (workers.find(w => w.id === e.workerId) || {}).supplierId === 's1') });
  docs.push({ id: 'hr_hr1_' + month, kind: 'hr', ownerId: 'hr1', ownerName: 'HR One', ownOnly: true, days: daysOf(e => (workers.find(w => w.id === e.workerId) || {}).hrId === 'hr1') });
  docs.push({ id: 'hr_hr2_' + month, kind: 'hr', ownerId: 'hr2', ownerName: 'hr2', ownOnly: false, days: daysOf(() => true) });
  docs.push({ id: 'empty', kind: 'client', ownerId: 'c3', ownerName: 'Client c3', days: {} });
  return docs;
}

// ── Old vs new on one dataset ──
const pickE = e => ({ worker: e.worker, workerId: e.workerId, hours: e.hours, days: e.days, regH: e.regH, otH: e.otH, shabH: e.shabH, total: e.total, travel: e.travel,
  warns: e.warns, clientHours: e.clientHours, countedDays: e.countedDays, daysUsed: e.daysUsed, supCom: e.supCom, dayKeys: [...e.dayKeys], seen: [...e.seen] });
const sameNum = (a, b, m) => assert.ok(Object.is(a, b), `${m}: ${a} (new) vs ${b} (old)`);
let tally = { rows: 0, pay: 0, payOld: 0, exportRows: 0 };

function compare(label, workers, clients, suppliers, log, session) {
  const env = { workers, clients, suppliers, log, tr, uiLocale: 'en', session, hrUsers: HRS, isFirmAdmin: !session, Payroll };
  const O = legacyAccounting(env);
  const D = { log, workers, clients, suppliers, tr };
  const me = session || {};
  const payOnly = !!session;
  for (const period of ['week', 'month', 'all', 'm:2026-09', 'm:2026-08', 'm:2025-12']) {
    const L = `${label} ${period}${payOnly ? ' hr' : ''}`;
    // salaryEntriesFor
    const o = O.salaryEntriesFor(period), n = A.salaryEntriesFor(D, period);
    assert.deepStrictEqual(Object.keys(n.byWorker), Object.keys(o.byWorker), `${L}: Salary row order`);
    for (const k of Object.keys(o.byWorker)) assert.deepStrictEqual(pickE(n.byWorker[k]), pickE(o.byWorker[k]), `${L} ${k}: Salary row`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(n.byClient)), JSON.parse(JSON.stringify(o.byClient)), `${L}: billable by client`);
    // The tab: renderSalary's rows, totals, figures, alerts, HR commission (and searched).
    for (const q of ['', 'avi', ' DANA ', 'zzz']) {
      const F = O.salaryFigures(period, q);
      const entries = Object.values(n.byWorker).filter(e => !payOnly || ((workers.find(w => w.id === e.workerId) || {}).hrId === me.uid));
      const shown = A.searchRows(entries, q), tot = A.salaryTotals(shown), figs = A.accFigures(entries);
      assert.deepStrictEqual(shown.map(e => e.workerId), F.rows.map(r => r.workerId), `${L} q=${q}: rows shown`);
      sameNum(tot.hours, F.totals.hours, `${L} q=${q}: total hours`); sameNum(tot.pay, F.totals.pay, `${L} q=${q}: total pay`);
      sameNum(tot.travel, F.totals.travel, `${L} q=${q}: total travel`); sameNum(tot.total, F.totals.total, `${L} q=${q}: Total Pay`);
      sameNum(Math.round(figs.hours), F.figs.hours, `${L}: figure Hours`); sameNum(Math.round(Number(figs.payroll) || 0), F.figs.payroll, `${L}: figure Payroll`);
      shown.forEach((e, i) => {
        const r = F.rows[i], rs = A.rateShown(D, e);
        assert.deepStrictEqual([rs.kind, rs.value].filter(x => x !== undefined), [r.rate[0] === 'day' && r.rate.length === 1 ? 'day-none' : r.rate[0], ...r.rate.slice(1)].map(x => x === 'day-none' ? 'day-none' : x), `${L} ${e.workerId}: rate shown`);
        assert.equal(A.daysByHand(D, e, period), r.byHand, `${L} ${e.workerId}: days by hand`);
        sameNum(e.total + e.travel, r.total, `${L} ${e.workerId}: row total`);
        if (payOnly) sameNum(A.hrCommission(D, e, me.commissionRate, me.commissionDayRate), r.myCom, `${L} ${e.workerId}: my commission`);
      });
      if (payOnly) sameNum(shown.reduce((t, e) => t + A.hrCommission(D, e, me.commissionRate, me.commissionDayRate), 0), F.totals.myCom, `${L}: my commission total`);
      if (q) continue;
      const al = payOnly ? [] : A.accAlerts(D, entries, n.byClient);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(al.map(a => ({ sec: a.sec, lvl: a.lvl, icon: 'ti-' + a.icon, title: a.title, sub: a.sub, go: a.go })))), JSON.parse(JSON.stringify(F.alerts)), `${L}: alerts`);
      if (payOnly) continue;
      // Billing: Payable by supplier (+ its export rows and detail windows), by HR, Billable by client (+ details).
      const SP = O.supplierPayableFigures(F.entries), sp = A.supplierPayable(D, entries);
      assert.deepStrictEqual(sp.map(r => [r.id, r.hours, r.total]), SP.rows.map(r => [r.id, r.hours, r.total]), `${L}: payable by supplier`);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(A.payableAoa(sp.map(r => ({ label: r.name, hours: r.hours, rate: tr('commission'), total: r.total })), tr))), JSON.parse(JSON.stringify(O.payableAoa(SP.exportRows))), `${L}: payable summary export`);
      SP.details.forEach(dt => {
        const rows = A.supplierPayDetail(D, entries, dt.id);
        assert.deepStrictEqual(rows.map(r => ({ n: r.name, h: tr('{h}h', { h: r.hours.toFixed(1) }), m: '₪' + r.total.toFixed(0) })), dt.rows, `${L} ${dt.id}: supplier detail rows`);
        assert.deepStrictEqual({ h: tr('{h}h', { h: rows.reduce((t, r) => t + r.hours, 0).toFixed(1) }), m: '₪' + rows.reduce((t, r) => t + r.total, 0).toFixed(0) }, dt.total, `${L} ${dt.id}: supplier detail total`);
      });
      const hp = A.hrPayable(D, entries, HRS);
      assert.deepStrictEqual(hp.map(r => [r.id, r.hours, r.rate, r.dayRate, r.total]), O.hrPayableFigures(F.entries).map(r => [r.id, r.hours, r.rate, r.dayRate, r.total]), `${L}: payable by HR`);
      const CB = O.clientBillableFigures(F.clientBillEntries, F.entries), cb = A.clientBillable(D, n.byClient);
      assert.deepStrictEqual(cb.map(r => [r.id, r.hours, r.total, r.mode]), CB.map(r => [r.id, r.hours, r.total, r.mode.toLowerCase()]), `${L}: billable by client`);
      CB.forEach(c => {
        const rows = A.clientBillDetail(entries, c.id), bill = n.byClient[c.id];
        assert.deepStrictEqual(rows.map(r => ({ n: r.name, h: tr('{h}h', { h: r.hours.toFixed(1) }) })), c.detail.rows, `${L} ${c.id}: client detail rows`);
        assert.deepStrictEqual({ h: tr('{h}h', { h: bill.hours.toFixed(1) }), m: bill.total > 0 ? '₪' + bill.total.toFixed(0) : '—' }, c.detail.total, `${L} ${c.id}: client detail total`);
      });
      // The pay window.
      for (const w of workers) assert.deepStrictEqual(JSON.parse(JSON.stringify(A.payWindowFigures(D, w, period, entries))), JSON.parse(JSON.stringify(O.payWindowFigures(w.id, period, F.entries))), `${L} ${w.id}: pay window`);
    }
    if (payOnly) continue;
    // Exports: the salary table (all, and Select), the accountant workbook.
    const aoa = A.salaryExportAoa(D, period), oaoa = O.salaryExportAoa(period);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(aoa)), JSON.parse(JSON.stringify(oaoa)), `${L}: salary export`);
    const some = workers.filter((_, i) => i % 3 === 0).map(w => w.id);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(A.salaryExportAoa(D, period, some))), JSON.parse(JSON.stringify(O.salaryExportAoa(period, some))), `${L}: salary export of the ticked workers`);
    const month = A.salaryMonthOf(period);
    assert.equal(month, O.salaryMonthOf(period), `${L}: month`);
    const docs = month ? genDocs(workers, log, month) : null;
    const nb = A.accountantSheets(D, period, docs, 'Firm', 'en'), ob = O.accountantSheets(period, docs, 'Firm');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nb)), JSON.parse(JSON.stringify(ob)), `${L}: accountant workbook`);
    if (month) {
      const shown = A.approvalDocsShown(docs).map(doc => { const s = A.hourApprovalSummary(D, doc, month);
        return { id: doc.id, done: s.done, total: s.total, allOk: s.allOk, open: s.open.map(x => ({ k: x.k, st: x.st, times: x.times, fix: x.fix })) }; });
      assert.deepStrictEqual(shown, O.approvalsFigures(docs, month), `${L}: hours approvals`);
      for (const doc of docs) assert.deepStrictEqual(A.hourDayLines(D, doc, month), O.hourDayLines(doc, month), `${L} ${doc.id}: approval lines`);
    }
    assert.deepStrictEqual(A.periodOptions(tr, 'en'), O.salaryExportPeriodOptions(), `${L}: period options`);
    tally.rows += Object.keys(n.byWorker).length; tally.exportRows += aoa.length - 2;
    Object.values(n.byWorker).forEach(e => { tally.pay += e.total + e.travel; });
    Object.values(o.byWorker).forEach(e => { tally.payOld += e.total + e.travel; });
  }
  // Commission and billing on their own.
  for (const w of workers) for (const sid of ['s1', 's2', 's3']) for (const e of [{ hours: 7.5, days: 2, daysUsed: 3, supCom: 12 }, { hours: 0, days: 0, supCom: undefined }])
    sameNum(A.supplierCommission(w, e, sid), O.supplierCommission(w, e, sid), `${label} ${w.id} ${sid}: supplierCommission`);
  for (const c of clients) for (const h of [0, 3.5, 8, 9.25, 11]) for (const sat of [false, true]) sameNum(A.clientBillPay(h, c, sat), O.clientBillPay(h, c, sat), `${label} ${c.id}: clientBillPay`);
}

for (let i = 0; i < 12; i++) {
  R = rng(4200 + i);
  const clients = genClients(), suppliers = genSuppliers();
  const workers = Array.from({ length: 12 }, (_, k) => genWorker(k));
  // Three months up to "today" (2026-10-15), one older month, so every period has data.
  const log = workers.flatMap(w => [...genPunches(w, 2026, 7), ...genPunches(w, 2026, 8), ...genPunches(w, 2026, 9), ...genPunches(w, 2025, 11)])
    .filter(e => new RealDate(e.ts) <= new RealDate(NOW));
  run(`dataset ${i + 1} (${workers.length} workers, ${log.length} punches)`, () => {
    compare('d' + (i + 1), workers, clients, suppliers, log, null);
    compare('d' + (i + 1), workers, clients, suppliers, log, { role: 'hr', uid: 'hr1', commissionRate: 3, commissionDayRate: 25 });
  });
}
run('totals', () => { sameNum(tally.pay, tally.payOld, 'pay + travel over every row'); return ` — ${tally.rows} Salary rows, ${tally.exportRows} export rows, pay + travel ${tally.pay.toFixed(2)} new = ${tally.payOld.toFixed(2)} old`; });

console.log(failed ? `${failed} FAILED (${passed} passed)` : `ALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
