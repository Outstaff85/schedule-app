// The manager page's own script, part "init": the app's start: error hooks, the first draw, push notifications, the service worker, the install button.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId, qs } from './dom';
import { reportError } from '../data/telemetry';
import { loadI18n, storedLanguage, tr } from '../logic/i18n';
import { autoSave, loadData } from '../data/store';
import { homeTab, isHrSession } from '../logic/access';
import { loadFirestoreBackend } from '../data/api';
import { getSession, saveSession } from '../data/session';
import { USERS_ADMIN_FN_URL, warmCloudFunctions } from '../logic/functions';
import { applyI18n, showContractNotice, syncLangButtons } from './language';
import { gateApp } from './gate';
import { render } from './render';
import { setSaveStatus } from './wiring';
import { applyNavPermissions, switchTab } from './nav';
import { renderAccounting } from './bridge';
import { showToast } from '../toast';
import { setFrame } from '../frame';
Object.defineProperties(window, {
  "installApp": {get: () => installApp, configurable: true},
});

// --- Init ---------------------------------------------------------------------
// Caught failures (2026-10-01): window 'error'/'unhandledrejection' only see
// errors nobody handled. Most failures are handled — a toast, a console
// error, a red line in a form — and never reached the Errors sheet. These
// hooks send them too: console.error/console.warn, toasts that read like an
// error, and the error lines of the forms below (same 1-minute dedupe and
// per-session cap as reportError()).
const _origConsoleError=console.error.bind(console), _origConsoleWarn=console.warn.bind(console);
function _consoleArgsText(args?: any){
  let stack='';
  const msg=Array.from(args).map((a?: any)=>{
    if(a instanceof Error){ stack=stack||a.stack||''; return a.message; }
    if(a && typeof a==='object'){ try{ return JSON.stringify(a).slice(0,200); }catch(e: any){ return String(a); } }
    return String(a);
  }).join(' ');
  return {msg,stack};
}
// The Firestore SDK logs a warning each time the live punch listener's
// connection drops — a phone in the background, a network switch, an idle
// connection cut by the carrier — and then reconnects by itself. Not a
// failure, so not reported (it filled the Errors pane every few minutes).
const SDK_RECONNECT_NOISE_RE=/@firebase\/firestore:.*(transport errored|Could not reach Cloud Firestore backend|stream .* (closed|errored))/i;
// Google Maps' notice that google.maps.Marker (the client map picker's pin)
// is deprecated — it still works, and Google gives 12 months' notice before
// removing it. Kept in the Errors log as a reminder, but at most once a day
// per device (per user request; the time is kept in localStorage).
const MAPS_MARKER_NOTICE_RE=/google\.maps\.Marker is deprecated/;
function _mapsNoticeSeenToday(){
  try{
    const last=Number(localStorage.getItem('mapsMarkerNoticeAt')||0);
    if(Date.now()-last<24*3600*1000) return true;
    localStorage.setItem('mapsMarkerNoticeAt',String(Date.now()));
  }catch(e: any){}
  return false;
}
const _consoleNoise=(msg?: any)=>SDK_RECONNECT_NOISE_RE.test(msg)||(MAPS_MARKER_NOTICE_RE.test(msg)&&_mapsNoticeSeenToday());
console.error=function(...args: any[]){ _origConsoleError(...args); try{ const t=_consoleArgsText(args); if(!_consoleNoise(t.msg)) reportError(t.msg,'console.error',t.stack); }catch(e: any){} };
console.warn=function(...args: any[]){ _origConsoleWarn(...args); try{ const t=_consoleArgsText(args); if(!_consoleNoise(t.msg)) reportError(t.msg,'console.warn',t.stack); }catch(e: any){} };
function watchErrorLine(id?: any){
  const el=byId(id); if(!el||typeof MutationObserver==='undefined') return;
  new MutationObserver(()=>{ const t=(el.textContent||'').trim(); if(t) reportError(t,'form:'+id,''); })
    .observe(el,{childList:true,characterData:true,subtree:true});
}
['firmEditFormError','userFormError'].forEach(watchErrorLine);
window.addEventListener('error', function(ev?: any){ _origConsoleError('App error:', ev.error||ev.message); reportError(ev.message, (ev.filename||'')+':'+(ev.lineno||''), ev.error&&ev.error.stack); });
window.addEventListener('unhandledrejection', function(ev?: any){ const r=ev.reason; reportError((r&&r.message)||String(r), 'promise', r&&r.stack); });
loadI18n(storedLanguage()).catch(()=>{}).then(()=>{ applyI18n(); syncLangButtons(); try{
  gateApp(function(){
    loadData();
    render();
    setSaveStatus('saved');
    applyNavPermissions();
    // Start on Dashboard (an HR login: its first tab)
    switchTab(homeTab());
    showContractNotice();
    // An HR's hours ticks as the ID token has them now (a change by the
    // owner shows on the next sign-in without a new login here).
    if(isHrSession()) loadFirestoreBackend().then((b?: any) => b.hourPerms()).then((hp?: any) => {
      const s = getSession(); if(!s || JSON.stringify(hp) === JSON.stringify(s.hourPerms || [])) return;
      saveSession(Object.assign(s, {hourPerms: hp})); applyNavPermissions();
      if(currentTab === 'accounting') renderAccounting();
    }).catch(()=>{});
    // What a staff / HR login may change, as the ID token has it now (a
    // template change ends the session; until then the token is the truth).
    if(isHrSession() || (getSession() || {} as any).role === 'staff') loadFirestoreBackend().then((b?: any) => b.editPerms()).then((ed?: any) => {
      const s = getSession(); if(!s || JSON.stringify(ed) === JSON.stringify(s.editPerms ?? null)) return;
      saveSession(Object.assign(s, {editPerms: ed})); render();
    }).catch(()=>{});
    // Wake users_admin (firm profile, users, files) so its first real call
    // doesn't wait for a cold start.
    warmCloudFunctions([USERS_ADMIN_FN_URL]);
    // Check push subscription status
    setTimeout(checkPushStatus, 1000);
  });
}catch(err: any){
  console.error('Init failed:', err);
  try{ showToast(tr('Startup error — reload the page (F5)')); }catch(e: any){}
} });
document.addEventListener('keydown',(e?: any)=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='s'){ e.preventDefault(); autoSave(); showToast(tr('Saved!')); }
});


// ── Push Notifications ────────────────────────────────────────────
const VAPID_PUBLIC_KEY = 'BBju9uoDfcpB0ZIPWhCyvUxg4lLwYVFy4QadSnvx6ImaafKK0pxalntUz5JmkH3Tc9wq9yymBucOf_U5i9o8t7w';
// Push delivery is not wired up yet (needs VAPID signing) — keep the button hidden
// so it doesn't promise alerts that won't arrive. Flip to true once a real sender exists.
const PUSH_ENABLED = false;

function urlB64ToUint8(b64?: any){
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map((c?: any)=>c.charCodeAt(0)));
}

async function subscribeToPush(){
  if(!('PushManager' in window)){ showToast(tr('Push not supported')); return; }
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ showToast(tr('Notifications blocked in browser settings')); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY)
    });
    localStorage.setItem('pushSubscription', JSON.stringify(sub));
    showToast(tr('Shift reminders enabled!'));
    byId('pushBtn')?.remove();
  } catch(e: any){ showToast(tr('Failed: {0}',{0:(e.message)})); console.error(e); }
}

async function checkPushStatus(){
  if(!PUSH_ENABLED) return;
  if(!('Notification' in window)) return;
  
  // If already granted - don't show button
  if(Notification.permission === 'granted'){
    try{
      if('serviceWorker' in navigator){
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if(sub) return; // already subscribed
      }
    } catch(e: any){}
  }
  
  // Show button if not yet subscribed
  if(!byId('pushBtn')){
    const btn=document.createElement('button');
    btn.id='pushBtn'; btn.className='btn sm';
    btn.innerHTML='<i class="ti ti-bell" style="color:var(--green)"></i> Enable Alerts';
    btn.style.cssText='';
    btn.onclick=subscribeToPush;
    qs('[data-slot-for="langBtn"]')?.before(btn); // in the React frame's title bar, before the Language button
  }
}

// ── PWA: Service Worker ───────────────────────────────────────────
if('serviceWorker' in navigator){
  // Auto-reload once when a new version of the app takes over.
  let _swRefreshing=false;
  const _hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(_swRefreshing) return; _swRefreshing=true;
    if(!_hadController) return;
    // Don't reload mid-upload (a deploy while a document is uploading used to
    // cut the upload off); wait until every upload has finished.
    const reloadWhenIdle=()=>{ if(typeof __uploadsInFlight!=='undefined' && __uploadsInFlight>0) setTimeout(reloadWhenIdle,1000); else window.location.reload(); };
    reloadWhenIdle();
  });
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('service-worker.js',{updateViaCache:'none'})
      .then((reg?: any)=>{
        console.log('[PWA] SW registered');
        reg.update();                       // check for a newer SW right away
        checkPushStatus();
      })
      .catch((e?: any)=>console.warn('[PWA] SW failed:',e));
  });
} else {
  // No SW support - still show button if Notification API available
  if('Notification' in window) checkPushStatus();
}

// ── PWA: "Install app" in the account menu (always shown until the app is installed) ──
let _installPrompt: any=null;
window.addEventListener('beforeinstallprompt',(e?: any)=>{ e.preventDefault(); _installPrompt=e; ensureInstallButton(); });
window.addEventListener('appinstalled',()=>{
  _installPrompt=null;
  setFrame({install:false});
  showToast(tr('Schedule Manager installed!'));
});
function _isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone===true; }
function ensureInstallButton(){ setFrame({install:!_isStandalone()}); }
async function installApp(){
  if(_installPrompt){
    _installPrompt.prompt();
    const{outcome}=await _installPrompt.userChoice;
    if(outcome==='accepted'){ setFrame({install:false}); showToast(tr('App installed!')); }
    _installPrompt=null;
  } else {
    const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
    showToast(ios ? tr('Safari: Share → «Add to Home Screen»') : tr('Browser menu (⋮) → «Install app»'));
  }
}
window.addEventListener('load', ensureInstallButton);
