// The manager page's own script, part "bridge": window.ManagerBridge — the data and actions the React pieces read and run — and the tabs' draw calls.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { decideShiftRequest, filterByClient, loadShiftRequests, pruneDateShifts, shiftOn, workerTotalHours } from '../logic/schedule';
import { currentDict, currentLang, tr, uiLocale } from '../logic/i18n';
import { ALL_PUNCHES_FROM, ensureAllPunches, ensurePunchesSince, getPunchLog, periodPunchStart, punchWindowStart, savePunchLog, syncPunchesFromGS } from '../data/punches';
import { WORKER_DOC_TYPES, isActiveWorker, workerDocExpiryMap, workerDocId, workerDocStatus, workerExpiryStatus } from '../logic/workers';
import { docIdKey } from '../worker';
import { canChange, hasEditPay, hasPermission, hrPayOnly, isAccTab, isFirmAdminSession, isHrSession, staffPayEdit } from '../logic/access';
import { isDailyPay, localYMD, salaryPeriodKey, wOwnRate } from '../logic/pay';
import { getSundayOfWeek, loadXlsx } from '../logic/util';
import { csvText } from '../../lib/utils';
import { hasBillRate } from '../accounting';
import { editedPunchTs, punchDate } from '../logic/punches';
import { autoSave, latestHoursBatch } from '../data/store';
import { fsTenantId, getSession, gsAuth } from '../data/session';
import { activeTenantIdForAdmin, activeTenantProfile, adminPanes, assignWorkersToHr, assignWorkersToSupplier, firmProfileMissing, firmsPayableRows, hrColor, loadAdminCache, loadFirmsCache } from '../logic/admin';
import { API_URL, gsDeletePunch, gsDeleteWorkerDoc, gsUpdatePunch, loadFirestoreBackend, uploadWorkerFile } from '../data/api';
import { exportExcel, exportJSON, exportPDF, exportShiftsDetail } from '../logic/exports';
import { genToken } from '../data/ids';
import { fileForStorage, fileToUploadPages } from '../logic/uploads';
import { reportError } from '../data/telemetry';
import { bellAct, bellItems, loadFirmMessages, markAllNotifRead, openNotif, renderGreeting, saveFirmMessage, toggleBell, waTemplate } from './header';
import { editFromWorkerCard, openHoursExportModal, openHoursImportModal, openNotices, openWorkerCard, openWorkerDocUpload, parseHoursExcelFile, parseHoursImagePage, renderClientsPage, renderSuppliersPage, renderWorkersPage, rescanFromWorkerCard, setWorkersStatus, todayPunchLog, workerBarColor, workerNotices, workerSiteName, workerToday } from './workers';
import { portalInfo, switchTab } from './nav';
import { buildPunchLink, copyWorkerLink, deleteWorkerNow, findScanFields, openAddWorker, openEditWorker, regenerateWorkerToken, rescanFromWorkerModal, setWorkerStatus, supplierMonthPayable, workerHasScanPages, workerScanLive } from './worker-window';
import { render } from './render';
import { setLanguage } from './language';
import { closeEditorUnsaved, commitClient, deleteClientsNow, openAddClient, openEditClient, openMapPicker, punchFromClientModal, workersMonthHours } from './clients';
import { addManualPunch, commitSupplier, deleteSuppliersNow, openAddSupplier, openEditSupplier, openManualPunch } from './suppliers';
import { __adminPane, __firmWin, __firmsCache, __firmsErr, __logPeriod, __usersErr, adminTeam, deleteTenantsNow, deleteUsersNow, firmSaved, firmsRows, hrNameOf, hrUsers, loadFirms, loadLogPane, logPaneSnapshot, openCreateFirmForm, openCreateUserForm, openEditFirmForm, openEditUserForm, openMyFirmForm, prefetchAdminUsers, resetLogs, setTenantsActive, switchAdminPane, userSaved } from './admin';
import { closeModal } from './windows';
import { logout, pingLogin, signIn, switchToTenant } from './wiring';
import { cacheTenantProfile, editMyName, setTheme } from './gate';
import { showToast } from '../toast';
import { scanDocument } from '../../scan-process/session';
import { sendScanDocument } from '../../scan/server';
import { bridge, island, provideBridge } from '../bridge';
import { canSeePay, canSetSignDate } from '../logic/access';
import { contractValues } from '../logic/contract-values';
import { form101Payload } from '../logic/form101';
import { loadSignRequests, signRequestOf } from '../logic/signing';
import { workerDocsCall } from '../logic/workerdocs';
import { openPdfBlob } from '../contracts';
// The WhatsApp text of "Documents to sign" (owner 2026-10-27): in the sender's language — the worker's full
// name, the ID or passport number, what to do, then the link to the worker's personal account.
function signMessage(w?: any,link?: any){
  const id=String(w.docId||'').trim();
  return [String(w.name||'').trim(),
    id?(w.docType==='passport'?tr('Passport: {0}',{0:id}):tr('ID: {0}',{0:id})):'',
    tr('You have documents to sign. Open your personal account at the link, read them and sign at the bottom.'),
    link].filter(Boolean).join('\n');
}
import { refreshTenantProfile } from './admin';
Object.defineProperties(window, {
  "renderDashboard": {get: () => renderDashboard, configurable: true},
  "renderSchedulePage": {get: () => renderSchedulePage, configurable: true},
  "accPeriod": {get: () => accPeriod, set: (v?: any) => { accPeriod = v; }, configurable: true},
  "__accOpenSeq": {get: () => __accOpenSeq, set: (v?: any) => { __accOpenSeq = v; }, configurable: true},
  "accData": {get: () => accData, configurable: true},
  "salaryEntriesFor": {get: () => salaryEntriesFor, configurable: true},
  "commissionFor": {get: () => commissionFor, configurable: true},
  "supplierCommission": {get: () => supplierCommission, configurable: true},
  "hourApprovalSummary": {get: () => hourApprovalSummary, configurable: true},
  "renderAccounting": {get: () => renderAccounting, configurable: true},
  "setAccTab": {get: () => setAccTab, configurable: true},
  "__hourApprovalsCache": {get: () => __hourApprovalsCache, set: (v?: any) => { __hourApprovalsCache = v; }, configurable: true},
  "hourApprovalsOf": {get: () => hourApprovalsOf, configurable: true},
  "rejectHoursBatch": {get: () => rejectHoursBatch, configurable: true},
  "canEditPay": {get: () => canEditPay, configurable: true},
  "openPayModal": {get: () => openPayModal, configurable: true},
  "latestOf": {get: () => latestOf, configurable: true},
  "renderAdmin": {get: () => renderAdmin, configurable: true},
  "exportPunchCSV": {get: () => exportPunchCSV, configurable: true},
});

// ── Odinson Glass list pieces (docs/redesign.md → Plates) ──
// ── Today (stage 6a): drawn in React — src/manager/Today.tsx, loaded as
// the React pieces (docs/build.md → The manager's React pieces). The page
// hands it its data and actions through window.ManagerBridge; renderDashboard() asks
// it to draw (render() and switchTab() call it as before).
function renderDashboard(){
  renderGreeting();
  if(island()) island()!.renderToday();
}
// ── Schedule (stage 6b): drawn in React — src/manager/Schedule.tsx. The week
// (weekStart), the site filter (selectedClientId)
// and the data stay here; the tab reads them through window.ManagerBridge.schedule()
// and writes through its actions below. Opening it reads the workers'
// requests (at most once a minute).
function renderSchedulePage(){
  loadShiftRequests();
  if(island()) island()!.renderSchedule();
}
window.addEventListener('manager-island-ready', () => { if(currentTab==='dashboard') renderDashboard(); if(currentTab==='schedule') renderSchedulePage(); if(currentTab==='workers') renderWorkersPage(); if(currentTab==='clients') renderClientsPage(); if(currentTab==='suppliers') renderSuppliersPage(); if(isAccTab(currentTab)) renderAccounting(); if(currentTab==='admin') renderAdmin(); if(byId('firmsScreen').style.display==='block') island()!.renderFirmsScreen(); });
provideBridge({
  lang:()=>currentLang(),
  dict:()=>currentDict(),
  // ── The frame (stage 8e-1, src/manager/Frame.tsx) ──
  switchTab:(tab?: any)=>switchTab(tab),
  toggleBell:(e?: any)=>toggleBell(e),
  editMyName:()=>{ editMyName(); },
  installApp:()=>{ window.installApp(); },
  signOut:()=>logout(),
  saveTheme:(t?: any)=>setTheme(t),
  portal:()=>portalInfo(),
  setLanguage:(l?: any)=>{ setLanguage(l); },
  bellItems:()=>bellItems(),
  openNotif:(id?: any)=>openNotif(id),
  bellAct:(id?: any,k?: any)=>bellAct(id,k),
  markAllNotifRead:()=>markAllNotifRead(),
  signIn:(u?: any,p?: any)=>signIn(u,p),
  pingLogin:()=>pingLogin(),
  // The snapshot Today draws from: each worker with today's shift, today's punch
  // and its notices (worked out here — they still belong to the Workers tab),
  // the suppliers, today's punches with their site, and the last 24 hours'
  // (who is on shift and today's hours: a night shift opened before midnight).
  today(){
    const now=new Date(), t=now.toDateString(), all=getPunchLog(), log=all.filter((e?: any)=>new Date(e.ts).toDateString()===t);
    const since=now.getTime()-24*36e5, recent=all.filter((e?: any)=>new Date(e.ts).getTime()>=since);
    return {
      ready:__dataReady,
      workers:workers.map((w?: any)=>{ const td=workerToday(w,log), sh=shiftOn(w,now);
        return {id:w.id, name:w.name||'', active:isActiveWorker(w), supplierId:w.supplierId||'', site:workerSiteName(w),
          shift:sh?{type:sh.type, start:sh.start||'', end:sh.end||''}:null, today:{k:td.k, time:td.time||''},
          notices:workerNotices(w,td).map((n?: any)=>({lvl:n.lvl, word:n.word, title:n.title}))}; }),
      suppliers:suppliers.map((x?: any)=>({id:x.id, name:x.name||'', color:x.color||''})),
      log:log.map((e?: any)=>({...e, site:punchSite(e)})),
      recent:recent as any[],
      canAddWorker:hasPermission('workers')&&canChange('editWorkers'),
    };
  },
  openWorker:(id?: any)=>openWorkerCardById(id),
  openNotices:(id?: any)=>openNotices(id),
  openSuppliers:()=>switchTab('suppliers'),
  addWorker:()=>{ switchTab('workers'); openAddWorker(); },
  refresh:async()=>{ try{ await syncPunchesFromGS(); }catch(e: any){} render(); },
  // The Schedule tab's snapshot: the shown week, the site filter, the active
  // workers' roster and one-date changes, the sites, the workers' requests.
  schedule(){
    const off={type:'off',start:null,end:null};
    return {
      ready:__dataReady, weekStart:localYMD(weekStart), clientId:selectedClientId||null,
      workers:workers.filter(isActiveWorker).map((w?: any)=>({id:w.id, name:w.name||'', status:w.status||'active', clientIds:w.clientIds||[], site:workerSiteName(w),
        schedule:[0,1,2,3,4,5,6].map((i?: any)=>(w.schedule||[])[i]||off), dateShifts:w.dateShifts||{}})),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||''})),
      requests:__shiftReqs,
      canEdit:hasPermission('schedule')&&canChange('editSchedule'), canExport:hasPermission('exports'), canAddWorker:hasPermission('workers')&&canChange('editWorkers'),
    };
  },
  setWeek:(ymd?: any)=>{ weekStart=getSundayOfWeek(new Date(ymd+'T00:00')); render(); },
  setClient:(id?: any)=>filterByClient(id||null),
  // "Every <weekday>" writes the roster and drops a change of that date; "Only <date>" writes w.dateShifts.
  setShift(wid?: any,ymd?: any,scope?: any,sh?: any){
    const w=workers.find((x?: any)=>x.id===wid); if(!w) return;
    const di=new Date(ymd+'T00:00').getDay(), v={type:sh.type, start:sh.type==='work'?sh.start:null, end:sh.type==='work'?sh.end:null};
    if(scope==='date') w.dateShifts=pruneDateShifts(Object.assign({}, w.dateShifts, {[ymd]:v}));
    else {
      w.schedule=[0,1,2,3,4,5,6].map((i?: any)=>(w.schedule||[])[i]||{type:'off',start:null,end:null}); w.schedule[di]=v;
      if(w.dateShifts && w.dateShifts[ymd]){ const d=Object.assign({}, w.dateShifts); delete d[ymd]; w.dateShifts=pruneDateShifts(d); }
    }
    render(); autoSave(); showToast(tr('Shift saved'));
  },
  // One-date changes (Copy last week, Repeat for N weeks, their Undo, Back to the weekly schedule): shift null drops the change.
  applyDated(changes?: any){
    changes.forEach((c?: any)=>{ const w=workers.find((x?: any)=>x.id===c.workerId); if(!w) return;
      const d=Object.assign({}, w.dateShifts);
      if(c.shift) d[c.date]={type:c.shift.type, start:c.shift.start||null, end:c.shift.end||null}; else delete d[c.date];
      w.dateShifts=pruneDateShifts(d); });
    render(); autoSave();
  },
  decideRequest:(id?: any,ok?: any)=>decideShiftRequest(id,ok),
  moveWorker(fromId?: any,toId?: any){
    const from=workers.findIndex((w?: any)=>w.id===fromId); if(from<0||fromId===toId) return;
    const moved=workers.splice(from,1)[0], to=workers.findIndex((w?: any)=>w.id===toId);
    workers.splice(to<0?workers.length:to,0,moved);
    render(); autoSave(); showToast(tr('Order updated'));
  },
  // the worker window edits: only with the Workers tab and editWorkers (as the card's ✎ and the Workers list)
  editWorker:(id?: any)=>{ if(!(hasPermission('workers')&&canChange('editWorkers'))) return; const i=workers.findIndex((w?: any)=>w.id===id); if(i>=0) openEditWorker(i); },
  // The Workers tab's snapshot (stage 6c-1): every worker's list fields, with
  // today's punch, its notices, the month's hours and the document status
  // worked out here (the card and the window that use them are still here).
  workers(){
    const now=new Date(), t=now.toDateString(), log=getPunchLog().filter((e?: any)=>new Date(e.ts).toDateString()===t), hours=workersMonthHours();
    return {
      ready:__dataReady,
      workers:workers.map((w?: any)=>{ const td=workerToday(w,log), st=workerDocStatus(w), ex=workerExpiryStatus(w);
        const badge=st.level==='ok'?'':st.failed?tr('UPLOAD FAILED'):(st.expiry&&st.expiry.level==='error')?tr('ID EXPIRED')
          :st.docExpired?tr('{0} EXPIRED',{0:tr(WORKER_DOC_TYPES[st.docExpired.doc.type]||'Document').toUpperCase()}):tr('DOCS');
        return {id:w.id, name:w.name||'', docGiven:w.docGiven||'', docSurname:w.docSurname||'', phone:w.phone||'', docId:String(workerDocId(w)||''),
          status:w.status==='vacation'||w.status==='fired'?w.status:'active', clientIds:w.clientIds||[], supplierId:w.supplierId||'', startDate:w.startDate||'',
          createdAt:w.createdAt||'', docUrl:w.docUrl||'', site:workerSiteName(w), today:{k:td.k, time:td.time||''},
          notices:workerNotices(w,td).map((n?: any)=>({lvl:n.lvl, word:n.word, title:n.title})), monthHours:hours[w.id]||0,
          docLevel:st.level, docLines:st.lines, docBadge:badge, docExpiring:!!st.expiry||st.docExpiries.length>0,
          contract:ex?{overdue:ex.level==='overdue', deadline:ex.deadline.toLocaleDateString('en-GB')}:null, canPay:!!canEditPay(w)}; }),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||'', object:c.object||''})),
      suppliers:suppliers.map((x?: any)=>({id:x.id, name:x.name||'', color:x.color||''})),
      canEdit:hasPermission('workers')&&canChange('editWorkers'),
    };
  },
  scanNew:()=>startNewScan(),
  openPay:(id?: any)=>openPayModal(id),
  copyLink:(id?: any)=>copyWorkerLink(id),
  setStatus:(ids?: any,v?: any)=>setWorkersStatus(ids,v),
  deleteWorkers(ids?: any){
    const one=ids.length===1?workers.find((x?: any)=>x.id===ids[0]):null;
    ids.forEach((id?: any)=>deleteWorkerNow(id)); render(); autoSave({allowEmpty:true}); // the last worker too
    showToast(one?tr('{0} removed',{0:one.name}):tr('{0} workers{1}',{0:ids.length,1:''}));
  },
  // ── Clients and Suppliers (stage 6d): the tabs and their windows are React;
  // the records, the figures (salaryEntriesFor, workersMonthHours), the map
  // picker, the logins and the saves stay here.
  clients(){
    const byClient=salaryEntriesFor('month').byClient||{};
    const waiting=new Set((__hoursBatches||[]).filter((b?: any)=>b.status==='pending').flatMap((b?: any)=>(b.entries||[]).map((e?: any)=>e.clientId)));
    return {ready:__dataReady, canEdit:hasPermission('clients'), canPunch:canChange('editPunches'),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||'', address:c.address||'', object:c.object||'',
        workers:workers.filter((w?: any)=>isActiveWorker(w)&&(w.clientIds||[]).includes(c.id)).length, monthHours:(byClient[c.id]||{}).hours||0,
        noRate:!hasBillRate(c), waiting:waiting.has(c.id)}))};
  },
  suppliers(){
    const hours=workersMonthHours();
    return {ready:__dataReady, canEdit:hasPermission('suppliers'),
      suppliers:suppliers.map((s?: any)=>{ const mine=workers.filter((w?: any)=>w.supplierId===s.id);
        return {id:s.id, name:s.name||'', color:s.color||'', phone:s.phone||'', workers:mine.length, monthHours:mine.reduce((t?: any,w?: any)=>t+(hours[w.id]||0),0)}; })};
  },
  openClient:(id?: any)=>{ if(id) openEditClient(id); else openAddClient(); },
  openSupplier:(id?: any)=>{ if(id) openEditSupplier(id); else openAddSupplier(); },
  manualPunch:(id?: any)=>openManualPunch(id),
  deleteClients:(ids?: any)=>deleteClientsNow(ids.filter((id?: any)=>clients.some((c?: any)=>c.id===id))),
  deleteSuppliers:(ids?: any)=>deleteSuppliersNow(ids.filter((id?: any)=>suppliers.some((s?: any)=>s.id===id))),
  clientInfo(id?: any){
    const c=id?clients.find((x?: any)=>x.id===id):null, e: any=c?((salaryEntriesFor('month').byClient||{})[c.id]||{}):{};
    return {
      workers:c?workers.filter((w?: any)=>isActiveWorker(w)&&(w.clientIds||[]).includes(c.id)).length:0, monthHours:e.hours||0, billed:e.total||0,
      waiting:c?(__hoursBatches||[]).filter((b?: any)=>b.status==='pending'&&(b.entries||[]).some((x?: any)=>x.clientId===c.id)).length:0,
      canDelete:hasPermission('clients'), canPay:hasEditPay(), otMult:PAY_RULES.otMult, shabbatMult:PAY_RULES.shabbatMult};
  },
  supplierInfo(id?: any){
    const sp=id?suppliers.find((x?: any)=>x.id===id):null, hours=workersMonthHours();
    return {
      workers:sp?workers.filter((w?: any)=>w.supplierId===sp.id).map((w?: any)=>({id:w.id, name:w.name||'', active:isActiveWorker(w), hours:hours[w.id]||0})):[],
      payable:sp?supplierMonthPayable(sp):0, canRate:isFirmAdminSession(), canDelete:hasPermission('suppliers'), defaultRate:window.ManagerAcc!.SUPPLIER_DEFAULT_RATE};
  },
  commitClient:(id?: any,fields?: any)=>commitClient(id,fields),
  commitSupplier:(id?: any,fields?: any)=>commitSupplier(id,fields),
  punchFromClient:()=>punchFromClientModal(),
  deleteFromEditor:(kind?: any)=>closeEditorUnsaved(kind==='client'?'clientOverlay':'supplierOverlay'),
  pickPlace:(start?: any,onPick?: any)=>openMapPicker(start,onPick),
  punchInfo(cid?: any){
    const c=clients.find((x?: any)=>x.id===cid); if(!c) return null;
    const mine=workers.filter((w?: any)=>isActiveWorker(w)&&(w.clientIds||[]).includes(cid));
    return {client:{id:c.id, name:c.name||''}, workers:(mine.length?mine:workers.filter(isActiveWorker)).map((w?: any)=>({id:w.id, name:w.name||''}))};
  },
  addPunch:(entry?: any)=>addManualPunch(entry),
  // ── Accounting (stage 6e): the tab and the pay window are React; the
  // period, the data, the server calls and the saves stay here.
  accounting(){
    const s=(getSession()||{} as any), payOnly=hrPayOnly(), firmAdmin=isFirmAdminSession();
    const batches=(__hoursBatches||[]);
    return {
      ready:__dataReady, period:accPeriod, locale:uiLocale(), payOnly,
      me:{uid:s.uid||'', commissionRate:Number(s.commissionRate)||0, commissionDayRate:Number(s.commissionDayRate)||0},
      canExport:hasPermission('exports'), canApprove:firmAdmin, canEditPunches:canChange('editPunches'),
      canPay:Object.fromEntries(workers.map((w?: any)=>[w.id, !!canEditPay(w)])),
      hrUsers:firmAdmin?hrUsers():[],
      waiting:batches.filter((b?: any)=>b.status==='pending').length, batchesKey:batches.map((b?: any)=>(b.id||b.batchId)+':'+b.status).join(),
      openSeq:__accOpenSeq, firmName:(activeTenantProfile()||{}).companyName||'',
    };
  },
  accData:()=>accData(),
  setPeriod:async (p?: any)=>{ await ensurePunchesSince(periodPunchStart(p)); accPeriod=p; renderAccounting(); },
  ensurePeriod:async (p?: any)=>{ await ensurePunchesSince(periodPunchStart(p)); },
  openClientWindow:(id?: any)=>openEditClient(id),
  hourApprovals:async(month?: any,fresh?: any)=>{ const docs=await hourApprovalsOf(month,fresh); if(__punchSynced) await __punchSynced.catch(()=>{}); return docs; },
  resolveFix:async(docId?: any,key?: any,accept?: any)=>{ const r=await hoursCall({action:'resolve', docId, key, accept, tenantId:fsTenantId()}); __hourApprovalsCache=null; return r.error||''; },
  openSigned:(path?: any)=>openSignedHours(path),
  approveBatch:(id?: any)=>approveHoursBatch(id),
  rejectBatches:(ids?: any)=>ids.length===1?rejectHoursBatch(ids[0]):bulkHoursBatches(ids,false),
  hoursCall:(body?: any)=>hoursCall(body),
  xlsx:async()=>{ try{ await loadXlsx(); return window.XLSX||null; }catch(e: any){ return null; } },
  payInfo(id?: any){ const w=workers.find((x?: any)=>x.id===id); if(!payWindowAllowed(w)) return null; return {w:JSON.parse(JSON.stringify(w)), ro:!canEditPay(w), period:accPeriod}; },
  savePay(id?: any,patch?: any){
    const w=workers.find((x?: any)=>x.id===id); if(!w || !canEditPay(w)) return;
    Object.entries(patch).forEach(([k,v]: any)=>{ if(v===undefined) delete w[k]; else w[k]=v; });
    autoSave(); closeModal('payOverlay');
    showToast(tr('Pay saved — {name}',{name:w.name||''}));
    render();
  },
  clearDays(id?: any,period?: any){
    const w=workers.find((x?: any)=>x.id===id); if(!w || !canEditPay(w) || !w.dayOverrides) return;
    const ov={...w.dayOverrides}; delete ov[salaryPeriodKey(period)];
    if(Object.keys(ov).length) w.dayOverrides=ov; else delete w.dayOverrides;
    autoSave(); render();
  },
  // ── Admin (stage 6f-1): the section tabs, the tiles and the Punch Log are
  // React; the punches, their saves and the server calls stay here.
  admin(){
    const s=(getSession()||{} as any), isAdminRole=s.role==='superadmin'||s.role==='tenant_admin', from=__punchLoadedFrom;
    return {
      ready:__dataReady, pane:__adminPane, panes:adminPanes(), canClear:isAdminRole, canEditPunches:canChange('editPunches'),
      firmIncomplete:isAdminRole&&firmProfileMissing().length>0,
      log:__adminPane==='punchlog'?bridge().punchLog():[],
      workers:workers.map((w?: any)=>({id:w.id, name:w.name||'', clientIds:w.clientIds||[]})),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||'', address:c.address||''})),
      loadedFrom:from&&from>ALL_PUNCHES_FROM?from.toLocaleDateString('en-GB'):null,
      // stage 6f-2
      isSuper:s.role==='superadmin', locale:uiLocale(),
      firms:firmsRows(), firmsError:__firmsErr,
      own:s.role==='superadmin'?null:{...(activeTenantProfile()||{}), missing:firmProfileMissing()},
      users:__adminPane==='users'?(()=>{ const c=loadAdminCache('users_'+activeTenantIdForAdmin()); return Array.isArray(c)?c:null; })():null,
      usersError:__usersErr,
      team:adminTeam(),
      suppliers:suppliers.map((x?: any)=>({id:x.id, name:x.name||''})),
      logs:__adminPane==='errors'||__adminPane==='timings'?logPaneSnapshot(__adminPane):null,
      firmNames:Object.fromEntries(((__firmsCache&&__firmsCache.length)?__firmsCache:(loadFirmsCache()||[])).map((t?: any)=>[t.tenantId, t.companyName||t.tenantId])),
    };
  },
  setAdminPane:(p?: any)=>switchAdminPane(p),
  punchLog:()=>getPunchLog().map((e?: any)=>({...e, id:e.id, site:punchSite(e), rawSite:e.site||''})),
  loadEarlierPunches:()=>loadEarlierPunchMonth(),
  // Whether the whole history came in: Clear Log and the export stop when it did not
  // (ensurePunchesSince has said why), so a file never holds only part of it.
  loadAllPunches:()=>ensureAllPunches().then((ok?: any)=>{ renderAdmin(); return !!ok; }),
  exportPunches:()=>ensureAllPunches().then((ok?: any)=>{ if(ok) exportPunchCSV(); }),
  clearPunchMonths:(months?: any)=>clearPunchMonths(months),
  savePunch:(id?: any,ed?: any)=>savePunchEdit(id,ed),
  deletePunches:(ids?: any)=>deletePunchesNow(ids.map(String)),
  // ── Admin (stage 6f-2): Firms, Users, Errors, Timings and the landing
  // screen's firms are React; the data, the saves and the calls stay here.
  adminCall:async (body?: any)=>{
    try{ return (await (await fetch(API_URL,{method:'POST', body:JSON.stringify({...body, ...gsAuth()})})).json())||{}; }
    catch(e: any){ return {error:'Network error'}; }
  },
  loadFirms:()=>loadFirms(),
  openFirm:(id?: any)=>switchToTenant(id),
  setFirmsActive:(ids?: any,active?: any)=>setTenantsActive(ids,active),
  deleteFirms:(ids?: any)=>deleteTenantsNow(ids),
  openFirmWindow:(mode?: any,id?: any)=>{ if(mode==='create') openCreateFirmForm(); else if(mode==='mine') openMyFirmForm(); else openEditFirmForm(id); },
  firmsPayable:()=>firmsPayableRows(__firmsCache),
  loadUsers:()=>prefetchAdminUsers(),
  openUserWindow:(id?: any)=>{ if(id) openEditUserForm(id); else openCreateUserForm(); },
  deleteUsers:(ids?: any)=>deleteUsersNow(ids),
  setLogPeriod:(kind?: any,v?: any)=>{ __logPeriod[kind]=v; renderAdmin(); loadLogPane(kind); },
  reloadLog:(kind?: any)=>loadLogPane(kind),
  resetLogs:()=>resetLogs(),
  copyText:(t?: any)=>{ copyTextToClipboard(t); },
  firmInfo:()=>__firmWin,
  loadProfile:async()=>{
    try{
      const json=await (await fetch(API_URL,{method:'POST', body:JSON.stringify({action:'loadTenantProfile', ...gsAuth()})})).json();
      if(json&&json.profile&&__firmWin){ cacheTenantProfile(__firmWin.tenantId, json.profile); return json.profile; }
    }catch(e: any){}
    return null;
  },
  firmMessage:async()=>{ await loadFirmMessages(true); return waTemplate(); },
  saveFirmMessage:(t?: any,text?: any)=>saveFirmMessage(t,text),
  firmSaved:(mode?: any,id?: any,profile?: any)=>firmSaved(mode,id,profile),
  userInfo:()=>{ const hrNames: any={}; hrUsers().forEach((u?: any)=>{ hrNames[u.id]=u.fullName||u.username||''; });
    return {workers:adminTeam(), suppliers:suppliers.map((x?: any)=>({id:x.id, name:x.name||''})),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', object:c.object||''})), hrNames}; },
  hrMonthCommission:(uid?: any,rate?: any,dayRate?: any)=>Object.values((salaryEntriesFor('month').byWorker)||{}).reduce((t?: any,e?: any)=>{ const wc=workers.find((w?: any)=>w.id===e.workerId); return wc&&wc.hrId===uid?t+commissionFor(wc,e,rate,dayRate):t; },0),
  assignWorkers:async(kind?: any,ids?: any,key?: any)=>{ const n=kind==='supplier'?assignWorkersToSupplier(ids,key):await assignWorkersToHr(ids,key); prefetchAdminUsers(); return n; },
  openAssign:(team?: any)=>{ if(!island()) return; island()!.openAssign(team); byId('hrAssignOverlay').classList.add('open'); },
  userSaved:(id?: any,orig?: any,role?: any,name?: any)=>userSaved(id,orig,role,name),
  exportAs:(k?: any)=>{ ({excel:exportExcel, pdf:exportPDF, json:exportJSON} as Record<string, () => void>)[k](); },
  toast:(t?: any,ms?: any)=>showToast(t,ms),

  // ── The worker card, the worker window, documents and hours (stage 6c-2):
  // drawn in React into the page's overlays; the data and the uploads stay here.
  record:(id?: any)=>{ const w=workers.find((x?: any)=>x.id===id); return w?JSON.parse(JSON.stringify(w)):null; },
  card(id?: any){
    const w=workers.find((x?: any)=>x.id===id); if(!w) return null;
    const head=workerHeadOf(w), st=workerDocStatus(w), ex=workerExpiryStatus(w), sh=shiftOn(w,new Date()), b=latestHoursBatch(w.id);
    const sup=suppliers.find((s?: any)=>s.id===w.supplierId);
    return {...head, w:JSON.parse(JSON.stringify(w)), canEdit:hasPermission('workers')&&canChange('editWorkers'), canPay:!!canEditPay(w), canExport:hasPermission('exports'),
      isFirmAdmin:isFirmAdminSession(), hr:w.hrId?{name:hrNameOf(w.hrId)||(w.hrId===(getSession()||{} as any).uid?String((getSession() as any).fullName||(getSession() as any).username||''):''), color:hrColor(w.hrId)}:null,
      clients:(w.clientIds||[]).map((cid?: any)=>clients.find((x?: any)=>x.id===cid)).filter(Boolean).map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||''})),
      supplier:sup?{name:sup.name||'', color:sup.color||''}:null,
      shiftToday:sh&&sh.type==='work'&&sh.start?{start:sh.start, end:sh.end||''}:null,
      contract:ex?{overdue:ex.level==='overdue', deadline:ex.deadline.toLocaleDateString('en-GB')}:null,
      weekHours:workerTotalHours(w), docLevel:st.level, docLines:st.lines, docExpiry:workerDocExpiryMap(w),
      hoursBatch:b?{status:b.status, when:(b.status==='pending'?b.uploadedAt:b.decidedAt)||''}:null};
  },
  notices:(id?: any)=>{ const w=workers.find((x?: any)=>x.id===id); return w?workerHeadOf(w):null; },
  editorInfo(w?: any,editId?: any){
    const rec=editId?workers.find((x?: any)=>x.id===editId):null, st=workerDocStatus(rec||w);
    return {...(rec?workerHeadOf(rec):{name:w.name||'', color:'var(--neutral)', site:'', today:{k:''}, monthHours:0, notices:[]}),
      clients:clients.map((c?: any)=>({id:c.id, name:c.name||'', color:c.color||'', object:c.object||'', lat:c.lat, lng:c.lng, radius:c.radius})),
      suppliers:suppliers.map((x?: any)=>({id:x.id, name:x.name||''})),
      isFirmAdmin:isFirmAdminSession(), hrUsers:isFirmAdminSession()?hrUsers().map((u?: any)=>({id:u.id, name:u.fullName||u.username})):[],
      hasScan:workerHasScanPages(rec||null),
      liveOthers:workerScanLive(rec||null)?(window.__aiPacketOtherPages||[]).filter((x?: any)=>x&&x.b64).length:null,
      docLevel:st.level, docLines:st.lines, docMissing:st.missing, docIdMissing:st.idMissing, docF101Missing:st.f101Missing, docFailed:st.failed,
      docExpiryText:st.expiry?st.expiry.text:'', docExpiryLevel:st.expiry?st.expiry.level:null,
      docProblems:st.missing.length+(st.expiry?1:0)+st.docExpiries.length+(st.failed?1:0), docExpiry:workerDocExpiryMap(rec||w),
      punchLink:buildPunchLink({token:(rec||w).token||''})};
  },
  closeModal:(id?: any)=>closeModal(id),
  setWorkerStatus(id?: any,v?: any){ const i=workers.findIndex((x?: any)=>x.id===id); if(i>=0) setWorkerStatus(i,v); },
  editFromCard:(id?: any)=>editFromWorkerCard(id),
  rescanFromCard:(id?: any)=>{ const i=workers.findIndex((x?: any)=>x.id===id); if(i>=0) rescanFromWorkerCard(i); },
  payFromCard:(id?: any)=>{ closeModal('workerCardOverlay'); openPayModal(id); },
  openDocUpload:(id?: any,type?: any,fromEditor?: any)=>openWorkerDocUpload(id,type,fromEditor),
  openHoursImport:(id?: any)=>openHoursImportModal(id),
  openHoursExport:(id?: any)=>openHoursExportModal(id),
  openCard:(id?: any)=>openWorkerCardById(id),
  // Delete never asks (the card's Undo snack): when its time is up the entries go, saved, and their files are deleted.
  removeDocs(wid?: any,ids?: any){
    const w=workers.find((x?: any)=>x.id===wid); if(!w) return;
    // a person's own delete: a signed document goes too (docs/contracts.md → Signed files are kept)
    const gone=(w.docs||[]).filter((d?: any)=>ids.includes(String(d.id)));
    if(!gone.length) return;
    w.docs=(w.docs||[]).filter((d?: any)=>!gone.includes(d));
    autoSave(); render();
    gone.forEach((d?: any)=>{ if(d.fileId) gsDeleteWorkerDoc(d.fileId, true); });
  },
  setScanField(wid?: any,key?: any,v?: any){
    const w=workers.find((x?: any)=>x.id===wid); if(!w) return;
    w[key]=v;
    if(key==='docGiven'||key==='docSurname') w.name=((w.docGiven||'')+' '+(w.docSurname||'')).trim();
    autoSave(); render();
  },
  regenerateDoc:(id?: any,sig?: any)=>regenerateWorkerDoc(id,sig||undefined),
  signContext:async(workerId?: any)=>{
    const w=workers.find((x?: any)=>x.id===workerId); if(!w) return null;
    const profile=await refreshTenantProfile(5*60*1000);
    const seePay=canSeePay();
    const link=w.token?buildPunchLink(w):'';
    return {worker:w, form101:form101Payload(w,w.docType!=='passport',profile),
      values:contractValues(w,{profile,clients,suppliers,seePay}), canSeePay:seePay, canSetDate:canSetSignDate(), punchLink:link,
      whatsapp:link?'https://wa.me/'+String(w.phone||'').replace(/\D/g,'').replace(/^0/,'972')+'?text='+encodeURIComponent(signMessage(w,link)):''};
  },
  firmProfile:()=>refreshTenantProfile(5*60*1000),
  async downloadData(workerId?: any,include?: any){
    const w=workers.find((x?: any)=>x.id===workerId); if(!w) throw new Error(tr('Worker not found'));
    const profile=include&&include.form101?await refreshTenantProfile(5*60*1000):null;
    const r=await workerDocsCall({action:'bundle', workerId, include, ...(include&&include.form101?{form101:form101Payload(w,w.docType!=='passport',profile)}:{})});
    openPdfBlob(r.blob,r.name);
    const {blob:_b,...rest}=r;
    return rest;
  },
  seesPay:()=>canSeePay(),
  signRequest:(workerId?: any)=>signRequestOf(workerId) as any,
  reloadSignRequests:()=>loadSignRequests(true),
  findScanFields:(editId?: any,keys?: any,docType?: any)=>findScanFields(editId?workers.find((x?: any)=>x.id===editId)||null:null,keys,docType),
  rescan:()=>rescanFromWorkerModal(),
  newToken:(id?: any)=>regenerateWorkerToken(id),
  // Another worker with this document number (matched without spaces, dashes or leading zeros); excludeId: the worker being edited.
  findByDocId(docId?: any,excludeId?: any){ const k=docIdKey(docId); const d=k?workers.find((w?: any)=>w.id!==excludeId&&docIdKey(workerDocId(w))===k):null; return d?{id:d.id, name:d.name||'', clientIds:d.clientIds||[]}:null; },
  isHr:()=>isHrSession(),
  async docExistsInFirm(docId?: any,workerId?: any){
    const r=await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'checkWorkerDoc',...gsAuth(),docId,...(workerId?{workerId}:{})})})).json();
    return !!(r&&r.exists);
  },
  liveScan:()=>!!window.__aiScanImage,
  rescannedId:()=>window.__aiRescannedWorkerId||null,
  setRescanned:(id?: any)=>{ window.__aiRescannedWorkerId=id; },
  sendScanDocument(workerId?: any,saved?: any){ const d=scanDocument(saved||{}); if(d) void sendScanDocument({workerId:String(workerId||''),...d}); },
  // An edit: the form over the record. Moved to a new client that has a rate: that client's rate is the
  // default again — an hourly worker's own rate is cleared (user decision 2026-10-05), only by a login
  // that may change pay. An HR change moves the worker's punches too (assignWorkersToHr).
  commitEdit(id?: any,fields?: any,hrPicked?: any){
    const i=workers.findIndex((x?: any)=>x.id===id); if(i<0) return;
    const prevW=workers[i], updated={...prevW,...fields}; delete updated.avatarB64;
    const addedRated=(updated.clientIds||[]).filter((cid?: any)=>!(prevW.clientIds||[]).includes(cid))
      .some((cid?: any)=>{ const c=clients.find((x?: any)=>x.id===cid); return c&&c.defaultHourlyRate!=null&&c.defaultHourlyRate!==''; });
    if(addedRated && !isDailyPay(updated) && wOwnRate(updated)!=='' && canEditPay(updated)){ updated.hourlyRate=0; updated.regRate=null; }
    workers[i]=updated;
    if(hrPicked!==undefined && (prevW.hrId||null)!==hrPicked) assignWorkersToHr([updated.id],hrPicked);
    render(); autoSave();
  },
  // A new worker: an HR login's own; the owner may pick one.
  addRecord(rec?: any,hrPicked?: any){
    if(isHrSession()) rec.hrId=getSession()!.uid;
    else if(hrPicked) rec.hrId=hrPicked;
    workers.push(rec);
    render(); autoSave();
  },
  async uploadForm101(isId?: any,id?: any,sig?: any){
    if(sig!==undefined) window.__wCapturedSigPng=sig;
    await autoUploadWithRetry(isId,id);
  },
  genToken:()=>genToken(),
  newId:()=>uid(),
  fileForStorage:(f?: any)=>fileForStorage(f),
  uploadWorkerFile:(body?: any,onProgress?: any)=>uploadWorkerFile({...body,...gsAuth()},onProgress),
  addDocs(wid?: any,docs?: any){ const w=workers.find((x?: any)=>x.id===wid); if(w&&docs.length){ w.docs=[...(w.docs||[]),...docs]; if(docs.some((d?: any)=>d.type==='contract')) delete w.contractUploadFailed; autoSave(); render(); } },
  reportError:(msg?: any,where?: any)=>reportError(msg,where,''),
  hoursInfo(id?: any){
    const w=workers.find((x?: any)=>x.id===id); if(!w) return null;
    const own=(w.clientIds||[]).map((cid?: any)=>clients.find((c?: any)=>c.id===cid)).filter(Boolean);
    return {name:w.name||'', daily:!!isDailyPay(w), clients:(own.length?own:clients).map((c?: any)=>({id:c.id, name:c.name||''}))};
  },
  parseHoursSheet:(f?: any)=>parseHoursExcelFile(f) as Promise<any[]>,
  filePages:(f?: any)=>fileToUploadPages(f),
  readHoursPage:(pg?: any)=>parseHoursImagePage(pg),
  async sendHours(entries?: any,fileName?: any){
    return await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'savePendingHoursBatch',...gsAuth(),entries,fileName})})).json();
  },
  // An own-workers HR reads only its own batches (the rules).
  async loadPendingHours(){ return ((await (await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadPendingHours',...gsAuth()})})).json()).batches)||[]; },
  async exportHours(id?: any,y?: any,m?: any,format?: any){ await ensurePunchesSince(new Date(y,m,0)); exportShiftsDetail(id,y,m,format); },
});
// The head of the worker card, the notices sheet and the worker window: the
// plate's colour, site, today's punch, the month's hours and the notices with
// their actions (by rights).
function workerHeadOf(w?: any){
  const t=workerToday(w,todayPunchLog()), ns=workerNotices(w,t);
  return {name:w.name||'', color:workerBarColor(w,ns), site:workerSiteName(w), today:{k:t.k as ''|'in'|'none'|'out'|'vac', time:t.time||''}, monthHours:workersMonthHours()[w.id]||0,
    notices:ns.map((n?: any)=>({lvl:n.lvl, word:n.word, title:n.title, icon:n.icon||'', detail:n.detail||'',
      acts:(n.acts||(n.act?[n.act]:[])).map((a?: any)=>({label:a.label, icon:a.icon||'', wa:!!a.wa, run:a.fn}))}))};
}
// a contract has no expiry (its date starts the contract term, shown on the card's contract line): no entry here

// Per-client and per-supplier rate tables in Accounting: turned off for now
// (user request 2026-10-11). Rates already set in them still count in pay
// and commission (effectiveRates, w.supplierRates); true shows them again.
// ── Accounting (stage 6e): the tab is React (src/manager/Accounting.tsx, the
// root #accountingRoot) and its figures are src/manager/accounting.ts, which
// the React pieces hand the page as window.ManagerAcc. The period
// (accPeriod), the data, the server calls (hours approvals, pending batches)
// and the pay window's save stay here; these wrappers keep the old names for
// the page's other callers (the client and supplier windows, the user form,
// the bell).
let accPeriod='week', __accOpenSeq=0;
function accData(){ return {log:getPunchLog() as any[], workers, clients, suppliers, tr}; }
function salaryEntriesFor(period?: any){ return window.ManagerAcc ? window.ManagerAcc.salaryEntriesFor(accData(), period) : {byWorker:{}, byClient:{}, byDay:{}}; }
function commissionFor(w?: any, e?: any, hourRate?: any, dayRate?: any){ return window.ManagerAcc!.commissionFor(w, e, hourRate, dayRate); }
function supplierCommission(w?: any, e?: any, sid?: any){ return window.ManagerAcc!.supplierCommission(w, e, sid); }
function hourApprovalSummary(doc?: any, month?: any){ return window.ManagerAcc!.hourApprovalSummary(accData(), doc, month); }
// The Accounting tab, or an HR's Commission or Hours tab (the same data), whichever is open.
export function renderAccounting(){
  const i=island(); if(!i || portalInfo()) return; // a supplier's or client's tabs are its portal screens (nav.ts)
  if(currentTab==='commission') i.renderCommission(); else if(currentTab==='hours') i.renderHours(); else i.renderAccounting();
}
function setAccTab(k?: any){ if(island()) island()!.setAccTab(k); }

// The hours function (the HR's Hours approval, the owner's approvals list and fixes).
const HOURS_REVIEW_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/hours';
async function hoursCall(body?: any){
  const idToken = await (await loadFirestoreBackend()).idToken();
  const res = await fetch(HOURS_REVIEW_FN_URL, {method:'POST',
    headers:{'Content-Type':'application/json', Authorization:'Bearer ' + idToken}, body: JSON.stringify(body)});
  return res.json();
}
// The month's approval documents (the hours function, list) — every login's.
// Kept for a minute per month: Accounting redraws on every punch, which must
// not ask the server each time; opening the tab and an accept / reject
// drop the copy, the accountant report always reads afresh (fresh).
const HOUR_APPROVALS_TTL=60e3;
let __hourApprovalsCache: any=null;
async function hourApprovalsOf(month?: any, fresh?: any){
  const c=!fresh&&__hourApprovalsCache, key=fsTenantId()+'|'+month;
  if(c&&c.key===key&&Date.now()-c.at<HOUR_APPROVALS_TTL) return c.docs;
  const r=await hoursCall({action:'list', month, tenantId:fsTenantId()});
  if(r.error) throw new Error(r.error);
  __hourApprovalsCache={key, at:Date.now(), docs:r.docs||[]};
  return __hourApprovalsCache.docs;
}
// A client's signed month: the PDF opens in a new tab (storage.rules: the firm's managers read).
async function openSignedHours(path?: any){
  const win=window.open('', '_blank');
  try{ const url=await (await loadFirestoreBackend()).storageUrl(path); if(win) win.location.href=url; else location.href=url; }
  catch(e: any){ if(win) win.close(); showToast(tr('Could not open the file')); }
}

// Hours-import approval queue (Admin/Roles plan, stage 14): only tenant_admin /
// superadmin approve or reject (the server checks the same).
async function bulkHoursBatches(ids?: any, approve?: any){
  if(approve){ for(const id of ids) await approveHoursBatch(id); return; }
  if(!confirm(tr('Reject {n} batch(es)?',{n:ids.length}))) return;
  let done=0;
  for(const batchId of ids){
    try{
      const json=await (await fetch(API_URL,{method:'POST', body:JSON.stringify({action:'rejectPendingHours', ...gsAuth(), batchId})})).json();
      if(json.error) showToast(json.error); else done++;
    }catch(e: any){ showToast(tr('Failed: {e}',{e:e.message})); }
  }
  showToast(tr('{n} batch(es) rejected',{n:done}));
}
async function approveHoursBatch(batchId?: any){
  try{
    const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'approvePendingHours', ...gsAuth(), batchId }) });
    const json = await res.json();
    if(json.error){ showToast(json.error); return; }
    showToast(tr('{n} shift(s) approved',{n:json.created}));
    // Approved hours are often for a past month, older than the live window
    // — load back to the earliest of them so they show.
    if(json.created){
      try{
        const made=await (await loadFirestoreBackend()).punchesOfBatch(fsTenantId(), batchId);
        const first=made.map((e?: any)=>new Date(e.ts)).filter((d?: any)=>!isNaN(d)).sort((a?: any,b?: any)=>a-b)[0];
        if(first) await ensurePunchesSince(new Date(first.getFullYear(), first.getMonth(), first.getDate()-1));
      }catch(e: any){ console.warn('Loading approved punches failed:', e); }
    }
    renderAccounting();
  }catch(e: any){ showToast(tr('Failed: {e}',{e:e.message})); }
}
async function rejectHoursBatch(batchId?: any){
  if(!confirm(tr('Reject this batch?'))) return;
  try{
    const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action:'rejectPendingHours', ...gsAuth(), batchId }) });
    const json = await res.json();
    if(json.error){ showToast(json.error); return; }
    showToast(tr('Batch rejected'));
  }catch(e: any){ showToast(tr('Failed: {e}',{e:e.message})); }
}

// ── Pay window (openPayModal; Accounting → Salary and the worker card) ────
// The one place a worker's money is set, drawn in React (src/manager/PayWindow.tsx).
// The firm owner, a super-admin and staff with Edit pay (before the flat
// rights: with Accounting) edit; an HR (its
// reduced Accounting) sees its own workers' pay window read-only, and edits
// it too with "Edit own workers' pay" (permission payEdit) — its own workers
// only (w.hrId is its uid).
function canEditPay(w?: any){
  const s=getSession();
  if(!s) return false;
  if(s.role==='tenant_admin'||s.role==='superadmin') return true;
  // (the rules let an HR write a worker only with Workers or Schedule)
  if(s.role==='hr') return hrPayOnly() && hasPermission('payEdit') && (hasPermission('workers')||hasPermission('schedule')) && (!w || w.hrId===s.uid);
  return s.role==='staff' && staffPayEdit();
}
function openWorkerCardById(wid?: any){ const i=workers.findIndex((w?: any)=>w.id===wid); if(i>=0) openWorkerCard(i); }
function payWindowAllowed(w?: any){ return !!w && (canEditPay(w) || (hrPayOnly() && w.hrId===((getSession()||{} as any)).uid)); }
function openPayModal(wid?: any){
  const w=workers.find((x?: any)=>x.id===wid); if(!payWindowAllowed(w) || !island()) return;
  island()!.openPay(wid);
  byId('payOverlay').classList.add('open');
}

// --- One worker's hours → PDF / Excel: getWorkerMonthShifts(), exportShiftsDetail()
// are src/manager/logic/exports.ts.


// --- Admin Panel -------------------------------------------------------------
// True latest punch by timestamp (robust to array order / back-dated manual entries / sync).
function latestOf(entries?: any){
  if(!entries||!entries.length) return null;
  return entries.reduce((a?: any,b?: any)=> new Date(b.ts).getTime() > new Date(a.ts).getTime() ? b : a);
}
// Resolve the site shown for a punch: a recorded site that matches a current
// client is kept (it was chosen on purpose); otherwise fall back to the
// worker's linked client name (so site follows client when not set manually).
function workerClientName(workerId?: any){
  const w = workers.find((x?: any)=>x.id===workerId);
  if(!w) return '';
  const c = (w.clientIds||[]).map((id?: any)=>clients.find((x?: any)=>x.id===id)).filter(Boolean)[0];
  return c ? c.name : '';
}
function punchSite(e?: any){
  if(e && e.clientId){ const c=clients.find((x?: any)=>x.id===e.clientId); if(c) return c.name; }
  if(e && e.site && clients.some((c?: any)=>c.name===e.site)) return e.site; // legacy entries without clientId
  return workerClientName(e && e.workerId) || (e && e.site) || '';
}


// ── Admin (stage 6f-1): the section tabs, the tiles and the Punch Log are
// drawn in React — src/manager/Admin.tsx, the root #adminRoot. The punches
// (getPunchLog), their saves, Export CSV and Clear Log's server call stay
// here; window.ManagerBridge.admin() and its actions below hand them over.
function renderAdmin(){ if(island()) island()!.renderAdmin(); }
// "Load earlier month": to the 1st of the month already partly loaded, or the month before it.
function loadEarlierPunchMonth(){
  const f=__punchLoadedFrom||punchWindowStart();
  return ensurePunchesSince(new Date(f.getFullYear(), f.getMonth()-(f.getDate()===1?1:0), 1)).then(renderAdmin);
}
// The punch window's save: type, time, site (a client, none = the worker's
// client name, or the stored custom site kept), notes; marked edited by admin.
function savePunchEdit(id?: any, ed?: any){
  const log = getPunchLog();
  const idx = log.findIndex((x?: any)=>String(x.id)===String(id));
  if(idx<0) return;
  log[idx].type = ed.type;
  // ts is what pay and the live sync use (time is rebuilt from it), so a new
  // time moves ts too: the edited hour and minute on the day that keeps the
  // shift whole (an OUT after its IN, within 24h — logic/punches.ts).
  if(ed.time !== log[idx].time){
    const ts = editedPunchTs(log, log[idx], ed.time, ed.type);
    if(ts){ log[idx].ts = ts; log[idx].date = punchDate(ts); }
  }
  log[idx].time = ed.time;
  if(ed.site==='__custom__'){
    // unchanged custom text kept from before — clientId stays null
  } else if(ed.site){
    const c = clients.find((x?: any)=>x.id===ed.site);
    log[idx].clientId = c ? c.id : null;
    log[idx].site      = c ? c.name : (log[idx].site || workerClientName(log[idx].workerId));
  } else {
    log[idx].clientId = null;
    log[idx].site      = workerClientName(log[idx].workerId);
  }
  log[idx].notes = ed.notes;
  log[idx].editedBy = 'admin';
  log[idx].editedAt = new Date().toISOString();
  savePunchLog(log);
  gsUpdatePunch(log[idx]);
  render();
  showToast(tr('Record updated'));
}
// Punches deleted from the log once their Undo time is up.
function deletePunchesNow(ids?: any){
  const gone=getPunchLog().filter((x?: any)=>ids.includes(String(x.id)));
  if(!gone.length) return;
  savePunchLog(getPunchLog().filter((x?: any)=>!ids.includes(String(x.id))));
  gone.forEach((e?: any)=>gsDeletePunch(e.id));
  render();
  showToast(tr('Record deleted'));
}

function exportPunchCSV(){
  const log = getPunchLog();
  if(!log.length){ showToast(tr('No records to export')); return; }
  const rows=[['Worker','Supplier','Type','Time','Date','Site','Distance(m)','GPS Accuracy','Notes','Edited']];
  log.forEach((e?: any)=>{
    const _w=workers.find((w?: any)=>w.id===e.workerId);
    const supName=suppliers.find((s?: any)=>s.id===_w?.supplierId)?.name||'';
    rows.push([
      e.workerName||'',
      supName,
      e.type?.toUpperCase()||'',
      e.time||'',
      new Date(e.ts).toLocaleDateString('en-GB'),
      punchSite(e),
      e.dist!=null?e.dist:'',
      e.gpsAccuracy!=null?Math.round(e.gpsAccuracy):'',
      e.notes||'',
      e.editedAt?new Date(e.editedAt).toLocaleString():''
    ]);
  });
  const blob=new Blob([csvText(rows)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='punch-log-'+localYMD(new Date())+'.csv'; a.click();
  URL.revokeObjectURL(url);
  showToast(tr('CSV exported!'));
}

// Admin → Punch Log → "Clear Log" (the React Alert Dialog picks whole
// months): a CSV backup of exactly the rows being deleted is downloaded
// first, then they are deleted from the database (deletePunchesByMonths) and
// the local cache. Months are keyed 'yyyy-MM' from the punch's own `date`
// (dd/MM/yyyy, the server-formatted field — same one the backend groups by),
// falling back to ts.
function punchMonthKey(e?: any){
  const m=String(e.date||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m) return m[3]+'-'+m[2].padStart(2,'0');
  const d=new Date(e.ts);
  return isNaN(+d) ? null : d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
async function clearPunchMonths(months?: any){
  if(!months.length) return false;
  const all=getPunchLog();
  const doomed=all.filter((e?: any)=>months.includes(punchMonthKey(e)));
  // Backup first: exportPunchCSV() reads getPunchLog(), so point it at just
  // the rows being deleted for the duration of the call.
  if(doomed.length){
    try{ savePunchLog(doomed); exportPunchCSV(); }catch(e: any){} finally{ savePunchLog(all); }
  }
  try{
    const res=await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'deletePunchesByMonths',...gsAuth(),months})});
    const json=await res.json();
    if(!json || json.error){ showToast(tr('Delete failed: {0}',{0:((json&&json.error)||'unknown error')})); return false; }
    savePunchLog(getPunchLog().filter((e?: any)=>!months.includes(punchMonthKey(e))));
    render();
    showToast(tr('{0} records deleted from the database (backup downloaded)',{0:(json.deleted)}),3500);
    return true;
  }catch(e: any){
    showToast(tr('Delete failed: {0}',{0:(e.message)})); return false;
  }
}
