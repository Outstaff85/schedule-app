// The worker punch page's logic (docs/punch.md), moved one to one from the old
// worker-punch.html: the personal link, the site and its geofence, the GPS
// checks, the punch, the offline queue, the schedule-change notice. The screen
// state lives here, outside React (a language change redraws the page from
// scratch, I18nProvider), and the components read it with usePunch().
// There is no login: the link token is the only credential; the page talks
// only to the punch function, which hands out only this worker and their sites.
import * as React from 'react';
import { toast } from 'sonner';
import { tr } from '@/lib/i18n';

// ── Data shapes ──
export interface Day { type?: string; start?: string; end?: string }
export interface PWorker {
  id: string; name: string; colorIdx?: number; token: string | null; clientIds: string[];
  schedule: Day[]; dates: Record<string, Day>;
}
export interface PClient { id: string; name?: string; object?: string; lat?: number | string | null; lng?: number | string | null; radius?: number | string | null }
export interface PunchEntry {
  id: number; workerId: string; workerName: string; type: 'in' | 'out'; time: string; ts: string;
  site: string; clientId: string | null; dist: number | null; lat: number | null; lng: number | null;
  gpsVerified: boolean; geoSkipped: boolean; manual: boolean;
  gpsAccuracy: number | null; gpsSuspicious: boolean; gpsWarnings: string[]; gpsElapsed: number | null;
  workerToken?: string | null;
}
export type Screen = 'none' | 'loading' | 'invalid' | 'punch' | 'schedule' | 'hours' | 'documents';
/** The worker's documents to sign, or signed (documents.ts; docs/contracts.md → Signing). */
export interface SignReq { id: string; status: 'sent' | 'signing' | 'signed'; templateName?: string; signDate?: string | null; dateFixed?: boolean; signedAt?: string }
export type IconName = 'link' | 'link-off' | 'wifi-off' | 'alert-triangle';
/** A day the worker can't work ('unavailable') or their shift offered to a colleague ('swap'), from the punch function's myRequests. */
export interface ShiftReq { id: string; kind: 'unavailable' | 'swap'; date: string; start?: string; end?: string; toWorkerId?: string; toWorkerName?: string; note?: string; status: 'active' | 'pending' | 'confirmed' | 'declined' }
export interface Colleague { id: string; name: string }
export interface MonthData { punches?: Record<string, unknown>[]; pay?: Record<string, unknown>; clients?: PClient[]; local?: boolean; failed?: boolean; error?: string }

// ── The link and the site ──
const params = new URLSearchParams(window.location.search);
// An installed punch app relaunches from the manifest's start_url, without
// ?t= — the link's token is remembered and reused when running standalone.
const _standalone = (window.matchMedia?.('(display-mode: standalone)').matches ?? false) || (navigator as { standalone?: boolean }).standalone === true;
export const URL_TOKEN: string | null = (() => {
  const t = params.get('t') || params.get('token') || null;
  try {
    if (t) localStorage.setItem('punchToken', t);
    else if (_standalone) return localStorage.getItem('punchToken');
  } catch { /* storage blocked */ }
  return t;
})();
let _site: Record<string, unknown> & { workers?: PWorker[] } | null = null;
try { _site = JSON.parse(localStorage.getItem('punchClockSite') || 'null'); } catch { /* none */ }
// A personal link (token in URL) is self-contained: trust ONLY the URL, never a
// stale punchClockSite left in localStorage from an admin session.
const _siteEff = URL_TOKEN ? null : _site;
// Legacy long links carry their own &lat=&lng=; short token links don't (geo comes from the DB).
const _urlHasGeo = !!(params.get('lat') && params.get('lng'));
// `??`, not `||`: a real 0 coordinate stays a coordinate.
const _rawLat = (_siteEff?.lat as string | undefined) ?? params.get('lat');
const _rawLng = (_siteEff?.lng as string | undefined) ?? params.get('lng');
const num = (v: unknown) => (v != null && v !== '' && !isNaN(parseFloat(String(v))) ? parseFloat(String(v)) : null);
export const SITE: { name: string; object: string; lat: number | null; lng: number | null; radius: number; clientId: string | null } = {
  name: (_siteEff?.clientName as string) || params.get('site') || 'Work Site',
  object: '',
  lat: num(_rawLat),
  lng: num(_rawLng),
  radius: parseInt(String(_siteEff?.radius || params.get('r'))) || 100,
  clientId: (_siteEff?.clientId as string) || null,
};

export const PUNCH_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/punch';
export const WEATHER_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/weather';
export function punchFn(body: Record<string, unknown>) {
  return fetch(PUNCH_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
/** One punch to the server; the reply is {ok} or {error}. */
function postPunch(e: PunchEntry) { return punchFn({ action: 'savePunch', token: e.workerToken || wpToken(), data: e }); }

// ── The store ──
export interface PunchState {
  screen: Screen;
  invalid: { title: string; msg: string; icon: IconName } | null;
  /** the picker of several sites (null = closed) */
  picker: PClient[] | null;
  worker: PWorker | null;
  /** the location pill: its colour and its text (an English key and its values, translated when drawn) */
  loc: { cls: 'loading' | 'ok' | 'warn'; t: string; p?: Record<string, string | number> };
  locOk: boolean;
  /** why GPS gives nothing (docs/punch.md → GPS off or blocked): not asked yet ('ask'), the app has
   * no permission ('denied'), the phone's location is off ('off'), the browser has no GPS ('none');
   * null when it works */
  gpsBlock: 'ask' | 'denied' | 'off' | 'none' | null;
  /** the GPS window is open (the first ask, or the steps after a refusal) */
  gpsHelp: boolean;
  /** the browser may still ask for the permission (a refusal that was only a closed question) */
  gpsCanAsk: boolean;
  /** the button's face after a punch (the check, ~1.6 s) */
  done: 'in' | 'out' | null;
  result: { type: 'in' | 'out'; text: string } | null;
  schedChanged: boolean;
  queued: number;
  wx: { kind: string; temp?: number } | null;
  tileHours: string;
  /** the worker's days off and shift offers (null = not read yet) and the colleagues of their sites (requests.ts) */
  requests: ShiftReq[] | null;
  colleagues: Colleague[];
  /** the documents to sign or signed (null = none, or not read yet) */
  signReq: SignReq | null;
  /** bumped on every write that the screens draw from (the punch log, the month data) */
  rev: number;
}
let st: PunchState = {
  screen: 'none', invalid: null, picker: null, worker: null,
  loc: { cls: 'loading', t: 'Checking location...' }, locOk: false, gpsBlock: null, gpsHelp: false, gpsCanAsk: false,
  done: null, result: null, schedChanged: false, queued: 0, wx: null, tileHours: '—', requests: null, colleagues: [], signReq: null, rev: 0,
};
const subs = new Set<() => void>();
export const set = (p: Partial<PunchState>) => { st = { ...st, ...p }; subs.forEach(f => f()); };
export const getState = () => st;
export const usePunch = () => React.useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => st);

let workers: PWorker[] = [];
export let allClients: PClient[] = [];
let _geoLocked = false, _lastPunchAt = 0, locDist: number | null = null;
let lastGps: { lat: number; lng: number; accuracy: number; dist: number; suspicious: boolean; warnings: string[]; elapsed: number; at: number } | null = null;
/** How long one on-site GPS reading allows punching: an open tab can't punch OUT from elsewhere on an old fix. */
const GPS_FRESH_MS = 60 * 1000;

// ── Toasts: the old showToast's kinds, guessed from the text ──
function toastKind(t: string) {
  if (/fail|error|could not|couldn't|not saved|denied|refused|invalid|נכשל|שגיאה|לא נשמר|לא ניתן/i.test(t)) return 'err';
  if (/(…|\.\.\.)\s*$/.test(t)) return 'info';
  if (/⚠|warn|check|empty|missing|not found|בדקו|ריק|חסר|לא נמצא/i.test(t)) return 'warn';
  return 'ok';
}
export function showToast(msg: string) {
  const k = toastKind(msg);
  (k === 'err' ? toast.error : k === 'warn' ? toast.warning : k === 'info' ? toast.info : toast.success)(msg);
}

// ── The device's punch log ──
export function getPunchLog(): PunchEntry[] { try { return JSON.parse(localStorage.getItem('punchLog') || '[]'); } catch { return []; } }
function savePunchLog(log: PunchEntry[]) { localStorage.setItem('punchLog', JSON.stringify(log)); }
export function getLastEntry(log: PunchEntry[], wid?: string): PunchEntry | null {
  const es = log.filter(e => e.workerId === wid);
  if (!es.length) return null;
  return es.reduce((a, b) => (new Date(b.ts).getTime() > new Date(a.ts).getTime() ? b : a));
}
export function haversine(a: number, b: number, c: number, d: number) {
  const R = 6371000, dL = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
  const x = Math.sin(dL / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// A leftover bridge to the manager app on the same device: an OUT writes today's shift into its cache.
function updateScheduleManager(wid: string, s: string, e: string) {
  try {
    const k = 'schedMgr_v1', r = localStorage.getItem(k) || localStorage.getItem('scheduleManagerData');
    if (!r) return;
    const d = JSON.parse(r), w = d.workers?.find((x: { id: string }) => x.id === wid);
    if (w) { w.schedule[new Date().getDay()] = { type: 'work', start: s, end: e }; localStorage.setItem(k, JSON.stringify(d)); }
  } catch { /* no cache */ }
}

// ── Offline queue ──
const QUEUE_KEY = 'punchQueue';
export function getQueue(): PunchEntry[] { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function saveQueue(q: PunchEntry[]) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
// The firm of a punch comes from the worker's own link token; a queued entry
// carries its own, so a flush after switching links still posts to the right firm.
export function wpToken(): string | null { return (st.worker && st.worker.token) || URL_TOKEN || null; }

// 'retry': no network, a server failure (5xx) or an unreadable reply — the
// punch is queued. 'refused': the function answered with json.error (a link
// that no longer works, a punch that isn't this worker's) — a retry can never
// succeed, so it isn't queued forever; the punch stays in the local history.
async function sendPunch(e: PunchEntry): Promise<'ok' | 'retry' | { refused: string }> {
  try {
    const res = await postPunch(e);
    let json: { error?: string } | null = null;
    try { json = await res.json(); } catch { return 'retry'; }
    if (json && !json.error) return 'ok';
    return res.ok && json?.error ? { refused: json.error } : 'retry';
  } catch { return 'retry'; }
}
function showRefused(msg: string) { showToast(tr('Punch not recorded: {0}', { 0: msg })); }
async function gsSavePunch(entry: PunchEntry) {
  if (!navigator.onLine) { queueEntry(entry); return; }
  const r = await sendPunch(entry);
  if (r === 'retry') queueEntry(entry);
  else if (r !== 'ok') showRefused(r.refused);
}
function queueEntry(entry: PunchEntry) {
  entry.workerToken = entry.workerToken || wpToken();
  const q = getQueue(); q.push(entry); saveQueue(q);
  set({ queued: q.length });
}
let _flushingQueue = false;
/** Sends the queued punches one at a time ('online' and on load); the failed ones stay. */
export async function flushQueue() {
  if (_flushingQueue) return; // two overlapping runs would both read the same queue and double-post
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;
  _flushingQueue = true;
  const failed: PunchEntry[] = [];
  let left = failed;
  try {
    for (const e of q) {
      const r = await sendPunch(e);
      if (r === 'retry') failed.push(e);
      else if (r !== 'ok') showRefused(r.refused);
    }
    // Keep what was queued while this loop was waiting on the network.
    left = failed.concat(getQueue().slice(q.length));
    saveQueue(left);
  } finally { _flushingQueue = false; }
  set({ queued: left.length });
  if (!left.length && q.length) showToast(q.length > 1 ? tr('Synced {0} offline punches', { 0: q.length }) : tr('Synced 1 offline punch'));
}
/** At startup: a queue left from before shows its badge and is sent. */
export function startQueue() {
  window.addEventListener('online', () => void flushQueue());
  const q = getQueue();
  if (q.length) { set({ queued: q.length }); void flushQueue(); }
}

// ── Workers ──
const slim = (list: Record<string, unknown>[]): PWorker[] => list.map((w, i) => ({
  id: w.id as string, name: w.name as string, colorIdx: (w.colorIdx as number) || i, token: (w.token as string) || null,
  clientIds: (w.clientIds as string[]) || [], schedule: Array.isArray(w.schedule) ? w.schedule as Day[] : [],
  dates: (w.dates && typeof w.dates === 'object') ? w.dates as Record<string, Day> : {},
}));
// Filtered to the site's client when set, falling back to all if that is empty.
const forSite = (list: Record<string, unknown>[]) => {
  if (!SITE.clientId) return list;
  const f = list.filter(w => ((w.clientIds as string[]) || []).includes(SITE.clientId!));
  return f.length ? f : list;
};
function loadWorkers() {
  // 1: data passed from the manager app (same device); 2: its cache; 3: the server (init).
  if (_site?.workers?.length) { workers = _site.workers; return; }
  try {
    const raw = localStorage.getItem('schedMgr_v1') || localStorage.getItem('scheduleManagerData');
    if (raw) {
      const d = JSON.parse(raw);
      allClients = d.clients || [];
      workers = slim(forSite(d.workers || []));
      if (workers.length) return;
    }
  } catch { /* bad cache */ }
  workers = [];
}
/** true when the server answered (this worker, or "Unknown worker link" → no workers); false when unreachable. */
export async function loadWorkersFromGS(): Promise<boolean> {
  if (!URL_TOKEN) return false;
  try {
    const res = await punchFn({ action: 'load', token: URL_TOKEN });
    const data = JSON.parse(await res.text());
    if (data.error === 'Unknown worker link') { workers = []; return true; }
    if (data.workers && data.workers.length) {
      allClients = data.clients || [];
      workers = slim(forSite(data.workers));
      localStorage.setItem('schedMgr_v1', JSON.stringify(data)); // the next open works offline from it
      return true;
    }
  } catch (e) { console.warn('Worker load failed:', (e as Error).message); }
  return false;
}

// ── Startup ──
export function init() {
  loadWorkers();
  if (URL_TOKEN) {
    const cached = workers.find(w => w.token === URL_TOKEN);
    if (cached) {
      // Fast path from the cache (also offline); online, verify in the background.
      goToPunchDirect(cached);
      if (navigator.onLine) verifyAndRefresh();
    } else if (navigator.onLine) {
      set({ screen: 'loading' });
      const noServer = () => showInvalidLink(tr('Connection problem'), tr("Couldn't reach the server. Check your connection and reload."), 'wifi-off');
      loadWorkersFromGS().then(ok => {
        if (!ok) { noServer(); return; }
        const verified = workers.find(w => w.token === URL_TOKEN);
        if (verified) goToPunchDirect(verified); else showInvalidLink();
      }).catch(noServer);
    } else {
      showInvalidLink(tr('No connection'), tr('Open this link once while online to set it up. After that it works offline.'), 'wifi-off');
    }
    return;
  }
  // No personal link: the page works only from a worker's own link.
  showInvalidLink(tr('Open your personal link'), tr('This page works only from the personal link your manager sent you.'), 'link');
}

// The token still exists (a regenerated or removed one is revoked at once) and the geofence is fresh.
function verifyAndRefresh() {
  loadWorkersFromGS().then(ok => {
    if (!ok) return; // server unreachable → keep the cached view
    const fresh = workers.find(w => w.token === URL_TOKEN);
    if (!fresh) { showInvalidLink(); return; }
    set({ worker: fresh });
    checkScheduleChange();
    if (!_urlHasGeo && !_geoLocked) {
      SITE.lat = null; SITE.lng = null;
      resolveSiteFromWorker(fresh);
      getLocation();
    }
  }).catch(() => {});
}

export function showInvalidLink(title?: string, msg?: string, icon?: IconName) {
  set({
    screen: 'invalid', picker: null,
    invalid: { title: title || tr('Invalid Link'), msg: msg || tr('This link is no longer valid.') + '\n' + tr('Ask your manager for a new link.'), icon: icon || 'link-off' },
  });
}

const hasGeo = (c: PClient) => c.lat != null && c.lng != null && c.lat !== '' && c.lng !== '';
// A token link without URL geo: the first of the worker's clients with coordinates is the site;
// none with coordinates → the first gives the name only (no geofence).
function resolveSiteFromWorker(w: PWorker) {
  if (SITE.lat != null && SITE.lng != null) return;
  if (!w || !(w.clientIds || []).length || !allClients.length) return;
  const cs = w.clientIds.map(id => allClients.find(x => x.id === id)).filter(Boolean) as PClient[];
  const geo = cs.find(hasGeo);
  if (geo) {
    SITE.name = geo.name || SITE.name; SITE.object = geo.object || '';
    SITE.lat = Number(geo.lat); SITE.lng = Number(geo.lng); SITE.radius = Number(geo.radius) || 100; SITE.clientId = geo.id;
  } else if (cs[0]) {
    SITE.name = cs[0].name || ''; SITE.object = cs[0].object || ''; SITE.clientId = cs[0].id;
  }
}

function goToPunchDirect(w: PWorker) {
  set({ worker: w });
  if (!workers.find(x => x.id === w.id)) workers = [w, ...workers];
  const ids = [...new Set(w.clientIds || [])];
  // Several sites but the client list not loaded yet (the cache fast path): load it first, so the picker can be built.
  if (ids.length > 1 && SITE.lat == null && !allClients.length && navigator.onLine) {
    loadWorkersFromGS().then(() => decideObjectOrPunch(w)).catch(() => enterPunch(w, false));
    return;
  }
  decideObjectOrPunch(w);
}
function decideObjectOrPunch(w: PWorker) {
  const objs = [...new Set(w.clientIds || [])].map(id => allClients.find(x => x.id === id)).filter(Boolean) as PClient[];
  if (objs.length > 1 && SITE.lat == null) { _geoLocked = true; set({ picker: objs, screen: 'punch' }); return; }
  enterPunch(w, false);
}
/** The worker picked the site they are at; it is locked (the background refresh keeps it). */
export function pickObject(clientId: string) {
  const c = allClients.find(x => x.id === clientId);
  if (c) {
    SITE.name = c.name || SITE.name; SITE.object = c.object || ''; SITE.clientId = c.id;
    if (hasGeo(c)) { SITE.lat = Number(c.lat); SITE.lng = Number(c.lng); SITE.radius = Number(c.radius) || 100; }
    else { SITE.lat = null; SITE.lng = null; }
  }
  _geoLocked = true;
  set({ picker: null });
  enterPunch(st.worker!, true);
}
function enterPunch(w: PWorker, skipResolve: boolean) {
  if (!skipResolve) resolveSiteFromWorker(w);
  set({ screen: 'punch' });
  getLocation();
  checkScheduleChange();
}
/** Back to the punch screen, with a fresh GPS check. */
export function closeSheet() { if (!st.worker) return; set({ screen: 'punch' }); getLocation(); }

// ── GPS check (anti-spoofing) ──
export const GPS_MAX_ACCURACY = 150, GPS_REQUEST_MS = 800, GPS_MAX_SPEED = 55;
let _lastGpsPos: { lat: number; lng: number; ts: number } | null = null;
function analyseGps(pos: GeolocationPosition) {
  const warnings: string[] = [], { latitude: lat, longitude: lng, accuracy: acc, speed: spd, altitude: alt } = pos.coords, ts = pos.timestamp;
  if (acc === 0) warnings.push('accuracy=0 (fake GPS suspected)');
  else if (acc > GPS_MAX_ACCURACY) warnings.push('accuracy too low (' + Math.round(acc) + 'm)');
  if (_lastGpsPos) { const dt = (ts - _lastGpsPos.ts) / 1000; if (dt > 0 && dt < 300) { const sp = haversine(lat, lng, _lastGpsPos.lat, _lastGpsPos.lng) / dt; if (sp > GPS_MAX_SPEED) warnings.push('impossible speed (' + (sp * 3.6).toFixed(0) + 'km/h)'); } }
  if (spd != null && spd > GPS_MAX_SPEED) warnings.push('device speed ' + (spd * 3.6).toFixed(0) + 'km/h');
  if (alt === 0 && acc < 10) warnings.push('altitude=0 with high accuracy');
  _lastGpsPos = { lat, lng, ts };
  return { lat, lng, acc, suspicious: warnings.length > 0, warnings };
}
// GPS off or blocked (docs/punch.md → GPS off or blocked). The page checks by itself: the
// browser's permission for the page (Permissions API, when there is one: a refusal is known
// at once, and a change made in the settings re-reads the location by itself) and the reply
// of a reading (denied / position unavailable). On the first entry (not asked yet) a window
// says GPS is needed and its button asks; a refusal opens the steps for this phone by itself
// (once per kind and visit; a tap on "Turn on GPS" always opens them).
let _permWatch = false;
async function gpsPermission(): Promise<PermissionState | null> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (!p) return null;
    if (!_permWatch) { _permWatch = true; p.onchange = () => { if (st.worker && st.screen === 'punch') getLocation(); }; }
    return p.state;
  } catch { return null; }
}
// this device gave a reading before (for a browser without the Permissions API: then no first ask)
const gpsKnown = () => { try { return localStorage.getItem('gpsOk') === '1'; } catch { return false; } };
const rememberGps = () => { try { localStorage.setItem('gpsOk', '1'); } catch { /* private mode */ } };
let _askedByTap = false; // the reading was asked for by a tap: a refusal opens the steps
const _shown = new Set<string>(); // the GPS windows opened by themselves on this visit
const showOnce = (kind: string) => { const open = _askedByTap || !_shown.has(kind); _shown.add(kind); return open; };
const blocked = (gpsBlock: 'denied' | 'off' | 'none', gpsCanAsk = false) => set({
  gpsBlock, gpsCanAsk, locOk: false, ...(showOnce(gpsBlock) ? { gpsHelp: true } : {}),
  loc: { cls: 'warn', t: gpsBlock === 'denied' ? 'GPS is blocked for this app' : gpsBlock === 'off' ? 'GPS is off on this phone' : 'GPS not available' },
});
/** One GPS reading → the location pill and whether a punch is allowed (locOk). */
export async function getLocation() {
  set({ loc: { cls: 'loading', t: 'Checking GPS...' }, locOk: false });
  // A site without coordinates: the check is skipped and the punch allowed.
  if (SITE.lat == null || SITE.lng == null) { set({ loc: { cls: 'ok', t: 'Location check skipped' }, locOk: true, gpsBlock: null, gpsHelp: false }); return; }
  if (!navigator.geolocation) { blocked('none'); _askedByTap = false; return; }
  const perm = await gpsPermission();
  if (perm === 'denied') { blocked('denied'); _askedByTap = false; return; }
  // not asked yet: first say why, and ask from the window's button (a question out of nowhere is easily refused)
  if (!_askedByTap && (perm === 'prompt' || (perm == null && !gpsKnown()))) {
    set({ gpsBlock: 'ask', gpsCanAsk: true, locOk: false, ...(showOnce('ask') ? { gpsHelp: true } : {}), loc: { cls: 'warn', t: 'Allow GPS to punch' } });
    return;
  }
  const t0 = Date.now();
  navigator.geolocation.getCurrentPosition(pos => {
    const elapsed = Date.now() - t0, a = analyseGps(pos);
    const dist = Math.round(haversine(a.lat, a.lng, SITE.lat!, SITE.lng!)); locDist = dist;
    const tooFast = elapsed < GPS_REQUEST_MS;
    const distOk = dist <= SITE.radius, accOk = a.acc > 0 && a.acc <= GPS_MAX_ACCURACY;
    lastGps = { lat: a.lat, lng: a.lng, accuracy: a.acc, dist, suspicious: a.suspicious || tooFast, warnings: tooFast ? ['Response in ' + elapsed + 'ms (too fast)'].concat(a.warnings) : a.warnings, elapsed, at: Date.now() };
    _askedByTap = false; rememberGps();
    set({ gpsBlock: null, gpsHelp: false });
    if (!distOk) set({ locOk: false, loc: { cls: 'warn', t: '{0}m from site (max {1}m)', p: { 0: dist, 1: SITE.radius } } });
    else if (!accOk) set({ locOk: false, loc: { cls: 'warn', t: 'Weak GPS (±{0}m) — go outside', p: { 0: Math.round(a.acc) } } });
    else if (a.suspicious || tooFast) set({ locOk: false, loc: { cls: 'warn', t: 'Suspicious GPS: {0}', p: { 0: tooFast ? tr('instant response') : a.warnings[0] } } });
    else set({ locOk: true, loc: { cls: 'ok', t: 'On site · {0}m · ±{1}m', p: { 0: dist, 1: Math.round(a.acc) } } });
  }, err => {
    // 1: no permission (or, on an iPhone, Location Services off); 2: the phone's location is off; 3: no fix in time.
    // A refusal the browser does not keep (the question only closed) leaves the permission at "prompt": asking again works.
    if (err.code === 1) void gpsPermission().then(p => { blocked('denied', p === 'prompt'); _askedByTap = false; });
    else { if (err.code === 2) blocked('off'); else set({ gpsBlock: null, locOk: false, loc: { cls: 'warn', t: 'GPS error — go outside' } }); _askedByTap = false; }
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
/** "Allow GPS" / "Turn on GPS" (the punch button, the notice, the window's button): asks for the
 * location at once, from the tap — the browser then asks for the permission when it may still
 * ask, and Chrome on Android offers to turn the phone's location on. A page can't switch GPS on
 * or open the phone's settings itself: when the browser refuses, the steps for this phone open,
 * and a permission given later in the settings is seen by itself. */
export function enableGps() { _askedByTap = true; set({ gpsHelp: false }); void getLocation(); }
/** "Ask again" on an iPhone: Safari asks again when the page opens anew (the same as closing and reopening the app). */
export function reopenForGps() { location.reload(); }
export const openGpsHelp = () => set({ gpsHelp: true });
export const closeGpsHelp = () => set({ gpsHelp: false });

// ── A punch ──
/** IN or OUT: the opposite of the worker's last punch across all days (an overnight shift closes correctly). */
export function nextType(): 'in' | 'out' { return getLastEntry(getPunchLog(), st.worker?.id)?.type === 'in' ? 'out' : 'in'; }
export function doPunch() {
  const w = st.worker;
  if (!st.locOk || !w) return;
  if (Date.now() - _lastPunchAt < 4000) { showToast(tr('Wait a couple of seconds')); return; } // an accidental double tap
  const geoEnforced = SITE.lat != null && SITE.lng != null;
  // The site check must be fresh: re-read the GPS instead of punching on an old reading.
  if (geoEnforced && (!lastGps || Date.now() - lastGps.at > GPS_FRESH_MS)) { showToast(tr('Checking your location again — punch in a moment')); getLocation(); return; }
  _lastPunchAt = Date.now();
  const now = new Date(), hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  const log = getPunchLog(), last = getLastEntry(log, w.id), type = last?.type === 'in' ? 'out' : 'in';
  const gps = lastGps || ({} as Partial<NonNullable<typeof lastGps>>);
  const entry: PunchEntry = {
    id: Date.now(), workerId: w.id, workerName: w.name,
    type, time: hh + ':' + mm, ts: now.toISOString(),
    site: SITE.name, clientId: SITE.clientId || null, dist: locDist,
    lat: geoEnforced ? (gps.lat ?? null) : null,
    lng: geoEnforced ? (gps.lng ?? null) : null,
    gpsVerified: geoEnforced, geoSkipped: !geoEnforced, manual: false,
    gpsAccuracy: gps.accuracy || null, gpsSuspicious: gps.suspicious || false, gpsWarnings: gps.warnings || [],
    gpsElapsed: gps.elapsed || null,
  };
  log.push(entry); savePunchLog(log);
  void gsSavePunch(entry);
  if (type === 'out' && last) updateScheduleManager(w.id, last.time, hh + ':' + mm);
  // The page stays: the face flashes its colour, a check draws, the phone vibrates, the line says so.
  try { navigator.vibrate?.([30, 40, 60]); } catch { /* not allowed */ }
  let text: string;
  if (type === 'in') text = tr('Punched in at {0} · have a good shift', { 0: entry.time });
  else {
    const mins = last && last.ts ? Math.max(0, Math.round((now.getTime() - new Date(last.ts).getTime()) / 60000)) : 0;
    text = tr('Punched out at {0} · {1} today', { 0: entry.time, 1: Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm' });
  }
  set({ done: type, result: { type, text }, rev: st.rev + 1 });
  window.setTimeout(() => { if (st.done) set({ done: null }); }, 1600);
  if (geoEnforced) { lastGps = null; window.setTimeout(getLocation, 1700); } // the next punch needs its own reading
}

// Back to the tab after a while: the location is read again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.screen === 'punch' && st.worker) getLocation();
});

// ── Schedule change notice ──
// The worker's roster and date changes against what this device last showed them
// (schedSeen_<workerId>); the first load on a device only remembers it.
const schedSig = (w: PWorker | null) => JSON.stringify([(w && w.schedule) || [], (w && w.dates) || {}]);
export function checkScheduleChange() {
  const w = st.worker;
  if (!w || !URL_TOKEN) return;
  const key = 'schedSeen_' + w.id, sig = schedSig(w);
  let seen: string | null = null; try { seen = localStorage.getItem(key); } catch { /* private */ }
  if (seen == null) { try { localStorage.setItem(key, sig); } catch { /* full */ } return; }
  set({ schedChanged: seen !== sig });
}
export function markScheduleSeen() {
  const w = st.worker; if (!w) return;
  try { localStorage.setItem('schedSeen_' + w.id, schedSig(w)); } catch { /* full */ }
  set({ schedChanged: false });
}
/** My Schedule: shown at once, then fresh from the server when online. */
export function openSchedule() {
  if (!st.worker) return;
  set({ screen: 'schedule' });
  markScheduleSeen();
  if (URL_TOKEN && navigator.onLine) loadWorkersFromGS().then(ok => {
    const fresh = ok && workers.find(w => w.id === st.worker?.id);
    if (fresh) { set({ worker: fresh }); if (st.screen === 'schedule') markScheduleSeen(); }
  }).catch(() => {});
}

// ── The weather for the greeting: the worker's site, read again after 30 minutes or for another site ──
let __wxKey = '', __wxAt = 0;
export function loadWeather() {
  if (!URL_TOKEN) return;
  const key = URL_TOKEN + '|' + (SITE.clientId || '');
  if (__wxKey === key && Date.now() - __wxAt < 30 * 60e3) return;
  __wxKey = key; __wxAt = Date.now();
  fetch(WEATHER_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: URL_TOKEN, clientId: SITE.clientId || '' }) })
    .then(r => r.json()).then(j => { if (__wxKey === key) set({ wx: j && j.kind ? { kind: j.kind, temp: j.temp } : null }); }).catch(() => {});
}

/** The site shown with a punch: its client if it is one of this worker's, else the worker's first client or the site. */
export function histSite(e: { clientId?: unknown; site?: unknown }): string {
  if (e.clientId && allClients.length) { const c = allClients.find(x => x.id === e.clientId); if (c) return c.name || ''; }
  const w = st.worker;
  if (w && allClients.length) {
    const wc = (w.clientIds || []).map(id => allClients.find(x => x.id === id)).filter(Boolean) as PClient[];
    const match = e.site ? wc.find(c => c.name === e.site) : undefined;
    if (match) return match.name || '';
    if (wc[0]) return wc[0].name || '';
  }
  if (SITE && SITE.name && SITE.name !== 'Work Site') return SITE.name;
  return String(e.site || '');
}

// ── Error telemetry: at most 21 per page, the same message at most once a minute ──
const _errSent: Record<string, number> = {};
let _errCount = 0;
export function reportError(message: unknown, source?: string, stack?: string) {
  try {
    if (_errCount > 20) return;
    const key = String(message || '').slice(0, 120), nowT = Date.now();
    if (_errSent[key] && nowT - _errSent[key] < 60000) return;
    _errSent[key] = nowT; _errCount++;
    punchFn({
      action: 'logError', page: (location.pathname.split('/').pop() || location.href), role: 'worker',
      worker: (st.worker && st.worker.name) || (URL_TOKEN ? 'token:' + String(URL_TOKEN).slice(0, 4) : ''),
      message: String(message || '').slice(0, 500), source: String(source || '').slice(0, 300), stack: String(stack || '').slice(0, 1200),
    }).catch(() => {});
  } catch { /* never throws */ }
}

/** The location pill's text in the chosen language (the literals here keep the dictionary check honest). */
export function locText(l: PunchState['loc']): string {
  const p = l.p;
  switch (l.t) {
    case 'Checking location...': return tr('Checking location...');
    case 'Checking GPS...': return tr('Checking GPS...');
    case 'GPS not available': return tr('GPS not available');
    case 'Location check skipped': return tr('Location check skipped');
    case '{0}m from site (max {1}m)': return tr('{0}m from site (max {1}m)', p);
    case 'Weak GPS (±{0}m) — go outside': return tr('Weak GPS (±{0}m) — go outside', p);
    case 'Suspicious GPS: {0}': return tr('Suspicious GPS: {0}', p);
    case 'On site · {0}m · ±{1}m': return tr('On site · {0}m · ±{1}m', p);
    case 'Allow GPS to punch': return tr('Allow GPS to punch');
    case 'GPS is blocked for this app': return tr('GPS is blocked for this app');
    case 'GPS is off on this phone': return tr('GPS is off on this phone');
    case 'GPS error — go outside': return tr('GPS error — go outside');
    default: return l.t;
  }
}
