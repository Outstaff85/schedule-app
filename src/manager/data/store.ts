// The manager app's data: load, save, the offline cache and the live
// watchers (React migration stage 8b; from schedule-manager.html).
// Firestore is the source of truth; localStorage is a cache / offline
// fallback only. loadData() draws the cached data at once, then the server's.
// autoSave() debounces writes (800 ms) and never saves an accidentally
// emptied workers / clients list over existing cached data. The arrays
// themselves (workers, clients, suppliers, weekStart) are still the page's
// state (page.d.ts), read and replaced here by name.
import { loadFirestoreBackend, gsLoad, gsSave, loadError } from './api';
import { getSession, fsTenantId, STORAGE_KEY, STORAGE_KEY_BASE } from './session';
import { syncPunchesFromGS } from './punches';
import { markFirstContent, markFreshContent } from './telemetry';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

export function setSaveStatus(s: 'saving' | 'saved'): void {
  const el = document.getElementById('saveIndicator');
  if (!el) return;
  el.className = 'save-indicator ' + s;
  el.querySelector('span')!.textContent = s === 'saving' ? tr('Saving...') : tr('Saved');
}

export function getDataObj(): Rec {
  return {workers, clients, suppliers, weekStart: weekStart.toISOString(), savedAt: new Date().toISOString()};
}

export function applyData(d: Rec): void {
  if (d.workers) workers = d.workers.map((w: Rec) => ({id: w.id || uid(), clientIds: w.clientIds || [], token: w.token || genToken(), status: w.status || 'active', ...w}));
  if (d.clients) clients = d.clients;
  if (d.suppliers) suppliers = d.suppliers;
  // d.weekStart (the week that was on screen at the last save) is deliberately
  // NOT restored — the Weekly Schedule always opens on the current week, and a
  // background re-load mustn't yank the manager off a week they navigated to.
  // The weekly roster is per weekday (w.schedule[0..6]); a change for one
  // date only lives in w.dateShifts, so the week shown picks those up.
}

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
  if (!(hasPermission('workers') || hasPermission('schedule'))) return false;
  let n = 0;
  workers.forEach(w => { if ('avatarB64' in w) { delete w.avatarB64; n++; } });
  return n > 0;
}
// Apply a fresh server load, unless local changes are still unsaved.
export function applyServerLoad(gd: Rec): boolean {
  if (hasUnsavedLocal()) {
    showToast(tr('Unsaved changes found on this device — saving them now'), 4000);
    autoSave();
    return false;
  }
  applyData(gd);
  const photosDropped = dropWorkerPhotos();
  render();
  if (photosDropped) autoSave();
  const gdJson = JSON.stringify(gd);
  localStorage.setItem(STORAGE_KEY(), gdJson);
  localStorage.setItem(STORAGE_KEY_BASE, gdJson); // legacy key for worker-punch.html's bridge, see autoSave()
  return true;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function autoSave(): void {
  // Glitch guard: don't overwrite existing data with a suddenly-empty state.
  if ((!workers || !workers.length) && (!clients || !clients.length)) {
    let hadData = false;
    try { const prev = JSON.parse(localStorage.getItem(STORAGE_KEY()) || '{}'); hadData = (prev.workers && prev.workers.length) || (prev.clients && prev.clients.length); } catch { /* no cache */ }
    if (hadData) { console.warn('Empty state but cache has data — skipping save'); setSaveStatus('saved'); showToast('⚠ Empty data — save skipped'); return; }
  }
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const data = getDataObj();
      const json = JSON.stringify(data);
      // localStorage as cache only
      localStorage.setItem(STORAGE_KEY(), json);
      localStorage.setItem(STORAGE_KEY() + '_bak', json);
      // Also mirror under the legacy unscoped key — worker-punch.html's
      // updateScheduleManager() (same-device convenience bridge) still reads
      // that literal key and has no tenantId of its own to scope by.
      localStorage.setItem(STORAGE_KEY_BASE, json);
      // Firestore is the primary storage
      try { localStorage.setItem(UNSAVED_KEY(), String(Date.now())); } catch { /* full */ }
      const ok = await gsSave(data);
      if (ok) { try { localStorage.removeItem(UNSAVED_KEY()); } catch { /* ignore */ } }
      setSaveStatus('saved');
      if (ok) showToast(tr('Saved'));
      else showToast(tr('Save failed — kept on this device'));
    } catch (e) {
      console.error('Save failed', e);
      setSaveStatus('saved');
      showToast(tr('Save error'));
    }
  }, 800);
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
      const d = JSON.parse(raw);
      applyData(d);
      __dataReady = true;
      render();
      markFirstContent();
    }
  } catch { /* a broken cache: wait for the server */ }

  // 2. Always load from Firestore (primary source)
  try {
    const gd = await gsLoad();
    __dataReady = true;
    if (gd) {
      applyServerLoad(gd);
      markFreshContent('app');
      setSaveStatus('saved');
      syncPunchesFromGS();
      if (isHrSession()) watchHrWorkers();
      watchHoursBatches();
      maybeRegenAfterFirmEdit();
    } else {
      const err = loadError();
      showToast(tr('Could not load from the server — showing saved data{0}', {0: (err ? ' (' + err.slice(0, 80) + ')' : '')}), 6000);
      retryLoadDataWhenBack();
    }
  } catch (e) {
    console.error('Load failed', e);
    showToast(tr('Offline — using cached data'));
  }
  if (!__dataReady) { __dataReady = true; if (currentTab === 'dashboard') renderDashboard(); if (currentTab === 'schedule') renderSchedulePage(); }
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
  loadFirestoreBackend().then(b => b.listenPendingHours(fsTenantId(), list => {
    batches = list;
    updateHoursBadge(); refreshBell();
    refreshCardHoursStatus();
    if (currentTab === 'accounting') renderAccounting();
  })).catch((e: any) => { hoursWatched = false; console.warn('Hours watch failed: ' + ((e && e.message) || e)); });
}
export function updateHoursBadge(): void {
  const tab = document.getElementById('tabAccounting'); if (!tab) return;
  const n = (batches || []).filter(b => b.status === 'pending').length;
  let el = document.getElementById('accPendingBadge');
  if (!el) { el = document.createElement('span'); el.id = 'accPendingBadge'; el.className = 'tab-badge'; tab.querySelector('.ic')!.appendChild(el); }
  el.textContent = n > 99 ? '99+' : String(n);
  el.style.display = n ? '' : 'none';
  el.title = tr('{0} hours batch(es) waiting for review', {0: (n)});
}
// This worker's latest hours batch (by when it was sent), or null.
export function latestHoursBatch(workerId: unknown): Rec | null {
  return (batches || []).filter(b => (b.entries || []).some((r: Rec) => r.workerId === workerId))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0] || null;
}
// An open worker card shows the worker's latest batch live.
function refreshCardHoursStatus(): void { if (window.ManagerIsland) window.ManagerIsland.refreshWindows(); }

// An HR's worker list follows the server (listenWorkers): a worker the owner
// assigns appears, one taken away disappears, a field the owner edits (a
// rate, a phone…) changes. Applied while no worker form or card is open
// (their index into `workers` must not move); otherwise it waits and tries again.
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
  const busy = ['workerOverlay','workerCardOverlay','payOverlay'].some(id => document.getElementById(id)?.classList.contains('open'));
  if (busy) { clearTimeout(hrRetry); hrRetry = setTimeout(applyHrWorkerChanges, 2000); return; }
  const changes = hrWorkerChanges.splice(0);
  let n = 0;
  changes.forEach(({added, removed, changed}) => {
    const gone = new Set(removed.map(String));
    const before = workers.length;
    workers = workers.filter(w => !gone.has(String(w.id)));
    n += before - workers.length;
    added.forEach(x => { if (!workers.some(w => String(w.id) === String(x.id))) { workers.push(x); n++; } });
    // An edit made elsewhere replaces this copy, unless this copy has edits
    // of its own not yet saved (those win and are saved over it).
    (changed || []).forEach(({data, unsaved}) => {
      const i = workers.findIndex(w => String(w.id) === String(data.id));
      if (i < 0 || unsaved(workers[i])) return;
      workers[i] = data; n++;
    });
  });
  if (!n) return;
  try { localStorage.setItem(STORAGE_KEY(), JSON.stringify(getDataObj())); } catch { /* full */ }
  render();
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
    if (gd) { try { if (applyServerLoad(gd)) showToast(tr('Data loaded')); } catch { /* drawn next time */ } markFreshContent('app'); syncPunchesFromGS(); maybeRegenAfterFirmEdit(); }
  };
  window.addEventListener('online', again); document.addEventListener('visibilitychange', again);
  setTimeout(again, 15000);
}
