// Firestore data layer (FIRESTORE_PLAN.md stage 4).
//
// Loaded by schedule-manager.html's loadFirestoreBackend() only when the
// device runs with BACKEND === 'firestore'; with the default 'sheets' this
// file is never fetched. It defines one global, initFirestoreBackend(),
// which loads the Firebase SDK from the CDN, signs in state, and returns the
// API the app's gs* functions dispatch to:
//
//   login(username, password)   login Cloud Function -> custom token -> Firebase sign-in
//   currentUser()               the signed-in Firebase user, or null
//   signOut()
//   loadSchedule(t)             {workers, clients, suppliers, weekStart, savedAt}
//   saveSchedule(t, data)       writes only the documents that changed
//   listenPunches(t, onChange)  live punches of the last 13 months; resolves
//                               with the first snapshot's entries
//   savePunch / updatePunch / deletePunch
//   idToken()                   the signed-in user's ID token (supplier portal)
//   handleAction(action, params)   stage 5: answers an Apps Script action
//                               (Admin panes, telemetry, hours queue) in the
//                               same JSON shape, or null to leave it to Apps Script
//
// Documents are the same objects the app keeps in memory: one per worker,
// client, supplier (plus sortIndex, the array position) and one per punch
// (ts as a Timestamp, day 'yyyy-MM-dd', archived). See functions-auth/
// migrate.py, which wrote them first.
(function(){
  const FB_VERSION = '12.19.0';
  const FB_CDN = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
  const LOGIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/login';
  const USERS_ADMIN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/users_admin';
  // Apps Script actions answered by the users_admin function instead.
  const FUNCTION_ACTIONS = ['listTenants','setTenantActive','deleteTenant','createUser','updateTenant',
    'loadTenantProfile','listUsers','createTenantUser','updateUser','resetUserPassword','deleteUser'];
  const PUNCH_MONTHS = 13;            // like the live PunchLog sheet (~12 months + this one)
  const BATCH_LIMIT = 450;            // Firestore allows 500 writes per batch

  // Web config: Firebase Hosting serves the project's own at this path; a
  // page opened elsewhere (tests, a local file) sets window.FIREBASE_WEB_CONFIG.
  async function webConfig(){
    if(window.FIREBASE_WEB_CONFIG) return window.FIREBASE_WEB_CONFIG;
    const r = await fetch('/__/firebase/init.json');
    if(!r.ok) throw new Error('Firebase web config not found (HTTP ' + r.status + ')');
    return r.json();
  }

  // Firestore can't store undefined; the app's objects have plenty of it.
  function plain(v){ return JSON.parse(JSON.stringify(v)); }
  // Change signature independent of key order: the app rebuilds objects
  // (applyData puts id/clientIds/token/status first), Firestore returns
  // fields in its own order, and neither is a real change.
  function sig(v){
    if(Array.isArray(v)) return '[' + v.map(sig).join(',') + ']';
    if(v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + sig(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  function ddmmyyyyToDay(s){
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s||''));
    return m ? m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0') : null;
  }

  window.initFirestoreBackend = async function(){
    const [appMod, authMod, fsMod] = await Promise.all([
      import(FB_CDN + 'firebase-app.js'),
      import(FB_CDN + 'firebase-auth.js'),
      import(FB_CDN + 'firebase-firestore.js'),
    ]);
    const app = appMod.initializeApp(await webConfig());
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    const F = fsMod;
    // Emulators for tests: localStorage fsEmulator = '127.0.0.1' (host).
    const emu = localStorage.getItem('fsEmulator');
    if(emu){
      F.connectFirestoreEmulator(db, emu, 8080);
      authMod.connectAuthEmulator(auth, 'http://' + emu + ':9099', {disableWarnings:true});
    }
    await auth.authStateReady();

    const col = (t, name) => F.collection(db, 'tenants', t, name);
    // Last JSON written/read per document, so a save sends only real changes.
    const known = {workers:new Map(), clients:new Map(), suppliers:new Map()};
    let knownTenant = null;

    async function login(username, password){
      const res = await fetch(LOGIN_FN_URL, {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username, password})});
      let json;
      try{ json = await res.json(); }catch(e){ return {error:'Сервер входа вернул ошибку (HTTP ' + res.status + ')'}; }
      if(!json || json.error) return json || {error:'Не удалось войти'};
      await authMod.signInWithCustomToken(auth, json.token);
      return json;
    }

    function listOf(snap, kind, store){
      const map = store[kind]; map.clear();
      const items = [];
      snap.forEach(d => {
        const data = d.data();
        const pos = typeof data.sortIndex === 'number' ? data.sortIndex : 1e9;
        delete data.sortIndex;
        if(data.id == null) data.id = d.id;
        items.push({pos, data});
        map.set(d.id, sig(data) + '#' + pos);
      });
      items.sort((a,b) => a.pos - b.pos || String(a.data.id).localeCompare(String(b.data.id)));
      return items.map(x => x.data);
    }

    async function loadSchedule(t, track = true){
      const [w, c, s, set] = await Promise.all([
        F.getDocs(col(t,'workers')), F.getDocs(col(t,'clients')), F.getDocs(col(t,'suppliers')),
        F.getDoc(F.doc(db, 'tenants', t, 'settings', 'schedule')),
      ]);
      const settings = set.exists() ? set.data() : {};
      // track=false (another firm's data, read for the super-admin's summary)
      // must not become the reference the next save is compared with.
      const keep = track ? known : {workers:new Map(), clients:new Map(), suppliers:new Map()};
      const out = {workers: listOf(w,'workers',keep), clients: listOf(c,'clients',keep), suppliers: listOf(s,'suppliers',keep),
                   weekStart: settings.weekStart || null, savedAt: settings.savedAt || null};
      if(track) knownTenant = t;
      return out;
    }

    // Writes the workers/clients/suppliers that differ from what was last
    // loaded or saved, and deletes the ones that are gone. Each document is
    // its own record now, so two managers editing different workers no longer
    // overwrite each other (the sheet stored the whole firm in one cell).
    async function saveSchedule(t, data){
      if(knownTenant !== t) await loadSchedule(t); // never diff against another firm
      const ops = [], next = {};
      for(const kind of ['workers','clients','suppliers']){
        next[kind] = new Map();
        (data[kind] || []).forEach((item, pos) => {
          if(!item || item.id == null) return;
          const id = String(item.id), body = plain(item);
          const s = sig(body) + '#' + pos;
          next[kind].set(id, s);
          if(known[kind].get(id) !== s) ops.push(['set', F.doc(db,'tenants',t,kind,id), Object.assign(body, {sortIndex: pos})]);
        });
        known[kind].forEach((_, id) => { if(!next[kind].has(id)) ops.push(['delete', F.doc(db,'tenants',t,kind,id)]); });
      }
      for(let i = 0; i < ops.length; i += BATCH_LIMIT){
        const batch = F.writeBatch(db);
        ops.slice(i, i + BATCH_LIMIT).forEach(op => op[0] === 'set' ? batch.set(op[1], op[2]) : batch.delete(op[1]));
        await batch.commit();
      }
      for(const kind in next) known[kind] = next[kind];
      return {ok:true, written: ops.length};
    }

    function punchFromDoc(d){
      const x = d.data();
      const ts = x.ts && typeof x.ts.toDate === 'function' ? x.ts.toDate().toISOString() : (x.tsRaw || null);
      const e = Object.assign({}, x, {ts});
      delete e.day; delete e.archived; delete e.tsRaw;
      if(e.id == null) e.id = d.id;
      return e;
    }
    function punchDoc(entry){
      const body = plain(entry);
      delete body.tenantId;
      const when = new Date(entry.ts || Date.now());
      body.ts = isNaN(when.getTime()) ? null : F.Timestamp.fromDate(when);
      body.day = ddmmyyyyToDay(entry.date);
      body.archived = false;
      return body;
    }

    let punchUnsub = null;
    function listenPunches(t, onChange){
      if(punchUnsub) punchUnsub();
      const since = new Date(); since.setMonth(since.getMonth() - PUNCH_MONTHS); since.setDate(1); since.setHours(0,0,0,0);
      const q = F.query(col(t,'punches'), F.where('ts', '>=', F.Timestamp.fromDate(since)));
      return new Promise((resolve, reject) => {
        let first = true;
        punchUnsub = F.onSnapshot(q, snap => {
          const entries = snap.docs.map(punchFromDoc);
          // Every snapshot counts, this device's own writes included: an
          // approved hours batch is written here but not by the app's punch code.
          if(first){ first = false; resolve(entries); }
          else onChange(entries);
        }, err => { if(first){ first = false; reject(err); } else console.warn('Punch listener stopped:', err); });
      });
    }
    async function savePunch(t, entry){
      await F.setDoc(F.doc(db,'tenants',t,'punches',String(entry.id)), punchDoc(entry));
      return {ok:true, id: entry.id};
    }
    async function updatePunch(t, data){
      const upd = {editedAt: new Date().toISOString()};
      ['type','time','site','notes','clientId'].forEach(k => { if(data[k] !== undefined) upd[k] = k === 'clientId' ? (data[k] || null) : data[k]; });
      await F.updateDoc(F.doc(db,'tenants',t,'punches',String(data.id)), upd);
      return {ok:true};
    }
    async function deletePunch(t, id){
      await F.deleteDoc(F.doc(db,'tenants',t,'punches',String(id)));
      return {ok:true};
    }

    // ── Stage 5: Apps Script actions answered from Firestore ──────────────
    // params: the action's request body (POST) or query (GET), as the app
    // built it — including token/asTenantId from gsAuth(). ctx: who is asking.
    async function callUsersAdmin(params){
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(USERS_ADMIN_URL, {method:'POST',
        headers:{'Content-Type':'application/json', Authorization:'Bearer ' + idToken},
        body: JSON.stringify(Object.assign({}, params, {token: undefined, secret: undefined}))});
      try{ return await res.json(); }catch(e){ return {error:'Сервер вернул ошибку (HTTP ' + res.status + ')'}; }
    }
    async function writeTelemetry(params){
      const items = params.action === 'logBatch' ? (params.items || []).slice(0, 60)
        : [Object.assign({type: params.action === 'logTiming' ? 'timing' : 'error'}, params)];
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const when = new Date().toISOString();
      const batch = F.writeBatch(db);
      items.forEach(d => {
        if(d.type === 'timing') batch.set(F.doc(F.collection(db,'timings')), {when, kind:clip(d.kind,40),
          totalMs:Math.max(0, Math.round(Number(d.totalMs)||0)), tenantId:clip(d.tenantId,80), user:clip(d.user,80),
          role:clip(d.role,40), details: plain(d.details || {})});
        else batch.set(F.doc(F.collection(db,'errors')), {when, page:clip(d.page,200), role:clip(d.role,40),
          worker:clip(d.worker,80), message:clip(d.message,500), source:clip(d.source,300), stack:clip(d.stack,1200)});
      });
      await batch.commit();
      return {ok:true};
    }
    // Errors / Timings panes: the Firestore rows (this mode, login refusals)
    // merged with the sheet's (the other mode), newest first. A slow or
    // failing Apps Script read just leaves its half out.
    async function readLog(name, max, gsRows){
      const snap = await F.getDocs(F.query(F.collection(db, name), F.orderBy('when','desc'), F.limit(max)));
      const mine = snap.docs.map(d => d.data());
      const other = await Promise.race([gsRows.catch(() => []), new Promise(r => setTimeout(() => r([]), 8000))]);
      return {rows: mine.concat(other || []).sort((a,b) => String(b.when).localeCompare(String(a.when))).slice(0, max)};
    }
    async function deletePunchesByMonths(t, ctx, months){
      if(ctx.role !== 'tenant_admin' && ctx.role !== 'superadmin') return {error:'Only the firm owner or super-admin can delete punch records'};
      months = (months || []).filter(m => /^\d{4}-\d{2}$/.test(String(m)));
      if(!months.length) return {error:'No months selected'};
      const refs = new Map();
      for(const m of months){
        const [y, mo] = m.split('-').map(Number);
        const byDay = await F.getDocs(F.query(col(t,'punches'), F.where('day','>=',m + '-01'), F.where('day','<=',m + '-31')));
        byDay.forEach(d => refs.set(d.id, d.ref));
        // A punch without a readable date has no day; its timestamp decides.
        const byTs = await F.getDocs(F.query(col(t,'punches'),
          F.where('ts','>=',F.Timestamp.fromDate(new Date(y, mo-1, 1))), F.where('ts','<',F.Timestamp.fromDate(new Date(y, mo, 1)))));
        byTs.forEach(d => { if(!d.data().day) refs.set(d.id, d.ref); });
      }
      const list = [...refs.values()];
      for(let i = 0; i < list.length; i += BATCH_LIMIT){
        const batch = F.writeBatch(db);
        list.slice(i, i + BATCH_LIMIT).forEach(r => batch.delete(r));
        await batch.commit();
      }
      return {ok:true, deleted: list.length};
    }
    // Hours-import queue (Apps Script savePendingHoursBatch / loadPendingHours
    // / approvePendingHours / rejectPendingHours). One document per batch.
    async function savePendingHours(t, ctx, params){
      if(ctx.role === 'supplier') return {error:'Недоступно для роли поставщика'};
      const entries = Array.isArray(params.entries) ? params.entries : [];
      if(!entries.length) return {error:'Нет распознанных смен для загрузки'};
      const ref = F.doc(col(t,'pendingHours'));
      const rows = entries.map(e => ({rowId: crypto.randomUUID(), workerId: e.workerId || '', clientId: e.clientId || null,
        date: e.date || '', inTime: e.inTime || '', outTime: e.outTime || ''}));
      await F.setDoc(ref, {status:'pending', fileName: params.fileName || '', uploadedBy: ctx.username || '',
        createdBy: auth.currentUser.uid, uploadedAt: new Date().toISOString(), createdAt: F.Timestamp.now(), rows});
      return {ok:true, batchId: ref.id, count: rows.length};
    }
    async function loadPendingHours(t, ctx){
      if(ctx.role === 'supplier') return {error:'Недоступно для роли поставщика'};
      const snap = await F.getDocs(col(t,'pendingHours'));
      return {batches: snap.docs.map(d => { const x = d.data(); return {batchId: d.id, fileName: x.fileName || '',
        uploadedBy: x.uploadedBy || '', uploadedAt: x.uploadedAt || '', status: x.status, entries: x.rows || []}; })};
    }
    function approver(ctx){ return ctx.role === 'tenant_admin' || ctx.role === 'superadmin'; }
    const APPROVER_ERROR = 'Подтверждать загруженные часы может только владелец фирмы или супер-админ';
    // Approving turns each row into an IN and an OUT punch (ids derived from
    // the batch, so approving twice can't duplicate) and marks the batch, all
    // in one batch write.
    async function approvePendingHours(t, ctx, batchId){
      if(!approver(ctx)) return {error: APPROVER_ERROR};
      const ref = F.doc(db,'tenants',t,'pendingHours',String(batchId));
      const snap = await F.getDoc(ref);
      if(!snap.exists()) return {error:'Пакет не найден'};
      const b = snap.data();
      if(b.status !== 'pending') return {ok:true, created:0};
      const workersSnap = await F.getDocs(col(t,'workers'));
      const names = {}; workersSnap.forEach(d => { names[d.id] = d.data().name || ''; });
      const note = 'Imported' + (b.fileName ? ' from ' + b.fileName : '');
      const tsFor = (date, time) => {
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date || '');
        if(!m || !time) return new Date().toISOString();
        const [h, mi] = String(time).split(':').map(Number);
        return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]), h||0, mi||0).toISOString();
      };
      const batch = F.writeBatch(db);
      (b.rows || []).forEach((r, i) => {
        [['in', r.inTime], ['out', r.outTime]].forEach(([type, time]) => {
          if(!time) return;
          const id = 'imp-' + batchId + '-' + i + '-' + type;
          batch.set(F.doc(db,'tenants',t,'punches',id), punchDoc({id, workerId: r.workerId, workerName: names[r.workerId] || '',
            type, time, date: r.date, ts: tsFor(r.date, time), clientId: r.clientId || '', notes: note, gpsWarnings: []}));
        });
      });
      batch.update(ref, {status:'approved'});
      await batch.commit();
      return {ok:true, created: (b.rows || []).length};
    }
    async function rejectPendingHours(t, ctx, batchId){
      if(!approver(ctx)) return {error: APPROVER_ERROR};
      const ref = F.doc(db,'tenants',t,'pendingHours',String(batchId));
      const snap = await F.getDoc(ref);
      if(!snap.exists()) return {error:'Пакет не найден'};
      if(snap.data().status !== 'pending') return {ok:true, rejected:0};
      await F.updateDoc(ref, {status:'rejected'});
      return {ok:true, rejected: (snap.data().rows || []).length};
    }
    async function punchesOnce(t){
      const since = new Date(); since.setMonth(since.getMonth() - PUNCH_MONTHS); since.setDate(1); since.setHours(0,0,0,0);
      const snap = await F.getDocs(F.query(col(t,'punches'), F.where('ts','>=',F.Timestamp.fromDate(since))));
      return {entries: snap.docs.map(punchFromDoc)};
    }

    // ctx: {role, username, tenantId (the firm being worked in)}; gsFetch():
    // the same request to Apps Script, for the Errors/Timings merge.
    async function handleAction(action, params, ctx, gsFetch){
      const t = params.asTenantId || ctx.tenantId;
      if(['logBatch','logError','logTiming'].includes(action)) return auth.currentUser ? writeTelemetry(params) : null;
      if(!auth.currentUser) return null;
      if(FUNCTION_ACTIONS.includes(action)) return callUsersAdmin(params);
      switch(action){
        case 'loadErrors':  return ctx.role === 'superadmin' ? readLog('errors', 100, gsFetch().then(j => j.rows || [])) : {error:'Доступ только для супер-админа'};
        case 'loadTimings': return ctx.role === 'superadmin' ? readLog('timings', 500, gsFetch().then(j => j.rows || [])) : {error:'Доступ только для супер-админа'};
        case 'loadSchedule': return loadSchedule(t, false);
        case 'loadPunchLog': return punchesOnce(t);
        case 'deletePunchesByMonths': return deletePunchesByMonths(t, ctx, params.months);
        case 'savePendingHoursBatch': return savePendingHours(t, ctx, params);
        case 'loadPendingHours': return loadPendingHours(t, ctx);
        case 'approvePendingHours': return approvePendingHours(t, ctx, params.batchId);
        case 'rejectPendingHours': return rejectPendingHours(t, ctx, params.batchId);
      }
      return null;
    }

    return {
      login, loadSchedule, saveSchedule, listenPunches, savePunch, updatePunch, deletePunch, handleAction,
      currentUser: () => auth.currentUser,
      idToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
      signOut: () => { if(punchUnsub) punchUnsub(); return authMod.signOut(auth); },
    };
  };
})();
