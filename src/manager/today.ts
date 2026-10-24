// The Today tab's figures and lists (docs/accounting.md → Today tab), worked
// out from the page's snapshot (bridge.ts). Hours only through the payroll
// module (src/lib/payroll.ts) — display only, never pay.
import { analyzeDayPunches, groupPunchesIntoShifts } from '@/lib/payroll';
import { tr } from '@/lib/i18n';
import type { BridgePunch, BridgeWorker, TodaySnapshot } from './bridge';

export type SectionKey = 'onsite' | 'late' | 'missing' | 'notices' | 'log' | 'suppliers';

export type TodayModel = {
  onSite: BridgeWorker[];
  /** the first IN came `by` minutes after the planned start (more than 5) */
  late: { w: BridgeWorker; by: number; inTime: string }[];
  /** today's shift started 15+ minutes ago with no punch, or OUT 10+ minutes before its end; `by` = minutes since the start */
  missing: { w: BridgeWorker; by: number }[];
  /** active workers with notices, urgent first */
  noticed: BridgeWorker[];
  /** today's punches, newest first */
  log: BridgePunch[];
  /** a headcount per supplier that has workers */
  suppliers: { id: string; name: string; color?: string; count: number }[];
  /** today's hours of a worker: its shifts with a punch today, and a shift still open (also one opened before midnight) up to now */
  hours: (w: BridgeWorker) => number;
};

export function toMins(t?: string | null): number {
  if (!t) return NaN;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** A lone IN older than this many hours (and not today's) is a forgotten OUT, not a running shift. */
export const MAX_OPEN_H = 16;

const tsOf = (e: { ts: unknown }) => new Date(e.ts as string).getTime();
/** The true latest punch by its time stamp (robust to the array's order). */
export function latestOf<P extends { ts: unknown }>(entries: P[]): P | null {
  return entries.length ? entries.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a)) : null;
}

export function todayModel(s: TodaySnapshot, now = new Date()): TodayModel {
  const index = (list: BridgePunch[]) => {
    const m = new Map<string, BridgePunch[]>();
    list.forEach(e => { const l = m.get(e.workerId); if (l) l.push(e); else m.set(e.workerId, [e]); });
    return m;
  };
  const byWorker = index(s.log), byWorkerRecent = index(s.recent || s.log);
  const of = (w: BridgeWorker) => byWorker.get(w.id) || [];
  // The last day's punches: a night shift opened before midnight is still on shift, and its OUT pairs with its IN.
  const recentOf = (w: BridgeWorker) => byWorkerRecent.get(w.id) || [];
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const today = now.toDateString(), isToday = (e: { ts: unknown }) => new Date(e.ts as string).toDateString() === today;

  // A shift opened before midnight runs on only while it is a plausible shift
  // (opened within the last MAX_OPEN_H hours); an older lone IN is a forgotten OUT.
  const running = (e: BridgePunch | null) => !!e && e.type === 'in' && (isToday(e) || now.getTime() - tsOf(e) <= MAX_OPEN_H * 36e5);
  const onSite = s.workers.filter(w => running(latestOf(recentOf(w))));

  const missing = s.workers.filter(w => w.active).flatMap(w => {
    const sh = w.shift;
    if (!sh || sh.type === 'off' || !sh.start) return [];
    const start = toMins(sh.start);
    if (nowMins < start + 15) return [];
    const last = latestOf(of(w));
    const out = !last || (last.type === 'out' && !!sh.end && nowMins < toMins(sh.end) - 10);
    return out ? [{ w, by: Math.max(0, nowMins - start) }] : [];
  });

  const late = s.workers.filter(w => w.active).flatMap(w => {
    const sh = w.shift;
    if (!sh || sh.type !== 'work' || !sh.start) return [];
    const firstIn = of(w).filter(e => e.type === 'in').sort((a, b) => tsOf(a) - tsOf(b))[0];
    if (!firstIn || !firstIn.time) return [];
    const by = toMins(firstIn.time) - toMins(sh.start);
    return by > 5 ? [{ w, by, inTime: firstIn.time }] : [];
  });

  const red = (w: BridgeWorker) => (w.notices.some(n => n.lvl === 'red') ? 1 : 0);
  const noticed = s.workers.filter(w => w.active && w.notices.length).sort((a, b) => red(b) - red(a));

  const counts = new Map<string, number>();
  s.workers.forEach(w => { if (w.supplierId) counts.set(w.supplierId, (counts.get(w.supplierId) || 0) + 1); });
  const suppliers = s.suppliers.filter(x => counts.get(x.id)).map(x => ({ ...x, count: counts.get(x.id)! }));

  // Only the worker's last shift may still be running: an earlier lone IN (a
  // forgotten OUT, a double tap) adds nothing. analyzeDayPunches counts a
  // shift opened today up to now; one still open since before midnight is
  // counted here up to now, the same whole minutes, while it is plausible.
  const withTr = { tr: (t: string, p?: Record<string, unknown>) => tr(t, p as Record<string, string | number>) };
  const hours = (w: BridgeWorker) => {
    let h = 0;
    const bs = groupPunchesIntoShifts(recentOf(w));
    bs.forEach((b, i) => {
      const last = b.entries[b.entries.length - 1], open = !!last && last.type === 'in';
      if (open) {
        if (i !== bs.length - 1 || !running(last)) return;
        if (isToday(last)) h += analyzeDayPunches(b.entries, b.date, withTr).hours;
        else h += Math.max(0, Math.floor(now.getTime() / 6e4) - Math.floor(tsOf(last) / 6e4)) / 60;
        return;
      }
      if (b.entries.some(isToday)) h += analyzeDayPunches(b.entries, b.date, withTr).hours;
    });
    return h;
  };

  return { onSite, late, missing, noticed, log: [...s.log].reverse(), suppliers, hours };
}

/** "late 12 min" / "late 2h" */
export function lateText(m: number): string {
  return m >= 60 ? tr('late {h}h', { h: Math.floor(m / 60) }) : tr('late {m} min', { m });
}
/** "6.5h" */
export function hoursShort(h: number): string {
  return tr('{h}h', { h: String(Math.round((h || 0) * 10) / 10) });
}
