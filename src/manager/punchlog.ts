// The Admin tab's punch log (docs/admin.md → Punch Log pane), the figures the
// React pane draws: the filter choices, the filtered list (newest first), the
// figures, the months Clear Log offers and the By Client view. The punches
// come from the page (ManagerBridge.admin(): its cache, with each punch's site
// worked out by punchSite); nothing here changes them.
import type { AdminPunch } from './bridge';

export type LogFilters = { worker: string; client: string; date: string; type: '' | 'in' | 'out' };
export const NO_FILTERS: LogFilters = { worker: '', client: '', date: '', type: '' };

type W = { id: string; name: string; clientIds: string[] };
type C = { id: string; name: string };

const tsOf = (e: AdminPunch) => new Date(e.ts).getTime();
/** The day of a punch as the log shows it (en-GB, dd/mm/yyyy). */
export const dayOf = (e: AdminPunch) => new Date(e.ts).toLocaleDateString('en-GB');

/** The workers that appear in the log (by name), the days that have punches (newest first). */
export function filterChoices(log: AdminPunch[]) {
  const seen = new Map<string, string>();
  log.forEach(e => { if (e.workerId && !seen.has(e.workerId)) seen.set(e.workerId, e.workerName || ''); });
  const workers = [...seen.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id, name]) => ({ id, name }));
  const byDay = new Map<string, number>();
  log.forEach(e => {
    const d = new Date(e.ts);
    if (isNaN(d.getTime())) return;
    const k = d.toLocaleDateString('en-GB');
    if (!byDay.has(k)) byDay.set(k, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  });
  const dates = [...byDay.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return { workers, dates };
}

/**
 * The punches the filters keep, newest first. A punch belongs to the client it
 * was recorded at (clientId); one saved without a clientId falls back to the
 * worker's current clients.
 */
export function filterLog(log: AdminPunch[], f: LogFilters, workers: W[]) {
  let out = log;
  if (f.worker) out = out.filter(e => e.workerId === f.worker);
  if (f.client) {
    const ids = new Set(workers.filter(w => (w.clientIds || []).includes(f.client)).map(w => w.id));
    out = out.filter(e => (e.clientId ? e.clientId === f.client : ids.has(e.workerId)));
  }
  if (f.date) out = out.filter(e => dayOf(e) === f.date);
  if (f.type) out = out.filter(e => e.type === f.type);
  return [...out].sort((a, b) => tsOf(b) - tsOf(a));
}

/** Total IN, Total OUT, Today and Total over what is loaded. */
export function logFigures(log: AdminPunch[], now = new Date()) {
  const t = now.toDateString();
  return {
    in: log.filter(e => e.type === 'in').length,
    out: log.filter(e => e.type === 'out').length,
    today: log.filter(e => new Date(e.ts).toDateString() === t).length,
    total: log.length,
  };
}

/** A punch's month 'yyyy-MM': from its own `date` (dd/MM/yyyy, what the server groups by), else from `ts`. */
export function punchMonthKey(e: { date?: string; ts: string | number }) {
  const m = String(e.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0');
  const d = new Date(e.ts);
  return isNaN(d.getTime()) ? null : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** Clear Log's checklist: every month with punches, newest first, with its count. */
export function monthCounts(log: { date?: string; ts: string | number }[]) {
  const counts: Record<string, number> = {};
  log.forEach(e => { const k = punchMonthKey(e); if (k) counts[k] = (counts[k] || 0) + 1; });
  return Object.keys(counts).sort().reverse().map(key => ({ key, count: counts[key] }));
}

/** The latest punch by its time (whatever the array order). */
export function latestOf<T extends AdminPunch>(list: T[]): T | null {
  return list.length ? list.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a)) : null;
}

/**
 * By Client: per client its assigned workers, how many are on site now (today's
 * latest punch is IN), the punches of those workers; per worker its punches,
 * newest first, and today's latest.
 */
export function byClient(log: AdminPunch[], clients: C[], workers: W[], now = new Date()) {
  const t = now.toDateString();
  return clients.map(c => {
    const assigned = workers.filter(w => (w.clientIds || []).includes(c.id));
    const ids = new Set(assigned.map(w => w.id));
    const clientLog = log.filter(e => ids.has(e.workerId)).sort((a, b) => tsOf(b) - tsOf(a));
    const rows = assigned.map(w => {
      const wLog = clientLog.filter(e => e.workerId === w.id);
      const last = latestOf(wLog.filter(e => new Date(e.ts).toDateString() === t));
      return { w, log: wLog, last, inNow: last?.type === 'in' };
    });
    return { c, rows, total: clientLog.length, present: rows.filter(r => r.inNow).length };
  });
}
