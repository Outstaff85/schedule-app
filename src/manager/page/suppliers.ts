// The manager page's own script, part "suppliers": the supplier window's entry points and save, the manual punch.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { CLIENT_COLORS } from '../logic/schedule';
import { tr } from '../logic/i18n';
import { autoSave } from '../data/store';
import { getPunchLog, savePunchLog } from '../data/punches';
import { renderSuppliersPage } from './workers';
import { render } from './render';
Object.defineProperties(window, {
  "openAddSupplier": {get: () => openAddSupplier, configurable: true},
  "openEditSupplier": {get: () => openEditSupplier, configurable: true},
  "showSupplierModal": {get: () => showSupplierModal, configurable: true},
  "commitSupplier": {get: () => commitSupplier, configurable: true},
  "deleteSuppliersNow": {get: () => deleteSuppliersNow, configurable: true},
  "openManualPunch": {get: () => openManualPunch, configurable: true},
  "addManualPunch": {get: () => addManualPunch, configurable: true},
});

// --- Suppliers ----------------------------------------------------------------
// A supplier is a staffing agency a worker is linked to via w.supplierId
// (single, unlike the many-to-many clientIds), see the `suppliers` global's own
// comment for the field list. The window is React (src/manager/SupplierEditor.tsx):
// one Save; a tap outside closes it without saving.
export function openAddSupplier(){ editingSupplierId=null; showSupplierModal({name:'',color:CLIENT_COLORS[suppliers.length%CLIENT_COLORS.length],phone:'',bank:'',bankBranch:'',accountNumber:'',companyNumber:''}); }
export function openEditSupplier(sid?: any){ const s=suppliers.find((x?: any)=>x.id===sid); if(!s) return; editingSupplierId=sid; showSupplierModal(s); }
function showSupplierModal(s?: any){
  if(!window.ManagerIsland) return;
  const ov=byId('supplierOverlay'), id=editingSupplierId;
  ov.__reopen=id?()=>openEditSupplier(id):null;
  window.ManagerIsland.openSupplier(JSON.parse(JSON.stringify(s)), id);
  ov.classList.add('open');
}
export function commitSupplier(id?: any, fields?: any){
  if(id){
    const idx=suppliers.findIndex((x?: any)=>x.id===id);
    if(idx>=0) suppliers[idx]={...suppliers[idx],...fields};
    showToast(tr('{0} updated!',{0:fields.name}));
  } else {
    suppliers.push({id:uid(),...fields});
    showToast(tr('{0} added!',{0:fields.name}));
  }
  closeModal('supplierOverlay'); renderSuppliersPage(); autoSave();
}
// A supplier's Undo time is up: removed and taken off every worker; saved.
export function deleteSuppliersNow(ids?: any){
  const one=ids.length===1?suppliers.find((s?: any)=>s.id===ids[0]):null;
  ids.forEach((sid?: any)=>{
    suppliers=suppliers.filter((x?: any)=>x.id!==sid);
    workers.forEach((w?: any)=>{ if(w.supplierId===sid) w.supplierId=null; if(w.supplierRates&&w.supplierRates[sid]) delete w.supplierRates[sid]; }); });
  render(); autoSave(); showToast(one?tr('{0} removed',{0:one.name}):tr('{0} suppliers',{0:ids.length}));
}


// The manual punch (React — src/manager/ManualPunch.tsx): this client's
// workers (or every active one), IN / OUT, date, time, a note.
export function openManualPunch(cid?: any){
  if(!clients.some((x?: any)=>x.id===cid)||!window.ManagerIsland) return;
  window.ManagerIsland.openManualPunch(cid);
  byId('manualPunchOverlay').classList.add('open');
}
// The punch entered: into the local punch log and to Firestore (gsSavePunch).
export function addManualPunch(entry?: any){
  const log=getPunchLog(); log.push(entry); savePunchLog(log);
  gsSavePunch(entry);
  closeModal('manualPunchOverlay');
  showToast(tr('Punch saved — {0} {1} at {2}',{0:entry.workerName,1:entry.type.toUpperCase(),2:entry.time}));
  render(); // the open tab (Clients, Accounting, Today, Admin…) shows the new punch
}
