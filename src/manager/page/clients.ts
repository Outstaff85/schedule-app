// The manager page's own script, part "clients": the client window's entry points and save, the map picker.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { CLIENT_COLORS } from '../logic/schedule';
import { tr } from '../logic/i18n';
import { autoSave } from '../data/store';
import { getPunchLog } from '../data/punches';
import { getWorkerMonthShifts } from '../logic/exports';
import { render } from './render';
import { showToast } from '../toast';
import { mayWriteWorkers } from '../logic/access';
import { island } from '../bridge';
Object.defineProperties(window, {
  "openAddClient": {get: () => openAddClient, configurable: true},
  "openEditClient": {get: () => openEditClient, configurable: true},
  "saveClient": {get: () => saveClient, configurable: true},
  "punchFromClientModal": {get: () => punchFromClientModal, configurable: true},
});

// --- Clients (stage 6d) ----------------------------------------------------------
// The Clients tab and the client window are drawn in React (src/manager/
// Clients.tsx, ClientEditor.tsx — docs/clients.md); the records, the map picker
// and the saves stay here (window.ManagerBridge). The window has no Cancel: a tap
// outside saves it (saveClient auto); a new client gets the next colour.
export function openAddClient(){ editingClientId=null; showClientModal({name:'',color:CLIENT_COLORS[clients.length%CLIENT_COLORS.length],address:''}); }
export function openEditClient(cid?: any){ const c=clients.find((x?: any)=>x.id===cid); if(!c) return; editingClientId=cid; showClientModal(c); }
function showClientModal(c?: any){
  if(!island()) return;
  const cov=byId('clientOverlay'), id=editingClientId;
  cov.__onUserClose=()=>saveClient({auto:true});
  // Coming back to it (from the manual punch or the user form) draws it again from the saved record.
  cov.__reopen=id?()=>openEditClient(id):null;
  island()!.openClient(JSON.parse(JSON.stringify(c)), id);
  cov.classList.add('open');
}
function saveClient(opts?: any){ if(island()) island()!.saveClient(opts||{}); }
// The window's record: stored in place (unless nothing changed) or added; saved.
export function commitClient(id?: any, fields?: any){
  if(id){
    const idx=clients.findIndex((x?: any)=>x.id===id); if(idx<0){ closeModal('clientOverlay'); return; }
    const next={...clients[idx],...fields};
    const norm=(o?: any)=>JSON.stringify(Object.keys(o).sort().map((k?: any)=>[k,o[k]??null]));
    if(norm(next)===norm(clients[idx])){ closeModal('clientOverlay'); return; }  // nothing changed
    clients[idx]=next;
    showToast(tr('{0} updated!',{0:fields.name}));
  } else {
    clients.push({id:uid(),...fields});
    showToast(tr('{0} added!',{0:fields.name}));
  }
  closeModal('clientOverlay'); renderClientsPage(); render(); autoSave();
}
// Delete from a window's ⋮: the window closes without saving (and does not
// come back); the list then deletes behind its Undo snack (src/manager/Clients.tsx).
export function closeEditorUnsaved(ov?: any){ const el=byId(ov); el.__reopen=null; el.__returnTo=null; closeModal(ov); }
// The manual punch from the client window: the window is saved first (as on a
// tap outside), then the punch opens; closing it brings the client back.
export function punchFromClientModal(){
  const cid=editingClientId; if(!cid) return;
  saveClient({auto:true});
  if(!byId('clientOverlay').classList.contains('open')) openManualPunch(cid);
}
// A client's Undo time is up: removed, taken off every worker and the site filter; saved.
// A login that may not write the workers the delete changes (their client
// list; a per-client rate needs Edit pay too) is refused here: the refused
// worker writes would stay in every later save of this device (mayWriteWorkers).
export function deleteClientsNow(ids?: any){
  const blocked=ids.filter((cid?: any)=>{
    const hit=workers.filter((w?: any)=>(w.clientIds||[]).includes(cid)||(w.clientRates&&w.clientRates[cid]));
    return hit.length>0 && !mayWriteWorkers(hit.some((w?: any)=>w.clientRates&&w.clientRates[cid]));
  });
  if(blocked.length){
    const c=clients.find((x?: any)=>x.id===blocked[0]);
    showToast(tr('{0} was not deleted — it would change workers this login may not edit',{0:(c&&c.name)||tr('Client')}));
    ids=ids.filter((cid?: any)=>!blocked.includes(cid));
    if(!ids.length){ renderClientsPage(); render(); return; }
  }
  const one=ids.length===1?clients.find((c?: any)=>c.id===ids[0]):null;
  ids.forEach((cid?: any)=>{
    clients=clients.filter((x?: any)=>x.id!==cid);
    workers.forEach((w?: any)=>{ if(w.clientIds) w.clientIds=w.clientIds.filter((id?: any)=>id!==cid); if(w.clientRates&&w.clientRates[cid]) delete w.clientRates[cid]; });
    if(selectedClientId===cid) selectedClientId=null; });
  render(); autoSave({allowEmpty:true}); showToast(one?tr('{0} removed',{0:one.name}):tr('{0} clients',{0:ids.length}));
}
// ── The map picker (React since stage 8e-3: src/manager/MapPicker.tsx, Google
// Maps in src/manager/maps.ts). The client window's small map opens it
// (ManagerBridge.pickPlace) over the window; the place picked goes back
// through onPick (lat, lng, radius and a maps link).
export function openMapPicker(start?: any, onPick?: any){
  if(!island()) return;
  island()!.openMapPicker({start: start||null, onPick: onPick||null, close: ()=>closeModal('mapPickOverlay')});
  byId('mapPickOverlay').classList.add('open');
}

// Hours worked this calendar month, per worker — the same canonical shift
// pairing (getWorkerMonthShifts → groupPunchesIntoShifts/analyzeDayPunches)
// the hours export uses, so the card can never disagree with it.
// The punch log is read (parsed) once and split by worker: reading it once
// per worker made the cards view take over a second at 150 workers.
export function workersMonthHours(){
  const now=new Date(), y=now.getFullYear(), m=now.getMonth(), out: any={}, byWorker: any={};
  getPunchLog().forEach((e?: any)=>{ (byWorker[e.workerId]||(byWorker[e.workerId]=[])).push(e); });
  workers.forEach((w?: any)=>{ out[w.id]=getWorkerMonthShifts(w.id,y,m,byWorker[w.id]||[]).reduce((s?: any,x?: any)=>s+x.hours,0); });
  return out;
}
