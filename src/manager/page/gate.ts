// The manager page's own script, part "gate": the firm profile in the session, the gate (login / Firms / app), the login, the account menu, the theme.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId, qsa } from './dom';
import { clearSession, getSession, saveSession } from '../data/session';
import { loadFirestoreBackend } from '../data/api';
import { PORTAL_SESSION_KEYS, isPortalRole, portalTabs } from '../portal';
import { setPortal, switchTab } from './nav';
import { USER_ROLE_LABELS, activeTenantProfile, firmProfileMissing } from '../logic/admin';
import { tr } from '../logic/i18n';
import { API_URL } from '../data/api';
import { showToast } from '../toast';
import { setFrame } from '../frame';
import { island } from '../bridge';
Object.defineProperties(window, {
  "gateApp": {get: () => gateApp, configurable: true},
  "renderAccountControl": {get: () => renderAccountControl, configurable: true},
  "setTheme": {get: () => setTheme, configurable: true},
  "editMyName": {get: () => editMyName, configurable: true},
});

// ── Firm profile (Form 101 section א) ──
// FIRM_PROFILE_FIELDS, activeTenantProfile(), firmProfileMissing() are
// src/manager/logic/admin.ts, like the Admin caches, the role labels,
// assignWorkersToHr / ToSupplier, the payable summary and the log periods.
// Keeps the session's cached copy of the firm profile in step with a save —
// the client only ever gets one at login, so without this a firm would have
// to log out and back in before its own edit showed up on a Form 101. Only
// touches the cache when the saved firm is the one currently being worked in.
export function cacheTenantProfile(tenantId?: any, profile?: any){
  const s = getSession();
  if(!s || !profile) return;
  if(tenantId !== (s.viewingTenantId || s.tenantId)) return;
  if(s.role === 'superadmin'){
    s.viewingTenantProfile = profile;
    s.viewingTenantName = profile.companyName || s.viewingTenantName;
  } else {
    s.tenantProfile = profile;
  }
  saveSession(s);
  renderAccountControl(s);
}

// ── App gate: decides which of the three top-level screens to show ─────────
// (1) no/expired session → #loginScreen, nothing else runs.
// (2) super-admin with no firm picked yet → #firmsScreen.
// (3) everyone else (a tenant login, or a super-admin who picked a firm) →
//     the normal app — runInitApp() runs the pre-existing init sequence.
// Called once at startup in place of the old unconditional init block.
const SUB_ROLES = ['staff', 'hr', 'supplier', 'client'];
export function gateApp(runInitApp?: any){
  let s = getSession() || adoptPortalSession();
  // A staff / HR / supplier / client session signed in before the flat rights
  // (no rights): its token has no claim rt, so the rules refuse it — sign in again.
  if(s && SUB_ROLES.includes(String(s.role)) && !Array.isArray(s.rights)){
    clearSession(); clearPortalSessions(); s = null;
    loadFirestoreBackend().then((b?: any) => b.signOut()).catch(() => {});
  }
  if(s && isPortalRole(s.role)){ void startPortal(s); return; }
  if(!s){
    // The sign-in screen (React, src/manager/SignIn.tsx) wakes the login function itself.
    setFrame({screen:'login'});
    byId('loginScreen').style.display = 'flex';
    return;
  }
  if(s.role === 'superadmin' && !s.viewingTenantId){
    setFrame({screen:'firms'});
    byId('firmsScreen').style.display = 'block';
    // the React list loads the firms when it is drawn (now, or when the React pieces mount)
    if(island()) island()!.renderFirmsScreen();
    return;
  }
  setFrame({screen:'app'});
  renderAccountControl(s);
  runInitApp();
  // A fresh firm profile for this device's Form 101s (see refreshTenantProfile),
  // once the Firebase sign-in has had time to come back.
  setTimeout(() => refreshTenantProfile(0), 4000);
}

// A supplier or client login stays here (permissions plan, stage 3): the same
// frame with its own tabs (portalTabs, from its flat rights, claim rt; a
// client: Hours), each drawn
// with the portal's screens through the supplier / hours functions. No firm
// data is loaded for it (runInitApp never runs) and nothing reads Firestore.
// The portal screens' own code reads its session key (PORTAL_SESSION_KEYS);
// a Firebase sign-in that is gone or another user's sends to the sign-in.
async function startPortal(s?: any){
  try{ localStorage.setItem(PORTAL_SESSION_KEYS[s.role], JSON.stringify({uid:s.uid, role:s.role, tenantId:s.tenantId, supplierId:s.supplierId, clientId:s.clientId, username:s.username, rights:s.rights})); }catch(e: any){}
  setFrame({screen:'app'});
  renderAccountControl(s);
  let rt: string[] = Array.isArray(s.rights) ? s.rights : [];
  try{
    const b = await loadFirestoreBackend();
    const u = b.currentUser();
    if(!u || u.uid !== s.uid){ clearPortalSessions(); clearSession(); location.reload(); return; }
    rt = (await b.rights().catch(() => rt)) || rt;
  }catch(e: any){ /* offline: the session's rights */ }
  setPortal({role: s.role, username: s.fullName || s.username || ''});
  const tabs = portalTabs(s.role, rt);
  setFrame({tabs});
  switchTab(tabs[0] || 'hours');
}
export function clearPortalSessions(){ Object.values(PORTAL_SESSION_KEYS).forEach(k => { try{ localStorage.removeItem(k); }catch(e: any){} }); }
// A login kept by the old portal pages (/supplier, /client — now they send
// here): its session becomes this page's.
function adoptPortalSession(){
  for(const role of Object.keys(PORTAL_SESSION_KEYS)){
    try{
      const p = JSON.parse(localStorage.getItem(PORTAL_SESSION_KEYS[role]) || 'null');
      if(p && p.uid && p.role === role){ saveSession(p); return getSession(); }
    }catch(e: any){}
  }
  return null;
}

// The account in the title bar: who's logged in, and for a super-admin the
// firm it is viewing.
export function renderAccountControl(s?: any){
  // The account button and its menu are the React frame's (AccountMenu,
  // src/manager/Frame.tsx). A firm sees its own company name, the same thing a
  // super-admin sees for it — read from the profile (not the session's fixed
  // username), so a rename shows as soon as cacheTenantProfile() lands. The
  // person's name (fullName), the login only while it has none; My name changes it.
  const profile = activeTenantProfile();
  const firm = s.role === 'superadmin'
    ? (s.viewingTenantName || s.viewingTenantId || 'Super-admin')
    : ((profile && profile.companyName) || '');
  const who = s.fullName || s.username || '';
  // The gear button that used to open the separate #adminScreen modal was
  // removed 2026-09-30 (its content merged into the Admin nav tab's own
  // sub-panes — see setupAdminPaneBar()) — its "profile incomplete" amber
  // warning moves to the Admin tab's own icon instead, so the cue isn't lost.
  const incomplete = firmProfileMissing().length > 0;
  setFrame({
    account: {name: String(who), firm: String(firm), sub: [firm, tr(USER_ROLE_LABELS[s.role] || s.role || '')].filter(Boolean).join(' · ')},
    adminWarn: (s.role==='superadmin'||s.role==='tenant_admin') && incomplete,
  });
}

// The theme (docs/redesign.md → Light theme): Dark (the default), Light — for
// outdoors — or System (the device's setting, followed live). Kept on this
// device (localStorage.uiTheme, shared by every page) and on the signed-in
// user's account (updateMyTheme; login brings it back on any device). The
// <head> script puts it on <html data-theme> before the first draw; og.css
// holds the light token values. The same functions as src/lib/theme.ts — keep them the same.
const THEME_BAR: Record<string, string> = {dark:'#10141f', light:'#eef1f7'};
function storedTheme(){ try{ const t = localStorage.getItem('uiTheme'); return t === 'light' || t === 'system' ? t : 'dark'; }catch(e: any){ return 'dark'; } }
function resolveTheme(c?: any){ return c === 'system' ? (typeof window.matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : c; }
function applyTheme(c?: any){
  c = c || storedTheme();
  const look = resolveTheme(c);
  document.documentElement.setAttribute('data-theme', look);
  qsa('meta[name="theme-color"]').forEach((m?: any) => { m.content = THEME_BAR[look]; });
}
export function setTheme(c?: any, opts?: any){
  c = ['dark','light','system'].includes(c) ? c : 'dark';
  try{ localStorage.setItem('uiTheme', c); }catch(e: any){}
  applyTheme(c);
  if(!(opts && opts.save === false) && getSession()){
    fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyTheme', theme: c})}).catch(()=>{});
  }
}
if(typeof window.matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if(storedTheme() === 'system') applyTheme('system'); });
window.addEventListener('storage', (e?: any) => { if(e.key === 'uiTheme') applyTheme(); });
document.addEventListener('DOMContentLoaded', () => applyTheme());

export async function editMyName(){
  const s = getSession(); if(!s) return;
  const name = prompt(tr('Your name (shown at the top instead of the login):'), String(s.fullName || ''));
  if(name === null) return;
  try{
    const json = await (await fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyName', fullName: name.trim()})})).json();
    if(!json || json.error){ showToast((json && json.error) || tr('Not saved')); return; }
    s.fullName = json.fullName; saveSession(s);
    renderAccountControl(s);
    showToast(tr('Saved'));
  }catch(e: any){ showToast(tr('Network error')); }
}
