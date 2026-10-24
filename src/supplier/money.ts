// The supplier's hours, pay and commission (docs/portals.md → Supplier login).
// Hours and pay come only from the one payroll copy (src/lib/payroll.ts) with
// this page's clients (the firm's clients with their worker-pay rates only),
// so a worker's pay is the same figure as in the manager's Salary table.
// Commission is independent of pay. myRateOn / myShiftCommission are copies of
// the manager app's supplierRateOn / supplierShiftCommission, and myCommission
// of its commissionFor rule — keep them the same (CLAUDE.md → Duplicated on purpose).
import {
  analyzeDayPunches, dailyRate, dayOverride, effectiveRates, groupPunchesIntoShifts, isDailyPay, localYMD, shiftPayFor,
} from '@/lib/payroll';
import { tr } from '@/lib/i18n';
import type { CommissionRate, SClient, SPunch, SupplierData, SWorker } from './api';

export interface MonthShift { date: Date; inTime: string; outTime: string; hours: number }

/** The worker's shifts in a month (year, month 0–11): the first IN, the last OUT, the hours (the short check). */
export function workerMonthShifts(punches: SPunch[], workerId: string, year: number, month: number): MonthShift[] {
  return groupPunchesIntoShifts(punches.filter(e => e.workerId === workerId))
    .filter(b => b.date.getFullYear() === year && b.date.getMonth() === month)
    .map(b => {
      const res = analyzeDayPunches(b.entries, b.date);
      const ins = b.entries.filter(x => x.type === 'in').map(x => String(x.time || '')).sort();
      const outs = b.entries.filter(x => x.type === 'out').map(x => String(x.time || '')).sort();
      return { date: b.date, inTime: ins[0] || '', outTime: outs[outs.length - 1] || '', hours: res.hours };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ── Commission ──
/** My own rate on a date: the latest entry that applies from on or before it. */
export function myRateOn(list: CommissionRate[], date: Date): CommissionRate | null {
  const d = localYMD(date);
  let best: CommissionRate | null = null;
  (list || []).forEach(x => { if (x && (!x.from || x.from <= d) && (!best || String(x.from || '') >= String(best.from || ''))) best = x; });
  const b = best as CommissionRate | null;
  return b && b.rate != null && b.rate !== '' ? b : null;
}
/** One shift priced by my rate: by the hour, by the day once per day, or 5 ₪/h. */
export function myShiftCommission(list: CommissionRate[], h: number, date: Date, seenDays: Set<string>): number {
  const r = myRateOn(list, date);
  if (!r) return h * 5;
  if (r.mode === 'day') { const k = localYMD(date); if (seenDays.has(k)) return 0; seenDays.add(k); return Number(r.rate) || 0; }
  return h * (Number(r.rate) || 0);
}
const hasDayRate = (w: SWorker) => w.supplierDayRate != null && Number(w.supplierDayRate) > 0;
export const hasOwnCommission = (w: SWorker) => w.supplierRate != null || hasDayRate(w);
/** A worker's own override: days × ₪/day for a daily-paid worker with one, else hours × ₪/h (default 5). */
export function myCommission(w: SWorker, hours: number, days: number): number {
  if (hasDayRate(w)) return days * Number(w.supplierDayRate);
  return hours * (w.supplierRate != null ? w.supplierRate : 5);
}
/** A worker's month: his override, else the shifts priced by my rate on their dates. */
export function myMonthCommission(w: SWorker, list: CommissionRate[], shifts: { date: Date; hours: number }[], hours: number, days: number): number {
  if (hasOwnCommission(w)) return myCommission(w, hours, days);
  const seen = new Set<string>();
  return shifts.reduce((t, s) => t + (s.hours > 0 ? myShiftCommission(list, s.hours, s.date, seen) : 0), 0);
}
export function myRateLabel(w: SWorker, list: CommissionRate[]): string {
  if (hasDayRate(w)) return tr('₪{0}/day', { 0: String(w.supplierDayRate) });
  if (w.supplierRate != null) return '₪' + w.supplierRate + '/h';
  const r = myRateOn(list, new Date());
  return r ? (r.mode === 'day' ? tr('₪{0}/day', { 0: String(r.rate) }) : '₪' + r.rate + '/h') : '₪5/h';
}
/** The commission figure on a worker's plate (₪/h or ₪/day), when the firm set one. */
export function plateRate(w: SWorker): string {
  if (hasDayRate(w)) return '₪' + w.supplierDayRate + '/' + tr('day');
  return w.supplierRate != null ? '₪' + w.supplierRate + '/h' : '';
}

/** The days set by hand for a month (as in the manager's Salary table): for a
 *  daily-paid worker, or one priced by a ₪/day commission — the server sends
 *  the day counts for the latter even without "sees pay" (a commission input,
 *  not a wage), so both portal figures equal the manager's commission. */
export function commissionDayOverride(w: SWorker, key: string): number | null {
  return isDailyPay(w) || hasDayRate(w) ? dayOverride(w, key) : null;
}

// ── The month's pay (only with "sees pay") ──
export interface PayRow { w: SWorker; hours: number; days: number; rate: string; pay: number; commission: number }
export function payRows(d: SupplierData, year: number, month: number): PayRow[] {
  const clients: SClient[] = d.clients;
  const key = 'm:' + year + '-' + String(month + 1).padStart(2, '0');
  return d.workers.map(w => {
    const seen = new Set<string>(), days = new Set<string>(), shifts: { date: Date; hours: number }[] = [];
    let hours = 0, pay = 0;
    groupPunchesIntoShifts(d.punches.filter(e => e.workerId === w.id))
      .filter(b => b.date.getFullYear() === year && b.date.getMonth() === month)
      .forEach(b => {
        const h = analyzeDayPunches(b.entries, b.date).hours;
        if (h <= 0) return;
        hours += h; days.add(localYMD(b.date)); shifts.push({ date: b.date, hours: h });
        pay += shiftPayFor(h, w, b.date.getDay() === 6, (b.entries[0] && b.entries[0].clientId) as string | undefined, b.date, seen, clients);
      });
    const daily = isDailyPay(w), ov = commissionDayOverride(w, key);
    if (ov != null && daily) pay = ov * dailyRate(w);
    const rate = daily ? dailyRate(w) : effectiveRates(w, (w.clientIds || [])[0], clients).regRate;
    const dd = ov != null ? ov : days.size;
    return { w, hours, days: dd, rate: daily ? '₪' + rate + '/day' : '₪' + rate + '/h', pay, commission: myMonthCommission(w, d.commission, shifts, hours, dd) };
  }).filter(r => r.hours > 0);
}

/** The payable summary: per worker with hours that month, its commission. */
export function summaryRows(d: SupplierData, year: number, month: number) {
  const key = 'm:' + year + '-' + String(month + 1).padStart(2, '0');
  return d.workers.map(w => {
    const shifts = workerMonthShifts(d.punches, w.id, year, month);
    const hours = shifts.reduce((s, x) => s + x.hours, 0);
    const days = new Set(shifts.filter(x => x.hours > 0).map(x => localYMD(x.date))).size;
    const ov = commissionDayOverride(w, key);
    const dd = ov != null ? ov : days;
    return { label: w.name, hours, rate: myRateLabel(w, d.commission), total: myMonthCommission(w, d.commission, shifts, hours, dd) };
  }).filter(r => r.hours > 0);
}
