// The manager page's own script, part "scan": the scan's entry points (the scanner, its reading into the worker window), Form 101's build and upload.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { FORM101_FN_URL, SCAN_WARM_URLS, warmCloudFunctions } from '../logic/functions';
import { tr } from '../logic/i18n';
import { DOC_STORE, workerAddress, workerDocId } from '../logic/workers';
import { firmProfileMissing } from '../logic/admin';
import { API_URL, loadFirestoreBackend, uploadWorkerFile } from '../data/api';
import { getSession, gsAuth } from '../data/session';
import { reportError, reportTiming } from '../data/telemetry';
import { autoSave } from '../data/store';
import { refreshTenantProfile } from './admin';
import { renderWorkerUploadProgress } from './worker-window';
import { render } from './render';
import { renderWorkersPage } from './workers';
import { openScanner } from '../../scan/open';
import type { ScannedPage } from '../../scan/Scanner';
import { readScan, resetScan, sessionPages } from '../../scan-process/session';
import { workerFields } from '../../scan-process/worker';
import { imagesToPdf } from '../../scan/pdf';
import { showToast } from '../toast';
Object.defineProperties(window, {
  "openWorkerModalFromScan": {get: () => openWorkerModalFromScan, configurable: true},
  "startNewScan": {get: () => startNewScan, configurable: true},
  "rescanWorkerDoc": {get: () => rescanWorkerDoc, configurable: true},
  "getSignaturePng": {get: () => getSignaturePng, configurable: true},
  "aiFillForm101": {get: () => aiFillForm101, configurable: true},
  // @ts-ignore — reassigned from outside (a wrapper or a test's stub)
  "autoUploadWithRetry": {get: () => autoUploadWithRetry, set: (v: any) => { autoUploadWithRetry = v; }, configurable: true},
  "regenerateWorkerDoc": {get: () => regenerateWorkerDoc, configurable: true},
  "maybeRegenAfterFirmEdit": {get: () => maybeRegenAfterFirmEdit, configurable: true},
  "regenerateAllWorkerDocs": {get: () => regenerateAllWorkerDocs, configurable: true},
});

// --- Upload preparation (shared by every file upload) -------------------------
// downscaleForUpload(), fileToUploadPages(), filesToUploadPages(),
// fileForStorage(), _loadPdfJs() are src/manager/logic/uploads.ts (CLAUDE.md →
// Uploads).

// The contract pages of a scan, saved to the worker's documents as one PDF of type
// "contract" (docs/scan-plan.md → Contracts in the scan): after the worker is saved,
// with one retry; its end date is not read — set by hand when wanted. A failure
// also marks the worker (contractUploadFailed: the red "Contract not saved"
// notice on the plate and card) until a contract document is added.
async function saveScanContract(w?: any,pages?: any[]){
  try{
    const pdf=await imagesToPdf(pages!.map((p?: any)=>({b64:p.b64,mediaType:p.mediaType})));
    const fileName='Contract '+(w.name||'').trim()+'.pdf';
    const send=()=>uploadWorkerFile({action:'saveWorkerFile',workerId:w.id,fileBase64:pdf,fileName,mimeType:'application/pdf'},()=>{});
    let r=await send().catch(()=>null);
    if(!r||!r.ok) r=await send().catch(()=>null);
    if(!r||!r.ok) throw new Error((r&&r.error)||'network error');
    const doc={id:'d'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),type:'contract',name:fileName,fileId:r.id,url:r.url,mediaType:'application/pdf',uploadedAt:new Date().toISOString(),expiry:''};
    window.ManagerBridge!.addDocs(w.id,[doc]); // clears contractUploadFailed
    showToast(tr('The contract ({0} pages) was added to the documents of {1}',{0:pages!.length,1:w.name||''}));
  }catch(e: any){
    showToast(tr('The contract could not be saved: {0} — add it from Add document',{0:(e&&e.message)||String(e)}),5000);
    reportError('saveScanContract: '+((e&&e.message)||e),'saveScanContract','');
    const live=workers.find((x?: any)=>x.id===w.id);
    if(live){ live.contractUploadFailed=true; autoSave(); render(); renderWorkersPage(); }
  }
}
// New-scan entry point (the "Scan passport" button).
// The Cloud Function warm-up (warmCloudFunctions, SCAN_WARM_URLS, __fnWarm) and
// the functions' URLs are src/manager/logic/functions.ts.
async function startNewScan(){
  warmCloudFunctions(SCAN_WARM_URLS());
  window.__aiRescanWorkerId=null;
  window.__wDraft=null;
  await openNewScan();
}
// The scanner (src/scan/, docs/scan.md → The scan window): the camera with the
// live frame and the device's photos / PDFs; the server cuts every document
// flat and upright. On Done the scan process (src/scan-process/, docs/scan.md →
// Reading) reads its pages in the same window, then the worker window opens
// with what was read. sameSession ("Scan again" from the worker window): the
// scanner starts with this session's pages, and only the changed ones are read.
export async function openNewScan(sameSession?: boolean){
  const initial: ScannedPage[]=sameSession?sessionPages().map(p=>({b64:p.b64,mediaType:p.mediaType,turn:0,blurry:false,kind:(p.kind||undefined) as any})):[];
  if(!sameSession) resetScan();
  let found: any=null;
  const pages=await openScanner({initial,read:async(list,progress)=>{
    // a page whose kind came from the scanner was also turned by it: only a page with no face and no kind is turned here
    found=await readScan(list.map(p=>({b64:p.b64,mediaType:p.mediaType,kind:p.kind||null,upright:p.turn>=0||!!p.kind})),progress);
    return found?null:tr('No ID card or passport was found in the pages — add a photo of one');
  }});
  if(!pages||!found) return;
  openWorkerModalFromScan(found.record,found.reads);
}
// Rescan entry point (the worker list's "scan again"): a new scan of this worker.
async function rescanWorkerDoc(workerId?: any){
  warmCloudFunctions(SCAN_WARM_URLS());
  window.__aiRescanWorkerId=workerId;
  window.__wDraft=null;
  await openNewScan();
}
// The scan's record into the worker window (scan-process/worker.ts gives the
// fields). A rescan of an existing worker (window.__aiRescanWorkerId, set by
// rescanWorkerDoc() / the worker window) reopens THAT worker with the scan's
// values over their record; a new scan whose document number matches an
// existing worker is that worker scanned again (no duplicate record, their
// stored Form 101 replaced); otherwise a new worker. The pages stay in
// window.__aiScanImage / __aiPacketOtherPages for the save's Form 101.
export function openWorkerModalFromScan(p?: any,reads?: any[]){
  if(!p){ showToast(tr('The scan could not be read')); return; }
  const ocrFields=workerFields(p,reads||[]);
  let rescanId=window.__aiRescanWorkerId;
  window.__aiRescanWorkerId=null;
  if(!rescanId&&ocrFields.docId){
    const dup=workers.find((w?: any)=>workerDocId(w)===ocrFields.docId);
    if(dup){ rescanId=dup.id; showToast(tr('Existing worker found ({0}) — updating their record',{0:dup.name||ocrFields.docId}),4000); }
  }
  if(rescanId){
    const idx=workers.findIndex((w?: any)=>w.id===rescanId);
    if(idx>=0){
      editingWorkerId=rescanId;
      // read by saveWorker(): this edit started from a fresh scan (upload its pages), not a plain edit
      window.__aiRescannedWorkerId=rescanId;
      showWorkerModal({...workers[idx],...ocrFields});
      applyWorkerDraft(); // a rescan started from the open window
      void autoFindMissingScanFields();
      return;
    }
  }
  editingWorkerId=null;
  showWorkerModal({...blankWorkerDefaults(),...ocrFields});
  applyWorkerDraft();
  void autoFindMissingScanFields();
}

// The signature for Form 101 is drawn in the worker window (the shared
// SignaturePad, src/manager/WorkerEditor.tsx); its save hands the PNG over in
// window.__wCapturedSigPng before the upload, and aiFillForm101 reads it here.
function getSignaturePng(){ return window.__wCapturedSigPng ?? null; }

// Opens the AI scan flow tagged to an existing worker, so the resulting
// upload replaces (not duplicates) that worker's previously stored PDF —
// see the previousFileId strategy in aiFillForm101. Cleared automatically
// once the upload lands, or when a fresh untagged scan is started.
// presetAssets ({scanB64,scanMediaType,sigPng,extraPages}) is set only by
// regenerateWorkerDoc() below, to source the scan image/signature/extra
// pages from the Storage sidecar instead of the live scan globals — used for a
// background regenerate where nothing was just scanned in THIS browser
// session (the live globals could easily belong to a different worker's scan
// entirely, see regenerateWorkerDoc()'s own comment). Every plain DATA field
// (name/address/marital/etc.) comes from `targetWorker` unconditionally now
// — the unified worker modal (showWorkerModal/saveWorker) is the single
// place that writes those onto the worker record, whether the worker came
// from a scan or was entered by hand, so there's no more separate "live scan
// panel" values to branch on for those.
async function aiFillForm101(isId?: any,mode?: any,workerId?: any,btnEl?: any,presetAssets?: any){
  mode=mode||'download';
  const isRegen=!!presetAssets;
  // Only the blocking new-worker/rescan upload path (mode==='upload' &&
  // !isRegen) shows its progress in the worker window (its save switches it
  // to the progress view first) — a background regenerate (isRegen, called
  // from regenerateWorkerDoc() after the window's already closed) never does.
  const showBlockingProgress=mode==='upload'&&!isRegen;
  // Hoisted above the try so the catch block (below) can still flag this
  // worker's failed upload for the "no document" badge even when the
  // failure happens before the assignment finishes.
  let targetWorker=(workerId||window.__aiRescanWorkerId)?workers.find((x?: any)=>x.id===(workerId||window.__aiRescanWorkerId)):null;
  const surname=(targetWorker&&targetWorker.docSurname)||'';
  const given=(targetWorker&&targetWorker.docGiven)||'';
  const dob=(targetWorker&&targetWorker.docDob)||'';
  const sex=(targetWorker&&targetWorker.docSex)||'';
  const no=workerDocId(targetWorker||{})||'';
  // No separate "nationality" field in the unified form — isId (Israeli ID
  // vs. foreign passport, matching w.docType) is the single source of truth.
  const isIsraeli=isId;
  // Explicit btnEl (or a deliberate null) takes precedence over the implicit
  // global `event` — needed when this runs in the background from saveWorker(),
  // where `event` is the Add/Save Worker button, not a Form 101 button.
  const btn=btnEl!==undefined?btnEl:(event&&event.target?(event.target as HTMLElement).closest('button'):null);
  const btnLabel=btn?btn.innerHTML:'';
  // Reported once the PDF is out — the Form 101 panel carries the same
  // warning inline, but this function also runs in the background from
  // saveWorker(), where that panel isn't on screen.
  let firmMissing: any=[];
  try{
    if(btn){ btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2 spin"></i> '+(mode==='upload'?'Uploading…':'Preparing…'); }

    // PDF construction itself (field placement, RTL Hebrew rendering, comb
    // fields, checkboxes, employer block, children table, signature/scan
    // pages) lives server-side now — see functions/main.py. It's a Python +
    // PyMuPDF port of what used to run here via pdf-lib, moved off the
    // client specifically because pdf-lib's own appearance-stream generator
    // has a confirmed bug that silently drops a glyph of multi-word RTL
    // (Hebrew) text; PyMuPDF has no such bug. This function still gathers
    // every value exactly as before — only "build the PDF bytes" moved.
    const profile=await refreshTenantProfile(5*60*1000);
    firmMissing=firmProfileMissing(profile);

    const signDateSrc=(targetWorker&&targetWorker.createdAt)?new Date(targetWorker.createdAt):new Date();
    const signDate=isNaN(+signDateSrc)?new Date():signDateSrc;
    const signDateStr=String(signDate.getDate()).padStart(2,'0')+'/'+String(signDate.getMonth()+1).padStart(2,'0')+'/'+signDate.getFullYear();

    const payload: any={
      isId, isIsraeli, surname, given, dob, sex, no,
      signDate: signDateStr,
      workerPhone: (targetWorker&&targetWorker.phone)||'',
      incomeType: targetWorker&&targetWorker.incomeType,
      otherIncomeType: targetWorker&&targetWorker.otherIncomeType,
      employer: profile ? {
        companyName: profile.companyName, street: profile.street, streetNumber: profile.streetNumber,
        city: profile.city, phone: profile.phone, deductionsFileNumber: profile.deductionsFileNumber,
      } : null,
    };

    // Israeli ID: address, marital, work start, fund, children — all from
    // the worker record (saveWorker() already wrote everything the unified
    // modal collected onto it before this function was ever called).
    let addr: any,city: any,marital: any,workStart: any,fund: any,children: any;
    if(isId){
      // workerAddress(w) is the street name only (see workerAddress()'s own
      // comment) — the PDF's address box wants "street number" as one
      // string (functions/main.py's _split_street() re-splits it back
      // apart), so the house number has to be appended here explicitly.
      // Previously this line dropped w.houseNumber entirely, silently
      // omitting the house number from every Form 101 whether it came from
      // a scan or was typed in by hand.
      addr=(workerAddress(targetWorker||{})+' '+((targetWorker&&targetWorker.houseNumber)||'')).trim();
      city=(targetWorker&&targetWorker.city)||'';
      marital=(targetWorker&&targetWorker.maritalStatus)||'';
      workStart=(targetWorker&&targetWorker.workStartDate)||'';
      fund=(targetWorker&&targetWorker.healthFund)||'';
      // Children table — only the Israeli-ID branch has one (from the ID's
      // ספח, manually editable in the modal as a fallback for a failed scan).
      children=(targetWorker&&targetWorker.docChildren)||[];
      Object.assign(payload,{address:addr,city,marital,workStart,healthFund:fund,children});
    } else {
      workStart=(targetWorker&&targetWorker.workStartDate)||'';
      fund=(targetWorker&&targetWorker.healthFund)||'';
      // A foreign-passport worker defaults to single server-side unless a
      // status was set (e.g. married with a spouse entered).
      marital=(targetWorker&&targetWorker.maritalStatus)||'';
      // Address in Israel and children, typed in by hand for a foreign
      // worker — printed in the same boxes as for an Israeli ID.
      addr=(workerAddress(targetWorker||{})+' '+((targetWorker&&targetWorker.houseNumber)||'')).trim();
      city=(targetWorker&&targetWorker.city)||'';
      children=(targetWorker&&targetWorker.docChildren)||[];
      Object.assign(payload,{workStart,healthFund:fund,marital,address:addr,city,children});
    }
    // Form 101 section ו (spouse), either document type.
    const tw=targetWorker||{};
    if(tw.spouseSurname||tw.spouseGiven||tw.spouseId||tw.spouseDob||tw.spouseIncome){
      payload.spouse={surname:tw.spouseSurname||'',given:tw.spouseGiven||'',idNo:tw.spouseId||'',dob:tw.spouseDob||'',income:tw.spouseIncome||''};
    }

    // Signature ("חתימת המבקש/ת") — drawn server-side as an image if the
    // worker actually signed on the pad. Regenerating (isRegen) reuses
    // whatever signature was captured the first time, from the Storage
    // sidecar — there's no open modal to read a live pad from in that case.
    // getSignaturePng() already returns a data: URL, so the base64 payload
    // is just the part after the comma.
    let sigPng=isRegen?(presetAssets.sigPng||null):(typeof getSignaturePng==='function'?getSignaturePng():null);

    // Regenerating reads the scan image back from presetAssets (the Storage
    // sidecar loaded by regenerateWorkerDoc()) instead of window.__aiScanImage
    // — that global belongs to whichever scan session happens to be open in
    // the browser right now, which is a DIFFERENT worker's data if a
    // background regenerate for worker B fires while the manager is
    // mid-scanning worker A (or just finished creating worker A from a scan
    // and is now plain-adding worker B by hand — see openAddWorker()'s own
    // reset of these globals). otherPagesToUse (ספח appendix card, contract
    // pages, etc.) follows the same split: a fresh, just-saved worker reads
    // them from window.__aiPacketOtherPages, a regenerate reads them from
    // presetAssets.extraPages (persisted in the Storage sidecar by
    // saveWorkerAssets() below).
    const scanImage=isRegen?(presetAssets.scanB64?{b64:presetAssets.scanB64,mediaType:presetAssets.scanMediaType}:null):window.__aiScanImage;
    let otherPagesToUse=isRegen?(Array.isArray(presetAssets.extraPages)?presetAssets.extraPages:[]):(Array.isArray(window.__aiPacketOtherPages)?window.__aiPacketOtherPages:[]);
    // Rescanning an existing worker who already had extra pages (ספח appendix,
    // a contract, ...) saved from a PRIOR scan session, where THIS session
    // only recaptured the primary page (window.__aiPacketOtherPages is empty):
    // those previously-saved extra pages must not be silently discarded just
    // because the manager didn't re-scan them again today. Before this fix,
    // the rescan path (added 2026-09-26 to fix the primary photo going stale)
    // always wrote otherPagesToUse — even when empty — into the new Storage
    // sidecar via saveWorkerAssets(..., previousFileId: w.assetsFileId), which
    // trashes the OLD sidecar, permanently losing whatever extra pages it had.
    // Carrying the old sidecar's extraPages forward here (only when this
    // session captured none itself) preserves them across a rescan that's
    // only meant to refresh the front card.
    // The same goes for the signature: a rescan with no new signature keeps
    // the one the worker already gave.
    if(!isRegen&&(!otherPagesToUse.length||!sigPng)&&targetWorker&&targetWorker.assetsFileId){
      try{
        const oldResp=await fetch(API_URL,{method:'POST',body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:targetWorker.assetsFileId})});
        const oldJson=await oldResp.json();
        if(oldJson&&oldJson.ok&&!otherPagesToUse.length&&Array.isArray(oldJson.extraPages)&&oldJson.extraPages.length) otherPagesToUse=oldJson.extraPages;
        if(oldJson&&oldJson.ok&&!sigPng&&oldJson.sigPng) sigPng=oldJson.sigPng;
      }catch(e: any){}
    }
    // The contract pages of this scan go to the worker's documents as one PDF (saveScanContract), not into Form 101.
    const contractPages=isRegen?[]:otherPagesToUse.filter((p?: any)=>p&&p.contract);
    if(contractPages.length) otherPagesToUse=otherPagesToUse.filter((p?: any)=>!(p&&p.contract));
    if(sigPng) payload.signaturePngBase64=sigPng.split(',')[1];
    const extraPages: any=[];
    if(scanImage) extraPages.push({b64:scanImage.b64,mediaType:scanImage.mediaType,caption:'Document scan'});
    for(const p of otherPagesToUse) extraPages.push({b64:p.b64,mediaType:p.mediaType,caption:'Document'});
    if(extraPages.length) payload.extraPages=extraPages;

    const f101t0=Date.now();
    // The function lets in only a signed-in manager-side login (functions/gate.py).
    const idToken=await (await loadFirestoreBackend()).idToken();
    const fnResp=await fetch(FORM101_FN_URL,{method:'POST',headers:idToken?{'Content-Type':'application/json',Authorization:'Bearer '+idToken}:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const fnJson=await fnResp.json();
    if(!fnResp.ok||fnJson.error) throw new Error(fnJson.error||'Could not build the PDF');
    // Admin → Timings, kind "form101": what each generated form carried —
    // flags and counts only, no personal data — so a section missing from a
    // real PDF can be traced to the record or to the PDF build.
    try{ reportTiming('form101',Date.now()-f101t0,{regen:isRegen,docType:isId?'israeli_id':'passport',
      spouse:!!payload.spouse,spouseNames:!!(payload.spouse&&(payload.spouse.surname||payload.spouse.given)),
      children:(payload.children||[]).length,marital:payload.marital||'',extraPages:(payload.extraPages||[]).length}); }catch(e: any){}
    const out=Uint8Array.from(atob(fnJson.pdfBase64),(c?: any)=>c.charCodeAt(0));
    const fileName=fnJson.fileName;

    // docType is the one thing this function itself determines (which
    // branch actually generated the PDF) rather than something the unified
    // modal collects — everything else (name/address/marital/etc.) is
    // already on targetWorker, written by saveWorker() before this ran.
    if(mode==='upload'&&targetWorker){
      targetWorker.docType=isId?'israeli_id':'passport';
    }

    if(mode==='upload'){
      // Worker (targetWorker) already resolved up top — reused here so a
      // rescan can pass along the previous file's ID: the OCR'd name/doc-
      // number baked into fileName can drift between scans, so name-based
      // dedup on the backend alone isn't reliable; a known previousFileId
      // lets it trash the exact old file.
      const fileBase64=fnJson.pdfBase64;
      const w=targetWorker;
      // Progress bar: real byte-level progress from the Storage upload.
      // docPromise/assetsPromise upload concurrently, so their progress is
      // combined by total bytes across both, not just whichever finishes
      // first; the 20-90% range leaves room for "building PDF" (0%) before
      // and "done" (100%) after, so the bar visibly moves at every stage.
      let docLoaded=0,docTotal=0,assetsLoaded=0,assetsTotal=0;
      const reportUploadProgress=()=>{
        if(!showBlockingProgress) return;
        const total=docTotal+assetsTotal;
        const frac=total>0?(docLoaded+assetsLoaded)/total:0;
        renderWorkerUploadProgress('מעלה ל-'+DOC_STORE+', נא לא לסגור…',20+Math.round(frac*70));
      };
      if(showBlockingProgress) renderWorkerUploadProgress('מעלה ל-'+DOC_STORE+', נא לא לסגור…',20);
      // saveWorkerDoc (the PDF) and saveWorkerAssets (the scan/signature
      // sidecar) write to two different Storage files and don't depend on each
      // other's result (the sidecar's own previousFileId is w.assetsFileId,
      // unrelated to the PDF's fileId) — fired concurrently (2026-09-27,
      // optimization) instead of one full round-trip after the other, since
      // this whole call runs behind a blocking "please wait" overlay for new
      // workers/rescans. Skipped on a regenerate (isRegen) same as before —
      // see the comment below that used to sit next to the sequential call.
      const docPromise=uploadWorkerFile(
        {action:'saveWorkerDoc',...gsAuth(),workerId:w&&w.id,fileBase64,fileName,mimeType:'application/pdf',previousFileId:(w&&w.docFileId)||null},
        (loaded?: any,total?: any)=>{ docLoaded=loaded; docTotal=total; reportUploadProgress(); });
      // Cache the scan+signature (and any extra pages — ספח appendix card,
      // contract, etc.) that actually built this PDF as a small private
      // Storage sidecar (never shown to anyone, just read back by
      // regenerateWorkerDoc()) — this is what lets a LATER edit (income
      // type, marital status, address, ...) rebuild the exact same PDF
      // with the new values without asking the manager to re-scan the
      // physical document. Best-effort: a failure here never rolls back
      // the main upload.
      // Skip this on a regenerate (isRegen): the scan/signature/extraPages
      // there came straight from loadWorkerAssets() a few seconds ago via
      // this SAME w.assetsFileId — re-uploading them as a "new" sidecar
      // would just be writing back the exact bytes just downloaded. A
      // background regenerate (triggered by editing one watched text
      // field, e.g. address) used to always pay for this redundant
      // multi-MB download-then-reupload round trip on top of the PDF
      // build itself, which is what made a single-field edit feel so slow.
      // ...except when the signature is new (drawn on an existing worker):
      // then the sidecar is written again so later rebuilds keep it — also
      // for a worker with no scan (a sidecar holding only the signature).
      const sigOnly=isRegen&&presetAssets.sigChanged;
      const assetsPromise=(w&&((scanImage&&!isRegen)||sigOnly))?uploadWorkerFile(
        {action:'saveWorkerAssets',...gsAuth(),workerId:w.id,
          scanB64:scanImage?scanImage.b64:'', scanMediaType:scanImage?scanImage.mediaType:'image/jpeg', sigPng:sigPng||null,
          extraPages:otherPagesToUse,
          fileNameBase:fileName.replace(/\.pdf$/,''), previousFileId:w.assetsFileId||null},
        (loaded?: any,total?: any)=>{ assetsLoaded=loaded; assetsTotal=total; reportUploadProgress(); }
      ).catch(()=>null):Promise.resolve(null);
      const [json,assetsJson]=await Promise.all([docPromise,assetsPromise]);
      if(!json||json.error) throw new Error((json&&json.error)||'The server did not answer');
      if(showBlockingProgress) renderWorkerUploadProgress('הועלה בהצלחה',100);
      if(w){
        w.docUrl=json.url; w.docSavedAt=new Date().toISOString(); w.docFileId=json.id;
        w.docUploadFailed=false;
        if(assetsJson&&assetsJson.ok) w.assetsFileId=assetsJson.id;
        // Completeness flags for workerDocStatus(): what this saved document
        // actually contains (on a regenerate these come from the sidecar).
        w.docHasSignature=!!sigPng;
        w.docExtraPages=Array.isArray(otherPagesToUse)?otherPagesToUse.length:0;
        render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); autoSave();
        showToast(tr('Documents of {0} saved to {1}',{0:(w.name||''),1:(DOC_STORE)}));
        window.__aiRescanWorkerId=null;
        if(contractPages.length) void saveScanContract(w,contractPages);
      } else showToast(tr('File saved to {0}',{0:(DOC_STORE)}));
    } else {
      const blob=new Blob([out],{type:'application/pdf'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url;
      a.download=fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
      showToast(tr('Form 101 downloaded'));
    }
    // After the success toast's own 2.5s, so the two don't overwrite each other.
    if(firmMissing.length) setTimeout(()=>showToast(tr('⚠ The firm profile is incomplete — empty in Form 101: {0}',{0:(firmMissing.join(', '))}),4000),2600);
    return true;
  }catch(err: any){
    console.error(err);
    showToast(tr('Failed: {0}',{0:(err&&err.message||'')}));
    // Flag it on the worker (if one's resolved) so the "no document" badge
    // in the workers list/card catches a silent background failure — the
    // toast alone is easy to miss, especially on mobile where a flaky
    // connection mid-upload is the most common trigger for this branch.
    if(mode==='upload'&&targetWorker){ targetWorker.docUploadFailed=true; autoSave(); render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); }
    return false;
  }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=btnLabel; } window.__aiPacketOtherPages=[]; window.__wCapturedSigPng=undefined; }
}

// Auto-generation right after a worker is created from a scan runs
// unattended — nobody is watching for the failure toast — so it gets one
// retry on failure (e.g. a transient CDN hiccup loading pdf-lib on a mobile
// connection) before leaving the "no document" badge (docUploadFailed) for
// the manager to notice and retry manually via "Rescan".
async function autoUploadWithRetry(isId?: any,workerId?: any){
  // aiFillForm101's finally clears the extra pages and the captured
  // signature — the retry gets them back so it builds the same PDF.
  const keep={pages:window.__aiPacketOtherPages, sig:window.__wCapturedSigPng};
  let ok=await aiFillForm101(isId,'upload',workerId,null);
  if(!ok){
    await new Promise((r?: any)=>setTimeout(r,1500));
    window.__aiPacketOtherPages=keep.pages; window.__wCapturedSigPng=keep.sig;
    ok=await aiFillForm101(isId,'upload',workerId,null);
  }
  return ok;
}

// Rebuilds and re-uploads a worker's Form-101 PDF using their CURRENTLY
// saved data (address, income type, marital status, health fund, ...)
// instead of what was true when the document was last generated — without
// asking the manager to re-scan the physical ID/passport. Reads the
// scan+signature back from the Storage sidecar saveWorkerAssets() cached at
// the last successful generation, when one exists (w.assetsFileId). This is
// the SAFE way to auto-regenerate on a background edit — unlike calling
// aiFillForm101 directly with no presetAssets (the "live" path), it never
// touches window.__aiScanImage/__aiPacketOtherPages, which could easily
// belong to a completely different worker's in-progress scan session. If
// there's no sidecar yet (a worker whose document has never been generated
// at all, or one predating this feature), it still proceeds — just with an
// empty scan/signature, producing a plain data-only PDF.
// newSigPng: a signature just drawn in the worker modal — it goes into this
// PDF and is stored in the sidecar for later rebuilds.
async function regenerateWorkerDoc(workerId?: any, newSigPng?: any){
  const w=workers.find((x?: any)=>x.id===workerId);
  if(!w) return false;
  try{
    let assets: any={scanB64:null,scanMediaType:null,sigPng:null,extraPages:[]};
    if(w.assetsFileId){
      const resp=await fetch(API_URL,{
        method:'POST',
        body:JSON.stringify({action:'loadWorkerAssets',...gsAuth(),fileId:w.assetsFileId})
      });
      const json=await resp.json();
      if(json&&json.ok) assets={scanB64:json.scanB64,scanMediaType:json.scanMediaType,sigPng:json.sigPng||null,extraPages:Array.isArray(json.extraPages)?json.extraPages:[]};
    }
    if(newSigPng){ assets.sigPng=newSigPng; assets.sigChanged=true; }
    const isId=w.docType!=='passport';
    return await aiFillForm101(isId,'upload',workerId,null,assets);
  }catch(e: any){ return false; }
}

// A firm whose details were edited from the Firms list while another firm
// was open: rebuild its workers' Form 101s once its data is loaded here.
function maybeRegenAfterFirmEdit(){
  const s=getSession(), t=s&&(s.viewingTenantId||s.tenantId);
  if(!t) return;
  let flag: any=null; try{ flag=localStorage.getItem('form101Regen:'+t); }catch(e: any){}
  if(!flag) return;
  try{ localStorage.removeItem('form101Regen:'+t); }catch(e: any){}
  refreshTenantProfile(0).then(()=>regenerateAllWorkerDocs());
}
// Firm-profile edits change every worker's Form 101 employer-details row
// (section א, פרטי המעסיק — company name/address/phone/deductions number),
// so every already-generated document is now stale, not just the one worker
// being edited. Sequential (not parallel) to avoid a burst of simultaneous
// PDF builds + Storage uploads when a firm
// has many workers. Only called for the firm currently loaded into
// `workers` (see firmSaved()) — there's nothing to regenerate for a
// firm whose schedule isn't the one open right now.
async function regenerateAllWorkerDocs(){
  const targets=workers.filter((w?: any)=>w.docUrl&&w.assetsFileId);
  if(!targets.length) return;
  let done=0, failed=0;
  for(const w of targets){
    const ok=await regenerateWorkerDoc(w.id);
    done++; if(!ok) failed++;
  }
  showToast(failed
    ? (tr('Documents updated: {0}/{1} (some failed — see the marks on the workers)',{0:(done-failed),1:(done)}))
    : (tr('Documents of all workers updated ({0})',{0:(done)})));
}

// ===== Form 101: fill the fillable template from AI-scanned document data =====
// The actual PDF filling (pdf-lib + fontkit + the Heebo font, all loaded
// client-side) moved server-side into a Python/PyMuPDF Cloud Function — see
// FORM101_FN_URL above and functions/main.py. This client only assembles the
// JSON payload now; the CDN loaders and Heebo font fetch that used to live
// here are gone along with the client-side build they supported.
