// The manager app's punches (React migration stage 8b; from schedule-manager.html).
// The punch cache (localStorage punchLog — the same key the punch page's
// getPunchLog / savePunchLog use, src/punch/core.ts) and its sync with Firestore.
// Only recent punches are kept: the live listener covers this month plus the
// week before it (punchWindowStart() — enough for "This week" and for a shift
// that started before the 1st). Older months are read once, when something
// asks for them (ensurePunchesSince(): a past month's salary, an export, Clear
// Log, "Load earlier" in the punch log), and they stay only for this app
// open: on the next open the cache is trimmed back to the window, so
// localStorage never fills up with years of punches.
import { loadFirestoreBackend } from './api';
import { getSession, fsTenantId } from './session';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

export function getPunchLog(): Rec[] {
  try { return JSON.parse(localStorage.getItem('punchLog') || '[]'); } catch { return []; }
}
export function savePunchLog(log: Rec[]): void {
  localStorage.setItem('punchLog', JSON.stringify(log));
}

export function punchWindowStart(): Date {
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); d.setDate(d.getDate() - 7); return d;
}
let loadedFrom: Date | null = null;          // earliest punch time loaded this app open
export const punchLoadedFrom = (): Date | null => loadedFrom;
let ensureChain: Promise<boolean> = Promise.resolve(true);
export const ALL_PUNCHES_FROM = new Date(2000, 0, 1);
export function ensurePunchesSince(from: Date | null): Promise<boolean> {
  if (!from) return Promise.resolve(true);
  const want = from;
  ensureChain = ensureChain.then(async () => {
    const have = loadedFrom || punchWindowStart();
    if (want >= have) return true;
    showToast(want <= ALL_PUNCHES_FROM ? tr('Loading the whole punch history…') : tr('Loading earlier punches…'), 1500);
    try {
      const older = await (await loadFirestoreBackend()).punchesBetween(fsTenantId(), want, have);
      loadedFrom = want;
      mergeRemotePunches(older);
      return true;
    } catch (e: any) {
      showToast(tr('Could not load earlier punches: {0}', {0: ((e && e.message) || e)}));
      return false;
    }
  });
  return ensureChain;
}
export function ensureAllPunches(): Promise<boolean> { return ensurePunchesSince(ALL_PUNCHES_FROM); }
// Start of the period a salary/export choice needs ('week', 'month',
// 'm:YYYY-MM', 'all'); a day early, so a shift that started the evening
// before stays whole.
export function periodPunchStart(period: string): Date | null {
  if (period === 'all') return ALL_PUNCHES_FROM;
  if (/^m:\d{4}-\d{2}$/.test(period)) { const [y, m] = period.slice(2).split('-').map(Number); return new Date(y, m - 1, 0); }
  return null; // week / this month: inside the live window
}
async function gsLoadPunchLog(): Promise<Rec[] | null> {
  // A live listener — the first snapshot is the load, and every later change
  // (a worker's punch on another device) is merged in at once.
  try {
    const since = punchWindowStart();
    if (!loadedFrom || loadedFrom > since) loadedFrom = since;
    return await (await loadFirestoreBackend()).listenPunches(fsTenantId(), entries => {
      mergeRemotePunches(entries);
      if (currentTab === 'dashboard') renderDashboard();
      // Hours approvals compare each day with the punches: redraw them too,
      // or a day could keep showing a stale "Changed after approval".
      if (currentTab === 'accounting') renderAccounting();
    }, since);
  } catch (e: any) { console.warn('Firestore punch load failed: ' + ((e && e.message) || e)); return null; }
}
// The first load of the punches (a promise): Accounting → Hours approvals
// waits for it, so a day is never compared with a punch log still loading
// (which showed an approved day as "Changed after approval").
let synced: Promise<void> | null = null;
export const punchSynced = (): Promise<void> | null => synced;
export function syncPunchesFromGS(): Promise<void> {
  synced = (async () => {
    const remote = await gsLoadPunchLog();
    if (!remote) return;
    mergeRemotePunches(remote);
  })();
  return synced;
}
export function mergeRemotePunches(remote: Rec[]): void {
  const local = getPunchLog();
  const byId: Record<string, Rec> = {};
  remote.forEach(e => {
    if (!e) return;
    // Rebuild the display time from the authoritative ISO timestamp (admin's local tz),
    // falling back to extracting HH:MM from whatever string we got.
    const d = e.ts ? new Date(e.ts) : null;
    if (d && !isNaN(d.getTime())) {
      e.time = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    } else if (typeof e.time === 'string') {
      const m = e.time.match(/(\d{1,2}):(\d{2})/); if (m) e.time = m[1].padStart(2,'0') + ':' + m[2];
    }
    if (e.id != null) byId[e.id] = e;
  });
  // Cached rows older than what this app open has loaded are dropped (loaded
  // on demand last time), so the cache never grows past what is in use.
  const keepFrom = (loadedFrom || punchWindowStart()).getTime();
  // An own-workers HR keeps cached rows only of the workers it still has (a
  // worker the owner moved to another HR takes its punches along).
  const s = getSession();
  const mine = s && s.role === 'hr' && s.ownOnly ? new Set(workers.map(w => String(w.id))) : null;
  local.forEach(e => { if (e && e.id != null && !(e.id in byId) && !(new Date(e.ts).getTime() < keepFrom)
    && (!mine || mine.has(String(e.workerId)))) byId[e.id] = e; });
  savePunchLog(Object.values(byId));
  if (currentTab === 'admin') renderAdmin();
}
