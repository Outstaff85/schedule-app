// The manager page's own script, part "workers": the worker plate and card entry points, worker documents, the hours import.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { normHoursDate, normHoursTime } from '../logic/dates';
import { byId } from './dom';
import { getPunchLog } from '../data/punches';
import { DOC_STORE, WORKER_DOC_TYPES, isActiveWorker, workerDocStatus, workerExpiryStatus } from '../logic/workers';
import { shiftOn } from '../logic/schedule';
import { loadSignRequests } from '../logic/signing';
import { contractValues, printHash } from '../logic/contract-values';
import { form101Payload } from '../logic/form101';
import { activeTenantProfile } from '../logic/admin';
import { askSign } from '../SignWindow';
import { loadXlsx, toMins } from '../logic/util';
import { hasPermission } from '../logic/access';
import { tr } from '../logic/i18n';
import { autoSave } from '../data/store';
import { API_URL } from '../data/api';
import { gsAuth } from '../data/session';
import { openEditWorker, rescanFromWorkerModal } from './worker-window';
import { loadFirmMessages, noPunchActs } from './header';
import { render } from './render';
import { showToast } from '../toast';
import { island } from '../bridge';
Object.defineProperties(window, {
  "todayPunchLog": {get: () => todayPunchLog, configurable: true},
  "workerToday": {get: () => workerToday, configurable: true},
  "workerSiteName": {get: () => workerSiteName, configurable: true},
  "workerNotices": {get: () => workerNotices, configurable: true},
  "workerBarColor": {get: () => workerBarColor, configurable: true},
  "openNotices": {get: () => openNotices, configurable: true},
  "renderWorkersPage": {get: () => renderWorkersPage, configurable: true},
  "openWorkerCard": {get: () => openWorkerCard, configurable: true},
  "openHoursImportModal": {get: () => openHoursImportModal, configurable: true},
  "parseHoursExcelFile": {get: () => parseHoursExcelFile, configurable: true},
  "renderClientsPage": {get: () => renderClientsPage, configurable: true},
  "renderSuppliersPage": {get: () => renderSuppliersPage, configurable: true},
});

// ── The worker plate (redesign stage 3, docs/workers.md → Workers tab) ──
// The full name, cut with … when it does not fit (.wp-n, og.css).
export function todayPunchLog(){ const t=new Date().toDateString(); return getPunchLog().filter((e?: any)=>new Date(e.ts).toDateString()===t); }
// A worker today: on vacation, the latest punch today (in / out and its time),
// "no punch" when today's shift started 15+ minutes ago with no punch, or nothing.
export function workerToday(w?: any, todayLog?: any){
  if(w.status==='vacation') return {k:'vac'};
  const le=latestOf((todayLog||[]).filter((e?: any)=>e.workerId===w.id));
  if(le) return {k:le.type==='in'?'in':'out', time:le.time||''};
  if(!isActiveWorker(w)) return {k:''};
  const now=new Date(), sh=shiftOn(w,now);
  if(sh && sh.type==='work' && sh.start && now.getHours()*60+now.getMinutes() >= toMins(sh.start)!+15) return {k:'none', sh};
  return {k:''};
}
export function workerSiteName(w?: any){ const c=(w.clientIds||[]).map((id?: any)=>clients.find((x?: any)=>x.id===id)).filter(Boolean)[0]; return c?c.name:''; }
// A worker's notices, urgent (red) first: a failed upload (Form 101, or the scanned contract), the ID / passport
// or a document (visa, permit, contract file) expired or expiring, missing
// documents, the contract ending, no punch on today's shift. Each has a short
// word (its chip), a title and a detail line (the notices sheet) and, with the
// rights for it, the action that fixes it.
/** The worker signed documents and what they print about the worker has changed since (docs/contracts.md → A new signature). */
export function signedChanged(w?: any): boolean {
  if(!w||!w.signedAt||!w.signedPrint) return false;
  const profile=activeTenantProfile();
  const f=form101Payload(w,w.docType!=='passport',profile);
  const v=contractValues(w,{profile,clients,suppliers,seePay:!!w.signedPrintPay});
  return printHash(f,v,w.signedPrintMarks||null,!!w.signedPrintPay)!==w.signedPrint;
}
export function workerNotices(w?: any, today?: any){
  const out: any=[], st=workerDocStatus(w), id=w.id, can=hasPermission('workers');
  const idx=()=>workers.findIndex((x?: any)=>x.id===id);
  const go=(fn?: any)=>()=>{ closeModal('noticesOverlay'); fn(); };
  const days=(d?: any)=>Math.max(0,Math.ceil((d-new Date().setHours(0,0,0,0))/864e5));
  const rescan=can?{label:tr('Upload'), icon:'ti-scan', fn:go(()=>rescanFromWorkerCard(idx()))}:null;
  const renew=can?{label:tr('Renew'), icon:'ti-refresh', fn:go(()=>openWorkerDocUpload(id))}:null;
  if(st.failed) out.push({lvl:'red', icon:'ti-cloud-off', word:tr('Upload failed'), title:tr('Upload failed'), detail:tr('Last upload to {0} failed',{0:DOC_STORE}), act:rescan});
  // the scanned contract could not be saved (saveScanContract): until a contract document is added
  if(w.contractUploadFailed) out.push({lvl:'red', icon:'ti-file-alert', word:tr('Contract'), title:tr('Contract not saved'), detail:tr('The scanned contract could not be saved — add it from Add document'),
    act:can?{label:tr('Add document'), icon:'ti-upload', fn:go(()=>openWorkerDocUpload(id))}:null});
  if(st.expiry){ const bad=st.expiry.level==='error'; out.push({lvl:bad?'red':'amber', icon:'ti-id', word:bad?tr('ID expired'):tr('ID {n}d',{n:days(st.expiry.date)}), title:tr('ID / Passport'), detail:st.expiry.text, act:rescan}); }
  st.docExpiries.forEach((x?: any)=>{ const bad=x.level==='error', label=tr(WORKER_DOC_TYPES[x.doc.type]||'Document');
    out.push({lvl:bad?'red':'amber', icon:'ti-id-badge-2', word:bad?tr('{0} expired',{0:label}):tr('{0} {n}d',{0:label,n:days(x.date)}), title:label, detail:x.text, act:renew}); });
  // only the signature missing: drawn in the worker window (Form 101 → its signature pad), not photographed
  const sigOnly=st.missing.length===1&&w.docHasSignature===false;
  if(st.missing.length) out.push({lvl:'amber', icon:'ti-file-alert', word:tr('Documents'), title:tr('Missing documents'), detail:st.missing.join(', '),
    act:sigOnly?(can?{label:tr('Sign'), icon:'ti-signature', fn:go(()=>openEditWorker(idx()))}:null):rescan});
  // D4: what the signed documents print about the worker changed — a new signature (the old documents stay until then)
  if(signedChanged(w)) out.push({lvl:'amber', icon:'ti-signature', word:tr('Documents changed'), title:tr('Documents changed — needs a new signature'),
    detail:tr('Signed {0}',{0:w.signDate||''}), act:can?{label:tr('Sign'), icon:'ti-signature', fn:go(()=>{ askSign(id); openWorkerCard(idx()); })}:null});
  const ex=workerExpiryStatus(w);
  if(ex) out.push({lvl:ex.level==='overdue'?'red':'amber', icon:'ti-file-certificate', word:tr('Contract'), title:ex.level==='overdue'?tr('Contract ended'):tr('Contract ending'), detail:ex.deadline.toLocaleDateString('en-GB'),
    act:can?(ex.doc?renew:{label:tr('Extend'), icon:'ti-calendar-plus', fn:go(()=>openEditWorker(idx()))}):null});
  if(today && today.k==='none') out.push({lvl:'red', icon:'ti-clock-off', word:tr('No punch'), title:tr('No punch on today\'s shift'), detail:today.sh?today.sh.start+'–'+(today.sh.end||''):'',
    acts:noPunchActs(w,today.sh)});
  return out.sort((a?: any,b?: any)=>(a.lvl==='red'?0:1)-(b.lvl==='red'?0:1));
}
// The plate's bar (and avatar) colour: red inactive or an urgent notice, amber
// on vacation or with a notice, green otherwise.
export function workerBarColor(w?: any, ns?: any){
  if(!isActiveWorker(w) || ns.some((n?: any)=>n.lvl==='red')) return 'var(--bad)';
  return (w.status==='vacation' || ns.length) ? 'var(--warn)' : 'var(--ok)';
}
// The Workers list is drawn in React (stage 6c-1, src/manager/Workers.tsx):
// the plates, the tabs, the search, the filters and Select live there.
export function setWorkersStatus(ids?: any, v?: any){
  ids.forEach((id?: any)=>{ const w=workers.find((x?: any)=>x.id===id); if(w) w.status=v; });
  render(); autoSave(); showToast(tr('Saved'));
}
// The notices sheet (stage 6c-2: drawn in React into #noticesModal,
// src/manager/worker-windows.tsx): who, a plate per notice with its action,
// and "Open worker card".
export function openNotices(wid?: any){
  if(!workers.some((x?: any)=>x.id===wid)||!island()) return;
  island()!.openNotices(wid);
  byId('noticesOverlay').classList.add('open');
  loadFirmMessages();
}
// ── Workers (stage 6c-1): the list is drawn in React — src/manager/Workers.tsx.
// The page keeps the data; the tab reads it through window.ManagerBridge.workers().
export function renderWorkersPage(){
  void loadSignRequests(); // Sent to sign / Signed, and the signed documents taken onto the workers (at most once a minute)
  if(island()) island()!.renderWorkers();
}

// The worker card (stage 6c-2): drawn in React into #workerCardModal
// (src/manager/WorkerCard.tsx). Coming back to it (a window opened from it
// was closed) draws it again from the current data, by id — nothing when the
// worker is gone; the open pane (Info / Docs / Hours) is kept.
export function openWorkerCard(wi?: any){
  const w=workers[wi]; if(!w||!island()) return;
  const ov=byId('workerCardOverlay');
  ov.__reopen=()=>{ const i=workers.findIndex((x?: any)=>x.id===w.id); if(i>=0) openWorkerCard(i); };
  island()!.openCard(w.id);
  ov.classList.add('open');
  // its Sent to sign / Signed chip from the server's requests, also when opened from another tab than Workers
  // (a signing done on the worker's own page, a date set there): read again when 10 s old
  void loadSignRequests(false, 10e3);
}

// The worker card's ✎: its edit form (closing it comes back to the card).
export function editFromWorkerCard(wid?: any){ closeModal('workerCardOverlay'); openEditWorker(workers.findIndex((x?: any)=>x.id===wid)); }
// From the worker card: opens this worker's modal and the scan over it, so
// the scan's result lands in the modal (empty fields filled, nothing typed
// lost) and saving rebuilds the Form 101 from the new photos.
export function rescanFromWorkerCard(wi?: any){
  closeModal('workerCardOverlay');
  openEditWorker(wi);
  rescanFromWorkerModal();
}

// --- Worker documents (contract / visa / work permit / other) -----------------
// Separate from the Form 101 scan: uploaded from Add document (React,
// src/manager/worker-windows.tsx), stored in Storage (saveWorkerFile ->
// tenants/<t>/workers/<id>/docs), listed on the worker card with their
// expiry. Expiry reminders flow through workerDocStatus() (badges, the
// "expiring" filter) and the Today tab's expiry cards.
export function openWorkerDocUpload(workerId?: any){
  if(!workers.some((x?: any)=>x.id===workerId)||!island()) return;
  island()!.openDocUpload(workerId);
  byId('workerDocOverlay').classList.add('open');
}

// --- Hours import (Admin/Roles plan, stage 14) ---------------------------------
// Upload PDF/photo/Excel with a worker's hours, tied to a client — parsed
// entries land in a server-side PENDING queue (savePendingHoursBatch), never
// straight into PunchLog/payroll. A human (tenant_admin/superadmin) must
// explicitly approve the batch (Accounting → Approvals → Pending hours,
// src/manager/Accounting.tsx) before it counts toward any salary calculation — this is the
// anti-fraud boundary the user explicitly asked for, which is also exactly
// why the supplier role never gets this button at all (see supplier-portal
// plan, stage 16) and the server itself rejects a supplier-role caller.
// The window is React (src/manager/worker-windows.tsx); the file reading
// below and the server calls are the page's (window.ManagerBridge).
export function openHoursImportModal(workerId?: any){
  if(!workers.some((x?: any)=>x.id===workerId)||!island()) return;
  island()!.openHoursImport(workerId);
  byId('hoursImportOverlay').classList.add('open');
}
// Fixed template: a header row containing Date and In, Out optional (or the same words in
// Russian), case-insensitive, in any column order. A spreadsheet's date cells come back as
// Dates (cellDates); a CSV is read as text (raw), so a day-first date is not taken as m/d.
// Every date goes through normHoursDate (logic/dates.ts) to dd/MM/yyyy, the punch log's
// form, and every time through normHoursTime to HH:MM; one that is not a date / time is kept
// as it is, and the window shows it in red and sends nothing. A row with no times is dropped.
export function parseHoursExcelFile(file?: any){
  return loadXlsx().then(()=>new Promise((resolve?: any,reject?: any)=>{
    const reader = new FileReader();
    reader.onerror = ()=>reject(new Error('read failed'));
    reader.onload = ()=>{
      try{
        const csv = /\.csv$/i.test(String(file&&file.name||''));
        const wb = XLSX.read(reader.result as any, csv?{type:'array', raw:true}:{type:'array', cellDates:true});
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
        if(!rows.length){ resolve([]); return; }
        const header = rows[0].map((h?: any)=>String(h||'').trim().toLowerCase());
        const dateIdx = header.findIndex((h?: any)=>['date','дата'].includes(h));
        const inIdx   = header.findIndex((h?: any)=>['in','вход'].includes(h));
        const outIdx  = header.findIndex((h?: any)=>['out','выход'].includes(h));
        if(dateIdx===-1||inIdx===-1){ reject(new Error('Expected Date/In(/Out) columns')); return; }
        const fmtDate = (v?: any)=>normHoursDate(v)||String(v==null?'':v).trim();
        const fmtTime = (v?: any)=>normHoursTime(v)||String(v==null?'':v).trim();
        const entries = rows.slice(1)
          .filter((r?: any)=>r[dateIdx]!=='' && r[dateIdx]!=null)
          .map((r?: any)=>({ date: fmtDate(r[dateIdx]), inTime: fmtTime(r[inIdx]), outTime: outIdx!==-1?fmtTime(r[outIdx]):'' }))
          .filter((e?: any)=>e.inTime||e.outTime); // a day with no times (a day off) is no shift
        resolve(entries);
      }catch(e: any){ reject(e); }
    };
    reader.readAsArrayBuffer(file);
  }));
}
// AI-vision path for a photographed/scanned timesheet (images only for now —
// a multi-page scan-PDF would need page rendering this feature doesn't do
// yet; a manager can screenshot/photograph each page instead as a practical
// workaround). Uses the same aiReadHoursTable backend action added alongside
// this stage; never writes anything itself — only returns entries for the
// caller to route through the approval queue below.
// One already-prepared page image ({b64,mediaType}) -> its shift entries.
export async function parseHoursImagePage(pg?: any){
  const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'aiReadHoursTable', ...gsAuth(), image:pg.b64, mediaType:pg.mediaType }) });
  const json = await res.json();
  if(json.error) throw new Error(json.error);
  const t=(v?: any)=>normHoursTime(v)||String(v==null?'':v).trim();
  return (json.entries||[]).map((e?: any)=>({...e, date: normHoursDate(e&&e.date)||String((e&&e.date)||'').trim(), inTime: t(e&&e.inTime), outTime: t(e&&e.outTime)}))
    .filter((e?: any)=>e.inTime||e.outTime);
}
// Detail-mode export for one worker (exportShiftsDetail): the month picker is
// React (src/manager/worker-windows.tsx).
export function openHoursExportModal(workerId?: any){
  if(!workers.some((x?: any)=>x.id===workerId)||!island()) return;
  island()!.openHoursExport(workerId);
  byId('hoursExportOverlay').classList.add('open');
}

// The Clients and Suppliers tabs (stage 6d): drawn in React — src/manager/
// Clients.tsx; the page keeps the data and the deletes.
export function renderClientsPage(){ if(island()) island()!.renderClients(); }
export function renderSuppliersPage(){ if(island()) island()!.renderSuppliers(); }
