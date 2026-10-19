// The manager page's own script, part "toast": the new version check (the toast itself is src/manager/toast.ts).
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { tr } from '../logic/i18n';
import { showToast } from '../toast';
Object.defineProperties(window, {
  "showToast": {get: () => showToast, configurable: true}, // src/manager/toast.ts
});

// ── New version check (2026-10-04; the same code in schedule-manager.html,
// worker-punch.html and supplier-portal.html). An app left open — a PWA in
// the background — keeps running the code it loaded, even after a deploy.
// When the page comes back to the screen, and every 30 min while it is
// shown, the files it runs are asked for their ETag (HEAD: the service
// worker only handles GET, and cache:'no-store' skips the HTTP cache). The
// first answer is the baseline; a changed ETag later means a deploy, and a
// bar offers to reload. Nothing reloads on its own (typed data stays).
function startVersionWatch(files?: any){
  let base: any=null, shown=false;
  const tags=async()=>{
    const out: any={};
    for(const f of files()){
      const r=await fetch(f,{method:'HEAD',cache:'no-store'});
      if(!r.ok) return null;
      out[f]=r.headers.get('etag')||r.headers.get('last-modified')||'';
    }
    return out;
  };
  const check=async()=>{
    if(shown||document.visibilityState!=='visible'||navigator.onLine===false) return;
    try{
      const t=await tags(); if(!t) return;
      if(!base){ base=t; return; }
      for(const f in t){ if(!(f in base)){ base[f]=t[f]; continue; } if(t[f]&&base[f]&&t[f]!==base[f]){ shown=true; showNewVersionBar(); return; } }
    }catch(e: any){}
  };
  document.addEventListener('visibilitychange',check);
  setInterval(check,30*60*1000);
  check();
}
function showNewVersionBar(){
  if(byId('newVersionBar')) return;
  // One compact line at the top (per user request 2026-10-11): it never
  // covers the bottom tab bar and stays until Update or ✕.
  document.body.insertAdjacentHTML('beforeend',`<div id="newVersionBar" role="status" style="position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 10px);transform:translateX(-50%);z-index:100000;display:flex;align-items:center;gap:10px;width:max-content;max-width:calc(100% - 24px);box-sizing:border-box;padding:6px 6px 6px 12px;border-radius:999px;background:#181c27;border:1px solid rgba(79,142,247,.45);color:#eef0f8;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)">
    <span style="width:8px;height:8px;border-radius:50%;background:#4f8ef7;box-shadow:0 0 0 4px rgba(79,142,247,.2);flex:none"></span>
    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tr('A new version is available')}</span>
    <button type="button" onclick="location.reload()" style="flex:none;border:0;border-radius:999px;padding:6px 14px;background:#4f8ef7;color:#fff;font:inherit;cursor:pointer">${tr('Update')}</button>
    <button type="button" aria-label="${tr('Close')}" onclick="this.parentElement.remove()" style="flex:none;border:0;background:none;color:#7c84a0;font:inherit;font-size:15px;cursor:pointer;padding:4px 8px 4px 2px">✕</button></div>`);
}
startVersionWatch(()=>[location.pathname,'og.css','payroll.js','firestore-backend.js']);

