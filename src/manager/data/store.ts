// Load, save, the offline cache and the live watchers (from schedule-manager.html).
// Firestore is the source of truth; localStorage is a cache / offline
// fallback only. loadData() applies the cached data at once, then the
// server's. autoSave() debounces writes (800 ms) and never saves an
// accidentally emptied workers / clients list over existing cached data
// (unless the save is an explicit delete of the last one: allowEmpty).
// Data not edited from this page's last server load or save (changes kept on
// the device after a failed save, an edit on the cached list before the load
// came back) is saved against the base it was edited from (BASE_KEY), merged
// with the server's fresh copy (firestore-backend saveSchedule's base), so a
// worker another manager added or edited meanwhile is never deleted or
// overwritten. An edit made before the first server load settles waits for it.
// A full localStorage never stops a save or a load: the cache writes are
// best-effort. The base is kept only when the cache it belongs to was
// written, and removed when it was not, so the two never disagree; data with
// no base (a cache from before the base existed) is saved with base
// 'unknown' — the server's copy of every record it has wins, nothing is
// deleted, and the user is told when local changes could not be merged.
// Nothing here draws: every change is an event (events.ts) the page answers.
import type { SaveBase, ScheduleBase } from '../../lib/firestore-backend';
import { loadFirestoreBackend, gsLoad, gsSave, scheduleBaseOf, loadError } from './api';
import { getSession, fsTenantId, STORAGE_KEY, STORAGE_KEY_BASE } from './session';
import { syncPunchesFromGS } from './punches';
import { markFirstContent, markFreshContent } from './telemetry';
import { state, applyData, getDataObj, type Rec } from './state';
import { emit, notify, host, tr } from './events';

// Set while local changes have not reached the server yet (2026-10-01).
// loadData() then keeps the local data and saves it, instead of replacing it
// with the older server copy — that replacement is how a newly added worker
// vanished from the list when its save had failed.
export function UNSAVED_KEY(): string { return STORAGE_KEY() + '_unsaved'; }
// The flag holds when the save started; one older than 3 days is ignored, so a
// device that was offline for long can't push stale data over newer edits.
export function hasUnsavedLocal(): boolean {
  try { const t = +(localStorage.getItem(UNSAVED_KEY()) || 0); return t > 0 && Date.now() - t < 3 * 864e5 && !!localStorage.getItem(STORAGE_KEY()); } catch { return false; }
}
// Worker photos are gone (owner 2026-10-13): no list shows them and a scan no
// longer takes one, so an old photo (avatarB64, 5–10 KB each) is dropped from
// every worker this login may write; the save that follows removes it from
// Firestore, and every later load is that much lighter.
export function dropWorkerPhotos(): boolean {
  if (!host.canWriteWorkers()) return false;
  let n = 0;
  state.workers.forEach(w => { if ('avatarB64' in w) { delete w.avatarB64; n++; } });
  return n > 0;
}
// The save base: the data as it was when last in step with the server (a
// load, a successful save) — per kind, record id -> a hash of the record
// (firestore-backend scheduleBaseOf).
export function BASE_KEY(): string { return STORAGE_KEY() + '_base'; }
// The kept base, or 'unknown' when none is kept (saveSchedule then keeps
// the server's copy of every record it has: see firestore-backend mergeOnBase).
function readBase(): SaveBase {
  try { const b = JSON.parse(localStorage.getItem(BASE_KEY()) || 'null'); return b && typeof b === 'object' ? b : 'unknown'; }
  catch { return 'unknown'; }
}
function dropBase(): void { try { localStorage.removeItem(BASE_KEY()); } catch { /* ignore */ } }
// cacheOk: the cache this base belongs to was written; otherwise the base is
// removed (a base newer than the cache would make every stale cached record
// look edited here).
function keepBase(b: ScheduleBase | null, cacheOk: boolean): void {
  if (!b || !cacheOk) { dropBase(); return; }
  try { localStorage.setItem(BASE_KEY(), JSON.stringify(b)); }
  catch { dropBase(); } // none kept: the next merged save uses base 'unknown'
}
// Best-effort: a full localStorage must not break a save or a load.
function tryWriteCache(json: string, bak = false): boolean {
  try { writeCache(json); if (bak) localStorage.setItem(STORAGE_KEY() + '_bak', json); return true; }
  catch (e) { console.warn('Cache write failed', e); return false; }
}
// true while `state` is what this page last loaded from or saved to the
// server (the backend's reference copy is then its base); false while it is
// the cache, or local changes merged on top of an older base.
let fromServer = false;
// The first server load has come back (or failed): until then a save waits.
let loadSettled = false;
let queuedSave = false;
let allowEmptyOnce = false;
let editSeq = 0;
let pending = false;
/** a change not yet saved (or a save under way): the new-version reload waits */
export const savePending = (): boolean => pending;

function writeCache(json: string): void {
  localStorage.setItem(STORAGE_KEY(), json);
  // Also mirror under the legacy unscoped key — worker-punch.html's
  // updateScheduleManager() (same-device convenience bridge) still reads
  // that literal key and has no tenantId of its own to scope by.
  localStorage.setItem(STORAGE_KEY_BASE, json);
}
// Apply a fresh server load, unless local changes are still unsaved.
// Unsaved local changes are saved (merged with this server copy against
// their base), else the server copy replaces the local data.
export function applyServerLoad(gd: Rec): boolean {
  if (queuedSave || hasUnsavedLocal()) {
    queuedSave = false;
    fromServer = false;
    notify(tr('Unsaved changes found on this device — saving them now'), 4000);
    autoSave();
    return false;
  }
  applyData(gd);
  fromServer = true;
  keepBase(scheduleBaseOf(getDataObj()), tryWriteCache(JSON.stringify(gd)));
  const photosDropped = dropWorkerPhotos();
  emit('data');
  if (photosDropped) autoSave();
  return true;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
// opts.allowEmpty: an explicit delete of the last worker / client (the empty
// guards would otherwise skip that save forever).
export function autoSave(opts?: {allowEmpty?: boolean}): void {
  if (opts && opts.allowEmpty) allowEmptyOnce = true;
  // Glitch guard: don't overwrite existing data with a suddenly-empty state.
  if (!allowEmptyOnce && !state.workers.length && !state.clients.length) {
    let hadData = false;
    try { const prev = JSON.parse(localStorage.getItem(STORAGE_KEY()) || '{}'); hadData = (prev.workers && prev.workers.length) || (prev.clients && prev.clients.length); } catch { /* no cache */ }
    if (hadData) { console.warn('Empty state but cache has data — skipping save'); emit('save', 'saved'); notify(tr('Empty data — save skipped')); return; }
  }
  editSeq++;
  pending = true;
  emit('save', 'saving');
  if (!loadSettled) {
    // An edit on the cached list before the server load came back: kept on
    // the device and saved once the server copy is in (applyServerLoad).
    tryWriteCache(JSON.stringify(getDataObj()));
    try { localStorage.setItem(UNSAVED_KEY(), String(Date.now())); } catch { /* full */ }
    queuedSave = true;
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = undefined; void runSave(); }, 800);
}
// The save itself (autoSave's debounced body); true when the data reached
// the server and nothing is left unsaved on the device.
let inflight: Promise<boolean> | null = null;
function runSave(): Promise<boolean> {
  const p = (async (): Promise<boolean> => {
    const seq = editSeq, allowEmpty = allowEmptyOnce;
    allowEmptyOnce = false;
    let done = false;
    try {
      const data = getDataObj();
      const savedBase = scheduleBaseOf(data); // what this save puts on the server (before any later edit)
      // localStorage as cache only
      const cacheOk = tryWriteCache(JSON.stringify(data), true);
      // Firestore is the primary storage
      try { localStorage.setItem(UNSAVED_KEY(), String(Date.now())); } catch { /* full */ }
      const base = fromServer ? null : readBase();
      let merged: Rec | null = null, dropped = 0;
      const ok = await gsSave(data, {base, allowEmpty, onMerged: (d, n) => { merged = d; dropped = n; }});
      // Edited again while a merged save ran (or a worker window is open over
      // the list): the next save merges once more against the same base;
      // otherwise the merged data is this device's now.
      if (ok && (!base || (seq === editSeq && !host.workerWindowOpen()))) {
        if (merged) { applyData(merged); keepBase(scheduleBaseOf(getDataObj()), tryWriteCache(JSON.stringify(getDataObj()))); emit('data'); }
        else keepBase(savedBase, cacheOk);
        fromServer = true;
        done = true;
        try { localStorage.removeItem(UNSAVED_KEY()); } catch { /* ignore */ }
      }
      emit('save', 'saved');
      if (ok && dropped) notify(tr('Changes kept on this device could not be merged with the server — the server copy was kept'), 6000);
      else notify(ok ? tr('Saved') : tr('Save failed — kept on this device'));
    } catch (e) {
      console.error('Save failed', e);
      emit('save', 'saved');
      notify(tr('Save error'));
    } finally {
      if (seq === editSeq) pending = false;
    }
    return done && seq === editSeq;
  })();
  inflight = p;
  p.finally(() => { if (inflight === p) inflight = null; });
  return p;
}
// Sign-out: a save still waiting for its 800 ms runs now, one under way is
// awaited. true when nothing is left unsaved on the device (false: changes
// would be lost if the device's data were removed now).
export async function flushSave(): Promise<boolean> {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined; await runSave(); }
  else if (inflight) await inflight;
  return !queuedSave && !pending && !hasUnsavedLocal();
}
// The first load settled without a server copy: an edit queued meanwhile is saved now.
function settleLoad(): void {
  if (queuedSave) { queuedSave = false; autoSave(); }
}

/** After a fresh server load: the punches, the live watchers. */
function afterServerLoad(): void {
  markFreshContent('app');
  syncPunchesFromGS();
  emit('loaded');
}

export async function loadData(): Promise<void> {
  // 1. Show cached data instantly while the server loads — read ONLY the
  // tenant-scoped key (never the legacy unscoped one) so switching firms
  // (switchToTenant()'s reload) never flashes a DIFFERENT firm's stale
  // cache; a firm with no cache yet under its own key just skips this step
  // and waits for the real server data.
  try {
    const raw = localStorage.getItem(STORAGE_KEY()) || localStorage.getItem(STORAGE_KEY() + '_bak');
    if (raw) {
      applyData(JSON.parse(raw));
      state.ready = true;
      emit('data');
      markFirstContent();
    }
  } catch { /* a broken cache: wait for the server */ }

  // 2. Always load from Firestore (primary source)
  try {
    const gd = await gsLoad();
    const wasReady = state.ready;
    state.ready = true;
    loadSettled = true;
    if (gd) {
      applyServerLoad(gd);
      emit('save', 'saved');
      afterServerLoad();
      if (getSession()?.role === 'hr') watchHrWorkers();
      watchHoursBatches();
    } else {
      const err = loadError();
      notify(tr('Could not load from the server — showing saved data{0}', {0: (err ? ' (' + err.slice(0, 80) + ')' : '')}), 6000);
      retryLoadDataWhenBack();
      if (!wasReady) emit('data');
      settleLoad();
    }
  } catch (e) {
    console.error('Load failed', e);
    notify(tr('Offline — using cached data'));
    if (!state.ready) { state.ready = true; emit('data'); }
    loadSettled = true;
    settleLoad();
  }
}

// The hours batches (Pending hours), live (listenPendingHours): the count of
// batches waiting for a decision on the Accounting tab, and each worker's
// latest batch status on the worker card.
let hoursWatched = false, batches: Rec[] | null = null;
export const hoursBatches = (): Rec[] | null => batches;
export function watchHoursBatches(): void {
  const s = getSession();
  if (hoursWatched || !s || s.role === 'supplier') return;
  hoursWatched = true;
  loadFirestoreBackend().then(b => b.listenPendingHours(fsTenantId(), list => { batches = list; emit('hours'); }))
    .catch((e: any) => { hoursWatched = false; console.warn('Hours watch failed: ' + ((e && e.message) || e)); });
}
/** batches waiting for a decision */
export const pendingHoursCount = (): number => (batches || []).filter(b => b.status === 'pending').length;
// This worker's latest hours batch (by when it was sent), or null.
export function latestHoursBatch(workerId: unknown): Rec | null {
  return (batches || []).filter(b => (b.entries || []).some((r: Rec) => r.workerId === workerId))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;
}

// An HR's worker list follows the server (listenWorkers): a worker the owner
// assigns appears, one taken away disappears, a field the owner edits (a
// rate, a phone…) changes. Applied while no worker window is open (their
// index into `workers` must not move); otherwise it waits and tries again.
type WorkerChange = {added: Rec[]; removed: string[]; changed: {data: Rec; unsaved: (item: Rec) => boolean}[]};
let hrWorkersWatched = false;
const hrWorkerChanges: WorkerChange[] = [];
export function watchHrWorkers(): void {
  if (hrWorkersWatched) return;
  hrWorkersWatched = true;
  loadFirestoreBackend().then(b => b.listenWorkers(fsTenantId(), ch => { hrWorkerChanges.push(ch); applyHrWorkerChanges(); }))
    .catch((e: any) => { hrWorkersWatched = false; console.warn('Worker watch failed: ' + ((e && e.message) || e)); });
}
let hrRetry: ReturnType<typeof setTimeout> | undefined;
function applyHrWorkerChanges(): void {
  if (!hrWorkerChanges.length) return;
  if (host.workerWindowOpen()) { clearTimeout(hrRetry); hrRetry = setTimeout(applyHrWorkerChanges, 2000); return; }
  const changes = hrWorkerChanges.splice(0);
  let n = 0;
  changes.forEach(({added, removed, changed}) => {
    const gone = new Set(removed.map(String));
    const before = state.workers.length;
    state.workers = state.workers.filter(w => !gone.has(String(w.id)));
    n += before - state.workers.length;
    added.forEach(x => { if (!state.workers.some(w => String(w.id) === String(x.id))) { state.workers.push(x); n++; } });
    // An edit made elsewhere replaces this copy, unless this copy has edits
    // of its own not yet saved (those win and are saved over it).
    (changed || []).forEach(({data, unsaved}) => {
      const i = state.workers.findIndex(w => String(w.id) === String(data.id));
      if (i < 0 || unsaved(state.workers[i])) return;
      state.workers[i] = data; n++;
    });
  });
  if (!n) return;
  try { localStorage.setItem(STORAGE_KEY(), JSON.stringify(getDataObj())); } catch { /* full */ }
  emit('data');
}

// After a failed load, try again once the device is back online or the tab
// is shown again, so cached data doesn't stay on screen until a manual reload.
let loadRetryArmed = false;
function retryLoadDataWhenBack(): void {
  if (loadRetryArmed) return; loadRetryArmed = true;
  const again = async () => {
    if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
    window.removeEventListener('online', again); document.removeEventListener('visibilitychange', again);
    const gd = await gsLoad(); loadRetryArmed = false;
    if (gd) { try { if (applyServerLoad(gd)) notify(tr('Data loaded')); } catch { /* drawn next time */ } afterServerLoad(); }
  };
  window.addEventListener('online', again); document.addEventListener('visibilitychange', again);
  setTimeout(again, 15000);
}
