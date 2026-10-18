// Firestore data layer — the app's whole backend in the browser.
//
// The one copy: scripts/build-globals.mjs builds it into firestore-backend.js
// at the repo root (committed, never edited by hand), a plain script that
// defines one global, initFirestoreBackend(), for the manager page
// (loadFirestoreBackend() in schedule-manager.html) and the new pages
// (loadBackend(), src/lib/backend.ts). It loads the Firebase SDK from the CDN,
// restores the sign-in state, and returns the API the app's gs* functions and
// its fetch(API_URL) dispatcher use:
//
//   login(username, password)   login Cloud Function -> custom token -> Firebase sign-in
//   currentUser()               the signed-in Firebase user, or null
//   signOut()
//   loadSchedule(t)             {workers, clients, suppliers, weekStart, savedAt}
//   saveSchedule(t, data)       writes only the documents that changed
//   listenPunches(t, onChange, since)  live punches from `since` (the app
//                               passes the start of this month minus a week);
//                               resolves with the first snapshot's entries
//   punchesBetween(t, from, to) one-time read of older punches, on demand
//   savePunch / updatePunch / deletePunch  (a punch gets its worker's hrId)
//   idToken()                   the signed-in user's ID token (supplier portal)
//   uploadWorkerFile(t, body, onProgress)   saveWorkerDoc / saveWorkerAssets /
//                               saveWorkerFile into Storage, replying {ok,id,url}
//   handleAction(action, params, ctx)   answers one named data action (Admin
//                               panes, telemetry, hours queue, AI reads, another
//                               firm's data) with a JSON reply, or null when no
//                               such action exists
//
// Documents are the same objects the app keeps in memory: one per worker,
// client, supplier (plus sortIndex, the array position) and one per punch
// (ts as a Timestamp, day 'yyyy-MM-dd', archived, hrId = the worker's HR).
//
// An "own workers" hr login (claims role 'hr', own) may read only the workers
// whose hrId is its uid and their punches (firestore.rules), so every read of
// workers, punches and pending hours adds that filter for it (hrOnly()).

/* eslint-disable @typescript-eslint/no-explicit-any */
// The Firebase SDK comes from the CDN as plain ES modules, untyped here.
type Mod = any;
/** A record as the app keeps it in memory (a worker, client, supplier, punch, request body…). */
type Rec = Record<string, any>;
/** A JSON reply of an action ({ok, …} or {error}). */
type Reply = Rec;
/** Who is asking: {role, username, tenantId (the firm being worked in)}. */
export interface ActionCtx { role?: string; username?: string; tenantId?: string; [k: string]: unknown }
type Kind = 'workers' | 'clients' | 'suppliers';
type Store = Record<Kind, Map<string, string>>;
type Op = ['set', any, Rec] | ['update', any, Rec] | ['delete', any];

declare global {
  interface Window {
    FIREBASE_WEB_CONFIG?: Rec;
    initFirestoreBackend?: () => Promise<FirestoreBackend>;
  }
}

const FB_VERSION = '12.19.0';
const FB_CDN = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
const LOGIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/login';
const USERS_ADMIN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/users_admin';
const AI_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/ai_read';
// The AI document actions, answered by the ai_read function.
const AI_ACTIONS = ['aiReadDoc','aiReadSefach','aiDetectAlign','aiVerifyField','aiVerifyFields','aiReadHoursTable','aiFindField'];
// Actions answered by the users_admin function.
const FUNCTION_ACTIONS = ['listTenants','setTenantActive','deleteTenant','createUser','updateTenant',
  'loadTenantProfile','listUsers','createTenantUser','updateUser','resetUserPassword','deleteUser','checkWorkerDoc','updateMyName','updateMyLanguage','updateMyTheme'];
// File uploads, straight to Storage.
const UPLOAD_ACTIONS = ['saveWorkerDoc','saveWorkerAssets','saveWorkerFile'];
// Reading/deleting a file in Storage (its id is the object path) goes
// through users_admin (functions-auth/files.py).
const STORAGE_FILE_ACTIONS = ['loadWorkerAssets','deleteWorkerDoc'];
const isStoragePath = (id: unknown): boolean => typeof id === 'string' && id.indexOf('tenants/') === 0;
const PUNCH_MONTHS = 13;            // listenPunches() default window when no `since` is given
const BATCH_LIMIT = 450;            // Firestore allows 500 writes per batch

// The SDK module at that URL; Vite leaves the import as it is.
const cdn = (file: string): Promise<Mod> => import(/* @vite-ignore */ FB_CDN + file);

// Web config: Firebase Hosting serves the project's own at this path; a
// page opened elsewhere (tests, a local file) sets window.FIREBASE_WEB_CONFIG.
async function webConfig(): Promise<Rec> {
  if (window.FIREBASE_WEB_CONFIG) return window.FIREBASE_WEB_CONFIG;
  const r = await fetch('/__/firebase/init.json');
  if (!r.ok) throw new Error('Firebase web config not found (HTTP ' + r.status + ')');
  return r.json();
}

// Firestore can't store undefined; the app's objects have plenty of it.
function plain<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }
// A worker's document numbers in one standard form (upper case, letters
// and digits only), stored as docKeys so checkWorkerDoc (functions-auth
// core.py doc_keys — keep the two the same) finds a duplicate in one query.
function docKeysOf(w: Rec | null | undefined): string[] {
  const keys: string[] = [];
  ['docId','passportNo','israeliId'].forEach(f => {
    const k = String((w && w[f]) || '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (k && !keys.includes(k)) keys.push(k);
  });
  return keys;
}
// Change signature independent of key order: the app rebuilds objects
// (applyData puts id/clientIds/token/status first), Firestore returns
// fields in its own order, and neither is a real change.
function sig(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(sig).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + sig((v as Rec)[k])).join(',') + '}';
  return JSON.stringify(v);
}

function ddmmyyyyToDay(s: unknown): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || ''));
  return m ? m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0') : null;
}

export async function initFirestoreBackend() {
  const [appMod, authMod, fsMod] = await Promise.all([
    cdn('firebase-app.js'),
    cdn('firebase-auth.js'),
    cdn('firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(await webConfig());
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  const F = fsMod;
  // Emulators for tests: localStorage fsEmulator = '127.0.0.1' (host).
  const emu = localStorage.getItem('fsEmulator');
  if (emu) {
    F.connectFirestoreEmulator(db, emu, 8080);
    authMod.connectAuthEmulator(auth, 'http://' + emu + ':9099', {disableWarnings: true});
  }
  // Storage (file uploads only) is not loaded with the rest: on the first
  // upload, or a few seconds after a signed-in start, whichever comes first.
  let stMod: Mod = null, storage: Mod = null, stLoading: Promise<void> | null = null;
  function loadStorage(): Promise<void> {
    return stLoading || (stLoading = cdn('firebase-storage.js').then(m => {
      stMod = m; storage = m.getStorage(app);
      if (emu) m.connectStorageEmulator(storage, emu, 9199);
    }).catch(e => { stLoading = null; throw e; }));
  }
  await auth.authStateReady();
  if (auth.currentUser) setTimeout(() => loadStorage().catch(() => {}), 4000);

  const col = (t: string, name: string) => F.collection(db, 'tenants', t, name);
  const emptyStore = (): Store => ({workers: new Map(), clients: new Map(), suppliers: new Map()});
  // Last JSON written/read per document, so a save sends only real changes.
  const known: Store = emptyStore();
  let knownTenant: string | null = null;
  // Worker id -> hrId (null: no HR), from the last load/save: a punch
  // written here is stamped with its worker's current HR.
  const workerHr = new Map<string, string | null>();

  // The signed-in login's claims (role, own, perms); refreshed per sign-in.
  let claimsFor: string | null = null, claims: Rec = {};
  async function myClaims(): Promise<Rec> {
    const u = auth.currentUser;
    if (!u) return {};
    if (claimsFor !== u.uid) { claims = (await u.getIdTokenResult()).claims || {}; claimsFor = u.uid; }
    return claims;
  }
  // The uid to filter by for an own-workers hr login, else null.
  async function hrOnly(): Promise<string | null> {
    const c = await myClaims();
    return c.role === 'hr' && c.own === true ? auth.currentUser.uid : null;
  }
  // A login may write that kind of record (an hr without the clients /
  // suppliers section only reads them, firestore.rules).
  async function mayWrite(kind: Kind): Promise<boolean> {
    const c = await myClaims();
    if (c.role !== 'hr' || kind === 'workers') return true;
    const p: unknown[] = Array.isArray(c.perms) ? c.perms : [];
    return p.includes('*') || p.includes(kind);
  }
  const hrWhere = (hr: string | null) => hr ? [F.where('hrId', '==', hr)] : [];

  async function login(username: string, password: string): Promise<Reply> {
    const res = await fetch(LOGIN_FN_URL, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username, password})});
    let json: Reply;
    try { json = await res.json(); } catch { return {error: 'The login server returned an error (HTTP ' + res.status + ')'}; }
    if (!json || json.error) return json || {error: 'Could not sign in'};
    await authMod.signInWithCustomToken(auth, json.token);
    return json;
  }

  // The stored sortIndex of each worker an own-workers HR loaded: its saves
  // keep it, so the owner's order isn't rewritten with the HR's positions.
  const storedPos = new Map<string, number>();
  function listOf(snap: any, kind: Kind, store: Store): Rec[] {
    const map = store[kind]; map.clear();
    if (kind === 'workers' && store === known) storedPos.clear();
    const items: {pos: number; data: Rec}[] = [];
    snap.forEach((d: any) => {
      const data: Rec = d.data();
      const pos = typeof data.sortIndex === 'number' ? data.sortIndex : 1e9;
      delete data.sortIndex;
      if (data.id == null) data.id = d.id;
      // docKeys stays in the stored copy (its signature) but not in the app's.
      map.set(d.id, sig(data) + '#' + pos);
      if (kind === 'workers') delete data.docKeys;
      items.push({pos, data});
      if (kind === 'workers' && store === known) storedPos.set(d.id, pos);
    });
    items.sort((a, b) => a.pos - b.pos || String(a.data.id).localeCompare(String(b.data.id)));
    return items.map(x => x.data);
  }

  async function loadSchedule(t: string, track = true): Promise<Rec> {
    const hr = await hrOnly();
    const [w, c, s, set] = await Promise.all([
      F.getDocs(F.query(col(t,'workers'), ...hrWhere(hr))), F.getDocs(col(t,'clients')), F.getDocs(col(t,'suppliers')),
      F.getDoc(F.doc(db, 'tenants', t, 'settings', 'schedule')),
    ]);
    const settings: Rec = set.exists() ? set.data() : {};
    // track=false (another firm's data, read for the super-admin's summary)
    // must not become the reference the next save is compared with.
    const keep = track ? known : emptyStore();
    const out = {workers: listOf(w,'workers',keep), clients: listOf(c,'clients',keep), suppliers: listOf(s,'suppliers',keep),
                 weekStart: settings.weekStart || null, savedAt: settings.savedAt || null};
    if (track) {
      knownTenant = t;
      workerHr.clear(); out.workers.forEach(x => workerHr.set(String(x.id), x.hrId || null));
    }
    return out;
  }

  // Writes the workers/clients/suppliers that differ from what was last
  // loaded or saved, and deletes the ones that are gone. Each document is
  // its own record, so two managers editing different workers never
  // overwrite each other.
  // first (optional): {ops, ids} — writes that must land together with the
  // documents of those ids (a confirmed shift offer: the request and its two
  // workers). They go first, in the first batch, so all of them commit or none.
  async function saveSchedule(t: string, data: Rec, first?: {ops: Op[]; ids?: unknown[]}): Promise<Reply> {
    if (knownTenant !== t) await loadSchedule(t); // never diff against another firm
    const hrScoped = !!(await hrOnly());
    const ops: Op[] = [];
    const next = {} as Store;
    for (const kind of ['workers','clients','suppliers'] as Kind[]) {
      if (!(await mayWrite(kind))) { next[kind] = known[kind]; continue; }
      next[kind] = new Map();
      ((data[kind] || []) as Rec[]).forEach((item, idx) => {
        if (!item || item.id == null) return;
        const id = String(item.id), body = plain(item);
        if (kind === 'workers') body.docKeys = docKeysOf(body);
        // An own-workers HR sees only part of the list: its positions are
        // not the firm's. It keeps a worker's stored place; a new one goes last.
        let pos = idx;
        if (hrScoped && kind === 'workers') {
          if (!storedPos.has(id)) storedPos.set(id, 1e6 + Date.now() % 1e6 + idx);
          pos = storedPos.get(id)!;
        }
        const s = sig(body) + '#' + pos;
        next[kind].set(id, s);
        if (known[kind].get(id) !== s) ops.push(['set', F.doc(db,'tenants',t,kind,id), Object.assign(body, {sortIndex: pos})]);
      });
      known[kind].forEach((_, id) => { if (!next[kind].has(id)) ops.push(['delete', F.doc(db,'tenants',t,kind,id)]); });
    }
    if (first) {
      const linked = new Set((first.ids || []).map(String));
      const isLinked = (op: Op) => op[1].parent.id === 'workers' && linked.has(op[1].id);
      ops.splice(0, ops.length, ...first.ops, ...ops.filter(isLinked), ...ops.filter(op => !isLinked(op)));
    }
    for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
      const batch = F.writeBatch(db);
      ops.slice(i, i + BATCH_LIMIT).forEach(op => op[0] === 'set' ? batch.set(op[1], op[2])
        : op[0] === 'update' ? batch.update(op[1], op[2]) : batch.delete(op[1]));
      await batch.commit();
    }
    for (const kind in next) known[kind as Kind] = next[kind as Kind];
    workerHr.clear(); ((data.workers || []) as Rec[]).forEach(x => { if (x && x.id != null) workerHr.set(String(x.id), x.hrId || null); });
    return {ok: true, written: ops.length};
  }

  function punchFromDoc(d: any): Rec {
    const x: Rec = d.data();
    const ts = x.ts && typeof x.ts.toDate === 'function' ? x.ts.toDate().toISOString() : (x.tsRaw || null);
    const e: Rec = Object.assign({}, x, {ts});
    delete e.day; delete e.archived; delete e.tsRaw;
    if (e.id == null) e.id = d.id;
    return e;
  }
  // hrId: the worker's HR when the caller knows it (approved hours read the
  // workers); otherwise the one from the last load/save, else the entry's.
  function punchDoc(entry: Rec, hrId?: string | null): Rec {
    const body = plain(entry);
    delete body.tenantId;
    const when = new Date(entry.ts || Date.now());
    body.ts = isNaN(when.getTime()) ? null : F.Timestamp.fromDate(when);
    body.day = ddmmyyyyToDay(entry.date);
    body.archived = false;
    const wid = String(entry.workerId);
    const hr = hrId !== undefined ? hrId : (workerHr.has(wid) ? workerHr.get(wid) : entry.hrId);
    if (hr) body.hrId = hr; else delete body.hrId;
    return body;
  }

  // An HR's worker list, live (2026-10-05): a worker the owner assigns to
  // it appears, one taken away disappears, and an edit made elsewhere (a
  // rate, a phone…) arrives, without a reload. Reported as {added, removed,
  // changed}; a changed worker comes with `unsaved(item)`, true when this
  // device's copy has edits not yet saved (the app keeps those). This
  // device's own writes (pending) are skipped. The reference copy (known /
  // storedPos / workerHr) follows, so the next save neither deletes an added
  // worker nor tries to delete one it can no longer touch.
  let workersUnsub: (() => void) | null = null;
  function listenWorkers(t: string, onChange: (c: {added: Rec[]; removed: string[]; changed: {data: Rec; unsaved: (item: Rec) => boolean}[]}) => void): Promise<void> {
    if (workersUnsub) workersUnsub();
    return hrOnly().then(hr => {
      const q = F.query(col(t,'workers'), ...hrWhere(hr));
      workersUnsub = F.onSnapshot(q, (snap: any) => {
        if (knownTenant !== t) return;
        const ids = new Set(snap.docs.map((d: any) => d.id));
        const added: Rec[] = [], changed: {data: Rec; unsaved: (item: Rec) => boolean}[] = [];
        snap.docs.forEach((d: any) => {
          if (known.workers.has(d.id)) {
            if (d.metadata.hasPendingWrites) return;
            const data: Rec = d.data();
            const pos = typeof data.sortIndex === 'number' ? data.sortIndex : 1e9;
            delete data.sortIndex;
            if (data.id == null) data.id = d.id;
            const before = known.workers.get(d.id)!, now = sig(data) + '#' + pos;
            if (before === now) return;
            const baseSig = before.slice(0, before.lastIndexOf('#'));
            known.workers.set(d.id, now);
            storedPos.set(d.id, pos);
            workerHr.set(String(data.id), data.hrId || null);
            delete data.docKeys;
            changed.push({data, unsaved: item => { const b = plain(item); b.docKeys = docKeysOf(b); return sig(b) !== baseSig; }});
            return;
          }
          const data: Rec = d.data();
          const pos = typeof data.sortIndex === 'number' ? data.sortIndex : 1e9;
          delete data.sortIndex;
          if (data.id == null) data.id = d.id;
          known.workers.set(d.id, sig(data) + '#' + pos);
          storedPos.set(d.id, pos);
          delete data.docKeys;
          workerHr.set(String(data.id), data.hrId || null);
          added.push(data);
        });
        const removed = [...known.workers.keys()].filter(id => !ids.has(id));
        removed.forEach(id => { known.workers.delete(id); storedPos.delete(id); workerHr.delete(id); });
        if (added.length || removed.length || changed.length) onChange({added, removed, changed});
      }, (err: unknown) => console.warn('Worker listener stopped:', err));
    });
  }

  // The hours batches this login may see (an own-workers HR: only its own),
  // live: every change (sent, approved, rejected) calls onChange with the
  // whole list, shaped like loadPendingHours.
  let hoursUnsub: (() => void) | null = null;
  function listenPendingHours(t: string, onChange: (batches: Rec[]) => void): Promise<void> {
    if (hoursUnsub) hoursUnsub();
    return hrOnly().then(hr => {
      const q = hr ? F.query(col(t,'pendingHours'), F.where('createdBy','==',hr)) : col(t,'pendingHours');
      hoursUnsub = F.onSnapshot(q, (snap: any) => onChange(snap.docs.map(batchFromDoc)),
        (err: unknown) => console.warn('Hours listener stopped:', err));
    });
  }

  let punchUnsub: (() => void) | null = null;
  function listenPunches(t: string, onChange: (entries: Rec[]) => void, since?: Date): Promise<Rec[]> {
    if (punchUnsub) punchUnsub();
    if (!since) { since = new Date(); since.setMonth(since.getMonth() - PUNCH_MONTHS); since.setDate(1); since.setHours(0,0,0,0); }
    const from = since;
    return hrOnly().then(hr => new Promise<Rec[]>((resolve, reject) => {
      const q = F.query(col(t,'punches'), ...hrWhere(hr), F.where('ts', '>=', F.Timestamp.fromDate(from)));
      let first = true;
      punchUnsub = F.onSnapshot(q, (snap: any) => {
        const entries: Rec[] = snap.docs.map(punchFromDoc);
        // Every snapshot counts, this device's own writes included: an
        // approved hours batch is written here but not by the app's punch code.
        if (first) { first = false; resolve(entries); }
        else onChange(entries);
      }, (err: unknown) => { if (first) { first = false; reject(err); } else console.warn('Punch listener stopped:', err); });
    }));
  }
  // Older punches, read once when the app needs them (a past month's
  // salary, an export, Clear Log): [from, to).
  async function punchesBetween(t: string, from: Date, to: Date): Promise<Rec[]> {
    const snap = await F.getDocs(F.query(col(t,'punches'), ...hrWhere(await hrOnly()),
      F.where('ts','>=',F.Timestamp.fromDate(from)), F.where('ts','<',F.Timestamp.fromDate(to))));
    return snap.docs.map(punchFromDoc);
  }
  // Punches an approved hours batch wrote (ids imp-<batch>-<row>-in|out).
  async function punchesOfBatch(t: string, batchId: string): Promise<Rec[]> {
    const pre = 'imp-' + batchId + '-';
    const snap = await F.getDocs(F.query(col(t,'punches'), ...hrWhere(await hrOnly()),
      F.where(F.documentId(),'>=',pre), F.where(F.documentId(),'<',pre + '')));
    return snap.docs.map(punchFromDoc);
  }
  async function savePunch(t: string, entry: Rec): Promise<Reply> {
    await F.setDoc(F.doc(db,'tenants',t,'punches',String(entry.id)), punchDoc(entry));
    return {ok: true, id: entry.id};
  }
  async function updatePunch(t: string, data: Rec): Promise<Reply> {
    const upd: Rec = {editedAt: new Date().toISOString()};
    ['type','time','site','notes','clientId'].forEach(k => { if (data[k] !== undefined) upd[k] = k === 'clientId' ? (data[k] || null) : data[k]; });
    await F.updateDoc(F.doc(db,'tenants',t,'punches',String(data.id)), upd);
    return {ok: true};
  }
  async function deletePunch(t: string, id: unknown): Promise<Reply> {
    await F.deleteDoc(F.doc(db,'tenants',t,'punches',String(id)));
    return {ok: true};
  }

  // ── Named data actions (handleAction) ────────────────────────────────
  // params: the action's request body (POST) or query (GET), as the app
  // built it — including asTenantId from gsAuth(). ctx: who is asking.
  async function callUsersAdmin(params: Rec, url = USERS_ADMIN_URL): Promise<Reply> {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(url, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken},
      body: JSON.stringify(Object.assign({}, params, {token: undefined, secret: undefined}))});
    try { return await res.json(); } catch { return {error: 'The server returned an error (HTTP ' + res.status + ')'}; }
  }
  async function writeTelemetry(params: Rec): Promise<Reply> {
    const items: Rec[] = params.action === 'logBatch' ? (params.items || []).slice(0, 60)
      : [Object.assign({type: params.action === 'logTiming' ? 'timing' : 'error'}, params)];
    const clip = (v: unknown, n: number) => String(v == null ? '' : v).slice(0, n);
    const when = new Date().toISOString();
    const batch = F.writeBatch(db);
    items.forEach(d => {
      if (d.type === 'timing') batch.set(F.doc(F.collection(db,'timings')), {when, kind: clip(d.kind,40),
        totalMs: Math.max(0, Math.round(Number(d.totalMs) || 0)), tenantId: clip(d.tenantId,80), user: clip(d.user,80),
        role: clip(d.role,40), details: plain(d.details || {})});
      else batch.set(F.doc(F.collection(db,'errors')), {when, page: clip(d.page,200), role: clip(d.role,40),
        worker: clip(d.worker,80), message: clip(d.message,500), source: clip(d.source,300), stack: clip(d.stack,1200)});
    });
    await batch.commit();
    return {ok: true};
  }
  // Errors / Timings panes: the newest rows first. With from/to (ISO
  // times, from the period picker) only that period, up to `max` rows;
  // `when` is an ISO string, so the range compares as text.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
  async function readLog(name: string, max: number, from: unknown, to: unknown): Promise<Reply> {
    const parts: any[] = [F.collection(db, name)];
    if (ISO_RE.test(String(from || ''))) parts.push(F.where('when','>=',from));
    if (ISO_RE.test(String(to || ''))) parts.push(F.where('when','<',to));
    parts.push(F.orderBy('when','desc'), F.limit(max));
    const snap = await F.getDocs(F.query(...parts));
    return {rows: snap.docs.map((d: any) => d.data())};
  }
  // Admin → Errors / Timings "Reset": every error and every measurement,
  // of every firm and period, deleted (super-admin; firestore.rules lets
  // only a super-admin delete them). In batches of 400 until none is left.
  async function resetLogs(): Promise<Reply> {
    const out: Record<string, number> = {errors: 0, timings: 0};
    for (const name of ['errors', 'timings']) {
      for (;;) {
        const snap = await F.getDocs(F.query(F.collection(db, name), F.limit(400)));
        if (snap.empty) break;
        const batch = F.writeBatch(db);
        snap.docs.forEach((d: any) => batch.delete(d.ref));
        await batch.commit();
        out[name] += snap.size;
      }
    }
    return Object.assign({ok: true}, out);
  }
  async function deletePunchesByMonths(t: string, ctx: ActionCtx, months: unknown): Promise<Reply> {
    if (ctx.role !== 'tenant_admin' && ctx.role !== 'superadmin') return {error: 'Only the firm owner or super-admin can delete punch records'};
    const list0 = ((months || []) as unknown[]).filter(m => /^\d{4}-\d{2}$/.test(String(m))) as string[];
    if (!list0.length) return {error: 'No months selected'};
    const refs = new Map<string, any>();
    for (const m of list0) {
      const [y, mo] = m.split('-').map(Number);
      const byDay = await F.getDocs(F.query(col(t,'punches'), F.where('day','>=',m + '-01'), F.where('day','<=',m + '-31')));
      byDay.forEach((d: any) => refs.set(d.id, d.ref));
      // A punch without a readable date has no day; its timestamp decides.
      const byTs = await F.getDocs(F.query(col(t,'punches'),
        F.where('ts','>=',F.Timestamp.fromDate(new Date(y, mo-1, 1))), F.where('ts','<',F.Timestamp.fromDate(new Date(y, mo, 1)))));
      byTs.forEach((d: any) => { if (!d.data().day) refs.set(d.id, d.ref); });
    }
    const list = [...refs.values()];
    for (let i = 0; i < list.length; i += BATCH_LIMIT) {
      const batch = F.writeBatch(db);
      list.slice(i, i + BATCH_LIMIT).forEach(r => batch.delete(r));
      await batch.commit();
    }
    return {ok: true, deleted: list.length};
  }
  // Hours-import queue (savePendingHoursBatch / loadPendingHours /
  // approvePendingHours / rejectPendingHours). One document per batch.
  async function savePendingHours(t: string, ctx: ActionCtx, params: Rec): Promise<Reply> {
    if (ctx.role === 'supplier') return {error: 'Not available for the supplier role'};
    const entries: Rec[] = Array.isArray(params.entries) ? params.entries : [];
    if (!entries.length) return {error: 'No recognized shifts to upload'};
    const ref = F.doc(col(t,'pendingHours'));
    const rows = entries.map(e => ({rowId: crypto.randomUUID(), workerId: e.workerId || '', clientId: e.clientId || null,
      date: e.date || '', inTime: e.inTime || '', outTime: e.outTime || ''}));
    await F.setDoc(ref, {status: 'pending', fileName: params.fileName || '', uploadedBy: ctx.username || '',
      createdBy: auth.currentUser.uid, uploadedAt: new Date().toISOString(), createdAt: F.Timestamp.now(), rows});
    return {ok: true, batchId: ref.id, count: rows.length};
  }
  async function loadPendingHours(t: string, ctx: ActionCtx): Promise<Reply> {
    if (ctx.role === 'supplier') return {error: 'Not available for the supplier role'};
    // An own-workers hr reads only the batches it uploaded.
    const hr = await hrOnly();
    const snap = await F.getDocs(hr ? F.query(col(t,'pendingHours'), F.where('createdBy','==',hr)) : col(t,'pendingHours'));
    return {batches: snap.docs.map(batchFromDoc)};
  }
  function batchFromDoc(d: any): Rec {
    const x: Rec = d.data();
    return {batchId: d.id, fileName: x.fileName || '', uploadedBy: x.uploadedBy || '', uploadedAt: x.uploadedAt || '',
      decidedAt: x.decidedAt || '', status: x.status, entries: x.rows || []};
  }
  function approver(ctx: ActionCtx): boolean { return ctx.role === 'tenant_admin' || ctx.role === 'superadmin'; }
  const APPROVER_ERROR = 'Only the firm owner or the super-admin can approve uploaded hours';
  // Approving turns each row into an IN and an OUT punch (ids derived from
  // the batch, so approving twice can't duplicate) and marks the batch, all
  // in one batch write.
  async function approvePendingHours(t: string, ctx: ActionCtx, batchId: unknown): Promise<Reply> {
    if (!approver(ctx)) return {error: APPROVER_ERROR};
    const ref = F.doc(db,'tenants',t,'pendingHours',String(batchId));
    const snap = await F.getDoc(ref);
    if (!snap.exists()) return {error: 'Batch not found'};
    const b: Rec = snap.data();
    if (b.status !== 'pending') return {ok: true, created: 0};
    const workersSnap = await F.getDocs(col(t,'workers'));
    const names: Record<string, string> = {}, hrs: Record<string, string | null> = {};
    workersSnap.forEach((d: any) => { names[d.id] = d.data().name || ''; hrs[d.id] = d.data().hrId || null; });
    const note = 'Imported' + (b.fileName ? ' from ' + b.fileName : '');
    const tsFor = (date: string, time: string) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date || '');
      if (!m || !time) return new Date().toISOString();
      const [h, mi] = String(time).split(':').map(Number);
      return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]), h || 0, mi || 0).toISOString();
    };
    const batch = F.writeBatch(db);
    ((b.rows || []) as Rec[]).forEach((r, i) => {
      ([['in', r.inTime], ['out', r.outTime]] as [string, string][]).forEach(([type, time]) => {
        if (!time) return;
        const id = 'imp-' + batchId + '-' + i + '-' + type;
        batch.set(F.doc(db,'tenants',t,'punches',id), punchDoc({id, workerId: r.workerId, workerName: names[r.workerId] || '',
          type, time, date: r.date, ts: tsFor(r.date, time), clientId: r.clientId || '', notes: note, gpsWarnings: []},
          hrs[r.workerId] || null));
      });
    });
    batch.update(ref, {status: 'approved', decidedAt: new Date().toISOString()});
    await batch.commit();
    return {ok: true, created: (b.rows || []).length};
  }
  async function rejectPendingHours(t: string, ctx: ActionCtx, batchId: unknown): Promise<Reply> {
    if (!approver(ctx)) return {error: APPROVER_ERROR};
    const ref = F.doc(db,'tenants',t,'pendingHours',String(batchId));
    const snap = await F.getDoc(ref);
    if (!snap.exists()) return {error: 'Batch not found'};
    if (snap.data().status !== 'pending') return {ok: true, rejected: 0};
    await F.updateDoc(ref, {status: 'rejected', decidedAt: new Date().toISOString()});
    return {ok: true, rejected: (snap.data().rows || []).length};
  }
  // A worker's HR changed (worker modal, the HR card's bulk assign): its
  // punches carry the new hrId, so the new HR sees its history and the old
  // one no longer does. Owner or super-admin only.
  async function setPunchesHr(t: string, ctx: ActionCtx, workerIds: unknown, hrId: unknown): Promise<Reply> {
    if (!approver(ctx)) return {error: 'Only the firm owner or the super-admin can assign an HR'};
    const ids = (Array.isArray(workerIds) ? workerIds : []).map(String).filter(Boolean);
    const val = hrId ? String(hrId) : F.deleteField();
    // Several workers at once (8 in flight): a bulk assign of dozens of
    // workers one after another was slow.
    let n = 0, next = 0;
    // The worker's days off and shift offers move with it too, so the new
    // own-workers HR sees them and the old one no longer does.
    async function one(wid: string) {
      const snaps = await Promise.all(['punches', 'shiftRequests'].map(c => F.getDocs(F.query(col(t,c), F.where('workerId','==',wid)))));
      const refs = snaps.flatMap((s: any) => s.docs).filter((d: any) => (d.data().hrId || null) !== (hrId || null)).map((d: any) => d.ref);
      const commits: Promise<void>[] = [];
      for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
        const batch = F.writeBatch(db);
        refs.slice(i, i + BATCH_LIMIT).forEach((r: any) => batch.update(r, {hrId: val}));
        commits.push(batch.commit());
      }
      await Promise.all(commits);
      n += refs.length;
    }
    async function lane() { while (next < ids.length) await one(ids[next++]); }
    await Promise.all(Array.from({length: Math.min(8, ids.length)}, lane));
    return {ok: true, updated: n};
  }
  // Another firm's punches for the super-admin summary (this week): the
  // same window the app keeps live — this month, plus the week before it.
  async function punchesOnce(t: string): Promise<Reply> {
    const since = new Date(); since.setDate(1); since.setHours(0,0,0,0); since.setDate(since.getDate() - 7);
    const snap = await F.getDocs(F.query(col(t,'punches'), ...hrWhere(await hrOnly()), F.where('ts','>=',F.Timestamp.fromDate(since))));
    return {entries: snap.docs.map(punchFromDoc)};
  }

  // ── Worker files in Storage ──────────────────────────────────────────
  // tenants/<t>/workers/<workerId>/{form101,assets,docs}/<time>-<name>.
  // The object path is the file's id on the worker record (docFileId,
  // assetsFileId, docs[].fileId); the PDF and documents also get a download
  // URL (docUrl, docs[].url) the app opens directly.
  function safeName(name: unknown): string {
    return String(name || 'file').replace(/[\/\\#?\[\]*\u0000-\u001f]/g, '_').slice(0, 150) || 'file';
  }
  function b64Bytes(b64: unknown): Uint8Array {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function uploadWorkerFile(t: string, body: Rec, onProgress?: (sent: number, total: number) => void): Promise<Reply> {
    if (!auth.currentUser) return {error: 'Session expired or invalid — please sign in again'};
    if (!t) return {error: 'No firm'};
    const action = body.action;
    let kind: string, name: string, bytes: Uint8Array, type: string;
    if (action === 'saveWorkerDoc') {
      if (!body.fileBase64 || !body.fileName) return {error: 'No fileBase64 or fileName'};
      kind = 'form101'; name = body.fileName; bytes = b64Bytes(body.fileBase64); type = body.mimeType || 'application/pdf';
    } else if (action === 'saveWorkerAssets') {
      // A sidecar may hold only a signature (a worker added without a scan).
      if (!body.scanB64 && !body.sigPng) return {error: 'No scanB64'};
      kind = 'assets'; name = (body.fileNameBase || 'worker') + '_assets.json'; type = 'application/json';
      bytes = new TextEncoder().encode(JSON.stringify({scanB64: body.scanB64, scanMediaType: body.scanMediaType || 'image/jpeg',
        sigPng: body.sigPng || null, extraPages: Array.isArray(body.extraPages) ? body.extraPages : []}));
    } else if (action === 'saveWorkerFile') {
      if (!body.fileBase64 || !body.fileName) return {error: 'Missing fileBase64 or fileName'};
      kind = 'docs'; name = body.fileName; bytes = b64Bytes(body.fileBase64); type = body.mimeType || 'application/octet-stream';
    } else return {error: 'Unknown action'};
    const wid = safeName(body.workerId || '_');
    const path = 'tenants/' + t + '/workers/' + wid + '/' + kind + '/' + Date.now() + '-' + safeName(name);
    await loadStorage();
    const ref = stMod.ref(storage, path);
    const meta: Rec = {contentType: type, customMetadata: {workerId: String(body.workerId || ''), kind}};
    // An own-workers hr may read back (download URL) only files stamped
    // with its uid (storage.rules).
    const hr = await hrOnly();
    if (hr) meta.customMetadata.hrId = hr;
    if (kind !== 'assets') meta.contentDisposition = "inline; filename*=UTF-8''" + encodeURIComponent(safeName(name));
    await new Promise((resolve, reject) => {
      const task = stMod.uploadBytesResumable(ref, bytes, meta);
      task.on('state_changed', (snap: any) => { if (onProgress) onProgress(snap.bytesTransferred, snap.totalBytes); }, reject, resolve);
    });
    if (kind === 'assets') return {ok: true, id: path};
    return {ok: true, id: path, url: await stMod.getDownloadURL(ref)};
  }

  async function handleAction(action: string, params: Rec, ctx: ActionCtx): Promise<Reply | null> {
    const t: string = params.asTenantId || ctx.tenantId;
    // Telemetry before the Firebase sign-in has nowhere to go: dropped.
    if (['logBatch','logError','logTiming'].includes(action)) return auth.currentUser ? writeTelemetry(params) : {ok: false, skipped: true};
    if (!auth.currentUser) return {error: 'Session expired or invalid — please sign in again'};
    if (FUNCTION_ACTIONS.includes(action)) return callUsersAdmin(params);
    if (AI_ACTIONS.includes(action)) return callUsersAdmin(params, AI_FN_URL);
    if (STORAGE_FILE_ACTIONS.includes(action)) {
      if (isStoragePath(params.fileId)) return callUsersAdmin(params);
      // Not a Storage path: nothing of ours to delete, nothing to read.
      return action === 'deleteWorkerDoc' ? {ok: true} : {error: 'File not found'};
    }
    switch (action) {
      case 'loadErrors':  return ctx.role === 'superadmin' ? readLog('errors', params.from ? 2000 : 100, params.from, params.to) : {error: 'Super-admin only'};
      case 'loadTimings': return ctx.role === 'superadmin' ? readLog('timings', params.from ? 5000 : 500, params.from, params.to) : {error: 'Super-admin only'};
      case 'resetLogs':   return ctx.role === 'superadmin' ? resetLogs() : {error: 'Super-admin only'};
      case 'loadSchedule': return loadSchedule(t, false);
      case 'loadPunchLog': return punchesOnce(t);
      case 'deletePunchesByMonths': return deletePunchesByMonths(t, ctx, params.months);
      case 'savePendingHoursBatch': return savePendingHours(t, ctx, params);
      case 'loadPendingHours': return loadPendingHours(t, ctx);
      case 'approvePendingHours': return approvePendingHours(t, ctx, params.batchId);
      case 'rejectPendingHours': return rejectPendingHours(t, ctx, params.batchId);
      case 'setPunchesHr': return setPunchesHr(t, ctx, params.workerIds, params.hrId);
      // Workers' days off and shift offers (stage 5b; the punch function
      // writes them): from today on. An own-workers hr reads its workers'.
      case 'loadShiftRequests': {
        if (ctx.role === 'supplier' || ctx.role === 'client') return {error: 'Not available for this login'};
        const hr = await hrOnly();
        const snap = await F.getDocs(hr ? F.query(col(t,'shiftRequests'), F.where('hrId','==',hr)) : col(t,'shiftRequests'));
        const today = new Date(); const d0 = today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
        return {ok: true, requests: snap.docs.map((d: any) => ({id: d.id, ...d.data()})).filter((r: Rec) => String(r.date || '') >= d0)};
      }
      // A manager confirms or declines a pending shift offer: only its status
      // and who / when (firestore.rules; decidedByUid must be the caller).
      // Confirming carries the schedule with both workers' dates changed:
      // the request and the two worker documents commit in one batch, so a
      // failed write never leaves the shift handed over with the offer pending.
      case 'decideShiftRequest': {
        const status = params.status === 'confirmed' ? 'confirmed' : 'declined';
        const ref = F.doc(db, 'tenants', t, 'shiftRequests', String(params.id));
        const fields = {status, decidedAt: new Date().toISOString(), decidedBy: ctx.username || auth.currentUser.uid,
          decidedByUid: auth.currentUser.uid};
        if (status === 'confirmed' && params.schedule)
          return saveSchedule(t, params.schedule, {ops: [['update', ref, fields]], ids: params.workerIds});
        await F.updateDoc(ref, fields);
        return {ok: true};
      }
      // The notifications this login has read (the bell's "Mark all read"),
      // one doc per login: notifReads/{uid} = {ids, at}. Manager-side logins.
      case 'loadNotifReads': {
        const snap = await F.getDoc(F.doc(db, 'notifReads', auth.currentUser.uid));
        return {ok: true, ids: snap.exists() ? (snap.data().ids || []) : []};
      }
      // The firm's message templates (stage 11a: the WhatsApp "no punch"
      // reminder), tenants/{t}/settings/messages = {waTemplate, at}; read by
      // every manager-side login, written by the owner (firestore.rules).
      case 'loadFirmMessages': {
        const snap = await F.getDoc(F.doc(db, 'tenants', t, 'settings', 'messages'));
        return {ok: true, messages: snap.exists() ? snap.data() : {}};
      }
      case 'saveFirmMessages': {
        const waTemplate = String(params.waTemplate == null ? '' : params.waTemplate).slice(0, 1000);
        await F.setDoc(F.doc(db, 'tenants', t, 'settings', 'messages'), {waTemplate, at: new Date().toISOString()}, {merge: true});
        return {ok: true};
      }
      case 'saveNotifReads': {
        const ids = ((params.ids || []) as unknown[]).filter(x => typeof x === 'string' && x.length <= 200).slice(-500);
        await F.setDoc(F.doc(db, 'notifReads', auth.currentUser.uid), {ids, at: new Date().toISOString()});
        return {ok: true};
      }
    }
    return null;
  }

  return {
    login, loadSchedule, saveSchedule, listenWorkers, listenPendingHours, listenPunches, punchesBetween, punchesOfBatch, savePunch, updatePunch, deletePunch, handleAction,
    uploadWorkerFile, UPLOAD_ACTIONS, isStoragePath,
    // A link to open a firm's file (storage.rules: the firm's managers read),
    // e.g. a client's signed month (hours.py sign).
    storageUrl: async (path: string): Promise<string> => { await loadStorage(); return stMod.getDownloadURL(stMod.ref(storage, path)); },
    currentUser: (): {uid: string} | null => auth.currentUser,
    idToken: (): Promise<string | null> => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
    // The hours-review ticks of this login (claim hp: hours, approve,
    // dispute, fix, schedule, export — functions-auth/core.py HOUR_PERMS).
    hourPerms: async (): Promise<string[]> => { const h = (await myClaims()).hp; return Array.isArray(h) ? h : []; },
    // A supplier login's portal tabs (claim ss; none in the token = all).
    supplierSections: async (): Promise<string[]> => { const v = (await myClaims()).ss; return Array.isArray(v) ? v : ['dashboard', 'workers', 'hours']; },
    signOut: (): Promise<void> => { if (punchUnsub) punchUnsub(); claimsFor = null; claims = {}; return authMod.signOut(auth); },
  };
}

/** The API initFirestoreBackend() returns. */
export type FirestoreBackend = Awaited<ReturnType<typeof initFirestoreBackend>>;
