// The manager page's own script, part "worker-window": the worker window's entry points, its scan search and its save.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { DAYS } from '../logic/schedule';
import { API_URL, gsDeleteWorkerDoc } from '../data/api';
import { gsAuth } from '../data/session';
import { FORM101_FN_URL, SCAN_WARM_URLS, warmCloudFunctions } from '../logic/functions';
import { tr } from '../logic/i18n';
import { HOUR_DEFAULT, HOUR_PERM_LABELS, activeTenantIdForAdmin, loadAdminCache } from '../logic/admin';
import { isFirmAdminSession } from '../logic/access';
import { autoSave } from '../data/store';
import { genToken } from '../data/ids';
import { render } from './render';
import { openNewScan } from './scan';
import { verifierFor } from '../../scan-process/ai';
import { normDate, normDigits } from '../../scan-process/ids';
import { resetScan } from '../../scan-process/session';
import { showToast } from '../toast';
import { island } from '../bridge';
Object.defineProperties(window, {
  "blankWorkerDefaults": {get: () => blankWorkerDefaults, configurable: true},
  "openAddWorker": {get: () => openAddWorker, configurable: true},
  "openEditWorker": {get: () => openEditWorker, configurable: true},
  "rescanFromWorkerModal": {get: () => rescanFromWorkerModal, configurable: true},
  "applyWorkerDraft": {get: () => applyWorkerDraft, configurable: true},
  "autoFindMissingScanFields": {get: () => autoFindMissingScanFields, configurable: true},
  "showWorkerModal": {get: () => showWorkerModal, configurable: true},
  "supplierMonthPayable": {get: () => supplierMonthPayable, configurable: true},
  "saveWorker": {get: () => saveWorker, configurable: true},
});

// --- Worker Modal -------------------------------------------------------------
// workerDocId() / workerAddress() (a number older records kept inside
// `address`) are src/manager/worker.ts, given to the page by ../globals.ts.
function blankWorkerDefaults(){
  return {name:'',docGiven:'',docSurname:'',colorIdx:workers.length%8,phone:'',clientIds:[],
    schedule:DAYS.map(()=>({type:'work',start:'09:00',end:'17:00'}))};
}
// Plain manual "Add Worker" (not the scan pipeline, which calls
// showWorkerModal() directly after OCR with its own fresh scan data already
// in these globals — see the scan-redirect logic below). Resets them here so
// a leftover scan/signature from a PREVIOUS, unrelated worker's session
// (e.g. the manager just created worker A from a scan a moment ago) never
// silently attaches to worker B's PDF — saveWorker()'s new-worker path reads
// these live globals directly (autoUploadWithRetry), unlike an edit-save
// (which goes through the sidecar-based regenerateWorkerDoc() instead).
export function openAddWorker(){
  editingWorkerId=null;
  window.__wDraft=null;
  resetScan();
  window.__wCapturedSigPng=undefined;
  showWorkerModal(blankWorkerDefaults());
}
export function openEditWorker(wi?: any){ const w=workers[wi]; if(!w) return; editingWorkerId=w.id; window.__wDraft=null; showWorkerModal(w); }
// Form 101 fields a document scan fills: the worker field, its input in the
// worker modal, the page it is printed on (front or ספח), its Hebrew label
// and, for digits and dates, the zoomed re-read kind (verifyField).
const SCAN_FIND_FIELDS: Record<string, any>={
  docGiven:{input:'wGiven',page:'front',label:'שם פרטי',kind:'hebrewText',passportKind:'latinName'},
  docSurname:{input:'wSurname',page:'front',label:'שם משפחה',kind:'hebrewText',passportKind:'latinName'},
  docId:{input:'wDocId',page:'front',label:'מספר זהות',passportLabel:'מספר דרכון',kind:'digits9',passportKind:'passportNo'},
  docDob:{input:'wDob',page:'front',label:'תאריך לידה',kind:'date'},
  docSex:{input:'wSex',page:'front',label:'מין'},
  address:{input:'wAddress',page:'sefach',label:'רחוב',idOnly:true,kind:'hebrewText'},
  houseNumber:{input:'wHouseNumber',page:'sefach',label:'מס׳ בית',idOnly:true,kind:'houseNumber'},
  city:{input:'wCity',page:'sefach',label:'ישוב',idOnly:true,kind:'hebrewText'},
};
// The worker's page photos, for a field search: the scan still in memory
// when it belongs to this worker (a new worker from a scan: w null), else the
// Storage sidecar saved with their Form 101 (cached per file).
const __scanPagesCache: any={};
export function workerScanLive(w?: any){ return !!window.__aiScanImage&&(w?window.__aiRescannedWorkerId===w.id:editingWorkerId===null); }
export function workerHasScanPages(w?: any){ return workerScanLive(w)||!!(w&&w.assetsFileId); }
async function workerScanPages(w?: any){
  if(workerScanLive(w)) return {front:window.__aiScanImage,others:(window.__aiPacketOtherPages||[]).filter((p?: any)=>p&&p.b64)};
  if(!w||!w.assetsFileId) return null;
  if(__scanPagesCache[w.assetsFileId]) return __scanPagesCache[w.assetsFileId];
  const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:w.assetsFileId})})).json();
  if(!j||!j.ok||!j.scanB64) return null;
  return __scanPagesCache[w.assetsFileId]={front:{b64:j.scanB64,mediaType:j.scanMediaType||'image/jpeg'},
    others:(j.extraPages||[]).filter((p?: any)=>p&&p.b64)};
}
// Searches the worker's page photos for one or more fields in ONE aiFindField
// request (the photos are the expensive part, so they go once). Each value
// found with a box is re-read zoomed — one batched aiVerifyFields per page —
// and the zoomed read wins. Resolves {key: {value, unsure}} (unsure: the two
// reads disagreed; value '' when not found), or null when there is no scan.
export async function findScanFields(w?: any,keys?: any,docType?: any){
  const pages=await workerScanPages(w);
  if(!pages||!keys.length) return null;
  // The fields' own page first: ספח pages for the address, else the front.
  const sefachFirst=keys.every((k?: any)=>SCAN_FIND_FIELDS[k].page==='sefach');
  const list=(sefachFirst?[...pages.others,pages.front]:[pages.front,...pages.others]).filter(Boolean).slice(0,4);
  const j=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'aiFindField',...gsAuth(),fields:keys,docType,
    images:list.map((p?: any)=>({image:p.b64,mediaType:p.mediaType}))})})).json();
  if(j&&j.error) console.warn('aiFindField failed: '+j.error);
  const found=(j&&j.ok&&j.found)||{};
  const out: any={}, zoom=new Map(); // page index -> zoom jobs
  for(const k of keys){
    const f=SCAN_FIND_FIELDS[k], hit=found[k]||{};
    out[k]={value:String(hit.value||'').trim(),unsure:false};
    const kind=docType==='passport'&&f.passportKind||f.kind;
    if(out[k].value&&kind&&hit.box&&list[hit.page]){
      if(!zoom.has(hit.page)) zoom.set(hit.page,[]);
      zoom.get(hit.page).push({field:k,kind,box:hit.box});
    }
  }
  const norm=(x?: any)=>String(x||'').replace(/[\s.\/-]/g,'').toUpperCase();
  await Promise.all([...zoom].map(async([pi,jobs]: any)=>{
    try{
      const vals=await verifierFor({b64:list[pi].b64,mediaType:list[pi].mediaType})(jobs);
      for(const jb of jobs){
        const z=String(vals[jb.field]||'').replace(/\s+/g,' ').trim();
        if(z){ out[jb.field].unsure=norm(z)!==norm(out[jb.field].value); out[jb.field].value=z; }
      }
    }catch(e: any){ console.error(e); }
  }));
  for(const k of keys){
    let v=out[k].value;
    if(k==='docId'&&docType!=='passport') v=normDigits(v);
    else if(k==='docId') v=v.replace(/\s/g,'').toUpperCase();
    if(k==='docDob') v=normDate(v)||v;
    if(k==='docSex') v=/^[mז]/i.test(v)?'M':/^[fנ]/i.test(v)?'F':'';
    if(k==='houseNumber') v=v.replace(/\s/g,'');
    out[k].value=v;
  }
  return out;
}
// "Scan again" from inside the worker window, without losing what is on the
// form: the window (React, src/manager/WorkerEditor.tsx) is kept as a draft
// (window.__wDraft) and the scanner opens over it — with this session's pages
// already in it when the window came from a scan still in memory (add, remove
// or re-cut a page there; only the changed pages are read again), otherwise
// as a new scan of this worker. When the reading finishes,
// openWorkerModalFromScan() (./scan.ts) opens the window again and
// applyWorkerDraft() puts the draft back: a field that had a value keeps it,
// an empty one takes the new scan's value.
export async function rescanFromWorkerModal(){
  window.__wDraft=island()?island()!.editorDraft():null;
  warmCloudFunctions(SCAN_WARM_URLS());
  const wid=editingWorkerId!==null&&workers.some((x?: any)=>x.id===editingWorkerId)?editingWorkerId:null;
  const sameSession=!!window.__aiScanImage&&(wid===null||window.__aiRescannedWorkerId===wid);
  window.__aiRescanWorkerId=wid;
  await openNewScan(sameSession);
}
function applyWorkerDraft(){ if(island()) island()!.applyDraft(); else window.__wDraft=null; }
// Second pass right after a scan: every field the scan left empty is searched
// for in one request (the window's own search, src/manager/WorkerEditor.tsx).
async function autoFindMissingScanFields(){ if(island()) await island()!.findMissing(); }

// The worker window (stage 6c-2) is drawn in React into #workerModal
// (src/manager/WorkerEditor.tsx); editingWorkerId says which worker it edits
// (null: a new one — the scan pipeline sets it too). It has no Save button: a
// tap outside saves it (saveWorker auto).
function showWorkerModal(w?: any){
  warmCloudFunctions([FORM101_FN_URL]); // saving builds the Form 101
  if(!island()) return;
  const wov=byId('workerOverlay');
  wov.__onUserClose=()=>saveWorker({auto:true});
  island()!.openEditor(w, editingWorkerId!==null&&workers.some((x?: any)=>x.id===editingWorkerId)?editingWorkerId:null);
  wov.classList.add('open');
}
// "New client login" / "New portal login" from an editor: the user form with
// the role and the client / supplier already set (the client window is saved
// first, as on a tap outside; closing the user form brings it back).
export function newLoginFor(role?: any, id?: any){
  if(role==='client') saveClient({auto:true}); else closeModal('supplierOverlay');
  openCreateUserForm({role, id});
}
// This month's commission payable to a supplier (the same figure as Accounting → Payable by supplier).
export function supplierMonthPayable(sp?: any){
  let payable=0;
  Object.values(salaryEntriesFor('month').byWorker||{}).forEach((e?: any)=>{ const wc=workers.find((w?: any)=>w.id===e.workerId); if(wc&&wc.supplierId===sp.id) payable+=supplierCommission(wc,e,sp.id); });
  return payable;
}
// The login rows a client / supplier window shows (the owner's users cache).
export function loginsInfo(role?: any, id?: any){
  const users=(loadAdminCache('users_'+activeTenantIdForAdmin())||[]).filter((u?: any)=>u.role===role&&id&&(role==='client'?u.clientId:u.supplierId)===id);
  return {logins:users.map((u?: any)=>({id:u.id, name:u.fullName||u.username||'', username:u.username||'', hourPerms:u.hourPerms, supplierSections:u.supplierSections, showPay:u.showPay, templateId:u.templateId||null})),
    canEdit:isFirmAdminSession(), hourLabels:HOUR_PERM_LABELS, hourDefault:HOUR_DEFAULT};
}

// The worker window saves itself when it is closed by a tap outside
// (opts.auto) — the save is the window's (src/manager/worker-save.ts). One
// save at a time.
let __saveWorkerBusy=false;
async function saveWorker(opts?: any){
  if(__saveWorkerBusy||!island()) return;
  __saveWorkerBusy=true;
  try{ return await island()!.saveWorker(opts||{}); } finally{ __saveWorkerBusy=false; }
}
// The window's progress while a new (or just rescanned) worker's Form 101 is
// built and uploaded (aiFillForm101 advances it at its two phases).
export function renderWorkerUploadProgress(label?: any,pct?: any){ if(island()) island()!.uploadProgress(label,pct); }

// Worker status: three pills in the worker card's header; a tap saves at once.
export function setWorkerStatus(wi?: any, v?: any){
  const w=workers[wi]; if(!w||(w.status||'active')===v) return;
  w.status=v;
  render(); autoSave();
  openWorkerCard(wi);
}

// A new punch-link token (the worker window's Access): the old link stops working.
export function regenerateWorkerToken(wid?: any){
  const w=workers.find((x?: any)=>x.id===wid); if(!w) return null;
  if(!confirm(tr('Create a new token? The old link will stop working.'))) return null;
  w.token = genToken();
  autoSave();
  showToast(tr('New token created — copy the link and send it again!'));
  return w.token;
}

export function buildPunchLink(w?: any){
  // Short, stable link — the punch page resolves the worker, client name and
  // geofence (lat/lng/radius) from the database by this token.
  return 'https://odinson.ltd/worker-punch.html?t='+w.token;
}
export function copyWorkerLink(wid?: any){
  const w = workers.find((x?: any)=>x.id===wid);
  if(!w||!w.token){ showToast(tr('No token — save worker first')); return; }
  const link = buildPunchLink(w);
  if(navigator.clipboard){
    navigator.clipboard.writeText(link).then(()=>showToast(tr('Link copied!'))).catch(()=>prompt(tr('Copy this link:'),link));
  } else {
    prompt(tr('Copy this link:'), link);
  }
}
// Removes the worker, then best-effort deletes their files (Form 101 PDF,
// the scan + signature sidecar, the contract / visa / permit files).
export function deleteWorkerNow(id?: any){
  const wi=workers.findIndex((x?: any)=>x.id===id); if(wi<0) return;
  const w=workers[wi];
  const docFileIds=(w.docs||[]).map((d?: any)=>d.fileId).filter(Boolean);
  workers.splice(wi,1);
  if(w.docFileId) gsDeleteWorkerDoc(w.docFileId);
  if(w.assetsFileId) gsDeleteWorkerDoc(w.assetsFileId);
  docFileIds.forEach(gsDeleteWorkerDoc);
}
