// The manager page's own script, part "header": the title bar: the greeting and weather, the breadcrumb, the bell and its notifications, the WhatsApp reminder.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { tr } from '../logic/i18n';
import { fsTenantId, getSession } from '../data/session';
import { WORKER_DOC_TYPES, isActiveWorker, workerDocStatus, workerExpiryStatus } from '../logic/workers';
import { API_URL, loadFirestoreBackend } from '../data/api';
import { localYMD } from '../logic/pay';
import { hasPermission, isHrSession } from '../logic/access';
import { switchTab } from './nav';
import { showToast } from '../toast';
import { frameState, setFrame } from '../frame';
import { trainingStats } from '../../scan/server';
import { loopNotice } from '../logic/scanloop';
Object.defineProperties(window, {
  "renderCrumb": {get: () => renderCrumb, configurable: true},
  "__notifRead": {get: () => __notifRead, set: (v?: any) => { __notifRead = v; }, configurable: true},
  "__notifReadLoaded": {get: () => __notifReadLoaded, set: (v?: any) => { __notifReadLoaded = v; }, configurable: true},
  "notifList": {get: () => notifList, configurable: true},
  "__firmMsgs": {get: () => __firmMsgs, set: (v?: any) => { __firmMsgs = v; }, configurable: true},
  "loadFirmMessages": {get: () => loadFirmMessages, configurable: true},
  "waTemplate": {get: () => waTemplate, configurable: true},
  "waPhone": {get: () => waPhone, configurable: true},
  "waLink": {get: () => waLink, configurable: true},
  "loadNotifReads": {get: () => loadNotifReads, configurable: true},
  "toggleBell": {get: () => toggleBell, configurable: true},
  "closeBell": {get: () => closeBell, configurable: true},
});

// ── Greeting and notifications (redesign stage 5, docs/accounting.md → Today) ──
// The greeting, the date and the weather icon are the React frame's
// (ShellGreeting, src/lib/greeting.ts); the page gives it the name and the weather.
// V7 (stage 6a): in the middle of the title bar on every tab — the date (short
// on a phone), the greeting (its words hidden on a phone) and the weather.
export function renderGreeting(){
  const s=getSession(); if(!s) return;
  setFrame({greet:{name:String(s.fullName||s.username||''), wx:__wx&&__wxTid===fsTenantId()?__wx:null}}); loadWeather();
}
// The breadcrumb plate (V7): the section's icon in its colour, its name and
// count, then the open sub-tab (Accounting › Salary, Admin › Users, Schedule ›
// All sites); the page itself shows no title.
const CRUMB_COUNT: Record<string, () => number>={workers:()=>workers.filter(isActiveWorker).length, clients:()=>clients.length, suppliers:()=>suppliers.length};
export function renderCrumb(){
  const sec=byId('section'+currentTab.charAt(0).toUpperCase()+currentTab.slice(1));
  const on=sec&&[...sec.querySelectorAll('.og-tabs button.on')].find((b?: any)=>b.offsetParent!==null);
  let sub='';
  if(on){ const c=on.cloneNode(true); c.querySelectorAll('i, svg, .tab-n, .tab-badge').forEach((x?: any)=>x.remove()); sub=c.textContent.trim(); }
  const n=CRUMB_COUNT[currentTab]?CRUMB_COUNT[currentTab]():undefined;
  setFrame({crumb:{count:n, sub:sub||undefined}});
}
// A sub-tab changes without render(): the crumb follows any tap in the page.
document.addEventListener('click', () => setTimeout(renderCrumb, 0));
// The weather for the greeting: the firm's main site, read again after 30 minutes
// or when the super-admin opens another firm; a failure keeps the time-of-day icon.
const WEATHER_FN_URL='https://europe-west3-schedule-odinson.cloudfunctions.net/weather';
let __wx: any=null, __wxAt=0, __wxTid: any=null;
async function loadWeather(){
  const s=getSession(), tid=fsTenantId();
  if(!s || !tid || !['superadmin','tenant_admin','staff','hr'].includes(s.role||'')) return;
  if(__wxTid===tid && Date.now()-__wxAt<30*60e3) return;
  __wxTid=tid; __wxAt=Date.now(); __wx=null;
  try{
    const idToken=await (await loadFirestoreBackend()).idToken();
    const res=await fetch(WEATHER_FN_URL,{method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+idToken},
      body:JSON.stringify(s.role==='superadmin'?{asTenantId:tid}:{})});
    const j=await res.json();
    if(__wxTid!==tid) return;
    __wx=j&&j.kind?{kind:j.kind, temp:j.temp}:null;
  }catch(e: any){ return; }
  if(__wx) renderGreeting();
}
// The bell: what needs a look, newest first — documents and visas expiring or
// expired, contracts ending, no punch on today's shift, hours waiting for
// approval, a client that approved a month. Each has a steady id; the ids this
// login has read are kept on its account (notifReads/{uid}, loadNotifReads /
// saveNotifReads), so "Mark all read" follows it to every device.
let __notifRead=new Set<string>(), __notifReadLoaded=false, __notifApprovals: any=[], __notifApprAt=0;
function notifEnabled(){ const s=getSession(); return !!s && ['superadmin','tenant_admin','staff','hr'].includes(s.role||''); }
function notifList(){
  const out: any=[], t=fsTenantId()+':', now=new Date(), today=localYMD(now), dayStart=new Date(now).setHours(0,0,0,0);
  const todayLog=todayPunchLog();
  workers.filter(isActiveWorker).forEach((w?: any)=>{
    const st=workerDocStatus(w);
    if(st.expiry){ const bad=st.expiry.level==='error'; out.push({id:t+'doc:'+w.id+':id:'+w.docExpiry, lvl:bad?'red':'amber', icon:'ti-id', title:bad?tr('ID / passport expired'):tr('ID / passport expiring'), detail:w.name+' · '+st.expiry.text, at:bad?+st.expiry.date:dayStart, open:()=>openNotices(w.id)}); }
    st.docExpiries.forEach((x?: any)=>{ const bad=x.level==='error', label=tr(WORKER_DOC_TYPES[x.doc.type]||'Document');
      out.push({id:t+'doc:'+w.id+':'+x.doc.type+':'+x.doc.expiry, lvl:bad?'red':'amber', icon:'ti-id-badge-2', title:bad?tr('{0} expired',{0:label}):tr('{0} expiring',{0:label}), detail:w.name+' · '+x.text, at:bad?+x.date:dayStart, open:()=>openNotices(w.id)}); });
    const ex=workerExpiryStatus(w);
    if(ex) out.push({id:t+'contract:'+w.id+':'+localYMD(ex.deadline), lvl:ex.level==='overdue'?'red':'amber', icon:'ti-file-certificate', title:ex.level==='overdue'?tr('Contract ended'):tr('Contract ending'), detail:w.name+' · '+ex.deadline.toLocaleDateString('en-GB'), at:ex.level==='overdue'?+ex.deadline:dayStart, open:()=>openNotices(w.id)});
    const td=workerToday(w,todayLog);
    if(td.k==='none'){ const [h,m]=String(td.sh.start).split(':').map(Number); out.push({id:t+'nopunch:'+w.id+':'+today, lvl:'red', icon:'ti-clock-off', title:tr('No punch on today\'s shift'), detail:w.name+' · '+td.sh.start+'–'+(td.sh.end||''), at:new Date(now).setHours(h||0,m||0,0,0), open:()=>openNotices(w.id), acts:noPunchActs(w,td.sh)}); }
  });
  if(hasPermission('accounting')&&!isHrSession()) (__hoursBatches||[]).filter((b?: any)=>b.status==='pending').forEach((b?: any)=>{
    out.push({id:t+'hours:'+b.batchId, lvl:'blue', icon:'ti-clock-hour-4', title:tr('Hours waiting for approval'), detail:[b.fileName,b.uploadedBy].filter(Boolean).join(' · '), at:Date.parse(b.uploadedAt)||dayStart, open:()=>switchTab('accounting')}); });
  __notifApprovals.forEach((a?: any)=>out.push(Object.assign({lvl:'green', icon:'ti-circle-check', open:()=>switchTab('accounting')}, a)));
  const tr6=scanEdgesNotice(); if(tr6) out.push(tr6);
  const tr7=scanDoctypeNotice(); if(tr7) out.push(tr7);
  const tr8=scanAttemptsNotice(); if(tr8) out.push(tr8);
  const tr9=scanPassportsNotice(); if(tr9) out.push(tr9);
  const tr10=scanIdCardsNotice(); if(tr10) out.push(tr10);
  const tr11=scanLoopNotice(); if(tr11) out.push(tr11);
  return out.sort((a?: any,b?: any)=>b.at-a.at);
}
// The scanner's "time to retrain" notice (docs/scan-plan.md → S6), the super-admin's
// only: scan_feedback counts the corrected pages since the last training; at 200 the
// owner runs /scan-train on the PC. Read at most every 6 hours.
let __scanTrain: any=null, __scanTrainAt=0;
function scanEdgesNotice(){
  if((getSession()||{} as any).role!=='superadmin') return null;
  if(Date.now()-__scanTrainAt>6*3600e3){ __scanTrainAt=Date.now(); trainingStats().then(r=>{ __scanTrain=r; if(r&&(r.due||r.doctypesDue||r.attemptsDue||r.passportsDue||r.idCardsDue||loopNotice(r.loop?.latest))) refreshBell(); }); }
  if(!(__scanTrain&&__scanTrain.due)) return null;
  const n=__scanTrain.edgesSince;
  return {id:'scan-train:'+Math.floor(n/100), lvl:'blue', icon:'ti-scan', title:tr('Time to retrain the document edges model'),
    detail:tr('{0} corrected pages since the last training — run /scan-train on the PC',{0:n}), at:new Date().setHours(0,0,0,0), open:openScanAdmin};
}
// The document type model's notice (docs/scan-plan.md → S7): every document type has
// enough page copies (scan_feedback's doctypesDue, read with the notice above).
function scanDoctypeNotice(){
  if((getSession()||{} as any).role!=='superadmin'||!(__scanTrain&&__scanTrain.doctypesDue)) return null;
  const n=Math.min(...['id_front','id_back','sefach','passport','contract'].map(k=>Number(__scanTrain.doctypes[k]||0)));
  return {id:'scan-doctypes', lvl:'blue', icon:'ti-scan', title:tr('Enough pages to train the document type model'),
    detail:tr('At least {0} pages of each document type — run /scan-train on the PC',{0:n}), at:new Date().setHours(0,0,0,0), open:openScanAdmin};
}
// Every scan attempt (docs/scan-plan.md → S8): enough new attempts from the site and the lab
// (scan_feedback's attemptsDue, read with the notices above) to train on.
function scanAttemptsNotice(){
  if((getSession()||{} as any).role!=='superadmin'||!(__scanTrain&&__scanTrain.attemptsDue)) return null;
  const n=Number(__scanTrain.attemptsSince||0);
  return {id:'scan-attempts:'+Math.floor(n/15), lvl:'blue', icon:'ti-scan', title:tr('New scan attempts — time to train'),
    detail:tr('{0} new scan attempts since the last training — run /scan-train on the PC',{0:n}), at:new Date().setHours(0,0,0,0), open:openScanAdmin};
}
// The readers' notices (docs/scan-plan.md → the bell): enough real passports / Israeli ID cards saved with
// the fields a person kept since the reader's last training (scan_feedback's passportsDue / idCardsDue,
// REAL_NEEDED: 30) to train the passport zone reader / the Hebrew field reader on the PC.
function scanPassportsNotice(){
  if((getSession()||{} as any).role!=='superadmin'||!(__scanTrain&&__scanTrain.passportsDue)) return null;
  const n=Number(__scanTrain.passportsSince||0);
  return {id:'scan-passports:'+Math.floor(n/30), lvl:'blue', icon:'ti-scan', title:tr('Enough real passports to train the passport zone reader'),
    detail:tr('{0} real passports saved since the last training — run /scan-train on the PC',{0:n}), at:new Date().setHours(0,0,0,0), open:openScanAdmin};
}
function scanIdCardsNotice(){
  if((getSession()||{} as any).role!=='superadmin'||!(__scanTrain&&__scanTrain.idCardsDue)) return null;
  const n=Number(__scanTrain.idCardsSince||0);
  return {id:'scan-idcards:'+Math.floor(n/30), lvl:'blue', icon:'ti-scan', title:tr('Enough real ID cards to train the Hebrew field reader'),
    detail:tr('{0} real ID cards saved since the last training — run /scan-train on the PC',{0:n}), at:new Date().setHours(0,0,0,0), open:openScanAdmin};
}
// The automatic training cycle on the owner's PC (docs/scan-training.md → The automatic cycle → Reports): its latest
// report when it is new — a new lab version with its PR to merge, nothing published, waiting for the golden set, failed
// (src/manager/logic/scanloop.ts loopNotice; scan_feedback's stats "loop", read with the notices above).
function scanLoopNotice(){
  if((getSession()||{} as any).role!=='superadmin'||!__scanTrain) return null;
  const n=loopNotice(__scanTrain.loop?.latest);
  return n?{...n, open:openScanAdmin}:null;
}
// A scanner notice opens Admin → Scanner (docs/hf-plan.md → Admin → Scanner and the bell).
function openScanAdmin(){ switchTab('admin'); (window as any).switchAdminPane?.('scanner'); }
// ── WhatsApp reminder (redesign stage 11a, docs/admin.md → Firms): a "no
// punch" notice gets a WhatsApp button next to Call. It opens wa.me with the
// worker's phone in international form and the firm's template filled in
// (tenants/{t}/settings/messages.waTemplate; empty = the default, in the UI
// language). No API: the owner taps Send in WhatsApp.
function waDefaultTemplate(){ return tr('Hi {full name}, you have not punched in today (shift {start} · {site}).'); }
let __firmMsgs: any=null, __firmMsgsAt=0;
export async function loadFirmMessages(force?: any){
  if(!force&&__firmMsgs&&Date.now()-__firmMsgsAt<5*60e3) return __firmMsgs;
  try{ const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadFirmMessages'})})).json();
    if(j&&j.ok){ __firmMsgs=j.messages||{}; __firmMsgsAt=Date.now(); } }catch(e: any){}
  return __firmMsgs||{};
}
export function waTemplate(){ const t=__firmMsgs&&__firmMsgs.waTemplate; return t&&String(t).trim()?String(t):waDefaultTemplate(); }
// "050-123 4567" → "972501234567"; "+972…" / "972…" / "00972…" kept (digits only).
function waPhone(p?: any){
  let d=String(p||'').replace(/\D/g,'');
  if(d.startsWith('00')) d=d.slice(2);
  if(/^0\d{8,9}$/.test(d)) d='972'+d.slice(1);
  return d.length>=9?d:'';
}
function waMessage(w?: any, sh?: any){
  const name=String(w.name||'').trim();
  return waTemplate().replace(/\{full name\}/g,name).replace(/\{first name\}/g,name.split(/\s+/)[0]||'')
    .replace(/\{start\}/g,(sh&&sh.start)||'').replace(/\{site\}/g,workerSiteName(w)||'');
}
function waLink(w?: any, sh?: any){ const n=waPhone(w&&w.phone); return n?'https://wa.me/'+n+'?text='+encodeURIComponent(waMessage(w,sh)):''; }
function openWhatsApp(w?: any, sh?: any){ const u=waLink(w,sh); if(u) window.open(u,'_blank','noopener'); }
function callWorker(w?: any){ location.href='tel:'+String(w.phone).replace(/[^\d+]/g,''); }
// The "no punch" actions: Call and WhatsApp, when the worker has a phone.
export function noPunchActs(w?: any, sh?: any){
  if(!w.phone) return [];
  return [{label:tr('Call'), icon:'ti-phone', fn:()=>callWorker(w)}, ...(waPhone(w.phone)?[{label:tr('WhatsApp'), icon:'ti-brand-whatsapp', fn:()=>openWhatsApp(w,sh), wa:true}]:[])];
}
// The firm window's WhatsApp reminder, saved on its own when it changes (not
// part of updateTenant, so it never rebuilds Form 101s); the default text = empty.
export async function saveFirmMessage(tenantId?: any, text?: any){
  const v=String(text||'').trim(), waTemplate=v===waDefaultTemplate()?'':v;
  try{
    const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'saveFirmMessages', asTenantId:tenantId, waTemplate})})).json();
    if(!j||j.error){ showToast(tr((j&&j.error)||'Save failed')); return; }
    __firmMsgs=Object.assign({}, __firmMsgs||{}, {waTemplate}); __firmMsgsAt=Date.now();
    showToast(tr('Saved'));
  }catch(e: any){ showToast(tr('Network error')); }
}
// A client login that approved every day of this month (the hours function's
// list, read at most every 5 minutes; firm admins and staff with Accounting).
async function refreshNotifApprovals(){
  if(isHrSession()||!hasPermission('accounting')||Date.now()-__notifApprAt<5*60e3) return;
  __notifApprAt=Date.now();
  const month=localYMD(new Date()).slice(0,7);
  try{
    const docs=await hourApprovalsOf(month);
    __notifApprovals=docs.filter((d?: any)=>d.kind==='client').map((d?: any)=>{ const sum=hourApprovalSummary(d,month); if(sum.open.length||!sum.done||sum.done<sum.total) return null;
      const at=Math.max(0,...Object.values(d.days||{}).map((e?: any)=>Date.parse(e.at)||0));
      return {id:fsTenantId()+':appr:'+d.id+':'+month, title:tr('A client approved the month'), detail:(d.ownerName||d.ownerId||'')+' · '+month, at:at||Date.now()}; }).filter(Boolean);
    refreshBell();
  }catch(e: any){}
}
export async function loadNotifReads(){
  if(__notifReadLoaded||!notifEnabled()) return;
  __notifReadLoaded=true;
  try{ const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadNotifReads'})})).json(); if(j&&Array.isArray(j.ids)) j.ids.forEach((id?: any)=>__notifRead.add(id)); }catch(e: any){ __notifReadLoaded=false; }
  refreshBell();
}
function saveNotifReads(){
  const ids=[...__notifRead].slice(-500); __notifRead=new Set(ids);
  fetch(API_URL,{method:'POST',body:JSON.stringify({action:'saveNotifReads', ids})}).catch(()=>{});
}
// The bell button and its list are the React frame's (ShellBell, BellPanel —
// src/manager/Frame.tsx); the page builds the list (notifList) and runs its actions.
let __bellItems: any=[];
export function refreshBell(){
  if(!notifEnabled()){ setFrame({bell:{shown:false, count:0}, bellOpen:false}); return; }
  const list=notifList(), n=list.filter((x?: any)=>!__notifRead.has(x.id)).length;
  setFrame({bell:{shown:true, count:n}, bellV:frameState().bellV+1});
}
export function toggleBell(e?: any){
  if(e) e.stopPropagation();
  if(frameState().bellOpen){ closeBell(); return; }
  setFrame({bellOpen:true, bellV:frameState().bellV+1});
  refreshNotifApprovals();
  loadFirmMessages();
}
function closeBell(){ if(frameState().bellOpen) setFrame({bellOpen:false}); }
document.addEventListener('click',()=>closeBell());
document.addEventListener('keydown',(e?: any)=>{ if(e.key==='Escape') closeBell(); });
// The list BellPanel draws: each notification with whether it is unread (its
// actions stay here, run by bellAct).
export function bellItems(){
  __bellItems=notifList();
  return __bellItems.map((x?: any)=>({id:x.id, lvl:x.lvl, icon:x.icon, title:x.title, detail:x.detail||'', at:x.at, unread:!__notifRead.has(x.id),
    acts:(x.acts||[]).map((a?: any)=>({label:a.label, icon:a.icon||'', wa:!!a.wa}))}));
}
export function openNotif(id?: any){
  const x=__bellItems.find((y?: any)=>y.id===id); if(!x) return;
  if(!__notifRead.has(x.id)){ __notifRead.add(x.id); saveNotifReads(); }
  closeBell(); refreshBell(); if(x.open) x.open();
}
export function bellAct(id?: any, k?: any){ const x=__bellItems.find((y?: any)=>y.id===id); const a=x&&(x.acts||[])[k]; if(a&&a.fn) a.fn(); }
export function markAllNotifRead(){
  __bellItems.forEach((x?: any)=>__notifRead.add(x.id)); saveNotifReads(); refreshBell();
}
setInterval(()=>{ if(getSession()){ refreshBell(); renderGreeting(); } }, 60e3);
