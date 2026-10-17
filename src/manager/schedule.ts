// The Schedule tab's week math (docs/app-core.md → Schedule tab), worked out
// from the page's snapshot (bridge.ts). The roster is per weekday
// (`schedule[0..6]`, Sunday first); a change for one date (`dateShifts`) wins
// over it on that date. `shiftOn` / `weekShifts` are the page's functions of
// the same names (the manager page keeps its copy for Today, the exports and
// the Workers tab until those move — CLAUDE.md → Duplicated on purpose).
// Schedule only: never punches or pay.
import { localYMD } from '@/lib/payroll';
import type { DatedChange, DayShift, SchedWorker, ShiftRequest } from './bridge';

export type Shift = DayShift & { dated?: boolean };

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** A local YYYY-MM-DD as a Date at 00:00. */
export function ymdDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
export function sundayOf(d: Date): Date {
  const c = new Date(d);
  c.setDate(c.getDate() - c.getDay());
  c.setHours(0, 0, 0, 0);
  return c;
}

export function shiftOn(w: SchedWorker, date: Date): Shift {
  const o = w.dateShifts[localYMD(date)];
  if (o) return { ...o, dated: true };
  return w.schedule[date.getDay()] || { type: 'off', start: null, end: null };
}
export function weekShifts(w: SchedWorker, start: Date): Shift[] {
  return [0, 1, 2, 3, 4, 5, 6].map(i => shiftOn(w, addDays(start, i)));
}

const toMins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** A shift's hours; one that ends at or before its start crosses midnight. */
export function calcHours(s?: string | null, e?: string | null): number {
  if (!s || !e) return 0;
  const sm = toMins(s), em = toMins(e);
  return em <= sm ? (1440 - sm + em) / 60 : (em - sm) / 60;
}
export const isWork = (x: DayShift): boolean => x.type === 'work' && !!x.start && !!x.end;
export const crossesMidnight = (x: DayShift): boolean => isWork(x) && toMins(x.end!) <= toMins(x.start!);
export function weekHours(w: SchedWorker, start: Date): number {
  return weekShifts(w, start).reduce((s, x) => s + (x.type === 'work' ? calcHours(x.start, x.end) : 0), 0);
}

/**
 * Who the tab shows (the page's `getVisible`): with a site, that site's
 * workers; with none, only workers with a working day in the roster or in the
 * shown week (a worker never given a schedule manages their own hours).
 */
export function visibleWorkers(workers: SchedWorker[], clientId: string | null, start: Date): SchedWorker[] {
  if (clientId) return workers.filter(w => w.clientIds.includes(clientId));
  return workers.filter(w => w.schedule.some(x => x?.type === 'work') || weekShifts(w, start).some(x => x.type === 'work'));
}

/** A pending request of `kind` for that worker and date (a declined one does not count). */
export function requestOn(reqs: ShiftRequest[], workerId: string, date: string, kind: ShiftRequest['kind']): ShiftRequest | undefined {
  return reqs.find(q => q.workerId === workerId && q.date === date && q.kind === kind && q.status !== 'declined');
}

export type CopyItem = DatedChange & { name: string; shift: DayShift };

/**
 * Copy last week / Repeat for N weeks: each working day of the source week
 * (from `from`, 7 days) becomes a shift for that date only on the same weekday
 * of every target week. A day that already has a shift — a working roster
 * day or any change for that date (a day off set for that date too) — keeps
 * it, and so does a day the worker marked they can't work. Nothing is written
 * here; the caller shows the list first.
 */
export function copyPlan(workers: SchedWorker[], from: Date, targets: Date[], reqs: ShiftRequest[] = []): CopyItem[] {
  const out: CopyItem[] = [];
  for (const w of workers) {
    for (const t of targets) {
      for (let di = 0; di < 7; di++) {
        const src = shiftOn(w, addDays(from, di));
        if (!isWork(src)) continue;
        const date = localYMD(addDays(t, di));
        if (w.dateShifts[date]) continue;
        const roster = w.schedule[di];
        if (roster && isWork(roster)) continue;
        if (requestOn(reqs, w.id, date, 'unavailable')) continue;
        out.push({ workerId: w.id, name: w.name, date, shift: { type: 'work', start: src.start, end: src.end } });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
