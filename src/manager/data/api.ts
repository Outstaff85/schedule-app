// The manager app's way to the backend (React migration stage 8b; from
// schedule-manager.html): firestore-backend.js loaded once, the fetch(API_URL)
// dispatcher, the direct calls (gs*) and the worker file uploads.
import type { FirestoreBackend } from '../../lib/firestore-backend';
import { getSession, clearSession, gsAuth, fsTenantId } from './session';
import { reportTiming, reportError } from './telemetry';
import { notify, tr } from './events';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

// Every data call of the page is written as fetch(API_URL, {method:'POST',
// body: JSON.stringify({action, ...})}) or fetch(API_URL + '?action=...').
// API_URL is not a server: the window.fetch wrapper below answers each such
// call from firestore-backend.js (Firestore, Storage, or the Cloud Functions
// it calls) in the JSON shape the call site expects, so the call sites stay
// simple. An action nothing answers gets {error:'Unknown action: …'}.
export const API_URL = 'api://app';

let fsBackend: Promise<FirestoreBackend> | null = null;
export function loadFirestoreBackend(): Promise<FirestoreBackend> {
  if (fsBackend) return fsBackend;
  fsBackend = new Promise<FirestoreBackend>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'firestore-backend.js';
    el.onload = () => window.initFirestoreBackend!().then(resolve, reject);
    el.onerror = () => reject(new Error('firestore-backend.js failed to load'));
    document.head.appendChild(el);
  }).catch(e => { fsBackend = null; throw e; });
  return fsBackend;
}

// Worker files — the Form 101 PDF, the scan sidecar and worker documents —
// are uploaded to Firebase Storage (firestore-backend.js uploadWorkerFile,
// real byte progress). uploadWorkerFile() returns {ok,id,url}; the id is the
// Storage path. The file being replaced (previousFileId) is deleted after
// the new one is up.
// Uploads still running; the new-app-version reload waits for them (the page's service worker code).
let uploadsInFlight = 0;
export const uploadsRunning = (): number => uploadsInFlight;
export async function uploadWorkerFile(bodyObj: Rec, onProgress?: (sent: number, total: number) => void): Promise<Rec> {
  uploadsInFlight++;
  try {
    const b = await loadFirestoreBackend();
    const json = await b.uploadWorkerFile(fsTenantId(), bodyObj, onProgress);
    if (json && json.ok && bodyObj.previousFileId && bodyObj.previousFileId !== json.id) gsDeleteWorkerDoc(bodyObj.previousFileId);
    return json;
  } catch (e: any) {
    return {error: 'Storage: ' + ((e && (e.code || e.message)) || e)};
  } finally { uploadsInFlight = Math.max(0, uploadsInFlight - 1); }
}

// The data-call dispatcher. Every fetch(API_URL…) call of the page (and of
// scan-pipeline.js) is answered by firestore-backend.js handleAction() —
// Firestore, Storage, or the users_admin / ai_read functions it calls — and
// comes back as a JSON Response, so the call sites read it like any reply.
// A reply with the exact "session expired" text (the functions refused the
// Firebase ID token: signed out, revoked after a rights change) clears the
// session and returns to the login screen. A call slower than
// SLOW_API_CALL_MS goes to the Timings pane as kind "gs:<action>".
export const SESSION_EXPIRED_ERROR = 'Session expired or invalid — please sign in again';
// Telemetry and login never trigger the session-expired logout.
const NO_LOGOUT_ACTIONS = ['logError','login','logTiming','logBatch'];
const SLOW_API_CALL_MS = 2500;
function apiParams(url: string, opts?: RequestInit): Rec {
  try { if (opts && typeof opts.body === 'string') return JSON.parse(opts.body); } catch { /* not JSON: the query */ }
  try { return Object.fromEntries(new URL(url).searchParams); } catch { return {}; }
}
const jsonResponse = (obj: unknown) => new Response(JSON.stringify(obj), {status: 200, headers: {'Content-Type': 'application/json'}});
async function route(url: string, opts?: RequestInit): Promise<Response> {
  const params = apiParams(url, opts);
  const action: string = params.action || 'loadSchedule';
  const s = getSession() || ({} as Rec);
  const ctx = {role: s.role, username: s.username, tenantId: s.viewingTenantId || s.tenantId};
  const t0 = Date.now();
  let json: Rec | null;
  try { json = await (await loadFirestoreBackend()).handleAction(action, params, ctx); }
  catch (e: any) { console.warn(action + ' failed:', e); json = {error: 'Firestore: ' + ((e && e.message) || e)}; }
  if (json == null) json = {error: 'Unknown action: ' + action};
  const quiet = NO_LOGOUT_ACTIONS.indexOf(action) !== -1;
  const ms = Date.now() - t0;
  // An AI call's reply carries _meta (time at Anthropic, tries, tokens) — kept with the measurement.
  const meta = json && json._meta && typeof json._meta === 'object' ? json._meta : null;
  if (meta) delete json._meta;
  if (!quiet && ms >= SLOW_API_CALL_MS) try { reportTiming('gs:' + action, ms, Object.assign({}, meta || {}, params.part ? {part: String(params.part)} : {})); } catch { /* telemetry never breaks a call */ }
  if (!quiet && json && json.error === SESSION_EXPIRED_ERROR && getSession()) {
    clearSession();
    notify(tr('Session expired — please sign in again'));
    setTimeout(() => location.reload(), 1200);
  }
  return jsonResponse(json);
}
export function installDispatcher(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = function (url: RequestInfo | URL, opts?: RequestInit) {
    if (typeof url === 'string' && url.indexOf(API_URL) === 0) return route(url, opts);
    return origFetch(url, opts);
  } as typeof window.fetch;
}

// ── Data sync (Firestore) ──────────────────────────────────────────────
export async function gsSave(data: Rec): Promise<boolean> {
  // Empty-payload guard: never push an empty dataset (would delete every record).
  if ((!data.workers || !data.workers.length) && (!data.clients || !data.clients.length)) {
    console.warn('Empty payload — skipping save');
    return false;
  }
  try { const r = await (await loadFirestoreBackend()).saveSchedule(fsTenantId(), data); return !!(r && r.ok); }
  catch (e) { console.warn('Firestore save failed:', e); return false; }
}

// The firm's workers, clients and suppliers. A failure leaves its reason in
// loadError() and the Errors pane; loadData() then keeps the cache.
let lastLoadError = '';
export const loadError = (): string => lastLoadError;
export async function gsLoad(): Promise<Rec | null> {
  try {
    const b = await loadFirestoreBackend();
    // The Firebase sign-in is gone (site data cleared, signed out elsewhere): log in again.
    if (!b.currentUser()) { clearSession(); location.reload(); return null; }
    const d = await b.loadSchedule(fsTenantId()); lastLoadError = ''; return d;
  } catch (e: any) { lastLoadError = 'Firestore: ' + ((e && e.message) || e); reportError('loadSchedule failed: ' + lastLoadError, 'gsLoad', ''); return null; }
}

export async function gsSavePunch(entry: Rec): Promise<void> {
  try { await (await loadFirestoreBackend()).savePunch(fsTenantId(), entry); } catch (e) { console.warn('Firestore punch save failed:', e); }
}
export async function gsDeletePunch(id: unknown): Promise<void> {
  try { await (await loadFirestoreBackend()).deletePunch(fsTenantId(), id); } catch (e) { console.warn('Firestore delete failed:', e); }
}
export async function gsUpdatePunch(data: Rec): Promise<void> {
  try { await (await loadFirestoreBackend()).updatePunch(fsTenantId(), data); } catch (e) { console.warn('Firestore update failed:', e); }
}
// Best-effort: deletes a worker's stored file in Storage (the replaced Form
// 101 or sidecar, or every file of a deleted worker). Never blocks anything.
export async function gsDeleteWorkerDoc(fileId: unknown): Promise<void> {
  try {
    await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'deleteWorkerDoc', ...gsAuth(), fileId })
    });
  } catch (e) { console.warn('Worker file delete failed:', e); }
}
