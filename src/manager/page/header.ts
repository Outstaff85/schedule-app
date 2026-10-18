// The manager page's own script, part "header": the title bar: the greeting and weather, the breadcrumb, the bell and its notifications, the WhatsApp reminder.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { esc, fmtDMY } from '../logic/util';
import { tr, uiLocale } from '../logic/i18n';
import { fsTenantId, getSession } from '../data/session';
import { WORKER_DOC_TYPES, isActiveWorker, workerDocStatus, workerExpiryStatus } from '../logic/workers';
import { API_URL, loadFirestoreBackend } from '../data/api';
import { localYMD } from '../logic/pay';
import { hasPermission, isHrSession } from '../logic/access';
import { switchTab } from './nav';
import { showToast } from '../toast';
Object.defineProperties(window, {
  "GREET_ICONS": {get: () => GREET_ICONS, configurable: true},
  "partOfDay": {get: () => partOfDay, configurable: true},
  "GIC_CLOUD": {get: () => GIC_CLOUD, configurable: true},
  "WX_ICONS": {get: () => WX_ICONS, configurable: true},
  "weatherIconHtml": {get: () => weatherIconHtml, configurable: true},
  "greetingHtml": {get: () => greetingHtml, configurable: true},
  "renderGreeting": {get: () => renderGreeting, configurable: true},
  "CRUMB_COUNT": {get: () => CRUMB_COUNT, configurable: true},
  "renderCrumb": {get: () => renderCrumb, configurable: true},
  "WEATHER_FN_URL": {get: () => WEATHER_FN_URL, configurable: true},
  "__wx": {get: () => __wx, set: (v?: any) => { __wx = v; }, configurable: true},
  "__wxAt": {get: () => __wxAt, set: (v?: any) => { __wxAt = v; }, configurable: true},
  "__wxTid": {get: () => __wxTid, set: (v?: any) => { __wxTid = v; }, configurable: true},
  "loadWeather": {get: () => loadWeather, configurable: true},
  "__notifRead": {get: () => __notifRead, set: (v?: any) => { __notifRead = v; }, configurable: true},
  "__notifReadLoaded": {get: () => __notifReadLoaded, set: (v?: any) => { __notifReadLoaded = v; }, configurable: true},
  "__notifApprovals": {get: () => __notifApprovals, set: (v?: any) => { __notifApprovals = v; }, configurable: true},
  "__notifApprAt": {get: () => __notifApprAt, set: (v?: any) => { __notifApprAt = v; }, configurable: true},
  "notifEnabled": {get: () => notifEnabled, configurable: true},
  "notifList": {get: () => notifList, configurable: true},
  "waDefaultTemplate": {get: () => waDefaultTemplate, configurable: true},
  "__firmMsgs": {get: () => __firmMsgs, set: (v?: any) => { __firmMsgs = v; }, configurable: true},
  "__firmMsgsAt": {get: () => __firmMsgsAt, set: (v?: any) => { __firmMsgsAt = v; }, configurable: true},
  "loadFirmMessages": {get: () => loadFirmMessages, configurable: true},
  "waTemplate": {get: () => waTemplate, configurable: true},
  "waPhone": {get: () => waPhone, configurable: true},
  "waMessage": {get: () => waMessage, configurable: true},
  "waLink": {get: () => waLink, configurable: true},
  "openWhatsApp": {get: () => openWhatsApp, configurable: true},
  "callWorker": {get: () => callWorker, configurable: true},
  "noPunchActs": {get: () => noPunchActs, configurable: true},
  "saveFirmMessage": {get: () => saveFirmMessage, configurable: true},
  "refreshNotifApprovals": {get: () => refreshNotifApprovals, configurable: true},
  "loadNotifReads": {get: () => loadNotifReads, configurable: true},
  "saveNotifReads": {get: () => saveNotifReads, configurable: true},
  "refreshBell": {get: () => refreshBell, configurable: true},
  "toggleBell": {get: () => toggleBell, configurable: true},
  "closeBell": {get: () => closeBell, configurable: true},
  "__bellItems": {get: () => __bellItems, set: (v?: any) => { __bellItems = v; }, configurable: true},
  "drawBellPanel": {get: () => drawBellPanel, configurable: true},
  "openNotif": {get: () => openNotif, configurable: true},
  "markAllNotifRead": {get: () => markAllNotifRead, configurable: true},
});

// ── Greeting and notifications (redesign stage 5, docs/accounting.md → Today) ──
// "Good morning / afternoon / evening / night, <first name>" by the device's
// local time (5–12, 12–17, 17–21, 21–5), with a small animated icon after it.
const GREET_ICONS: Record<string, string>={
  morning:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz"><rect x="0" y="0" width="32" height="23"/></clipPath></defs><g clip-path="url(#gicHz)"><g class="rise"><circle cx="16" cy="22" r="7" fill="#f7c062"/>'+[0,51,102,154,205,257,308].map((a?: any)=>`<line x1="16" y1="12" x2="16" y2="9" stroke="#f7c062" stroke-width="2" stroke-linecap="round" transform="rotate(${a} 16 22)"/>`).join('')+'</g></g><line x1="4" y1="23.5" x2="28" y2="23.5" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round"/></svg>',
  day:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="spin">'+[0,45,90,135,180,225,270,315].map((a?: any)=>`<line x1="16" y1="6" x2="16" y2="2" stroke="#fde68a" stroke-width="2.2" stroke-linecap="round" transform="rotate(${a} 16 16)"/>`).join('')+'</g><circle class="pulse" cx="16" cy="16" r="6.5" fill="#fcd34d"/></svg>',
  evening:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz2"><rect x="0" y="0" width="32" height="21"/></clipPath></defs><g clip-path="url(#gicHz2)"><g class="sink"><circle cx="16" cy="20" r="8" fill="#f9a8d4"/></g></g><line x1="4" y1="21.5" x2="28" y2="21.5" stroke="rgba(255,255,255,.6)" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="25.5" x2="23" y2="25.5" stroke="rgba(255,255,255,.3)" stroke-width="2" stroke-linecap="round"/></svg>',
  night:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><path class="moon" d="M20 6a10 10 0 1 0 7 15A8 8 0 0 1 20 6z" fill="#c7d2fe"/><circle class="tw" cx="7" cy="8" r="1.4" fill="#fff"/><circle class="tw tw2" cx="11" cy="4" r="1" fill="#fff"/></svg>'};
function partOfDay(d?: any){ const h=(d||new Date()).getHours(); return h>=5&&h<12?'morning':h>=12&&h<17?'day':h>=17&&h<21?'evening':'night'; }
// The weather in the greeting (redesign stage 12): the `weather` function's
// {kind, temp} for the site (punch page: the worker's site; manager app: the
// firm's main site). "clear" keeps the time-of-day icon; no answer = that icon.
const GIC_CLOUD=(fill?: any,y?: any)=>`<circle cx="12" cy="${15+y}" r="5" fill="${fill}"/><circle cx="18" cy="${12+y}" r="6.5" fill="${fill}"/><circle cx="23.5" cy="${16+y}" r="4.5" fill="${fill}"/><rect x="8" y="${15+y}" width="19.5" height="5.5" rx="2.75" fill="${fill}"/>`;
const WX_ICONS: Record<string, string>={
  clouds:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g transform="translate(4 -5)"><g class="drift d2" opacity=".55">'+GIC_CLOUD('#94a3b8',0)+'</g></g><g class="drift">'+GIC_CLOUD('#e2e8f0',2)+'</g></svg>',
  rain:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#cbd5e1',-3)+'</g>'+[11,17,23].map((x?: any,i?: any)=>`<line class="drop d${i+1}" x1="${x}" y1="22" x2="${x-1.5}" y2="26" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"/>`).join('')+'</svg>',
  thunder:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#94a3b8',-3)+'</g><path class="bolt" d="M17 19l-4 6h3.5l-2 5 6-7.5h-3.5l2-3.5z" fill="#fcd34d"/></svg>',
  snow:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#e2e8f0',-3)+'</g>'+[11,17,23].map((x?: any,i?: any)=>`<circle class="flake d${i+1}" cx="${x}" cy="24" r="1.6" fill="#fff"/>`).join('')+'</svg>',
  fog:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true">'+[[6,26,10],[4,22,16],[9,28,22]].map(([a,b,y]: any,i?: any)=>`<line class="fogl d${i+1}" x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="#cbd5e1" stroke-width="2.4" stroke-linecap="round"/>`).join('')+'</svg>'};
function weatherIconHtml(p?: any,wx?: any){
  const k=wx&&wx.kind, ic=(k&&WX_ICONS[k])||GREET_ICONS[p];
  return ic+(wx&&Number.isFinite(wx.temp)?`<span class="gtemp">${esc(String(wx.temp))}°</span>`:'');
}
function greetingHtml(name?: any, wx?: any){
  const p=partOfDay(), first=String(name||'').trim().split(/\s+/)[0]||'';
  const text={morning:'Good morning, {name}',day:'Good afternoon, {name}',evening:'Good evening, {name}',night:'Good night, {name}'}[p];
  return `<h3 class="t-${p}"><span class="gtext">${esc(first?tr(text,{name:first}):tr(text,{name:''}).replace(/,\s*$/,''))}</span>${weatherIconHtml(p,wx)}</h3>`;
}
// V7 (stage 6a): in the middle of the title bar on every tab — the date (short
// on a phone), the greeting (its words hidden on a phone) and the weather.
export function renderGreeting(){
  const el=byId('ogGreet'), d=byId('ogDate'), s=getSession(); if(!el||!s) return;
  const now=new Date();
  if(d) d.innerHTML=`<span class="og-date-l">${esc(now.toLocaleDateString(uiLocale(),{weekday:'long',day:'numeric',month:'short'}))}</span><span class="og-date-s">${esc(now.toLocaleDateString(uiLocale(),{weekday:'short',day:'numeric',month:'short'}))}</span>`;
  el.innerHTML=greetingHtml(s.fullName||s.username, __wx&&__wxTid===fsTenantId()?__wx:null); loadWeather();
}
// The breadcrumb plate (V7): the section's icon in its colour, its name and
// count, then the open sub-tab (Accounting › Salary, Admin › Users, Schedule ›
// All sites); the page itself shows no title.
const CRUMB_COUNT: Record<string, () => number>={workers:()=>workers.filter(isActiveWorker).length, clients:()=>clients.length, suppliers:()=>suppliers.length};
export function renderCrumb(){
  const el=byId('ogCrumb'); if(!el) return;
  const tab=byId('tab'+currentTab.charAt(0).toUpperCase()+currentTab.slice(1)); if(!tab){ el.innerHTML=''; return; }
  const sec=byId('section'+currentTab.charAt(0).toUpperCase()+currentTab.slice(1));
  const on=sec&&[...sec.querySelectorAll('.og-tabs button.on')].find((b?: any)=>b.offsetParent!==null);
  let sub='';
  if(on){ const c=on.cloneNode(true); c.querySelectorAll('i, .tab-n, .tab-badge').forEach((x?: any)=>x.remove()); sub=c.textContent.trim(); }
  const n=CRUMB_COUNT[currentTab]?CRUMB_COUNT[currentTab]():null;
  el.style.setProperty('--k', tab.style.getPropertyValue('--k'));
  el.innerHTML=`<i class="${esc((tab.querySelector('.ic i')||{}).className||'')}"></i><b>${esc(tab.querySelector('.lb').textContent)}</b>`
    +(n!=null?`<em>${n}</em>`:'')+(sub?`<i class="ti ti-chevron-right og-crumb-sep"></i><span>${esc(sub)}</span>`:'');
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
  if(hasPermission('accounting')) (__hoursBatches||[]).filter((b?: any)=>b.status==='pending').forEach((b?: any)=>{
    out.push({id:t+'hours:'+b.batchId, lvl:'blue', icon:'ti-clock-hour-4', title:tr('Hours waiting for approval'), detail:[b.fileName,b.uploadedBy].filter(Boolean).join(' · '), at:Date.parse(b.uploadedAt)||dayStart, open:()=>switchTab('accounting')}); });
  __notifApprovals.forEach((a?: any)=>out.push(Object.assign({lvl:'green', icon:'ti-circle-check', open:()=>switchTab('accounting')}, a)));
  return out.sort((a?: any,b?: any)=>b.at-a.at);
}
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
export function refreshBell(){
  const btn=byId('bellBtn'); if(!btn) return;
  if(!notifEnabled()){ btn.style.display='none'; return; }
  btn.style.display='';
  const list=notifList(), n=list.filter((x?: any)=>!__notifRead.has(x.id)).length, c=byId('bellCount');
  c.textContent=n>99?'99+':String(n); c.style.display=n?'':'none'; btn.classList.toggle('has-new',n>0);
  if(byId('bellPanel')) drawBellPanel(list);
}
function toggleBell(e?: any){
  if(e) e.stopPropagation();
  if(byId('bellPanel')){ closeBell(); return; }
  const p=document.createElement('div'); p.id='bellPanel'; p.className='og-npop'; p.setAttribute('role','dialog');
  p.addEventListener('click',(ev?: any)=>ev.stopPropagation());
  document.body.appendChild(p);
  drawBellPanel(notifList());
  const r=byId('bellBtn').getBoundingClientRect(), pw=p.offsetWidth;
  const left=Math.min(window.innerWidth-pw-8, Math.max(8, r.right-pw+40));
  p.style.left=left+'px'; p.style.top=(r.bottom+10)+'px';
  p.style.setProperty('--px', Math.max(10, Math.min(pw-22, r.left+r.width/2-left-6))+'px');
  byId('bellBtn').classList.add('on');
  void p.offsetWidth; p.classList.add('open');
  refreshNotifApprovals();
  loadFirmMessages();
}
function closeBell(){ const p=byId('bellPanel'); if(p) p.remove(); const b=byId('bellBtn'); if(b) b.classList.remove('on'); }
document.addEventListener('click',()=>closeBell());
document.addEventListener('keydown',(e?: any)=>{ if(e.key==='Escape') closeBell(); });
let __bellItems: any=[];
function drawBellPanel(list?: any){
  const p=byId('bellPanel'); if(!p) return;
  __bellItems=list;
  const unread=list.some((x?: any)=>!__notifRead.has(x.id));
  p.innerHTML=`<h5><span>${esc(tr('Notifications'))}</span>${unread?`<button type="button" class="og-npop-all" onclick="markAllNotifRead()">${esc(tr('Mark all read'))}</button>`:''}</h5><div class="og-npop-list"></div>`;
  const box=p.querySelector('.og-npop-list');
  if(!list.length){ box.innerHTML=`<div class="t3-empty" style="padding:10px 8px">${esc(tr('Nothing new'))}</div>`; return; }
  const col: Record<string, string>={red:'var(--bad)', amber:'var(--warn)', blue:'var(--info)', green:'var(--ok)'};
  const when=(ms?: any)=>{ const d=new Date(ms); return localYMD(d)===localYMD(new Date())?d.toTimeString().slice(0,5):fmtDMY(localYMD(d)); };
  const acts=(x?: any)=>(x.acts||[]).length?`<div class="og-ni-acts">${x.acts.map((a?: any)=>`<button type="button" class="gbtn nact${a.wa?' wa':''}" onclick="event.stopPropagation();runRowFn('${rowFnKey(a.fn)}')"><i class="ti ${esc(a.icon)}"></i><span>${esc(a.label)}</span></button>`).join('')}</div>`:'';
  renderPagedList(box,'notifs',list.length+':'+unread,list,(x?: any,i?: any)=>`<div class="og-ni-w"><button type="button" class="og-ni${__notifRead.has(x.id)?'':' new'}" style="--c:${col[x.lvl]||'var(--neutral)'}" onclick="openNotif(${i})"><span class="ic"><i class="ti ${esc(x.icon)}"></i></span><span class="tx"><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></span><time>${esc(when(x.at))}</time></button>${acts(x)}</div>`);
}
function openNotif(i?: any){
  const x=__bellItems[i]; if(!x) return;
  if(!__notifRead.has(x.id)){ __notifRead.add(x.id); saveNotifReads(); }
  closeBell(); refreshBell(); if(x.open) x.open();
}
function markAllNotifRead(){
  __bellItems.forEach((x?: any)=>__notifRead.add(x.id)); saveNotifReads(); refreshBell();
}
setInterval(()=>{ if(getSession()){ refreshBell(); renderGreeting(); } }, 60e3);
