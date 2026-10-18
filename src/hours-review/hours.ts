// The hours review's data (docs/hours-review.md): what the `hours` Cloud
// Function (functions-auth/hours.py) replies, the month's days per worker and
// each day's state (they replaced the old pages' hours-review.js, now
// removed); the shift pairing is the payroll module's.
import { addMonths, format, startOfMonth } from 'date-fns';
import { analyzeDayPunches, groupPunchesIntoShifts, localYMD, type Punch } from '@/lib/payroll';

export const HOURS_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/hours';

export type HourPerm = 'hours' | 'approve' | 'dispute' | 'fix' | 'export' | 'schedule';
export type DayStatus = 'approved' | 'fixed' | 'disputed' | 'fix' | 'rejected';
export interface DayEntry {
  status: DayStatus;
  line?: string;
  comment?: string;
  inT?: string;
  outT?: string;
  shift?: number;
  byName?: string;
}
type PlanDay = { type?: string; start?: string | null; end?: string | null };
export interface HoursWorker {
  id: string;
  name: string;
  schedule?: PlanDay[];
  dates?: Record<string, PlanDay>;
}
export interface HoursPunch extends Punch { workerId: string; time?: string }
export interface HoursData {
  month: string;
  perms: HourPerm[];
  owner?: { kind?: string; id?: string; name?: string; object?: string | null };
  workers?: HoursWorker[];
  punches?: HoursPunch[];
  days?: Record<string, DayEntry>;
  /** a client's signed month (sign): when and by whom */
  signed?: { at?: string; byName?: string };
  error?: string;
}
export type HoursCall = (body: Record<string, unknown>) => Promise<HoursData & { ok?: boolean }>;

/** The month `offset` months from this one (≤ 0), as yyyy-MM. */
export function monthKey(offset: number, now = new Date()): string {
  return format(addMonths(startOfMonth(now), offset), 'yyyy-MM');
}
export function monthStart(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
export const can = (d: HoursData | null, p: HourPerm) => !!d && (d.perms || []).includes(p);

export interface DayShift { inT: string; outT: string }
export interface DayRow {
  key: string;        // worker|yyyy-MM-dd
  workerId: string;
  day: string;
  date: Date;
  shifts: DayShift[];
  hours: number;
  /** "<worker>|<day>|<ins>|<outs>" — what an approval keeps, so a later change shows */
  line: string;
}

// The month's days per worker: a day holds every shift that started on it.
export function monthDays(d: HoursData | null): DayRow[] {
  if (!d || !d.punches) return [];
  const from = monthStart(d.month), to = addMonths(from, 1);
  const byW: Record<string, HoursPunch[]> = {};
  d.punches.forEach(e => { (byW[e.workerId] = byW[e.workerId] || []).push(e); });
  const days: Record<string, Omit<DayRow, 'line'>> = {};
  Object.entries(byW).forEach(([wid, list]) => groupPunchesIntoShifts(list).forEach(b => {
    if (b.date < from || b.date >= to) return;
    const inE = b.entries.find(e => e.type === 'in'), outE = [...b.entries].reverse().find(e => e.type === 'out');
    const day = localYMD(b.date), key = wid + '|' + day;
    const row = days[key] = days[key] || { key, workerId: wid, day, date: b.date, shifts: [], hours: 0 };
    row.shifts.push({ inT: (inE && inE.time) || '', outT: (outE && outE.time) || '' });
    row.hours += analyzeDayPunches(b.entries, b.date).hours;
  }));
  return Object.values(days).map(r => ({
    ...r, line: [r.workerId, r.day, r.shifts.map(s => s.inT).join(','), r.shifts.map(s => s.outT).join(',')].join('|'),
  })).sort((a, b) => a.date.getTime() - b.date.getTime());
}

export type DayState = 'pending' | 'changed' | DayStatus;
/** A day's state: its stored entry, or "changed" when an approved (or fixed) day's shift is no longer the one approved. */
export function dayState(d: HoursData | null, r: DayRow): { st: DayState; e?: DayEntry } {
  const e = ((d && d.days) || {})[r.key];
  if (!e) return { st: 'pending' };
  if ((e.status === 'approved' || e.status === 'fixed') && e.line !== r.line) return { st: 'changed', e };
  return { st: e.status, e };
}
/** The days a login may still approve: waiting, changed, or whose fix was rejected. */
export const PICKABLE: DayState[] = ['pending', 'changed', 'rejected'];

export const STATES: Record<DayState, { color: string; label: string; pill: string }> = {
  pending: { color: 'var(--ink-2)', label: 'Waiting for approval', pill: 'Waiting' },
  approved: { color: 'var(--green)', label: 'Approved', pill: 'Approved' },
  fixed: { color: 'var(--green)', label: 'Fix accepted', pill: 'Fixed' },
  changed: { color: 'var(--amber)', label: 'Changed after approval', pill: 'Changed' },
  disputed: { color: 'var(--amber)', label: 'Disputed', pill: 'Disputed' },
  fix: { color: 'var(--accent)', label: 'Fix proposed', pill: 'Fix proposed' },
  rejected: { color: 'var(--red)', label: 'Fix rejected', pill: 'Rejected' },
};

export const shiftsText = (r: DayRow) => r.shifts.map(s => (s.inT || '--:--') + '–' + (s.outT || '--:--')).join(', ');

/** A worker's planned day: the weekly roster, a change for a single date winning on its date. */
export function planned(w: HoursWorker, d: Date): string {
  const day = (w.dates || {})[localYMD(d)] || (w.schedule || [])[d.getDay()] || {};
  return day.type === 'work' && day.start && day.end ? day.start + '–' + day.end : '';
}
