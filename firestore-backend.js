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
//
// Documents are the same objects the app keeps in memory: one per worker,
// client, supplier (plus sortIndex, the array position) and one per punch
// (ts as a Timestamp, day 'yyyy-MM-dd', archived). See functions-auth/
// migrate.py, which wrote them first.
(function(){
  const FB_VERSION = '12.19.0';
  const FB_CDN = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
  const LOGIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/login';
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

    function listOf(snap, kind){
      const map = known[kind]; map.clear();
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

    async function loadSchedule(t){
      const [w, c, s, set] = await Promise.all([
        F.getDocs(col(t,'workers')), F.getDocs(col(t,'clients')), F.getDocs(col(t,'suppliers')),
        F.getDoc(F.doc(db, 'tenants', t, 'settings', 'schedule')),
      ]);
      knownTenant = t;
      const settings = set.exists() ? set.data() : {};
      return {workers: listOf(w,'workers'), clients: listOf(c,'clients'), suppliers: listOf(s,'suppliers'),
              weekStart: settings.weekStart || null, savedAt: settings.savedAt || null};
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
          if(first){ first = false; resolve(entries); }
          else if(!snap.metadata.hasPendingWrites) onChange(entries);
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

    return {
      login, loadSchedule, saveSchedule, listenPunches, savePunch, updatePunch, deletePunch,
      currentUser: () => auth.currentUser,
      signOut: () => { if(punchUnsub) punchUnsub(); return authMod.signOut(auth); },
    };
  };
})();
