// The manager page's own script, part "wiring": the data layer's events and the page's answers to them.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { tr } from '../logic/i18n';
import { pendingHoursCount } from '../data/store';
import { clearSession, getSession, saveSession } from '../data/session';
import { FIRMS_CACHE_KEY, clearAdminCaches } from '../logic/admin';
import { loadFirestoreBackend } from '../data/api';
import { render } from './render';
import { refreshBell } from './header';
import { showToast } from '../toast';
import { setFrame } from '../frame';
import { island } from '../bridge';
import { isAccTab } from '../logic/access';
import { clearPortalSessions } from './gate';
Object.defineProperties(window, {
  "backToFirmsList": {get: () => backToFirmsList, configurable: true},
});

// --- Export dropdown ----------------------------------------------------------

// --- Export Excel / PDF / JSON: exportExcel(), exportPDF(), exportJSON() are
// src/manager/logic/exports.ts.

// --- Save / Load -------------------------------------------------------------
// The data layer — the session (getSession, gsAuth), the fetch(API_URL)
// dispatcher, load / save / cache (loadData, autoSave), the punches, the
// uploads and the telemetry — is src/manager/data/, loaded before this script
// under the same names through ../globals.ts (React migration stage 8b).

// ── The data layer's events (src/manager/data/events.ts) ──
// The data layer never draws, shows a toast or looks at the screen: it
// emits events, and this is the one place the page answers them. Its texts
// come untranslated ({text, vars}) and are translated here.
ManagerData.setHost({
  // an HR's live worker list waits while one of these is open
  workerWindowOpen:()=>['workerOverlay','workerCardOverlay','payOverlay'].some((id?: any)=>byId(id)?.classList.contains('open')),
});
ManagerData.on('data', ()=>render());
// Hours approvals compare each day with the punches: they redraw too, or a
// day could keep showing a stale "Changed after approval".
ManagerData.on('punches', ()=>{ if(currentTab==='dashboard') renderDashboard(); else if(isAccTab(currentTab)) renderAccounting(); else if(currentTab==='admin') renderAdmin(); });
// An open worker card shows the worker's latest hours batch live.
ManagerData.on('hours', ()=>{ updateHoursBadge(); refreshBell(); if(island()) island()!.refreshWindows(); if(isAccTab(currentTab)) renderAccounting(); });
ManagerData.on('save', (s?: any)=>setSaveStatus(s));
ManagerData.on('notice', ({msg, ms}: any)=>showToast(typeof msg==='string'?msg:tr(msg.text, msg.vars), ms));
ManagerData.on('loaded', ()=>maybeRegenAfterFirmEdit());
ManagerData.on('requests', ()=>{ if(currentTab==='schedule') renderSchedulePage(); });
export function setSaveStatus(s?: any){ setFrame({save:s==='saving'?'saving':'saved'}); }
// The count of hours batches waiting for a decision, on the Accounting tab.
function updateHoursBadge(){ setFrame({counts:{accounting:pendingHoursCount()}}); }

export const LOGIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/login';

// Sign out: this page's session (and a supplier's or client's portal session, gate.ts) and the Firebase sign-in end.
export async function logout(){
  try{ localStorage.removeItem(FIRMS_CACHE_KEY); }catch(e: any){}
  clearAdminCaches(); clearSession(); clearPortalSessions();
  try{ await (await loadFirestoreBackend()).signOut(); }catch(e: any){}
  location.reload();
}



// The login Cloud Function checks the password and signs this device in to
// Firebase (firestore-backend.js login()); the session keeps who that is. The
// sign-in card is React (src/manager/SignIn.tsx): this returns the error text
// to show, or reloads the page signed in.
export async function signIn(username?: any, password?: any): Promise<string | null>{
  if(!username || !password) return tr('Enter a username and password');
  const t0 = Date.now();
  let backend: any;
  try{ backend = await loadFirestoreBackend(); }
  catch(e: any){ return tr('Could not load Firebase — check the network'); }
  let fb: any;
  try{ fb = await backend.login(username, password); }
  catch(e: any){ return tr('No network — try again'); }
  if(!fb || fb.error) return tr((fb&&fb.error)||'') || tr('Could not sign in');
  // The language this user last picked (on any device) wins over this device's.
  if(fb.language) try{ localStorage.setItem('uiLang', fb.language); }catch(e: any){}
  // So does the theme (Dark / Light / System).
  if(fb.theme) setTheme(fb.theme, {save:false});
  // A supplier login belongs in the supplier portal: hand the session over
  // (same origin, same Firebase sign-in) and go there.
  try{ sessionStorage.setItem('pendingLoginTiming', JSON.stringify({t0, loginMs:Date.now()-t0, pingMs:window.__pingMs==null?null:window.__pingMs, pingDone:window.__pingMs!=null})); }catch(e: any){}
  saveSession({
    uid: fb.uid, role: fb.role, tenantId: fb.tenantId, username: fb.username, tenantProfile: fb.tenantProfile,
    permissions: fb.permissions, supplierId: fb.supplierId, clientId: fb.clientId || null,
    ownOnly: fb.ownOnly === true, fullName: fb.fullName || '',
    showPay: fb.showPay === true, commissionRate: Number(fb.commissionRate) || 0,
    hourPerms: Array.isArray(fb.hourPerms) ? fb.hourPerms : [],
    editPerms: Array.isArray(fb.editPerms) ? fb.editPerms : null,
    rights: Array.isArray(fb.rights) ? fb.rights : null, // the flat rights; null: a login on none yet
    commissionDayRate: Number(fb.commissionDayRate) || 0,
    viewingTenantId: fb.tenantId, // a super-admin (tenantId null) picks one on the Firms screen
  });
  location.reload();
  return null;
}
// Wakes a cold login function while the user types, so the login request
// itself doesn't pay the cold start.
export function pingLogin(){
  const pingT0=Date.now();
  fetch(LOGIN_FN_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"ping":true}'})
  .then(()=>{ window.__pingMs=Date.now()-pingT0; }).catch(()=>{});
}

// A super-admin drilling into one firm's normal view — every subsequent API
// call sends asTenantId until they switch again or log out. Also caches that
// firm's own profile (from the already-fetched Firms list — __firmsCache) as
// viewingTenantProfile, since aiFillForm101() needs it for Form 101 section א
// and a super-admin's own login never carries a tenantProfile (they have no
// fixed tenant of their own).
export function switchToTenant(tenantId?: any){
  const s = getSession();
  if(!s || s.role !== 'superadmin') return;
  const t = __firmsCache.find((x?: any) => x.tenantId === tenantId);
  s.viewingTenantId = tenantId;
  s.viewingTenantName = (t && t.companyName) || tenantId;
  s.viewingTenantProfile = t || null;
  saveSession(s);
  location.reload();
}
function backToFirmsList(){
  const s = getSession();
  if(!s || s.role !== 'superadmin') return;
  s.viewingTenantId = null;
  s.viewingTenantName = null;
  saveSession(s);
  location.reload();
}
