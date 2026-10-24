// My Schedule and My Hours (docs/punch.md): the worker's planned days, the next
// shift, and the month's hours and pay — summed with the one payroll copy
// (src/lib/payroll.ts) exactly as Accounting → Salary does for a month
// (salaryEntriesFor): punches paired into shifts, the shifts that opened in the month, each shift
// priced by shiftPayFor, daily days set by hand, travel. An estimate before
// deductions; the payslip is the final figure.
import { tr, uiLocale } from '@/lib/i18n';
import {
  analyzeDayPunches, dailyRate, dayOverride, groupPunchesIntoShifts, isDailyPay, localYMD, PAY_RULES, shiftPayFor, travelPay,
  type PayClient, type PayWorker, type Punch,
} from '@/lib/payroll';
import { getPunchLog, getState, punchFn, set, URL_TOKEN, wpToken, type MonthData, type PWorker } from './core';

// ── My Schedule ──
export interface SchedDay { work: boolean; start?: string; end?: string; night?: boolean; hours: number; dated: boolean }
/** A day of the worker's roster: a change for that date wins over the weekly roster (Sunday first). */
export function schedDay(w: PWorker | null, d: Date): SchedDay {
  const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const dated = w && w.dates && w.dates[k];
  const day = dated || ((w && w.schedule) || [])[d.getDay()] || {};
  if (!(day.type === 'work' && day.start && day.end)) return { work: false, hours: 0, dated: !!dated };
  const toM = (t: string) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  let m = toM(day.end) - toM(day.start); const night = m <= 0; if (night) m += 1440;
  return { work: true, start: day.start, end: day.end, night, hours: m / 60, dated: !!dated };
}
/** The My Schedule tile: the next planned shift in the coming two weeks. */
export function nextShiftText(w: PWorker | null): string {
  if (!w) return '—';
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i), sh = schedDay(w, d);
    if (sh.work && sh.start) {
      if (i === 0 && sh.end && sh.end > sh.start && String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') > sh.end) continue;
      const day = i === 0 ? tr('Today') : i === 1 ? tr('Tomorrow') : d.toLocaleDateString(uiLocale(), { weekday: 'short', day: 'numeric' });
      return day + ' · ' + sh.start + '–' + (sh.end || '');
    }
  }
  return tr('No shifts planned yet');
}

// ── My Hours ──
/** The months read during this visit ('YYYY-MM' → the punch function's myMonth reply, or this device's punches). */
export const hoursData: Record<string, MonthData> = {};
export const monthKey = (offset: number) => { const n = new Date(); return localYMD(new Date(n.getFullYear(), n.getMonth() + offset, 1)).slice(0, 7); };

/** This device's own punches of the worker: offline or on an error (no pay figures). */
function localMonthData(): MonthData {
  const w = getState().worker!;
  return { local: true, pay: { id: w.id }, clients: [], punches: getPunchLog().filter(e => e.workerId === w.id) as unknown as Record<string, unknown>[] };
}
const bump = () => set({ rev: getState().rev + 1 });
/** One month from the punch function (myMonth: own punches, own pay inputs, the sites' worker-pay rates). */
export async function loadMonth(key: string) {
  if (!URL_TOKEN) { hoursData[key] = localMonthData(); bump(); return; }
  try {
    const r = await (await punchFn({ action: 'myMonth', token: wpToken(), month: key })).json();
    hoursData[key] = (r && !r.error) ? r : (hoursData[key] || { failed: true });
  } catch { hoursData[key] = hoursData[key] && !hoursData[key].failed ? hoursData[key] : { failed: true }; }
  if (hoursData[key].failed) { const l = localMonthData(); if (l.punches!.length) hoursData[key] = l; }
  bump();
}
// The My Hours tile reads this month in the background, at most once a minute.
let _tileAt = 0;
export function refreshTileHours() {
  const key = localYMD(new Date()).slice(0, 7), d = hoursData[key];
  if (d && d.punches) { try { set({ tileHours: tr('{h}h', { h: myMonthFigures(d, key).hours.toFixed(1) }) }); } catch { /* bad data */ } }
  if (URL_TOKEN && navigator.onLine && Date.now() - _tileAt > 60e3) {
    _tileAt = Date.now();
    punchFn({ action: 'myMonth', token: wpToken(), month: key }).then(r => r.json()).then(r => {
      if (r && !r.error) { hoursData[key] = r; try { set({ tileHours: tr('{h}h', { h: myMonthFigures(r, key).hours.toFixed(1) }) }); } catch { /* bad data */ } }
    }).catch(() => {});
  }
}

export interface MonthShift { date: Date; inT?: string; outT?: string; h: number; pay: number; entries: (Punch & { type: string; time?: string; ts: string; dist?: number; clientId?: string; site?: string })[] }
export interface MonthFigures { shifts: MonthShift[]; hours: number; regH: number; otH: number; shabH: number; total: number; travel: number; days: number; ov: number | null; hasRate: boolean }
/** The month summed exactly as Accounting → Salary does for 'm:YYYY-MM' — no second calculation. */
export function myMonthFigures(data: MonthData, key: string): MonthFigures {
  const clients = (data.clients || []) as PayClient[];
  const w = (data.pay || {}) as PayWorker;
  const [y, m] = key.split('-').map(Number), from = new Date(y, m - 1, 1), to = new Date(y, m, 1);
  // Paired over every punch read (the server sends a day each side), a shift
  // kept in the month it opened — an overnight shift at the month's end whole.
  const list = (data.punches || []) as unknown as MonthShift['entries'];
  const seen = new Set<string>(), dayKeys = new Set<string>(), shifts: MonthShift[] = [];
  let hours = 0, regH = 0, otH = 0, shabH = 0, total = 0;
  groupPunchesIntoShifts(list).filter(b => b.date >= from && b.date < to).forEach(b => {
    const h = analyzeDayPunches(b.entries, b.date).hours;
    const inE = b.entries.find(e => e.type === 'in'), outE = b.entries.find(e => e.type === 'out');
    let pay = 0;
    if (h > 0) {
      const isSat = b.date.getDay() === 6, RM = PAY_RULES.regularMax;
      if (isSat) shabH += h; else { regH += Math.min(h, RM); otH += Math.max(h - RM, 0); }
      hours += h;
      pay = shiftPayFor(h, w, isSat, b.entries[0] && b.entries[0].clientId, b.date, seen, clients);
      total += pay;
      dayKeys.add(localYMD(b.date));
    }
    shifts.push({ date: b.date, inT: inE && inE.time, outT: outE && outE.time, h, pay, entries: b.entries });
  });
  const ov = isDailyPay(w) ? dayOverride(w, 'm:' + key) : null;
  if (ov != null) total = ov * dailyRate(w);
  const days = ov != null ? ov : dayKeys.size;
  const travel = travelPay(w, days, dayKeys.size ? 1 : 0);
  const hasRate = !data.local && (isDailyPay(w) ? dailyRate(w) > 0 : true);
  return { shifts, hours, regH, otH, shabH, total, travel, days, ov, hasRate };
}
export const money = (n: number) => '₪' + (Number(n) || 0).toLocaleString(uiLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 });
