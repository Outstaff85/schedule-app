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
  /** today's hours of a worker: the day's paired shifts plus a shift still open up to now */
  hours: (w: BridgeWorker) => number;
};

export function toMins(t?: string | null): number {
  if (!t) return NaN;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const tsOf = (e: { ts: unknown }) => new Date(e.ts as string).getTime();
/** The true latest punch by its time stamp (robust to the array's order). */
export function latestOf<P extends { ts: unknown }>(entries: P[]): P | null {
  return entries.length ? entries.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a)) : null;
}

export function todayModel(s: TodaySnapshot, now = new Date()): TodayModel {
  const byWorker = new Map<string, BridgePunch[]>();
  s.log.forEach(e => { const l = byWorker.get(e.workerId); if (l) l.push(e); else byWorker.set(e.workerId, [e]); });
  const of = (w: BridgeWorker) => byWorker.get(w.id) || [];
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const onSite = s.workers.filter(w => latestOf(of(w))?.type === 'in');

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

  const hours = (w: BridgeWorker) => {
    let h = 0;
    groupPunchesIntoShifts(of(w)).forEach(b => {
      h += analyzeDayPunches(b.entries, b.date, { tr }).hours;
      const last = b.entries[b.entries.length - 1];
      if (last && last.type === 'in') h += Math.max(0, (now.getTime() - tsOf(last)) / 36e5);
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
