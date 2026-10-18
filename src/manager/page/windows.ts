// The manager page's own script, part "windows": the windows: closing, going back to the window they came from.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId, qs } from './dom';
Object.defineProperties(window, {
  "closeModal": {get: () => closeModal, configurable: true},
  "_overlayDownOn": {get: () => _overlayDownOn, set: (v?: any) => { _overlayDownOn = v; }, configurable: true},
  "MODAL_CHAIN_MS": {get: () => MODAL_CHAIN_MS, configurable: true},
  "__lastModalClose": {get: () => __lastModalClose, set: (v?: any) => { __lastModalClose = v; }, configurable: true},
  "__reopeningModal": {get: () => __reopeningModal, set: (v?: any) => { __reopeningModal = v; }, configurable: true},
  "reopenModal": {get: () => reopenModal, configurable: true},
});

// --- Modal close --------------------------------------------------------------
export function closeModal(id?: any){ byId(id).classList.remove('open'); }
// Every modal closes on a tap anywhere outside it — on the dark backdrop,
// including where the card or row that opened it was (per user request
// 2026-10-04, for every modal; modals have no ✕ and no Cancel button). Only
// when the press also started on the backdrop, so a drag that starts inside
// the modal (selecting text, moving a map pin) and ends outside doesn't close
// it. The topmost open overlay is the one under the tap, so a modal over
// another closes alone. An overlay whose closing must undo something sets
// overlay.__onUserClose (e.g. the client billing-rate popup reverts the rate
// mode); otherwise closeModal(id). The same code is in schedule-manager.html
// and supplier-portal.html.
let _overlayDownOn: any=null;
document.addEventListener('pointerdown',(e?: any)=>{ _overlayDownOn=e.target; },true);
document.addEventListener('click',(e?: any)=>{
  const t=e.target;
  if(!(t&&t.classList&&t.classList.contains('overlay')&&t.classList.contains('open')&&_overlayDownOn===t&&t.id)) return;
  if(typeof t.__onUserClose==='function') t.__onUserClose(); else closeModal(t.id);
});

// Phone (≤ 700 px): a window, opened from the bottom as a sheet, also closes
// with a swipe down on it (user request 2026-10-11) — the same way as a tap
// outside (__onUserClose, else closeModal). Only when the sheet and anything
// scrolled under the finger are at their top, never from a field, a map,
// a canvas or a .no-swipe surface (the scan crop editor, the avatar crop —
// a drag there moves the photo, not the sheet); while it is open the page behind does not scroll (CSS). The
// same code is in the manager app and both portals.
(function(){
  let sw: any=null;
  document.addEventListener('touchstart',(e?: any)=>{
    sw=null;
    if(!window.matchMedia('(max-width:700px)').matches||e.touches.length!==1) return;
    const m=e.target.closest&&e.target.closest('.overlay.open>.modal');
    if(!m||e.target.closest('input,textarea,select,canvas,.leaflet-container,.no-swipe')) return;
    for(let n=e.target;n&&n!==m.parentElement;n=n.parentElement){ if(n.scrollTop>0) return; }
    sw={m, x:e.touches[0].clientX, y:e.touches[0].clientY, dy:0, on:false};
  },{passive:true});
  document.addEventListener('touchmove',(e?: any)=>{
    if(!sw) return;
    const dx=e.touches[0].clientX-sw.x, dy=e.touches[0].clientY-sw.y;
    if(!sw.on){
      if(dy<0||Math.abs(dx)>Math.abs(dy)){ if(dy<-6||Math.abs(dx)>10) sw=null; return; }
      if(dy<8) return;
      sw.on=true; sw.m.style.transition='none';
    }
    sw.dy=Math.max(0,dy); sw.m.style.transform='translateY('+sw.dy+'px)';
    if(e.cancelable) e.preventDefault();
  },{passive:false});
  const end=()=>{
    if(!sw) return;
    const {m,dy,on}=sw; sw=null; if(!on) return;
    m.style.transition='transform .18s ease';
    const ov=m.parentElement;
    if(dy>90){
      m.style.transform='translateY(100%)';
      setTimeout(()=>{ m.style.transform=''; m.style.transition=''; if(typeof ov.__onUserClose==='function') ov.__onUserClose(); else closeModal(ov.id); },180);
    } else { m.style.transform=''; setTimeout(()=>{ m.style.transition=''; },200); }
  };
  document.addEventListener('touchend',end); document.addEventListener('touchcancel',end);
})();

// Back to the previous window (user request 2026-10-11): a window opened from
// another one — the first closed and the second opened by the same action
// (one batch of class changes, e.g. closeModal(a); openB()) — remembers it
// (overlay.__returnTo). When it closes and no other window opens right after
// (MODAL_CHAIN_MS), the previous one comes back — drawn again by its
// __reopen() if it has one (the worker card), else shown as it was. Chains
// stack: card → pay → … each go back one step. Watches the class of every
// .overlay, so every way of opening and closing (closeModal, a tap outside,
// __onUserClose) works.
const MODAL_CHAIN_MS=250;
let __lastModalClose: any=null, __reopeningModal: any=null;
function reopenModal(id?: any){
  const el=byId(id); if(!el||el.classList.contains('open')) return;
  __reopeningModal=id;
  if(typeof el.__reopen==='function') el.__reopen(); else el.classList.add('open');
  if(!el.classList.contains('open')) __reopeningModal=null;  // __reopen found nothing to show
}
new MutationObserver((recs?: any)=>{
  const closedNow: any=[];
  recs.forEach((r?: any)=>{
    const el=r.target;
    if(!(el.classList&&el.classList.contains('overlay')&&el.id)) return;
    const wasOpen=/(^|\s)open(\s|$)/.test(r.oldValue||''), isOpen=el.classList.contains('open');
    if(wasOpen===isOpen) return;
    if(isOpen){
      if(__lastModalClose&&Date.now()-__lastModalClose.at<MODAL_CHAIN_MS) __lastModalClose.followed=true;
      if(__reopeningModal===el.id){ __reopeningModal=null; return; }  // coming back: keeps its own __returnTo
      const prev=closedNow.filter((id?: any)=>id!==el.id&&!byId(id).classList.contains('open')).pop();
      el.__returnTo=prev||null;
    } else {
      closedNow.push(el.id);
      const rec={id:el.id, at:Date.now(), followed:false};
      __lastModalClose=rec;
      const back=el.__returnTo; el.__returnTo=null;
      if(back) setTimeout(()=>{
        if(rec.followed||qs('.overlay.open')) return;  // another window opened instead
        reopenModal(back);
      },60);
    }
  });
}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});
