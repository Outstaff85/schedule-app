// The Accounting tab's figures (docs/accounting.md → Accounting tab), moved
// from schedule-manager.html in stage 6e of the React migration: the one copy
// of the Salary rows (salaryEntriesFor), the supplier and HR commission, the
// client billing, the alerts, the payable / billable rows, the salary and
// accountant exports and the hours-approval lines. Hours and pay come only
// from src/lib/payroll.ts (shiftPayFor and the canonical functions); a
// commission or a bill never changes a worker's pay. The page reads the same
// functions through `window.ManagerAcc` (its one-line wrappers keep the old
// names). tests/accounting/compare.test.mjs runs this file and the old page
// code (tests/accounting/legacy.mjs) on the same months and requires
// identical figures — a change here is a payroll change.
import {
  analyzeDayPunches, dailyRate, dayOverride, effectiveRates, groupPunchesIntoShifts, isDailyPay, israeliDayPay, localYMD,
  PAY_RULES, salaryPeriodKey, shiftPayFor, travelPay, wOwnRate, type Punch, type PayWorker, type Translate,
} from '@/lib/payroll';
import { workerDocId } from './worker';

// ── Data shapes (the fields the figures read) ──
export type AccPunch = Punch & { workerId: string; workerName?: string; type: string; time?: string | null; clientId?: string | null; date?: string };
export type AccWorker = PayWorker & {
  id: string; name?: string; supplierId?: string | null; hrId?: string | null; clientIds?: string[]; colorIdx?: number;
  bank?: string; bankBranch?: string; bankAccountNumber?: string; docId?: string; address?: string;
  supplierRates?: Record<string, { rate?: number | null; dayRate?: number | null } | null> | null;
};
export type AccClient = {
  id: string; name?: string; color?: string; object?: string; rateMode?: string;
  billRate?: number | string | null; billOtRate?: number | string | null; billShabbatRate?: number | string | null;
  fixedBillRate?: number | string | null; dailyBillRate?: number | string | null;
  defaultHourlyRate?: number | string | null; defaultOtRate?: number | string | null; defaultShabbatRate?: number | string | null;
  [k: string]: unknown;
};
export type CommissionRate = { from?: string; mode?: string; rate: number | string | null };
export type AccSupplier = { id: string; name?: string; color?: string; commission?: CommissionRate[] };
export type HrLogin = { id: string; fullName?: string; username?: string; commissionRate?: number | string | null; commissionDayRate?: number | string | null };
/** The page's data the figures read (`ManagerBridge.accData()`). */
export type AccData = { log: AccPunch[]; workers: AccWorker[]; clients: AccClient[]; suppliers: AccSupplier[]; tr: Translate };

/** One worker's Salary row for a period. */
export type SalaryEntry = {
  worker: string; workerId: string; hours: number; days: number; regH: number; otH: number; shabH: number;
  total: number; travel: number; warns: string[]; clientHours: Record<string, number>;
  seen: Set<string>; dayKeys: Set<string>; supCom?: number; supDays?: Set<string>;
  countedDays: number; daysUsed: number;
};
export type ClientBill = { hours: number; total: number };

const byId = <T extends { id: string }>(list: T[], id: string | null | undefined): T | undefined => list.find(x => x.id === id);

// ── Client billing (a separate figure; never a worker's pay) ──
/** The client's hourly billing rate: `billRate`, else the older `defaultHourlyRate`. */
export function clientBillRate(client: AccClient | null | undefined): number {
  const v = client && (client.billRate != null && client.billRate !== '' ? client.billRate : client.defaultHourlyRate);
  return Number(v) || 0;
}
/** What a client is billed for one shift's hours: fixed ₪/h, ₪ per shift (daily), or the law tiers on its billing rate. */
export function clientBillPay(hours: number, client: AccClient | null | undefined, isSat: boolean): number {
  if (!client) return 0;
  if (client.rateMode === 'fixed') return hours * (Number(client.fixedBillRate) || 0);
  if (client.rateMode === 'daily') return hours > 0 ? (Number(client.dailyBillRate) || 0) : 0;
  const rate = clientBillRate(client), has = (v: unknown) => v != null && v !== '';
  if (isSat) {
    if (has(client.billShabbatRate)) return hours * Number(client.billShabbatRate);
    return israeliDayPay(hours, rate, true).total;
  }
  if (has(client.billOtRate)) { const RM = PAY_RULES.regularMax; return Math.min(hours, RM) * rate + Math.max(hours - RM, 0) * Number(client.billOtRate); }
  return israeliDayPay(hours, rate, false).total;
}
/** The client has a billing rate for its mode. */
export function hasBillRate(c: AccClient): boolean {
  return c.rateMode === 'fixed' ? Number(c.fixedBillRate) > 0 : c.rateMode === 'daily' ? Number(c.dailyBillRate) > 0 : clientBillRate(c) > 0;
}

// ── Commission (supplier or HR; never part of the wage) ──
/** The supplier's flat ₪/h when it has no rate of its own and the worker no override. */
export const SUPPLIER_DEFAULT_RATE = 5;
export function supplierCommissionRate(w: AccWorker, supplierId: string): number {
  const ov = w.supplierRates && w.supplierRates[supplierId];
  return (ov && ov.rate != null) ? ov.rate : SUPPLIER_DEFAULT_RATE;
}
export function supplierDayCommission(w: AccWorker, supplierId: string): number | null {
  const ov = w.supplierRates && w.supplierRates[supplierId];
  return (ov && ov.dayRate != null) ? ov.dayRate : null;
}
/** A commission for one worker's Salary row: days × ₪/day for a daily-paid worker with a day rate, else hours × ₪/h. */
export function commissionFor(w: AccWorker | null | undefined, e: { hours: number; days?: number; daysUsed?: number }, hourRate: unknown, dayRate: unknown): number {
  if (isDailyPay(w) && Number(dayRate) > 0) return (Number(e.daysUsed != null ? e.daysUsed : e.days) || 0) * Number(dayRate);
  return (Number(e.hours) || 0) * (Number(hourRate) || 0);
}
/** The supplier's own rate on a date: the newest entry from on or before it (an emptied rate = the default). */
export function supplierRateOn(list: CommissionRate[] | null | undefined, date: Date): CommissionRate | null {
  const d = localYMD(date);
  let best: CommissionRate | null = null;
  (list || []).forEach(x => { if (x && (!x.from || x.from <= d) && (!best || String(x.from || '') >= String(best.from || ''))) best = x; });
  const b = best as CommissionRate | null;
  return b && b.rate != null && b.rate !== '' ? b : null;
}
/** One shift by the supplier's own rate: by the hour, by the day once per day worked, or the default ₪/h. */
export function supplierShiftCommission(list: CommissionRate[] | null | undefined, h: number, date: Date, seenDays: Set<string>): number {
  const r = supplierRateOn(list, date);
  if (!r) return h * SUPPLIER_DEFAULT_RATE;
  if (r.mode === 'day') { const k = localYMD(date); if (seenDays.has(k)) return 0; seenDays.add(k); return Number(r.rate) || 0; }
  return h * (Number(r.rate) || 0);
}
export function workerHasSupplierOverride(w: AccWorker | null | undefined, sid: string): boolean {
  const ov = w && w.supplierRates && w.supplierRates[sid];
  return !!ov && (ov.rate != null || (isDailyPay(w) && Number(ov.dayRate) > 0));
}
/** A Salary row's supplier commission: the worker's override, else the per-shift sum of the supplier's own rate. */
export function supplierCommission(wc: AccWorker, e: SalaryEntry, sid: string): number {
  if (workerHasSupplierOverride(wc, sid)) return commissionFor(wc, e, supplierCommissionRate(wc, sid), supplierDayCommission(wc, sid));
  return Number(e.supCom) || 0;
}

// ── The period ──
/** The punches of a period: This Week (from Sunday), This Month, a month `m:YYYY-MM`, or all. */
export function periodPunches<P extends { ts: Punch['ts'] }>(log: P[], period: string): P[] {
  const now = new Date();
  if (period === 'week') {
    const ws = new Date(now); ws.setDate(ws.getDate() - ws.getDay()); ws.setHours(0, 0, 0, 0);
    return log.filter(e => new Date(e.ts) >= ws);
  }
  if (period === 'month') {
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    return log.filter(e => new Date(e.ts) >= ms);
  }
  if (/^m:\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.slice(2).split('-').map(Number);
    const from = new Date(y, m - 1, 1), to = new Date(y, m, 1);
    return log.filter(e => { const d = new Date(e.ts); return d >= from && d < to; });
  }
  return log;
}
/** The month of a period (This Month or `m:YYYY-MM`), else null. */
export function salaryMonthOf(period: string | null | undefined): string | null {
  if (period === 'month') return localYMD(new Date()).slice(0, 7);
  return /^m:\d{4}-\d{2}$/.test(period || '') ? (period as string).slice(2) : null;
}
const PERIOD_LABELS: Record<string, string> = { week: 'This Week', month: 'This Month', all: 'All Time' };
/** The period choices: This Week, This Month, each of the 12 previous months, All Time. */
export function periodOptions(tr: Translate, locale: string): [string, string][] {
  const now = new Date(), opts: [string, string][] = [['week', tr(PERIOD_LABELS.week)], ['month', tr(PERIOD_LABELS.month)]];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push(['m:' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), d.toLocaleDateString(locale, { month: 'long', year: 'numeric' })]);
  }
  opts.push(['all', tr(PERIOD_LABELS.all)]);
  return opts;
}
export function periodLabel(period: string, tr: Translate, locale: string): string {
  const o = periodOptions(tr, locale).find(([v]) => v === period);
  return o ? o[1] : period;
}

// ── Salary ──
/**
 * The Salary rows for one period, per worker: hours split into regular / OT /
 * Shabbat, days, pay (shiftPayFor, each shift at its own client; a daily-paid
 * worker's days set by hand win), travel, warnings, the supplier's own
 * commission shift by shift; plus the billable-by-client figures and the
 * hours per day (the chart).
 */
export function salaryEntriesFor(d: AccData, period: string): { byWorker: Record<string, SalaryEntry>; byClient: Record<string, ClientBill>; byDay: Record<string, number> } {
  const { workers, clients, suppliers, tr } = d;
  const filtered = periodPunches(d.log, period);
  // Pair IN/OUT per worker into shifts (by workerId; an overnight shift stays one).
  const byWorkerPunches: Record<string, AccPunch[]> = {};
  filtered.forEach(e => { (byWorkerPunches[e.workerId] = byWorkerPunches[e.workerId] || []).push(e); });
  const byWorkerDay: Record<string, { worker: string; workerId: string; date: Date; entries: AccPunch[] }> = {};
  Object.entries(byWorkerPunches).forEach(([wid, list]) => {
    groupPunchesIntoShifts(list).forEach((bucket, i) => {
      byWorkerDay[wid + '|' + i] = { worker: list[0].workerName as string, workerId: wid, date: bucket.date, entries: bucket.entries };
    });
  });
  const byWorker: Record<string, SalaryEntry> = {};
  const byClient: Record<string, ClientBill> = {};
  const byDay: Record<string, number> = {};
  Object.values(byWorkerDay).forEach(({ worker, workerId, date, entries }) => {
    if (!byWorker[workerId]) byWorker[workerId] = { worker, workerId, hours: 0, days: 0, regH: 0, otH: 0, shabH: 0, total: 0, travel: 0, warns: [], clientHours: {}, seen: new Set(), dayKeys: new Set(), countedDays: 0, daysUsed: 0 };
    const bw = byWorker[workerId];
    const res = analyzeDayPunches(entries, date, { tr });
    const dstr = date.toLocaleDateString('en-GB');
    res.warnings.forEach(wn => bw.warns.push(dstr + ': ' + wn));
    const h = res.hours;
    if (h > 0) {
      const isSat = date.getDay() === 6, RM = PAY_RULES.regularMax;
      const wc = byId(workers, workerId);
      if (isSat) bw.shabH += h;
      else { bw.regH += Math.min(h, RM); bw.otH += Math.max(h - RM, 0); }
      bw.hours += h;
      bw.days++;
      // The shift's own client (its opening punch) picks up a per-client rate.
      const cid = entries[0] && entries[0].clientId;
      bw.total += shiftPayFor(h, wc, isSat, cid, date, bw.seen, clients);
      if (wc && wc.supplierId) {
        const sp = byId(suppliers, wc.supplierId);
        bw.supCom = (bw.supCom || 0) + supplierShiftCommission(sp && sp.commission, h, date, bw.supDays || (bw.supDays = new Set()));
      }
      const ymd = localYMD(date);
      bw.dayKeys.add(ymd);
      byDay[ymd] = (byDay[ymd] || 0) + h;
      if (cid) bw.clientHours[cid] = (bw.clientHours[cid] || 0) + h;
      // Billable by client: a parallel figure, never part of the wage above.
      if (cid) {
        if (!byClient[cid]) byClient[cid] = { hours: 0, total: 0 };
        byClient[cid].hours += h;
        byClient[cid].total += clientBillPay(h, byId(clients, cid), isSat);
      }
    }
  });
  // Days worked (from the punches); a daily-paid worker's days set by hand replace them.
  const periodKey = salaryPeriodKey(period);
  Object.values(byWorker).forEach(e => {
    e.countedDays = e.dayKeys.size;
    const wc = byId(workers, e.workerId), ov = isDailyPay(wc) ? dayOverride(wc, periodKey) : null;
    if (ov != null) e.total = ov * dailyRate(wc);
    e.daysUsed = ov != null ? ov : e.countedDays;
    e.travel = travelPay(wc, e.daysUsed, new Set([...e.dayKeys].map(k => k.slice(0, 7))).size);
  });
  return { byWorker, byClient, byDay };
}

/** The client a worker's row reads its rate from: where it had most hours, else its first client. */
export function mainClientOf(e: SalaryEntry, wc: AccWorker | undefined): string {
  return Object.entries(e.clientHours || {}).sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || ((wc && wc.clientIds) || [])[0] || '';
}
/** A row's rate as shown: own ₪/day (or none), own ₪/h, the client's ₪/h, or none. */
export type RateShown = { kind: 'day' | 'day-none' | 'hour' | 'client' | 'none'; value?: number | string };
export function rateShown(d: AccData, e: SalaryEntry): RateShown {
  const wc = byId(d.workers, e.workerId);
  const er = wc ? effectiveRates(wc, mainClientOf(e, wc), d.clients) : { regRate: 0 };
  const daily = isDailyPay(wc), own = wOwnRate(wc);
  if (daily) return own !== '' ? { kind: 'day', value: own as number | string } : { kind: 'day-none' };
  if (own !== '') return { kind: 'hour', value: own as number | string };
  return er.regRate > 0 ? { kind: 'client', value: er.regRate } : { kind: 'none' };
}
/** A daily-paid worker whose days for this period were set by hand. */
export function daysByHand(d: AccData, e: SalaryEntry, period: string): boolean {
  const wc = byId(d.workers, e.workerId);
  return isDailyPay(wc) && dayOverride(wc, salaryPeriodKey(period)) != null;
}
/** The totals over the rows shown: hours, pay, travel, pay + travel. */
export function salaryTotals(rows: SalaryEntry[]): { hours: number; pay: number; travel: number; total: number } {
  const hours = rows.reduce((s, e) => s + e.hours, 0);
  const pay = rows.reduce((s, e) => s + e.total, 0), travel = rows.reduce((s, e) => s + e.travel, 0);
  return { hours, pay, travel, total: pay + travel };
}
/** The figures on top: the period's hours and payroll (pay + travel) over every row. */
export function accFigures(rows: SalaryEntry[]): { hours: number; payroll: number } {
  return { hours: rows.reduce((t, e) => t + e.hours, 0), payroll: rows.reduce((t, e) => t + e.total + e.travel, 0) };
}
/** Search by name (the totals follow the rows shown). */
export function searchRows(rows: SalaryEntry[], q: string): SalaryEntry[] {
  q = (q || '').trim().toLowerCase();
  return q ? rows.filter(e => String(e.worker || '').toLowerCase().includes(q)) : rows;
}
/** An HR's commission on one of its workers' rows (its ₪/h, or ₪/day for a daily-paid worker). */
export function hrCommission(d: AccData, e: SalaryEntry, rate: unknown, dayRate: unknown): number {
  return commissionFor(byId(d.workers, e.workerId), e, Number(rate) || 0, Number(dayRate) || 0);
}

// ── Alerts ──
export type AccAlert = {
  sec: 'punch' | 'pay' | 'client'; lvl: 'red' | 'amber'; icon: string; title: string; sub: string;
  /** what a tap opens: the worker card, the pay window, the client window */
  go: ['worker' | 'pay' | 'client', string];
};
/** Every accounting-only warning of the period's rows: punches (not a shift still running today), rates and pay, clients with no billing rate. */
export function accAlerts(d: AccData, entries: SalaryEntry[], byClient: Record<string, ClientBill>): AccAlert[] {
  const { tr } = d, out: AccAlert[] = [], money = (n: unknown) => '₪' + Math.round(Number(n) || 0);
  entries.forEach(e => {
    const wc = byId(d.workers, e.workerId); if (!wc) return;
    (e.warns || []).forEach(wn => {
      if (/still at work/.test(wn)) return;
      const m = String(wn).match(/^([^:]+):\s*(.*)$/), date = m ? m[1] : '', text = m ? m[2] : wn;
      out.push({ sec: 'punch', lvl: /open shift|>12h/.test(text) ? 'amber' : 'red', icon: 'clock-exclamation', title: text, sub: [e.worker, date].filter(Boolean).join(' · '), go: ['worker', wc.id] });
    });
    const mainCid = mainClientOf(e, wc);
    const own = wOwnRate(wc);
    if (isDailyPay(wc)) { if (own === '') out.push({ sec: 'pay', lvl: 'red', icon: 'calendar-dollar', title: tr('No daily rate — pay 0'), sub: e.worker + ' · ' + tr('{n} days', { n: e.daysUsed }), go: ['pay', wc.id] }); }
    else if (own === '' && !(effectiveRates(wc, mainCid, d.clients).regRate > 0)) out.push({ sec: 'pay', lvl: 'red', icon: 'cash-off', title: tr('No rate — pay 0'), sub: e.worker + ' · ' + tr('{h}h', { h: e.hours.toFixed(1) }), go: ['pay', wc.id] });
    if (!(wc.bank || wc.bankBranch || wc.bankAccountNumber)) out.push({ sec: 'pay', lvl: 'amber', icon: 'building-bank', title: tr('No bank details'), sub: e.worker + (e.total > 0 ? ' · ' + money(e.total) : ''), go: ['pay', wc.id] });
  });
  Object.entries(byClient || {}).forEach(([cid, v]) => {
    const c = byId(d.clients, cid); if (!c || !(v.hours > 0)) return;
    if (!hasBillRate(c)) out.push({ sec: 'client', lvl: 'red', icon: 'receipt-off', title: tr('No billing rate — billed 0'), sub: (c.name || '') + ' · ' + tr('{h}h', { h: v.hours.toFixed(1) }), go: ['client', cid] });
  });
  return out;
}

// ── Billing ──
export type PayableRow = { id: string; name: string; color: string; hours: number; total: number };
/** Payable by supplier: per supplier its workers' hours and commission; only suppliers with hours and a commission. */
export function supplierPayable(d: AccData, entries: SalaryEntry[]): PayableRow[] {
  const bySupplier: Record<string, { hours: number; total: number }> = {};
  entries.forEach(e => {
    const wc = byId(d.workers, e.workerId);
    const sid = wc && wc.supplierId;
    if (!wc || !sid) return;
    if (!bySupplier[sid]) bySupplier[sid] = { hours: 0, total: 0 };
    bySupplier[sid].hours += e.hours;
    bySupplier[sid].total += supplierCommission(wc, e, sid);
  });
  return d.suppliers.filter(s => bySupplier[s.id] && bySupplier[s.id].hours > 0 && bySupplier[s.id].total > 0)
    .map(s => ({ id: s.id, name: s.name || '', color: s.color || '', ...bySupplier[s.id] }));
}
export type DetailRow = { name: string; hours: number; total: number };
/** The workers behind a supplier's sum: hours and commission, the largest first. */
export function supplierPayDetail(d: AccData, entries: SalaryEntry[], sid: string): DetailRow[] {
  return entries.map(e => ({ e, wc: byId(d.workers, e.workerId) })).filter(x => x.wc && x.wc.supplierId === sid)
    .map(({ e, wc }) => ({ name: e.worker, hours: e.hours, total: supplierCommission(wc as AccWorker, e, sid) }))
    .sort((a, b) => b.total - a.total);
}
export type HrPayableRow = { id: string; name: string; hours: number; rate: number; dayRate: number; total: number };
/** Payable by HR: per HR login its workers' hours and its commission; only HRs with hours and a commission. */
export function hrPayable(d: AccData, entries: SalaryEntry[], hrs: HrLogin[]): HrPayableRow[] {
  return hrs.map(u => {
    const mine = entries.filter(e => (byId(d.workers, e.workerId) || { hrId: null }).hrId === u.id);
    const hours = mine.reduce((t, e) => t + e.hours, 0);
    const rate = Number(u.commissionRate) || 0, dayRate = Number(u.commissionDayRate) || 0;
    const total = mine.reduce((t, e) => t + commissionFor(byId(d.workers, e.workerId), e, rate, dayRate), 0);
    return { id: u.id, name: u.fullName || u.username || '', hours, rate, dayRate, total };
  }).filter(r => r.hours > 0 && r.total > 0);
}
export type BillableRow = { id: string; name: string; color: string; mode: 'fixed' | 'daily' | 'tiered'; hours: number; total: number };
/** Billable by client: only clients with hours and a bill, in the order the shifts brought them. */
export function clientBillable(d: AccData, byClient: Record<string, ClientBill>): BillableRow[] {
  return Object.entries(byClient).map(([clientId, v]) => ({ cl: byId(d.clients, clientId), clientId, ...v }))
    .filter(r => r.cl && r.hours > 0 && r.total > 0)
    .map(r => { const cl = r.cl as AccClient;
      return { id: cl.id, name: cl.name || '', color: cl.color || '', mode: cl.rateMode === 'fixed' ? 'fixed' : cl.rateMode === 'daily' ? 'daily' : 'tiered', hours: r.hours, total: r.total }; });
}
/** The workers behind a client's bill: each one's hours there, the most first. */
export function clientBillDetail(entries: SalaryEntry[], cid: string): { name: string; hours: number }[] {
  return entries.filter(e => (e.clientHours || {})[cid] > 0).map(e => ({ name: e.worker, hours: e.clientHours[cid] })).sort((a, b) => b.hours - a.hours);
}

// ── The pay window ──
/** The pay window's figures: the client's rate (the placeholder), the period key the days are saved under, the days counted. */
export function payWindowFigures(d: AccData, w: AccWorker, period: string, entries: SalaryEntry[]) {
  const cid = (w.clientIds || [])[0];
  const clientRate = effectiveRates({ ...w, hourlyRate: 0, regRate: null, otRate: null, shabbatRate: null, clientRates: w.clientRates }, cid, d.clients);
  const key = salaryPeriodKey(period);
  const counted = (entries.find(e => e.workerId === w.id) || { countedDays: 0 }).countedDays || 0;
  return { daily: isDailyPay(w), own: wOwnRate(w), clientRate: clientRate.regRate, clientSrc: clientRate.src, key, days: dayOverride(w, key), counted };
}
/** The pay window's fields, as typed. */
export type PayForm = { mode: 'hourly' | 'daily'; rate: string; ot: string; shab: string; days: string; travelDay: string; travelMonth: string; bank: string; branch: string; account: string };
/** What the pay window writes on the worker (the old savePayModal): `regRate` cleared, the days of this period by hand (daily). */
export function payPatch(w: AccWorker & { dayOverrides?: Record<string, unknown> | null }, f: PayForm, key: string): Record<string, unknown> {
  const num = (s: string) => (s === '' ? null : (parseFloat(s) || 0));
  const p: Record<string, unknown> = {
    payMode: f.mode === 'daily' ? 'daily' : undefined,
    hourlyRate: num(f.rate) || 0, regRate: null, otRate: num(f.ot), shabbatRate: num(f.shab),
    travelAllowance: num(f.travelDay) || 0, travelMonthly: num(f.travelMonth) || 0,
    bank: f.bank.trim(), bankBranch: f.branch.trim(), bankAccountNumber: f.account.trim(),
  };
  if (f.mode === 'daily') {
    const ov: Record<string, unknown> = { ...(w.dayOverrides || {}) };
    if (f.days === '') delete ov[key]; else ov[key] = Math.max(0, Math.round(Number(f.days) || 0));
    p.dayOverrides = Object.keys(ov).length ? ov : undefined;
  }
  return p;
}

// ── Exports ──
export type ExportRow = { worker: string; client: string; supplier: string; date: string; firstIn: string; lastOut: string; hours: number; rate: number | string; pay: number; notes: string };
/** The client object of a punch (its own client), else the worker's first client. */
function shiftObject(d: AccData, e: AccPunch | undefined, wid: string): string {
  if (e && e.clientId) { const c = byId(d.clients, e.clientId); if (c) return c.object || c.name || ''; }
  const w = byId(d.workers, wid);
  if (!w) return '';
  const c = (w.clientIds || []).map(id => byId(d.clients, id)).filter(Boolean)[0];
  return c ? (c.object || c.name || '') : '';
}
/** One row per shift (workers by name, then by date), each priced by shiftPayFor; a daily worker's days set by hand add one row. */
export function buildSalaryExportRows(d: AccData, period: string, onlyIds?: string[] | null): ExportRow[] {
  const { tr } = d;
  const only = onlyIds && onlyIds.length ? new Set(onlyIds.map(String)) : null;
  const log = d.log.filter(e => !only || only.has(String(e.workerId))); const now = new Date();
  const filtered = periodPunches(log, period);
  const byWorkerPunches: Record<string, AccPunch[]> = {};
  filtered.forEach(e => { (byWorkerPunches[e.workerId] = byWorkerPunches[e.workerId] || []).push(e); });
  const byWD: Record<string, { worker: string; wid: string; date: Date; entries: AccPunch[] }> = {};
  Object.entries(byWorkerPunches).forEach(([wid, list]) => {
    groupPunchesIntoShifts(list).forEach((bucket, i) => {
      byWD[wid + '|' + i] = { worker: list[0].workerName as string, wid, date: bucket.date, entries: bucket.entries };
    });
  });
  const rows: ExportRow[] = [], seenBy: Record<string, Set<string>> = {};
  Object.values(byWD).sort((a, b) => a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : (a.date.getTime() - b.date.getTime())).forEach(x => {
    const res = analyzeDayPunches(x.entries, x.date, { tr });
    const ins = x.entries.filter(p => p.type === 'in').map(p => p.time as string).sort();
    const outs = x.entries.filter(p => p.type === 'out').map(p => p.time as string).sort();
    const w = byId(d.workers, x.wid);
    const shiftClientId = x.entries[0] && x.entries[0].clientId;
    const daily = isDailyPay(w);
    const rate = daily ? dailyRate(w) : effectiveRates(w, shiftClientId, d.clients).regRate;
    const isSat = x.date.getDay() === 6;
    const seen = seenBy[x.wid] || (seenBy[x.wid] = new Set());
    const pay = res.hours > 0 ? shiftPayFor(res.hours, w, isSat, shiftClientId, x.date, seen, d.clients) : 0;
    const supName = (byId(d.suppliers, w?.supplierId) || { name: '' }).name || '';
    rows.push({ worker: x.worker, client: shiftObject(d, x.entries[0], x.wid), supplier: supName, date: x.date.toLocaleDateString('en-GB'), firstIn: ins[0] || '', lastOut: outs[outs.length - 1] || '', hours: res.hours, rate: daily ? rate + tr('/day') : rate, pay, notes: res.warnings.join('; ') });
  });
  const key = salaryPeriodKey(period, now);
  Object.entries(seenBy).forEach(([wid, seen]) => {
    const w = byId(d.workers, wid), ov = isDailyPay(w) ? dayOverride(w, key) : null;
    if (!w || ov == null || ov === seen.size) return;
    rows.push({ worker: w.name || '', client: '', supplier: (byId(d.suppliers, w.supplierId) || { name: '' }).name || '', date: '', firstIn: '', lastOut: '', hours: 0,
      rate: dailyRate(w) + tr('/day'), pay: (ov - seen.size) * dailyRate(w), notes: tr('Days set by hand: {n} (punches: {m})', { n: ov, m: seen.size }) });
  });
  return rows;
}
const SALARY_HEAD = ['Worker', 'Object/Client', 'Supplier', 'Date', 'First In', 'Last Out', 'Hours', 'Rate (₪/h or /day)', 'Day Pay (₪)', 'Notes'];
/** The salary export's table (Excel / PDF / CSV): the header, a row per shift, the total row (the CSV leaves it out). */
export function salaryExportAoa(d: AccData, period: string, onlyIds?: string[] | null): (string | number)[][] {
  const { tr } = d, rows = buildSalaryExportRows(d, period, onlyIds);
  const header = SALARY_HEAD.map(h => tr(h));
  const totalHours = rows.reduce((s, r) => s + r.hours, 0), totalPay = rows.reduce((s, r) => s + r.pay, 0);
  return [header, ...rows.map(r => [r.worker, r.client, r.supplier, r.date, r.firstIn, r.lastOut, r.hours.toFixed(2), r.rate, r.pay.toFixed(2), r.notes]),
    ['', '', '', '', '', tr('Total'), totalHours.toFixed(2), '', totalPay.toFixed(2), '']];
}

// ── Hours approvals (the hours function's documents) ──
export type ApprovalDay = { status?: string; line?: string; comment?: string; inT?: string; outT?: string; byName?: string; at?: string | number };
export type ApprovalDoc = { id: string; kind: 'client' | 'supplier' | 'hr'; ownerId: string; ownerName?: string; ownOnly?: boolean; days?: Record<string, ApprovalDay>; signed?: { path?: string; at?: string | number; byName?: string } };
export const HOUR_STATES: Record<string, { color: string; icon: string; label: string }> = {
  approved: { color: 'var(--ok)', icon: 'circle-check', label: 'Approved' },
  fixed: { color: 'var(--ok)', icon: 'circle-check', label: 'Fix accepted' },
  changed: { color: 'var(--warn)', icon: 'alert-triangle', label: 'Changed after approval' },
  disputed: { color: 'var(--warn)', icon: 'alert-triangle', label: 'Disputed' },
  fix: { color: 'var(--accent)', icon: 'pencil', label: 'Fix proposed' },
  rejected: { color: 'var(--bad)', icon: 'circle-x', label: 'Fix rejected' },
  pending: { color: 'var(--ink-3)', icon: 'clock', label: 'Waiting for approval' },
};
export const HOUR_KINDS: Record<string, string> = { client: 'Client', supplier: 'Supplier', hr: 'HR' };
/** The days of a login's scope this month: {"<worker>|<day>": line}, paired like the hours review. */
export function hourDayLines(d: AccData, doc: ApprovalDoc, month: string): Record<string, string> {
  const [y, m] = month.split('-').map(Number), from = new Date(y, m - 1, 1), to = new Date(y, m, 1);
  const lo = new Date(y, m - 1, 0), hi = new Date(y, m, 2);
  let pick: (e: AccPunch) => boolean;
  if (doc.kind === 'client') pick = e => e.clientId === doc.ownerId;
  else {
    let ids: Set<string> | null = null;
    if (doc.kind === 'supplier') ids = new Set(d.workers.filter(w => w.supplierId === doc.ownerId).map(w => w.id));
    else if (doc.ownOnly !== false) ids = new Set(d.workers.filter(w => w.hrId === doc.ownerId).map(w => w.id));
    pick = e => !ids || ids.has(e.workerId);
  }
  const byW: Record<string, AccPunch[]> = {};
  d.log.filter(e => { const t = new Date(e.ts); return t >= lo && t < hi && pick(e); }).forEach(e => { (byW[e.workerId] = byW[e.workerId] || []).push(e); });
  const days: Record<string, [string, string][]> = {};
  Object.entries(byW).forEach(([wid, list]) => groupPunchesIntoShifts(list).forEach(b => {
    if (b.date < from || b.date >= to) return;
    const inE = b.entries.find(e => e.type === 'in'), outE = [...b.entries].reverse().find(e => e.type === 'out');
    const k = wid + '|' + localYMD(b.date); (days[k] = days[k] || []).push([(inE && inE.time) || '', (outE && outE.time) || '']);
  }));
  const out: Record<string, string> = {};
  Object.entries(days).forEach(([k, sh]) => { out[k] = [k, sh.map(x => x[0]).join(','), sh.map(x => x[1]).join(',')].join('|'); });
  return out;
}
/** A day's state: its stored status, or "changed" when an approved / fixed day's line no longer matches its shifts. */
export function hourEntryState(e: ApprovalDay, line: string): string {
  if ((e.status === 'approved' || e.status === 'fixed') && e.line !== line) return 'changed';
  return e.status || 'pending';
}
export type OpenDay = { k: string; e: ApprovalDay; st: string; times: string; fix: string };
/** One login's month: the days approved, the days counted, the days that need a look (by date) with their times as now punched. */
export function hourApprovalSummary(d: AccData, doc: ApprovalDoc, month: string): { lines: Record<string, string>; open: OpenDay[]; done: number; total: number; allOk: boolean } {
  const lines = hourDayLines(d, doc, month), days = doc.days || {};
  const open = Object.entries(days).map(([k, e]) => ({ k, e, st: hourEntryState(e, lines[k] || '') }))
    .filter(x => x.st !== 'approved' && x.st !== 'fixed').sort((a, b) => a.k.split('|')[1].localeCompare(b.k.split('|')[1]))
    .map(x => {
      const now = (lines[x.k] || '').split('|');
      const times = now.length === 4 ? now[2].split(',').map((t, i) => (t || '--:--') + '–' + (now[3].split(',')[i] || '--:--')).join(', ') : '';
      return { ...x, times, fix: x.e.inT ? ' → ' + x.e.inT + '–' + x.e.outT : '' };
    });
  const done = Object.entries(days).filter(([k, e]) => hourEntryState(e, lines[k] || '') === 'approved' || hourEntryState(e, lines[k] || '') === 'fixed').length;
  const total = new Set([...Object.keys(lines), ...Object.keys(days)]).size;
  return { lines, open, done, total, allOk: !open.length && done >= total };
}
/** The month's documents that hold a day, by kind and name. */
export function approvalDocsShown(docs: ApprovalDoc[]): ApprovalDoc[] {
  return docs.filter(x => Object.keys(x.days || {}).length).sort((a, b) => (a.kind + a.ownerName).localeCompare(b.kind + b.ownerName));
}

// ── The accountant report ──
/** The accountant's workbook: Summary (a row per worker from the Salary rows, a total row), Shifts, and for a month Hours approvals. */
export function accountantSheets(d: AccData, period: string, approvals: ApprovalDoc[] | null, firmName: string, locale: string): { summary: (string | number)[][]; shifts: (string | number)[][]; approvals?: (string | number)[][] } {
  const { tr } = d, month = salaryMonthOf(period);
  const { byWorker } = salaryEntriesFor(d, period);
  const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100, hrs = money;
  const head = ['Worker', 'ID / Passport', 'Supplier', 'Pay mode', 'Rate', 'Days', 'Regular hours', 'Overtime hours', 'Shabbat hours', 'Total hours', 'Pay (₪)', 'Travel (₪)', 'Total (₪)', 'Bank', 'Branch', 'Account', 'Warnings'].map(h => tr(h));
  const list = Object.values(byWorker).map(e => ({ e, w: byId(d.workers, e.workerId) || ({ id: e.workerId, name: e.worker } as AccWorker) }))
    .sort((a, b) => String(a.w.name || '').localeCompare(String(b.w.name || '')));
  const rows: (string | number)[][] = list.map(({ e, w }) => [w.name || e.worker, workerDocId(w as never) || '', (byId(d.suppliers, w.supplierId) || { name: '' }).name || '',
    isDailyPay(w) ? tr('By the day') : tr('By the hour'), isDailyPay(w) ? dailyRate(w) : ((wOwnRate(w) as number | string) || ''),
    e.daysUsed, hrs(e.regH), hrs(e.otH), hrs(e.shabH), hrs(e.hours), money(e.total), money(e.travel), money(e.total + e.travel),
    w.bank || '', w.bankBranch || '', w.bankAccountNumber || '', e.warns.length]);
  const sum = (k: 'regH' | 'otH' | 'shabH' | 'hours' | 'total' | 'travel' | 'grand') => money(list.reduce((s, { e }) => s + (k === 'grand' ? e.total + e.travel : e[k]), 0));
  rows.push([tr('Total'), '', '', '', '', list.reduce((s, { e }) => s + e.daysUsed, 0), sum('regH'), sum('otH'), sum('shabH'), sum('hours'), sum('total'), sum('travel'), sum('grand'), '', '', '', '']);
  const shifts = buildSalaryExportRows(d, period);
  const sRows = shifts.map(r => [r.worker, r.client, r.supplier, r.date, r.firstIn, r.lastOut, hrs(r.hours), r.rate, money(r.pay), r.notes]);
  const title = [tr('Accountant report — {period}', { period: periodLabel(period, tr, locale) })], firm = [firmName || ''];
  const out: { summary: (string | number)[][]; shifts: (string | number)[][]; approvals?: (string | number)[][] } = {
    summary: [title, firm, [], head, ...rows], shifts: [SALARY_HEAD.map(h => tr(h)), ...sRows],
  };
  if (month && approvals && approvals.length) {
    const aRows: (string | number)[][] = [];
    approvals.forEach(doc => {
      const lines = hourDayLines(d, doc, month), who = doc.ownerName || doc.ownerId, kind = tr(HOUR_KINDS[doc.kind] || HOUR_KINDS.client);
      Object.entries(doc.days || {}).sort((x, y) => x[0].split('|')[1].localeCompare(y[0].split('|')[1])).forEach(([k, e]) => {
        const [wid, day] = k.split('|');
        aRows.push([who, kind, (byId(d.workers, wid) || { name: '' }).name || wid, day, tr((HOUR_STATES[hourEntryState(e, lines[k] || '')] || HOUR_STATES.pending).label),
          e.inT ? e.inT + '–' + e.outT : '', e.comment || '', e.byName || '', e.at ? new Date(e.at).toLocaleString('en-GB') : '']);
      });
    });
    out.approvals = [[tr('Login'), tr('Role'), tr('Worker'), tr('Date'), tr('Status'), tr('Proposed fix'), tr('Comment'), tr('By'), tr('When')], ...aRows];
  }
  return out;
}
/** A summary the caller computed ({label, hours, rate, total}) as a sheet: the header, the rows, the total row. */
export function payableAoa(rows: { label: string; hours: number; rate: string; total: number }[], tr: Translate): (string | number)[][] {
  const grand = rows.reduce((s, r) => s + r.total, 0);
  return [['Label', 'Hours', 'Rate', 'Total'].map(h => tr(h)), ...rows.map(r => [r.label, r.hours.toFixed(2), r.rate, r.total.toFixed(2)]), ['', '', tr('Total'), grand.toFixed(2)]];
}
