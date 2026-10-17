// Payroll: the old copies vs the module (docs/tests.md → Payroll).
// The old code (tests/payroll/legacy.mjs, a verbatim snapshot of the four
// pages' copies before stage 2) and payroll.js (built from src/lib/payroll.ts,
// exactly what the old pages now load) run on the same inputs, each page the
// way it calls them (the manager with tr, the portals without), and every
// result must be identical: shift buckets, hours and warnings, rates and their
// sources, every shift's pay, daily pay with its seen days, travel, period keys
// and day overrides. Then a few figures checked by hand.
//
//   node tests/payroll/compare.test.mjs                  generated months
//   node tests/payroll/compare.test.mjs --data file.json  also a real export:
//        { "workers": [...], "clients": [...], "punches": [...] }
//
// Both run inside one vm context with a fixed clock, so "today" (the
// manager's open shift counted up to now) is the same for both.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Asia/Jerusalem';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + 'FAIL ' + msg);
}

// ── One context: a fixed "now", the old pages and payroll.js ──
const NOW = Date.parse(process.env.PAYROLL_NOW || '2026-10-15T12:34:00Z');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
const ctx = vm.createContext({ Date: FixedDate, console });
const legacySrc = fs.readFileSync(path.join(HERE, 'legacy.mjs'), 'utf8').replace(/^export function /gm, 'function ');
vm.runInContext(legacySrc + '\nthis.legacy = { managerPage, supplierPage, punchPage, clientPage };', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'payroll.js'), 'utf8') + '\nthis.Payroll = Payroll;', ctx);
const { legacy, Payroll: P } = ctx;

const tr = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? String(p[k]) : m));
let clients = [];
const env = { clients: () => clients, tr };
const OLD = { manager: legacy.managerPage(env), supplier: legacy.supplierPage(env), punch: legacy.punchPage(env), client: legacy.clientPage(env) };
// The new module, called the way each page's wrapper calls it.
const NEW = {
  manager: { analyze: (e, d) => P.analyzeDayPunches(e, d, { tr }) },
  short: { analyze: (e, d) => P.analyzeDayPunches(e, d) },
};

// ── A seeded generator of realistic months ──
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
let R = rng(20261017);
const pick = a => a[Math.floor(R() * a.length)];
const chance = p => R() < p;
const hhmm = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
const rateVal = () => pick([null, undefined, '', 0, '0', 32.3, 40, '45', 52.5, '61.25', 38]);

function genClients() {
  return ['c1', 'c2', 'c3', 'c4'].map(id => ({
    id, name: id,
    defaultHourlyRate: pick([null, '', 35, '42', 48.5, undefined]),
    defaultOtRate: pick([null, '', undefined, undefined, 60, '55.5']),
    defaultShabbatRate: pick([null, '', undefined, undefined, 70, '66']),
  }));
}
function genWorker(i) {
  const w = { id: 'w' + i, name: 'W' + i };
  if (chance(0.7)) w.hourlyRate = pick([0, '', 34.3, 40, '45', 50, 62.5]);
  if (chance(0.25)) w.regRate = pick(['', null, 41, '47.5']);
  if (chance(0.3)) w.otRate = rateVal();
  if (chance(0.3)) w.shabbatRate = rateVal();
  if (chance(0.4)) {
    w.clientRates = {};
    for (const c of ['c1', 'c2', 'c3']) if (chance(0.5)) w.clientRates[c] = { rate: rateVal(), otRate: chance(0.4) ? rateVal() : undefined, shabbatRate: chance(0.4) ? rateVal() : undefined };
    if (chance(0.2)) w.clientRates.c4 = null;
  }
  if (chance(0.25)) w.payMode = 'daily';
  else if (chance(0.1)) w.payMode = 'hourly';
  if (chance(0.4)) w.travelAllowance = pick([0, 11.8, '22.6', '', null]);
  if (chance(0.2)) w.travelMonthly = pick([0, 250, '400', '']);
  if (chance(0.3)) {
    w.dayOverrides = {};
    w.dayOverrides['m:2026-10'] = pick(['', null, 12, '9', 0]);
    w.dayOverrides['w:2026-10-11'] = pick(['', 3, '4']);
    w.dayOverrides.all = pick([undefined, 20, '']);
  }
  return w;
}
// One worker's punches for a month: ordinary shifts, night shifts across
// midnight, split days, Saturdays, and the anomalies the pages must survive
// (double IN, OUT without IN, a punch with no time, 0 minutes, >12h, today's
// open shift).
function genPunches(w, year, month) {
  const out = [];
  let n = 0;
  const push = (d, h, m, type, clientId, noTime) => {
    const dt = new RealDate(year, month, d, h, m, Math.floor(R() * 60));
    out.push({ id: w.id + '-' + (n++), workerId: w.id, type, ts: dt.toISOString(), time: noTime ? pick(['', null, undefined]) : hhmm(dt.getHours(), dt.getMinutes()), clientId });
  };
  const days = new RealDate(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    if (!chance(0.6)) continue;
    const c = pick(['c1', 'c2', 'c3', 'c4', '', undefined]);
    const kind = R();
    const sh = 5 + Math.floor(R() * 12), sm = Math.floor(R() * 60);
    if (kind < 0.55) { // a day shift, 4–13h
      const len = 4 * 60 + Math.floor(R() * 9 * 60);
      const end = sh * 60 + sm + len;
      push(d, sh, sm, 'in', c);
      if (end < 1440) push(d, Math.floor(end / 60), end % 60, 'out', c);
      else if (d < days) push(d + 1, Math.floor((end - 1440) / 60), (end - 1440) % 60, 'out', c);
    } else if (kind < 0.7) { // a night shift across midnight
      push(d, 20 + Math.floor(R() * 4), Math.floor(R() * 60), 'in', c);
      if (d < days) push(d + 1, 2 + Math.floor(R() * 6), Math.floor(R() * 60), 'out', c);
    } else if (kind < 0.8) { // a split day: two shifts
      push(d, 6, Math.floor(R() * 60), 'in', c); push(d, 10, Math.floor(R() * 60), 'out', c);
      push(d, 14, Math.floor(R() * 60), 'in', c); push(d, 18 + Math.floor(R() * 3), Math.floor(R() * 60), 'out', c);
    } else if (kind < 0.85) { // double IN
      push(d, sh, sm, 'in', c); push(d, sh, Math.min(59, sm + 1), 'in', c); push(d, Math.min(23, sh + 8), sm, 'out', c);
    } else if (kind < 0.89) { // OUT without IN
      push(d, sh, sm, 'out', c);
    } else if (kind < 0.92) { // a punch with no time
      push(d, sh, sm, 'in', c, chance(0.5)); push(d, Math.min(23, sh + 7), sm, 'out', c, chance(0.5));
    } else if (kind < 0.95) { // 0 minutes
      push(d, sh, sm, 'in', c); out.push({ ...out[out.length - 1], id: w.id + '-' + (n++), type: 'out' });
    } else if (kind < 0.98) { // longer than 12h
      push(d, 4, sm, 'in', c); push(d, 18 + Math.floor(R() * 5), sm, 'out', c);
    } else { // left open
      push(d, sh, sm, 'in', c);
    }
  }
  return out;
}

// ── The comparison of one dataset ──
const SAT = d => d.getDay() === 6;
function compareDataset(label, workers, cls, punches) {
  clients = cls;
  let shifts = 0, payOld = 0, payNew = 0;
  const pages = [
    ['manager', OLD.manager, NEW.manager.analyze],
    ['supplier', OLD.supplier, NEW.short.analyze],
    ['punch', OLD.punch, NEW.short.analyze],
    ['client', OLD.client, NEW.short.analyze],
  ];
  for (const w of workers) {
    const mine = punches.filter(p => p.workerId === w.id);
    for (const [page, old, analyze] of pages) {
      const bOld = old.groupPunchesIntoShifts(mine), bNew = P.groupPunchesIntoShifts(mine);
      assert.deepStrictEqual(bNew, bOld, `${label} ${page} ${w.id}: shift buckets`);
      if (page === 'client') {
        for (const b of bOld) assert.deepStrictEqual(analyze(b.entries, b.date), old.analyzeDayPunches(b.entries, b.date), `${label} client ${w.id}: hours`);
        continue;
      }
      const seenOld = new Set(), seenNew = new Set();
      for (const b of bOld) {
        const aOld = old.analyzeDayPunches(b.entries, b.date), aNew = analyze(b.entries, b.date);
        assert.deepStrictEqual(aNew, aOld, `${label} ${page} ${w.id} ${b.date.toISOString()}: hours and warnings`);
        const cid = (b.entries.find(e => e.clientId) || {}).clientId;
        const sat = SAT(b.date);
        assert.deepStrictEqual(P.effectiveRates(w, cid, clients), old.effectiveRates(w, cid), `${label} ${page} ${w.id} ${cid}: rates`);
        for (const sat2 of [sat, !sat]) {
          assert.deepStrictEqual(P.israeliDayPay(aOld.hours, P.effectiveRates(w, cid, clients).regRate, sat2), old.israeliDayPay(aOld.hours, old.effectiveRates(w, cid).regRate, sat2), `${label} ${page} ${w.id}: israeliDayPay`);
          assert.ok(Object.is(P.shiftPay(aOld.hours, w, sat2, cid, clients), old.shiftPay(aOld.hours, w, sat2, cid)), `${label} ${page} ${w.id}: shiftPay`);
        }
        const o = old.shiftPayFor(aOld.hours, w, sat, cid, b.date, seenOld);
        const nw = P.shiftPayFor(aNew.hours, w, sat, cid, b.date, seenNew, clients);
        assert.ok(Object.is(nw, o), `${label} ${page} ${w.id} ${b.date.toISOString()}: shiftPayFor ${nw} vs ${o}`);
        if (page === 'manager') { shifts++; payOld += o; payNew += nw; }
      }
      assert.deepStrictEqual([...seenNew], [...seenOld], `${label} ${page} ${w.id}: seen days`);
      for (const k of ['week', 'month', 'all', '', null, undefined, 'm:2026-09'])
        for (const now of [undefined, new FixedDate(2026, 9, 1), new FixedDate(2026, 9, 17, 23, 30), new FixedDate(2027, 0, 2)]) {
          const kOld = old.salaryPeriodKey(k, now), kNew = P.salaryPeriodKey(k, now);
          assert.equal(kNew, kOld, `${label} ${page}: salaryPeriodKey(${k})`);
          assert.ok(Object.is(P.dayOverride(w, kNew), old.dayOverride(w, kOld)), `${label} ${page} ${w.id}: dayOverride(${kOld})`);
        }
      assert.ok(Object.is(P.wOwnRate(w), old.wOwnRate(w)), `${label} ${page} ${w.id}: wOwnRate`);
      assert.ok(Object.is(P.dailyRate(w), old.dailyRate(w)), `${label} ${page} ${w.id}: dailyRate`);
      assert.equal(P.isDailyPay(w), old.isDailyPay(w), `${label} ${page} ${w.id}: isDailyPay`);
      if (old.travelPay) for (const [d, m] of [[0, 0], [1, 1], [17, 1], [33, 2]])
        assert.ok(Object.is(P.travelPay(w, d, m), old.travelPay(w, d, m)), `${label} ${page} ${w.id}: travelPay`);
    }
  }
  for (const [page, old] of pages) assert.deepStrictEqual(P.PAY_RULES, old.PAY_RULES || P.PAY_RULES, `${page}: PAY_RULES`);
  return { shifts, payOld, payNew };
}

function run(label, fn) {
  try { const r = fn(); passed++; if (r) console.log(`PASS ${label}${r}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${e.message.split('\n')[0]}`); }
}

// Generated months: 2025-01 … 2026-10, plus today's month with open shifts "now".
let total = { shifts: 0, payOld: 0, payNew: 0, months: 0 };
for (let i = 0; i < 22; i++) {
  const year = 2025 + Math.floor(i / 12), month = i % 12;
  R = rng(1000 + i);
  const cls = genClients();
  const workers = Array.from({ length: 14 }, (_, k) => genWorker(k));
  const punches = workers.flatMap(w => genPunches(w, year, month));
  run(`${year}-${String(month + 1).padStart(2, '0')}`, () => {
    const r = compareDataset(`${year}-${month + 1}`, workers, cls, punches);
    total.shifts += r.shifts; total.payOld += r.payOld; total.payNew += r.payNew; total.months++;
  });
}
// Today: an open shift since this morning counts up to now in the manager.
run('today: open shift counted up to now', () => {
  const t = new FixedDate();
  const p = [{ workerId: 'w0', type: 'in', ts: new FixedDate(t.getFullYear(), t.getMonth(), t.getDate(), 7, 5).toISOString(), time: '07:05' }];
  const a = P.analyzeDayPunches(p, t, { tr }), b = OLD.manager.analyzeDayPunches(p, t);
  assert.deepStrictEqual(a, b);
  assert.ok(a.hours > 0 && a.warnings.length === 1, JSON.stringify(a));
  assert.deepStrictEqual(P.analyzeDayPunches(p, t), OLD.supplier.analyzeDayPunches(p, t));
});
run('localYMD on every day of two years', () => {
  for (let d = new FixedDate(2025, 0, 1); d < new FixedDate(2027, 0, 1); d = new FixedDate(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23, 59))
    for (const old of Object.values(OLD)) assert.equal(P.localYMD(d), old.localYMD(d));
});

// A real export, when given.
const di = process.argv.indexOf('--data');
if (di > 0) {
  const data = JSON.parse(fs.readFileSync(process.argv[di + 1], 'utf8'));
  run(`real data (${(data.punches || []).length} punches)`, () => {
    const r = compareDataset('real', data.workers || [], data.clients || [], data.punches || []);
    return ` — ${r.shifts} shifts, pay ${r.payNew.toFixed(2)} (old ${r.payOld.toFixed(2)})`;
  });
}

// ── Figures checked by hand ──
clients = [{ id: 'c1', defaultHourlyRate: 40 }, { id: 'c2', defaultHourlyRate: 40, defaultOtRate: 55, defaultShabbatRate: 65 }];
const W = { id: 'h' };
const eq = (a, b, m) => ok(Math.abs(a - b) < 1e-9, `${m}: ${a} ≠ ${b}`);
eq(P.shiftPay(8, W, false, 'c1', clients), 320, 'weekday 8h at 40');
eq(P.shiftPay(10, W, false, 'c1', clients), 320 + 2 * 50, 'weekday 10h: 2h at 125%');
eq(P.shiftPay(12, W, false, 'c1', clients), 320 + 100 + 2 * 60, 'weekday 12h: then 150%');
eq(P.shiftPay(9, W, true, 'c1', clients), 8 * 60 + 70, 'Saturday 9h: 150% then 175%');
eq(P.shiftPay(11, W, true, 'c1', clients), 480 + 140 + 80, 'Saturday 11h: then 200%');
eq(P.shiftPay(10, W, false, 'c2', clients), 320 + 2 * 55, 'flat OT rate from the client');
eq(P.shiftPay(10, W, true, 'c2', clients), 650, 'flat Shabbat rate from the client');
eq(P.shiftPay(10, { hourlyRate: 50, clientRates: { c1: { rate: 60 } } }, false, 'c1', clients), 480 + 150, 'the worker\'s own client override wins');
eq(P.shiftPay(8, { hourlyRate: 50 }, false, 'c1', clients), 400, 'the worker\'s own rate beats the client\'s');
{
  const seen = new Set(), dw = { payMode: 'daily', hourlyRate: 300 };
  const d1 = new FixedDate(2026, 9, 5, 8), d1b = new FixedDate(2026, 9, 5, 18), d2 = new FixedDate(2026, 9, 6, 8);
  eq(P.shiftPayFor(9, dw, false, 'c1', d1, seen, clients) + P.shiftPayFor(3, dw, false, 'c1', d1b, seen, clients) + P.shiftPayFor(2, dw, true, 'c1', d2, seen, clients), 600, 'daily pay: once per day worked');
}
eq(P.travelPay({ travelAllowance: '11.8', travelMonthly: 200 }, 10, 1), 318, 'travel');
ok(P.salaryPeriodKey('week', new FixedDate(2026, 9, 15)) === 'w:2026-10-11', 'week key = its Sunday');
{
  const night = [{ type: 'in', ts: '2026-10-05T19:00:00Z', time: '22:00' }, { type: 'out', ts: '2026-10-06T03:30:00Z', time: '06:30' }];
  const b = P.groupPunchesIntoShifts(night);
  ok(b.length === 1 && P.analyzeDayPunches(b[0].entries, b[0].date).hours === 8.5, 'a night shift stays one 8.5h shift');
}

if (total.months) {
  console.log(`PASS ${total.months} generated months: ${total.shifts} manager shifts, pay ${total.payNew.toFixed(2)} new = ${total.payOld.toFixed(2)} old`);
  ok(Object.is(total.payNew, total.payOld), 'month totals identical');
}
console.log(failed ? `${failed} FAILED (${passed} passed)` : `ALL PASSED (${passed})`);
process.exit(failed ? 1 : 0);
