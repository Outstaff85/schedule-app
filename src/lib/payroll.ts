// Payroll — the one copy of the shift pairing and the pay functions
// (docs/accounting.md). Moved unchanged from the pages in stage 2 of the React
// migration (archive/docs/react-migration-plan.md): the old pages load it as the
// classic script /payroll.js (built from this file by scripts/build-globals.mjs,
// a global `Payroll`) and call it through thin wrappers that pass their own
// `clients` list and `tr`; the new pages import it. tests/payroll/ runs it
// against the old copies (tests/payroll/legacy.mjs) and requires identical
// results (but for a pair from 1 November 2026 across a clock change or over
// 24h, which counts by its time stamps — PAIR_STAMPS_FROM, docs/history.md) —
// a change here is a payroll change.

// ── Data shapes (only the fields payroll reads) ──
export interface Punch {
  ts: string | number | Date;
  type: string; // 'in' | 'out'
  time?: string | null; // 'HH:MM'
  [k: string]: unknown;
}
export interface ShiftBucket<P extends Punch = Punch> {
  date: Date; // the date of the opening punch
  entries: P[];
}
type RateValue = number | string | null | undefined;
export interface ClientRates {
  rate?: RateValue;
  otRate?: RateValue;
  shabbatRate?: RateValue;
}
export interface PayWorker {
  regRate?: RateValue;
  hourlyRate?: RateValue;
  otRate?: RateValue;
  shabbatRate?: RateValue;
  clientRates?: Record<string, ClientRates | null | undefined> | null;
  payMode?: string | null; // 'daily' | anything else = hourly
  travelAllowance?: RateValue;
  travelMonthly?: RateValue;
  dayOverrides?: Record<string, RateValue> | null;
  [k: string]: unknown;
}
export interface PayClient {
  id: string;
  defaultHourlyRate?: RateValue;
  defaultOtRate?: RateValue;
  defaultShabbatRate?: RateValue;
  [k: string]: unknown;
}
export type RateSource = 'override' | 'worker' | 'client' | '';
export interface EffectiveRates {
  regRate: number;
  otRate: number;
  shabbatRate: number;
  hasOtOverride: boolean;
  hasShabbatOverride: boolean;
  src: RateSource;
  otSrc: RateSource;
  shabbatSrc: RateSource;
}
export interface DayPay {
  regularPay: number;
  otPay: number;
  total: number;
  isSat: boolean;
}
export type Translate = (text: string, params?: Record<string, unknown>) => string;
/** What each warning is, in step with `warnings` (the texts are translated;
 * the codes are what a page sorts them by — Accounting → Alerts). */
export type WarnCode = 'double-in' | 'out-no-in' | 'zero' | 'gt12' | 'open' | 'open-today';
export interface DayAnalysis {
  hours: number;
  warnings: string[];
  codes: WarnCode[];
}

// ── Pay rules (Israeli labour-law DEFAULTS — VERIFY against your real rules) ──
// regularMax: hours at base rate. ot1Span: next N hours at the first OT tier.
// Rates: weekday base x1.0 / OT1 x1.25 / OT2 x1.5 ; Saturday base x1.5 / x1.75 / x2.0.
// roundMinutes: round each session to nearest N minutes (0 = off; no change to pay).
export const PAY_RULES = { regularMax: 8, ot1Span: 2, roundMinutes: 0, otMult: 1.25, shabbatMult: 1.5 };

export function roundMins(m: number): number {
  const n = PAY_RULES.roundMinutes;
  return n > 0 ? Math.round(m / n) * n : m;
}

export function localYMD(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const tsOf = (p: Punch) => new Date(p.ts).getTime();
// Minutes since midnight of 'HH:MM'. Kept as each page had it: the manager's
// full check (analyzeDayPunches with tr) reads a time with no minutes as NaN,
// the portals' short one as HH:00.
const minsFull = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const minsShort = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const nowHHMM = () => { const n = new Date(); return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0'); };
// The minutes from one punch to a later one: from their time stamps, in whole
// minutes as the clock showed them — so a night across a clock change (Israel,
// last Sunday of October / Friday before the last Sunday of March) counts its
// real 9 or 7 hours and a forgotten OUT a day later counts 25h, not 1h. The
// 'HH:MM' strings (the old rule, a length under 24h) when a stamp is missing
// or unreadable, and also:
// - for a pair that opened before PAIR_STAMPS_FROM: the months before it keep
//   exactly the numbers they had (owner, 2026-10-24: past months' pay never
//   changes because of this rule);
// - for a pair with an edited punch (editedBy / editedAt) whose stamps are more
//   than 24h apart: the punch window used to move only the HH:MM within the
//   stamp's own day, so an old edit can leave its stamp a day off; an edit now
//   keeps the pair within 24h (src/manager/logic/punches.ts editedPunchTs), as
//   does an accepted hours fix (functions-auth/hours.py).
export const PAIR_STAMPS_FROM = Date.parse('2026-11-01T00:00:00+02:00'); // 1 November 2026, Israel time
const edited = (p: Punch | null) => !!(p && (p.editedBy || p.editedAt));
function pairMins(a: Punch, b: Punch | null, mins: (t: string) => number, bTime: string): number {
  const ta = tsOf(a), tb = b ? tsOf(b) : Date.now();
  if (isFinite(ta) && isFinite(tb) && tb >= ta && ta >= PAIR_STAMPS_FROM) {
    const m = Math.floor(tb / 60000) - Math.floor(ta / 60000);
    if (m <= 1440 || !(edited(a) || edited(b))) return m;
  }
  let dur = mins(bTime) - mins(a.time as string); if (dur < 0) dur += 1440;
  return dur;
}

// ═══ CANONICAL punch-hours calculation — single source of truth. ═══
// Pair a day's punches chronologically; return total hours + a list of anomalies.
// With opts.tr (the manager app): every anomaly is reported (double IN, OUT
// without IN, 0-minute or >12h shift, an open shift) and today's open shift
// counts up to now. Without it (the portals and the punch page): only closed
// IN→OUT pairs count and warnings stays empty. A pair's length comes from the
// punches' time stamps from 1 November 2026, from the 'HH:MM' strings before
// (pairMins); `codes` names each warning.
export function analyzeDayPunches(entries: Punch[], date: string | number | Date, opts?: { tr: Translate }): DayAnalysis {
  const chrono = [...entries].sort((a, b) => tsOf(a) - tsOf(b));
  let hours = 0, openIn: Punch | null = null;
  const warnings: string[] = [], codes: WarnCode[] = [];
  const tr = opts && opts.tr;
  if (!tr) {
    chrono.forEach(e => {
      if (e.type === 'in') { openIn = e; }
      else if (e.type === 'out') {
        if (!openIn) return;
        if (!openIn.time || !e.time) { openIn = null; return; }
        const dur = pairMins(openIn, e, minsShort, e.time);
        hours += dur / 60; openIn = null;
      }
    });
    return { hours, warnings, codes };
  }
  chrono.forEach(e => {
    if (e.type === 'in') {
      if (openIn) { warnings.push(tr('double IN (no OUT after {0})', { 0: openIn.time })); codes.push('double-in'); }
      openIn = e;
    } else if (e.type === 'out') {
      if (!openIn) { warnings.push(tr('OUT without IN ({0})', { 0: e.time })); codes.push('out-no-in'); return; }
      if (!openIn.time || !e.time) { openIn = null; return; }
      const dur = roundMins(pairMins(openIn, e, minsFull, e.time));
      const hh = dur / 60;
      if (hh <= 0) { warnings.push(tr('0-minute shift ({0}→{1})', { 0: openIn.time, 1: e.time })); codes.push('zero'); }
      else if (hh > 12) { warnings.push(tr('shift >12h ({0}→{1})', { 0: openIn.time, 1: e.time })); codes.push('gt12'); }
      hours += hh; openIn = null;
    }
  });
  const open = openIn as Punch | null;
  if (open) {
    const isToday = new Date().toDateString() === new Date(date).toDateString();
    warnings.push(tr(isToday ? 'open shift from {0} (still at work)' : 'open shift from {0} — no OUT', { 0: open.time }));
    codes.push(isToday ? 'open-today' : 'open');
    if (isToday && open.time) hours += roundMins(pairMins(open, null, minsFull, nowHHMM())) / 60;
  }
  return { hours, warnings, codes };
}

// Pair one worker's punches into shifts chronologically, independent of calendar-day
// boundaries — so an IN before midnight and its OUT after midnight stay one bucket
// instead of splitting into two half-shifts that analyzeDayPunches can't pair (and
// whose hours would otherwise vanish from payroll). Each bucket is tagged with the
// date of its opening punch.
export function groupPunchesIntoShifts<P extends Punch>(entries: P[]): ShiftBucket<P>[] {
  const chrono = [...entries].sort((a, b) => tsOf(a) - tsOf(b));
  const buckets: ShiftBucket<P>[] = [];
  let cur: ShiftBucket<P> | null = null;
  chrono.forEach(e => {
    if (e.type === 'in') {
      if (cur) buckets.push(cur);
      cur = { date: new Date(e.ts), entries: [e] };
    } else {
      if (!cur) cur = { date: new Date(e.ts), entries: [] };
      cur.entries.push(e);
      buckets.push(cur); cur = null;
    }
  });
  const last = cur as ShiftBucket<P> | null;
  if (last) buckets.push(last);
  return buckets;
}

export function israeliDayPay(hours: number, rate: number, isSat: boolean): DayPay {
  const base = isSat ? 1.5 : 1.0, ot1 = isSat ? 1.75 : 1.25, ot2 = isSat ? 2.0 : 1.5;
  const RM = PAY_RULES.regularMax, O1 = PAY_RULES.ot1Span;
  const reg = Math.min(hours, RM), o1 = Math.min(Math.max(hours - RM, 0), O1), o2 = Math.max(hours - (RM + O1), 0);
  const regularPay = reg * rate * base, otPay = o1 * rate * ot1 + o2 * rate * ot2;
  return { regularPay, otPay, total: regularPay + otPay, isSat };
}

// Effective per-hour rates for one shift, resolving a 3-tier priority chain —
// most specific wins, each tier optional, falling through to the next:
//   1. worker.clientRates[clientId] — this worker's own override for this
//      specific client (set in the Accounting rate matrix).
//   2. the worker's own rate — hourlyRate (or the older regRate), otRate,
//      shabbatRate — set in the worker modal or Accounting → Salary. It
//      changes this worker only (user decision 2026-10-05).
//   3. client.defaultHourlyRate/defaultOtRate/defaultShabbatRate — the
//      client's rate, shared by every worker there without a rate of their own.
// Each of the three rates resolves on its own. `src` says which tier gave the
// regular rate: 'override' / 'worker' / 'client' / '' (none). `has*Override` tells shiftPay() whether an
// explicit flat OT/Shabbat rate was found at ANY tier (vs falling back to
// the israeliDayPay law tiers) — the three tiers can't be told apart just by
// comparing the resolved number to a law-tier calculation.
// `clients` is the page's list of clients (with their worker-pay rates).
export function effectiveRates(w: PayWorker | null | undefined, clientId: string | null | undefined, clients: readonly PayClient[]): EffectiveRates {
  const ov = clientId && w && w.clientRates && w.clientRates[clientId];
  const cl = clientId && clients.find(c => c.id === clientId);
  const set = (v: unknown) => v != null && v !== '';
  const own = set(w && w.regRate) ? w!.regRate : (Number(w && w.hourlyRate) > 0 ? w!.hourlyRate : null);
  const pick = (ovVal: unknown, wVal: unknown, clVal: unknown, fallback: number): { val: number; has: boolean; src: RateSource } => {
    if (set(ovVal)) return { val: Number(ovVal), has: true, src: 'override' };
    if (set(wVal)) return { val: Number(wVal), has: true, src: 'worker' };
    if (set(clVal)) return { val: Number(clVal), has: true, src: 'client' };
    return { val: fallback, has: false, src: '' };
  };
  const reg = pick(ov && ov.rate, own, cl && cl.defaultHourlyRate, 0);
  const ot = pick(ov && ov.otRate, w && w.otRate, cl && cl.defaultOtRate, Math.round(reg.val * PAY_RULES.otMult * 100) / 100);
  const shab = pick(ov && ov.shabbatRate, w && w.shabbatRate, cl && cl.defaultShabbatRate, Math.round(reg.val * PAY_RULES.shabbatMult * 100) / 100);
  return {
    regRate: reg.val, otRate: ot.val, shabbatRate: shab.val, hasOtOverride: ot.has, hasShabbatOverride: shab.has,
    src: reg.src, otSrc: ot.src, shabbatSrc: shab.src,
  };
}

// Pay for one shift's hours. Default: the israeliDayPay law tiers (125%/150% OT,
// 150%/175%/200% Shabbat) applied to the effective regular rate. An explicit flat
// OT/Shabbat rate (at any tier above) replaces the law tiers with that single flat
// rate across all OT/Shabbat hours of the shift, same as before this defaulted to
// the law. clientId is optional — see effectiveRates() above.
export function shiftPay(hours: number, w: PayWorker | null | undefined, isSat: boolean, clientId: string | null | undefined, clients: readonly PayClient[]): number {
  const RM = PAY_RULES.regularMax, r = effectiveRates(w, clientId, clients);
  if (isSat) {
    if (r.hasShabbatOverride) return hours * r.shabbatRate;
    return israeliDayPay(hours, r.regRate, true).total;
  }
  if (r.hasOtOverride) return Math.min(hours, RM) * r.regRate + Math.max(hours - RM, 0) * r.otRate;
  return israeliDayPay(hours, r.regRate, false).total;
}

// The worker's own regular rate (hourlyRate, or the older regRate); '' = none.
export function wOwnRate(w: PayWorker | null | undefined): RateValue {
  if (!w) return '';
  if (w.regRate != null && w.regRate !== '') return w.regRate;
  return Number(w.hourlyRate) > 0 ? w.hourlyRate : '';
}

// Daily pay (w.payMode === 'daily', picked per worker in Accounting →
// the pay window): the worker is paid their own rate (read as ₪/day)
// once for every day worked, whatever the hours. A client's rate (an hourly
// figure) never applies to a daily-paid worker.
export function isDailyPay(w: PayWorker | null | undefined): boolean { return !!(w && w.payMode === 'daily'); }
export function dailyRate(w: PayWorker | null | undefined): number { return Number(wOwnRate(w)) || 0; }

// One shift's pay, for every payroll figure (Salary, its export, the
// super-admin summary). seenDays is a Set kept per worker over the period:
// a daily-paid worker's later shifts on a day already paid pay 0.
export function shiftPayFor(hours: number, w: PayWorker | null | undefined, isSat: boolean, clientId: string | null | undefined,
  date: Date, seenDays: Set<string>, clients: readonly PayClient[]): number {
  if (isDailyPay(w)) {
    const k = localYMD(date);
    if (seenDays.has(k)) return 0;
    seenDays.add(k);
    return dailyRate(w);
  }
  return shiftPay(hours, w, isSat, clientId, clients);
}

// Travel for a period (the pay window): travelAllowance ₪ for each
// day worked + travelMonthly ₪ once for each calendar month with work in it.
// Never part of the wage itself (shiftPay / shiftPayFor).
export function travelPay(w: PayWorker | null | undefined, days: number, months: number): number {
  return (Number(w && w.travelAllowance) || 0) * days + (Number(w && w.travelMonthly) || 0) * months;
}

// The days of a daily-paid worker can be set by hand for one period
// (w.dayOverrides[key]); key = the concrete period: 'w:<Sunday yyyy-mm-dd>',
// 'm:<yyyy-mm>' or 'all'.
export function salaryPeriodKey(period: string | null | undefined, now?: Date): string {
  now = now || new Date();
  if (period === 'week') { const ws = new Date(now); ws.setDate(ws.getDate() - ws.getDay()); return 'w:' + localYMD(ws); }
  if (period === 'month') return 'm:' + localYMD(now).slice(0, 7);
  return period || 'all';
}
export function dayOverride(w: PayWorker | null | undefined, key: string): number | null {
  const v = w && w.dayOverrides && w.dayOverrides[key];
  return (v == null || v === '') ? null : Number(v);
}
