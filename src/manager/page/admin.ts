// The manager page's own script, part "admin": the Admin tab's loading and windows: firms, users, HR names, Errors / Timings.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { getSession, gsAuth, gsAuthQuery, saveSession } from '../data/session';
import { ADMIN_CACHE_PREFIX, activeTenantIdForAdmin, activeTenantProfile, adminPanes, assignWorkersToHr, firmProfileMissing, loadAdminCache, loadFirmsCache, logPeriodOptions, logPeriodQuery, logPeriodRange, saveAdminCache, saveFirmsCache } from '../logic/admin';
import { markFirstContent, markFreshContent } from '../data/telemetry';
import { API_URL } from '../data/api';
import { tr } from '../logic/i18n';
import { workerDocId } from '../logic/workers';
import { isFirmAdminSession } from '../logic/access';
import { cacheTenantProfile, renderAccountControl } from './gate';
import { closeModal } from './windows';
import { renderWorkersPage } from './workers';
import { renderCrumb } from './header';
import { showToast } from '../toast';
import { island } from '../bridge';
Object.defineProperties(window, {
  "__firmsCache": {get: () => __firmsCache, set: (v?: any) => { __firmsCache = v; }, configurable: true},
  "setTenantsActive": {get: () => setTenantsActive, configurable: true},
  "deleteTenantsNow": {get: () => deleteTenantsNow, configurable: true},
  "refreshTenantProfile": {get: () => refreshTenantProfile, configurable: true},
  "openCreateFirmForm": {get: () => openCreateFirmForm, configurable: true},
  "openMyFirmForm": {get: () => openMyFirmForm, configurable: true},
  "setupAdminPaneBar": {get: () => setupAdminPaneBar, configurable: true},
  "__adminPane": {get: () => __adminPane, set: (v?: any) => { __adminPane = v; }, configurable: true},
  "switchAdminPane": {get: () => switchAdminPane, configurable: true},
  "openCreateUserForm": {get: () => openCreateUserForm, configurable: true},
  "openEditUserForm": {get: () => openEditUserForm, configurable: true},
  "hrUsers": {get: () => hrUsers, configurable: true},
});

// ── Admin → Firms, Users, Errors, Timings (stage 6f-2) ────────────────────
// Drawn in React (src/manager/Firms.tsx, Users.tsx, Logs.tsx; the super-admin's
// landing screen into #firmsScreenRoot); the data, its caches, the saves of
// workers and the server calls that touch the page's state stay here and are
// handed over through window.ManagerBridge (its Admin part below).
export let __firmsCache: any = [];
// The Admin tab and the landing screen draw again (whichever is shown).
function renderFirmsViews(){ renderAdmin(); if(island()) island()!.renderFirmsScreen(); }
export let __firmsErr='', __firmsLoaded=false;
// A super-admin's firms: the cached list first, then listTenants. An owner's
// own firm: the session's profile, then a fresh read.
export async function loadFirms(){
  const s=getSession(); if(!s) return;
  if(s.role!=='superadmin'){ await refreshTenantProfile(0); renderFirmsViews(); return; }
  const cached=loadFirmsCache(), isLanding=!s.viewingTenantId;
  if(cached){ if(!__firmsLoaded) __firmsCache=cached; renderFirmsViews(); if(isLanding) markFirstContent(); }
  try{
    const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'listTenants', ...gsAuth() }) })).json();
    if(!json || json.error){ __firmsErr=(json&&json.error)||'Load failed'; renderFirmsViews(); return; }
    __firmsErr=''; __firmsCache=json.tenants||[]; __firmsLoaded=true;
    saveFirmsCache(__firmsCache);
    renderFirmsViews();
    if(isLanding) markFreshContent('firms');
  }catch(e: any){ __firmsErr='No network'; renderFirmsViews(); }
}
// The firms a super-admin's snapshot shows (cached until listTenants answers), each with what Form 101 would miss.
export function firmsRows(){
  const s=getSession(); if(!s||s.role!=='superadmin') return null;
  const list=__firmsLoaded?__firmsCache:(loadFirmsCache()||(__firmsCache.length?__firmsCache:null));
  return list?list.map((t?: any)=>({...t, missing:firmProfileMissing(t)})):null;
}
// Disable / Enable: flips every login of the firm (reversible).
export async function setTenantsActive(ids?: any, active?: any){
  let ok=0;
  for(const tenantId of ids){
    try{ const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'setTenantActive', ...gsAuth(), tenantId, active }) })).json();
      if(json && !json.error) ok++; else showToast((json&&json.error)||tr('Error')); }catch(e: any){ showToast(tr('No network')); }
  }
  if(ok) showToast(active ? tr('Firm enabled') : tr('Firm disabled'));
  await loadFirms();
}
// Deletes firms — irreversible: the profile, logins, schedule, punch history
// and every worker file in Storage. Runs when the Undo time is up (the React list).
export async function deleteTenantsNow(ids?: any){
  let ok=0;
  const name=ids.length===1?((__firmsCache.find((t?: any)=>t.tenantId===ids[0])||{}).companyName||''):'';
  for(const tenantId of ids){
    try{ const json=await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'deleteTenant', ...gsAuth(), tenantId }) })).json();
      if(json && !json.error) ok++; else showToast((json&&json.error)||tr('Error')); }catch(e: any){ showToast(tr('No network')); }
  }
  if(ok) showToast(ok===1 && ids.length===1 ? tr('Firm «{0}» deleted',{0:name}) : tr('{0} firms deleted',{0:ok}));
  await loadFirms();
}
// Form 101's employer block comes from the session's copy of the firm
// profile. A login keeps the copy it got at sign-in, so a change made
// elsewhere (the super-admin's Firms list) would not reach this device's
// PDFs: refresh it from the server when the app opens and before a PDF is
// built, at most once per maxAgeMs (0 = now).
let __profileFetchedAt = 0;
export async function refreshTenantProfile(maxAgeMs?: any){
  const s = getSession();
  const t = s && (s.viewingTenantId || s.tenantId);
  if(!t) return activeTenantProfile();
  if(maxAgeMs && Date.now() - __profileFetchedAt < maxAgeMs) return activeTenantProfile();
  try{
    const json = await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'loadTenantProfile', ...gsAuth() }) })).json();
    if(json && json.profile){ __profileFetchedAt = Date.now(); cacheTenantProfile(t, json.profile); renderAdmin(); return json.profile; }
  }catch(e: any){}
  return activeTenantProfile();
}

// The firm window (React, #firmModal): a new firm (with its owner's login), a
// firm of the super-admin's list, or the firm being worked in (a firm's own
// login fills in its Form 101 employer data itself). __firmWin is what it edits.
export let __firmWin: any=null;
function showFirmWindow(mode?: any, tenantId?: any, profile?: any){
  if(!island()) return;
  const s=getSession(), on=!!tenantId&&tenantId===(s&&(s.viewingTenantId||s.tenantId));
  __firmWin={mode, tenantId:tenantId||null, profile:profile||{}, wa:on};
  island()!.openFirm();
  byId('editFirmOverlay').classList.add('open');
}
export function openCreateFirmForm(){ showFirmWindow('create', null, {}); }
export function openEditFirmForm(tenantId?: any){
  const t = __firmsCache.find((x?: any) => x.tenantId === tenantId);
  if(!t){ showToast(tr('Firm not found')); return; }
  showFirmWindow('edit', tenantId, t);
}
export function openMyFirmForm(){
  const s = getSession(); if(!s) return;
  const tenantId = s.viewingTenantId || s.tenantId;
  if(!tenantId){ showToast(tr('No firm selected')); return; }
  showFirmWindow('mine', tenantId, activeTenantProfile() || {});
}
// After a save: a new firm → the list; an edited firm → the session's copy of
// its profile, and every worker's Form 101 (its employer block changed) — now
// when the edited firm is the one loaded here, else when this device opens it.
export function firmSaved(mode?: any, tenantId?: any, profile?: any){
  closeModal('editFirmOverlay');
  if(mode==='create'){ showToast(tr('Firm created')); loadFirms(); return; }
  showToast(tr('Firm details saved'));
  cacheTenantProfile(tenantId, profile);
  if(getSession()?.role === 'superadmin') loadFirms(); else renderAdmin();
  const s=getSession(), active=s&&(s.viewingTenantId||s.tenantId);
  if(active===tenantId) regenerateAllWorkerDocs();
  else {
    try{ localStorage.setItem('form101Regen:'+tenantId,'1'); }catch(e: any){}
    showToast(tr('Saved. The Form 101s of this firm\'s workers update when you open it'), 5000);
  }
}

// Admin tab sub-panes (merged 2026-09-30 into the Admin nav tab — see
// docs/history.md). Punch Log for everyone who reaches the tab (the tab needs
// the `workers` permission); Firms and Users for an owner or a super-admin;
// Errors and Timings for a super-admin (listTenants / loadErrors are gated
// server-side too).
function setupAdminPaneBar(){
  const s = getSession();
  if(!s) return;
  switchAdminPane(__adminPane);
  if(s.role === 'superadmin' || s.role === 'tenant_admin') prefetchAdminUsers();
}
// Loads the Users list in the background as soon as the Admin tab opens, so
// the Users section usually draws at once; a load already in flight is shared.
export let __usersFetch: any=null, __usersErr='';
function fetchAdminUsers(){
  if(__usersFetch) return __usersFetch;
  __usersFetch=fetch(API_URL,{method:'POST',body:JSON.stringify({action:'listUsers',...gsAuth()})})
    .then((res?: any)=>res.json())
    .finally(()=>{ __usersFetch=null; });
  return __usersFetch;
}
// The firm's logins (listUsers returns more for a super-admin: this firm's
// only), cached; then what shows them is drawn again.
export function prefetchAdminUsers(){
  const tenantId=activeTenantIdForAdmin();
  return fetchAdminUsers().then((json?: any)=>{
    if(json && !json.error){
      __usersErr='';
      saveAdminCache('users_'+tenantId,(json.users||[]).filter((u?: any)=>u.tenantId===tenantId));
      if(currentTab==='admin') renderAdmin();
      // The HR names on the worker tiles come from this list.
      if(currentTab==='workers' && workers.some((w?: any)=>w.hrId)) renderWorkersPage();
      // ...and the HR commissions in Accounting → Payable by HR.
      if(currentTab==='accounting' && workers.some((w?: any)=>w.hrId)) renderAccounting();
      // ...and the HR field of a worker window already open.
      if(island()) island()!.refreshWindows();
    } else { __usersErr=(json&&json.error)||'Load failed'; if(currentTab==='admin') renderAdmin(); }
  }).catch(()=>{ __usersErr='Network error'; if(currentTab==='admin') renderAdmin(); });
}
// The Admin tab opens with no section (the React tiles): nothing is loaded
// until a section is picked; the React section loads its own data. The
// chosen section is kept while the app stays open.
export let __adminPane: any=null;
export function switchAdminPane(pane?: any){
  __adminPane=pane && adminPanes().includes(pane) ? pane : null;
  if(__adminPane==='errors'||__adminPane==='timings') loadLogPane(__adminPane);
  renderAdmin();
  renderCrumb();
}
// The user window (React, #userFormModal): a saved login from the list the
// Users section drew (its cache; the server only when the row isn't there),
// or a new one.
function showUserWindow(u?: any, preset?: any){
  if(!island()) return;
  island()!.openUser(u, preset);
  byId('userFormOverlay').classList.add('open');
}
export function openCreateUserForm(preset?: any){ showUserWindow(null, preset); }
export async function openEditUserForm(id?: any){
  const cachedUsers = loadAdminCache('users_'+activeTenantIdForAdmin());
  let u = Array.isArray(cachedUsers) ? cachedUsers.find((x?: any) => x.id === id) : null;
  if(!u){
    const json = await fetchAdminUsers();
    u = ((json && json.users) || []).find((x?: any) => x.id === id);
  }
  if(!u){ showToast(tr('User not found')); return; }
  showUserWindow(u);
}
// After a save: a former HR's workers are no longer assigned to it, one's own
// new name shows in the header; the window closes and the list is read again.
export async function userSaved(id?: any, origRole?: any, role?: any, fullName?: any){
  if(id && origRole==='hr' && role!=='hr'){
    const ids = workers.filter((w?: any) => w.hrId===id).map((w?: any) => w.id);
    if(ids.length) await assignWorkersToHr(ids, null);
  }
  const me = getSession();
  if(id && me && me.uid === id){ me.fullName = fullName; saveSession(me); renderAccountControl(me); }
  closeModal('userFormOverlay');
  showToast(tr('Saved'));
  await prefetchAdminUsers();
}
// The workers as the Users section and its windows see them (an HR's hrId, a supplier's supplierId).
export function adminTeam(){ return workers.map((w?: any)=>({id:w.id, name:w.name||'', docId:String(workerDocId(w)||''), hrId:w.hrId||undefined, supplierId:w.supplierId||undefined})); }
// Logins deleted once their Undo time is up.
export async function deleteUsersNow(ids?: any){
  let ok=0;
  for(const id of ids){
    try{
      const json = await (await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'deleteUser', ...gsAuth(), id }) })).json();
      if(!json || json.error) showToast((json&&json.error)||tr('Failed')); else ok++;
    }catch(e: any){ showToast(tr('Network error')); }
  }
  if(ok) showToast(tr('User deleted'));
  await prefetchAdminUsers();
}

// ── HR logins and their workers (docs/admin.md → HR) ────────────────────────
// A worker's hrId is the uid of the HR login it belongs to. Only the firm's
// owner or a super-admin assigns it: here (the HR's card: list, unassign,
// "Add workers") or in the worker modal's HR field. Reassigning also moves
// the worker's past punches, days off and shift offers to the new HR (setPunchesHr).
// The HR list comes from the cached users list. It is loaded on first need
// (worker modal, a worker tile or card with an HR) — not at every app open —
// once per app open; meanwhile the cache from the last time is used.
let __hrUsersLoaded=false;
function ensureHrUsers(){
  if(__hrUsersLoaded || !isFirmAdminSession() || !activeTenantIdForAdmin()) return;
  __hrUsersLoaded=true;
  prefetchAdminUsers();
}
export function hrUsers(){
  ensureHrUsers();
  const c = loadAdminCache('users_'+activeTenantIdForAdmin());
  return Array.isArray(c) ? c.filter((u?: any) => u.role==='hr') : [];
}
export function hrNameOf(id?: any){
  const u = hrUsers().find((x?: any) => x.id===id);
  return u ? (u.fullName || u.username) : '';
}
// ── Errors / Timings: the period picker (logPeriodOptions / Range / Query, src/manager/logic/admin.ts) ──
export const __logPeriod: Record<string, string>={errors:'30d', timings:'30d'}, __logErr: Record<string, string>={errors:'', timings:''};
// The period's rows: the cached ones are drawn first, then loadErrors / loadTimings.
export async function loadLogPane(kind?: any){
  const pr=logPeriodRange(__logPeriod[kind]), key=kind+':'+pr.key;
  __logErr[kind]='';
  try{
    const res=await fetch(API_URL+'?action='+(kind==='errors'?'loadErrors':'loadTimings')+gsAuthQuery()+logPeriodQuery(pr));
    const json=await res.json();
    if(!json||json.error) __logErr[kind]=(json&&json.error)||'Load failed';
    else saveAdminCache(key, json.rows||[]);
  }catch(e: any){ __logErr[kind]='Network error'; }
  if(__adminPane===kind) renderAdmin();
}
export function logPaneSnapshot(kind?: any){
  const pr=logPeriodRange(__logPeriod[kind]), rows=loadAdminCache(kind+':'+pr.key);
  return {kind, period:pr.key, periods:logPeriodOptions(), label:pr.label, rows:Array.isArray(rows)?rows:null, error:__logErr[kind]};
}
// Reset (Errors and Timings, behind the React Alert Dialog): every error and
// every measurement, of every firm and period, deleted; the cached periods go too.
export async function resetLogs(){
  try{
    const json=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'resetLogs'})})).json();
    if(!json||json.error){ showToast(tr((json&&json.error)||'Not deleted')); return; }
    try{ Object.keys(localStorage).filter((k?: any)=>k.startsWith(ADMIN_CACHE_PREFIX+'errors')||k.startsWith(ADMIN_CACHE_PREFIX+'timings')).forEach((k?: any)=>localStorage.removeItem(k)); }catch(e: any){}
    showToast(tr('Deleted: {0} errors, {1} measurements',{0:json.errors||0,1:json.timings||0}));
    if(__adminPane==='timings'||__adminPane==='errors') await loadLogPane(__adminPane);
  }catch(e: any){ showToast(tr('Network error')); }
}
// Optimistic concurrency: the savedAt value we last loaded from the DB.
