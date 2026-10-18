// The manager page's own script, part "clients": the client window's entry points and save, the map picker.
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
import { getPunchLog } from '../data/punches';
import { getWorkerMonthShifts } from '../logic/exports';
import { render } from './render';
import { showToast } from '../toast';
Object.defineProperties(window, {
  "openAddClient": {get: () => openAddClient, configurable: true},
  "openEditClient": {get: () => openEditClient, configurable: true},
  "showClientModal": {get: () => showClientModal, configurable: true},
  "saveClient": {get: () => saveClient, configurable: true},
  "commitClient": {get: () => commitClient, configurable: true},
  "closeEditorUnsaved": {get: () => closeEditorUnsaved, configurable: true},
  "punchFromClientModal": {get: () => punchFromClientModal, configurable: true},
  "deleteClientsNow": {get: () => deleteClientsNow, configurable: true},
  "GOOGLE_MAPS_API_KEY": {get: () => GOOGLE_MAPS_API_KEY, configurable: true},
  "MAP_PICK_DEFAULT_CENTER": {get: () => MAP_PICK_DEFAULT_CENTER, configurable: true},
  "_gmapsLoading": {get: () => _gmapsLoading, set: (v?: any) => { _gmapsLoading = v; }, configurable: true},
  "__mapPick": {get: () => __mapPick, set: (v?: any) => { __mapPick = v; }, configurable: true},
  "__mapPickDone": {get: () => __mapPickDone, set: (v?: any) => { __mapPickDone = v; }, configurable: true},
  "loadGoogleMaps": {get: () => loadGoogleMaps, configurable: true},
  "openMapPicker": {get: () => openMapPicker, configurable: true},
  "mapPickSetPos": {get: () => mapPickSetPos, configurable: true},
  "mapPickSetRadius": {get: () => mapPickSetRadius, configurable: true},
  "mapPickUseMyLocation": {get: () => mapPickUseMyLocation, configurable: true},
  "saveMapPick": {get: () => saveMapPick, configurable: true},
  "workersMonthHours": {get: () => workersMonthHours, configurable: true},
});

// --- Clients (stage 6d) ----------------------------------------------------------
// The Clients tab and the client window are drawn in React (src/manager/
// Clients.tsx, ClientEditor.tsx — docs/clients.md); the records, the map picker
// and the saves stay here (window.ManagerBridge). The window has no Cancel: a tap
// outside saves it (saveClient auto); a new client gets the next colour.
export function openAddClient(){ editingClientId=null; showClientModal({name:'',color:CLIENT_COLORS[clients.length%CLIENT_COLORS.length],address:''}); }
export function openEditClient(cid?: any){ const c=clients.find((x?: any)=>x.id===cid); if(!c) return; editingClientId=cid; showClientModal(c); }
function showClientModal(c?: any){
  if(!window.ManagerIsland) return;
  const cov=byId('clientOverlay'), id=editingClientId;
  cov.__onUserClose=()=>saveClient({auto:true});
  // Coming back to it (from the manual punch or the user form) draws it again from the saved record.
  cov.__reopen=id?()=>openEditClient(id):null;
  window.ManagerIsland.openClient(JSON.parse(JSON.stringify(c)), id);
  cov.classList.add('open');
}
function saveClient(opts?: any){ if(window.ManagerIsland) window.ManagerIsland.saveClient(opts||{}); }
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
export function deleteClientsNow(ids?: any){
  const one=ids.length===1?clients.find((c?: any)=>c.id===ids[0]):null;
  ids.forEach((cid?: any)=>{
    clients=clients.filter((x?: any)=>x.id!==cid);
    workers.forEach((w?: any)=>{ if(w.clientIds) w.clientIds=w.clientIds.filter((id?: any)=>id!==cid); if(w.clientRates&&w.clientRates[cid]) delete w.clientRates[cid]; });
    if(selectedClientId===cid) selectedClientId=null; });
  render(); autoSave(); showToast(one?tr('{0} removed',{0:one.name}):tr('{0} clients',{0:ids.length}));
}
// ── Client geolocation map picker (Google Maps JavaScript API) ─────────────
// The client window's small map opens it (window.ManagerBridge.pickPlace): search box
// (Places autocomplete), tap/drag pin, live radius circle, "Use my location".
// The place picked goes back to the window (onPick: lat, lng, radius and a
// maps link) — the paste-a-link field in the window still works as before. The Maps script is lazy-loaded only
// when the picker first opens. Needs GOOGLE_MAPS_API_KEY (a browser key
// restricted by HTTP referrer to this app's domains, with Maps JavaScript API,
// Places API (New) and Geocoding API enabled); without one the button falls
// back to opening Google Maps in a new tab so the link can be pasted.
const GOOGLE_MAPS_API_KEY = 'AIzaSyDlS9G5zOhg8lK88_jzHewC5BLM1QkeKwc';
const MAP_PICK_DEFAULT_CENTER = {lat:32.0853, lng:34.7818}; // Tel Aviv
let _gmapsLoading: any = null;
let __mapPick: {map: any, marker: any, circle: any, pos: any} = { map:null, marker:null, circle:null, pos:null }, __mapPickDone: any = null;
function loadGoogleMaps(){
  if(window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
  if(_gmapsLoading) return _gmapsLoading;
  _gmapsLoading = new Promise((resolve?: any,reject?: any)=>{
    window.__gmapsReady = ()=>resolve();
    const s=document.createElement('script');
    s.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(GOOGLE_MAPS_API_KEY)+'&v=weekly&loading=async&callback=__gmapsReady';
    s.async=true;
    s.onerror=()=>{ _gmapsLoading=null; reject(new Error('Google Maps failed to load')); };
    document.head.appendChild(s);
  });
  return _gmapsLoading;
}
// Google calls this global on an invalid/unauthorized key.
window.gm_authFailure = function(){ showToast(tr('Google Maps key rejected — check GOOGLE_MAPS_API_KEY and its allowed domains'),5000); };
export async function openMapPicker(start?: any, onPick?: any){
  const lat=start&&start.lat!=null?Number(start.lat):NaN, lng=start&&start.lng!=null?Number(start.lng):NaN;
  const addr=String((start&&start.addr)||'').trim();
  __mapPickDone=onPick||null;
  if(!GOOGLE_MAPS_API_KEY){
    const q = !isNaN(lat)&&!isNaN(lng) ? lat+','+lng : (addr||'Israel');
    window.open('https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q),'_blank');
    showToast(tr('Pick the point in Google Maps, copy the link and paste it here'),4000);
    return;
  }
  byId('mapPickRadius').value = (start&&start.radius) || 100;
  byId('mapPickSave').disabled = true;
  byId('mapPickCoords').textContent = '';
  byId('mapPickOverlay').classList.add('open');
  try{ await loadGoogleMaps(); }catch(e: any){ showToast(e.message); closeModal('mapPickOverlay'); return; }
  const {Map, Circle} = await google.maps.importLibrary('maps');
  const {Marker} = await google.maps.importLibrary('marker');
  __mapPick = { map:null, marker:null, circle:null, pos:null };
  const hasPos = !isNaN(lat)&&!isNaN(lng);
  const map = new Map(byId('mapPickMap'), {
    center: hasPos?{lat,lng}:MAP_PICK_DEFAULT_CENTER, zoom: hasPos?17:12,
    mapTypeControl:false, streetViewControl:false, fullscreenControl:false, clickableIcons:false, gestureHandling:'greedy'
  });
  __mapPick.map = map;
  // Classic Marker (not AdvancedMarkerElement) — the advanced one requires a
  // Cloud-configured Map ID; this keeps setup to just the API key.
  __mapPick.marker = new Marker({ map, draggable:true, visible:false });
  __mapPick.circle = new Circle({ map, visible:false, strokeColor:'#4f8cff', strokeWeight:2, fillColor:'#4f8cff', fillOpacity:0.15, clickable:false });
  __mapPick.marker.addListener('dragend', (e?: any)=>mapPickSetPos(e.latLng.lat(), e.latLng.lng(), false));
  map.addListener('click', (e?: any)=>mapPickSetPos(e.latLng.lat(), e.latLng.lng(), false));
  if(hasPos) mapPickSetPos(lat,lng,false);
  else if(addr){
    try{
      const {Geocoder} = await google.maps.importLibrary('geocoding');
      new Geocoder().geocode({address:addr, region:'il'}, (res?: any,status?: any)=>{
        if(status==='OK' && res[0] && !__mapPick.pos){ map.setCenter(res[0].geometry.location); map.setZoom(17); }
      });
    }catch(e: any){}
  }
  // Places search box (new PlaceAutocompleteElement). Older builds fire
  // 'gmp-placeselect' with event.place, newer 'gmp-select' with
  // event.placePrediction — handle both.
  const searchHost=byId('mapPickSearch'); searchHost.innerHTML='';
  try{
    const {PlaceAutocompleteElement} = await google.maps.importLibrary('places');
    const ac = new PlaceAutocompleteElement({ includedRegionCodes:['il'] });
    ac.style.width='100%';
    searchHost.appendChild(ac);
    const onPlace = async (place?: any)=>{
      if(!place) return;
      await place.fetchFields({fields:['location','formattedAddress']});
      if(place.location) mapPickSetPos(place.location.lat(), place.location.lng(), true);
    };
    ac.addEventListener('gmp-select', (e?: any)=>onPlace(e.placePrediction && e.placePrediction.toPlace()));
    ac.addEventListener('gmp-placeselect', (e?: any)=>onPlace(e.place));
  }catch(e: any){ searchHost.innerHTML='<div style="font-size:12px;color:var(--text3)">'+tr('Address search unavailable — tap the map instead')+'</div>'; }
}
function mapPickSetPos(lat?: any,lng?: any,recenter?: any){
  __mapPick.pos={lat,lng};
  const p={lat,lng};
  __mapPick.marker.setPosition(p); __mapPick.marker.setVisible(true);
  __mapPick.circle.setCenter(p); __mapPick.circle.setRadius(Number(byId('mapPickRadius').value)||100); __mapPick.circle.setVisible(true);
  if(recenter){ __mapPick.map.setCenter(p); __mapPick.map.setZoom(17); }
  byId('mapPickCoords').textContent=lat.toFixed(5)+', '+lng.toFixed(5);
  byId('mapPickSave').disabled=false;
}
function mapPickSetRadius(v?: any){ if(__mapPick.circle) __mapPick.circle.setRadius(Number(v)||100); }
function mapPickUseMyLocation(){
  if(!navigator.geolocation){ showToast(tr('Geolocation not supported on this device')); return; }
  navigator.geolocation.getCurrentPosition(
    (pos?: any)=>{ mapPickSetPos(pos.coords.latitude,pos.coords.longitude,true); showToast(tr('Accuracy ±{0} m',{0:(Math.round(pos.coords.accuracy))})); },
    (err?: any)=>showToast(tr('Could not get location: {0}',{0:(err.message)})),
    {enableHighAccuracy:true, timeout:15000, maximumAge:0});
}
function saveMapPick(){
  const p=__mapPick.pos; if(!p) return;
  const lat=+p.lat.toFixed(6), lng=+p.lng.toFixed(6);
  const radius=Number(byId('mapPickRadius').value)||100;
  if(__mapPickDone) __mapPickDone({lat, lng, radius, mapsUrl:'https://www.google.com/maps?q='+lat+','+lng});
  closeModal('mapPickOverlay');
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
