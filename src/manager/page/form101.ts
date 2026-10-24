// The manager page's own script, part "form101": Form 101's build and upload
// (aiFillForm101 — the values from the worker record, functions/main.py
// builds the PDF), its retry, the rebuild from the stored pages and signature
// (data/pages.ts) after an edit or a firm profile change, and the scan's contract pages saved to the
// worker's documents. Split from part "scan" (React migration 8f); the values
// sent are `form101Payload` (logic/form101.ts). Its top-level functions stay
// reachable under their old global names through the window accessors below
// (the other parts and the browser tests use them).
import { FORM101_FN_URL } from '../logic/functions';
import { tr } from '../logic/i18n';
import { DOC_STORE } from '../logic/workers';
import { firmProfileMissing } from '../logic/admin';
import { loadFirestoreBackend, uploadWorkerFile } from '../data/api';
import { getSession, gsAuth } from '../data/session';
import { applySavedPages, hasStoredAssets, loadStoredAssets, saveScanPages } from '../data/pages';
import { reportError, reportTiming } from '../data/telemetry';
import { autoSave } from '../data/store';
import { refreshTenantProfile } from './admin';
import { renderWorkerUploadProgress } from './worker-window';
import { render } from './render';
import { renderWorkersPage } from './workers';
import { imagesToPdf } from '../../scan/pdf';
import { showToast } from '../toast';
import { bridge } from '../bridge';
import { form101Payload } from '../logic/form101';
Object.defineProperties(window, {
  // @ts-ignore — reassigned from outside (a wrapper or a test's stub)
  "autoUploadWithRetry": {get: () => autoUploadWithRetry, set: (v: any) => { autoUploadWithRetry = v; }, configurable: true},
  "regenerateWorkerDoc": {get: () => regenerateWorkerDoc, configurable: true},
  "maybeRegenAfterFirmEdit": {get: () => maybeRegenAfterFirmEdit, configurable: true},
  "regenerateAllWorkerDocs": {get: () => regenerateAllWorkerDocs, configurable: true},
});

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
    bridge().addDocs(w.id,[doc]); // clears contractUploadFailed
    showToast(tr('The contract ({0} pages) was added to the documents of {1}',{0:pages!.length,1:w.name||''}));
  }catch(e: any){
    showToast(tr('The contract could not be saved: {0} — add it from Add document',{0:(e&&e.message)||String(e)}),5000);
    reportError('saveScanContract: '+((e&&e.message)||e),'saveScanContract','');
    const live=workers.find((x?: any)=>x.id===w.id);
    if(live){ live.contractUploadFailed=true; autoSave(); render(); renderWorkersPage(); }
  }
}

// The signature for Form 101 is drawn in the worker window (the shared
// SignaturePad, src/manager/WorkerEditor.tsx); its save hands the PNG over in
// window.__wCapturedSigPng before the upload, and aiFillForm101 reads it here.
function getSignaturePng(){ return window.__wCapturedSigPng ?? null; }

// Builds a worker's Form 101 (functions/main.py) and uploads it with the pages
// and signature it was built from. Two paths:
// - live (no presetAssets): a new worker or a worker rescanned in this session —
//   the scan image, the extra pages (window.__aiPacketOtherPages) and the
//   signature drawn in the worker window (window.__wCapturedSigPng) are read
//   into locals before the first await, and only this path clears them at the
//   end; the worker window shows the upload progress.
// - rebuild (presetAssets {scanB64,scanMediaType,sigPng,extraPages}, set only by
//   regenerateWorkerDoc() below): the scan, the signature and the pages come
//   from the worker's stored pages (data/pages.ts); the live globals are never
//   read nor cleared — they may belong to another worker being scanned now.
// Every plain data field (name / address / marital…) comes from the worker
// record, written by the worker window's save before this runs.
async function aiFillForm101(isId?: any,workerId?: any,presetAssets?: any){
  const isRegen=!!presetAssets;
  // The live values, taken before any await (a rebuild finishing meanwhile must not change them).
  const liveSig=isRegen?null:getSignaturePng();
  const liveOthers: any[]=isRegen?[]:(Array.isArray(window.__aiPacketOtherPages)?window.__aiPacketOtherPages:[]);
  const liveScan=isRegen?null:window.__aiScanImage;
  const rescanId=isRegen?null:window.__aiRescanWorkerId;
  // Only the live path (a new worker / a rescan) shows its progress in the worker window.
  const showBlockingProgress=!isRegen;
  // Hoisted above the try so the catch block can still flag this worker's failed upload.
  const targetWorker=(workerId||rescanId)?workers.find((x?: any)=>x.id===(workerId||rescanId)):null;
  // Reported once the PDF is out: this runs after the worker window has closed or in the background.
  let firmMissing: any=[];
  try{
    // The PDF itself is built server-side (functions/main.py, PyMuPDF); this gathers the values.
    const profile=await refreshTenantProfile(5*60*1000);
    firmMissing=firmProfileMissing(profile);

    const payload: any=form101Payload(targetWorker, isId, profile);

    // The signature ("חתימת המבקש/ת"): a rebuild reuses the stored one (sigFileId) or a newly drawn one.
    let sigPng=isRegen?(presetAssets.sigPng||null):liveSig;
    const scanImage=isRegen?(presetAssets.scanB64?{b64:presetAssets.scanB64,mediaType:presetAssets.scanMediaType}:null):liveScan;
    let otherPagesToUse=isRegen?(Array.isArray(presetAssets.extraPages)?presetAssets.extraPages:[]):liveOthers;
    // A rescan that recaptured only the main page keeps the extra pages (ספח…) and the
    // signature already stored (keep.others / keep.sig).
    const keep: any=isRegen?{front:true,others:true,sig:!presetAssets.sigChanged}:{};
    if(!isRegen&&(!otherPagesToUse.length||!sigPng)&&hasStoredAssets(targetWorker)){
      try{
        const old=await loadStoredAssets(targetWorker);
        if(old&&!otherPagesToUse.length&&old.extraPages.length){ otherPagesToUse=old.extraPages; keep.others=true; }
        if(old&&!sigPng&&old.sigPng){ sigPng=old.sigPng; keep.sig=true; }
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

    // A worker with signed documents keeps its signed Form 101 (never built again): a rescan stores only its pages.
    const keepSigned=!!(targetWorker&&targetWorker.signedAt);
    const f101t0=Date.now();
    // The function lets in only a signed-in manager-side login (functions/gate.py).
    const idToken=await (await loadFirestoreBackend()).idToken();
    const fnResp=keepSigned?new Response(JSON.stringify({pdfBase64:'',fileName:'signed.pdf'})):await fetch(FORM101_FN_URL,{method:'POST',headers:idToken?{'Content-Type':'application/json',Authorization:'Bearer '+idToken}:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const fnJson=await fnResp.json();
    if(!fnResp.ok||fnJson.error) throw new Error(fnJson.error||'Could not build the PDF');
    // Admin → Timings, kind "form101": what each generated form carried —
    // flags and counts only, no personal data.
    try{ reportTiming('form101',Date.now()-f101t0,{regen:isRegen,docType:isId?'israeli_id':'passport',
      spouse:!!payload.spouse,spouseNames:!!(payload.spouse&&(payload.spouse.surname||payload.spouse.given)),
      children:(payload.children||[]).length,marital:payload.marital||'',extraPages:(payload.extraPages||[]).length}); }catch(e: any){}
    const fileName=fnJson.fileName;

    // The document type the PDF was built for (the worker window's save passes the type it saved).
    if(targetWorker) targetWorker.docType=isId?'israeli_id':'passport';

    // previousFileId lets the backend trash the exact old file (the name in fileName can drift between scans).
    const fileBase64=fnJson.pdfBase64;
    const w=targetWorker;
    // Progress: the PDF and the pages upload at once, combined by total bytes, in the 20–90% range.
    let docLoaded=0,docTotal=0,assetsLoaded=0,assetsTotal=0;
    const uploadingLabel=tr('Uploading to {0}, please do not close…',{0:DOC_STORE});
    const reportUploadProgress=()=>{
      if(!showBlockingProgress) return;
      const total=docTotal+assetsTotal;
      const frac=total>0?(docLoaded+assetsLoaded)/total:0;
      renderWorkerUploadProgress(uploadingLabel,20+Math.round(frac*70));
    };
    if(showBlockingProgress) renderWorkerUploadProgress(uploadingLabel,20);
    const docPromise=keepSigned?Promise.resolve({ok:true,kept:true} as any):uploadWorkerFile(
      {action:'saveWorkerDoc',...gsAuth(),workerId:w&&w.id,fileBase64,fileName,mimeType:'application/pdf',previousFileId:(w&&w.docFileId)||null},
      (loaded?: any,total?: any)=>{ docLoaded=loaded; docTotal=total; reportUploadProgress(); });
    // The scan's pages and the signature that built this PDF are kept under the worker
    // (docs/contracts.md → Scanned pages), so a later edit rebuilds the same PDF. Best-effort.
    // A rebuild stores nothing — its pages came from Storage — except a new signature,
    // or the pages of a worker still on the old sidecar, which are split into pages then.
    const legacy=!!(w&&w.assetsFileId);
    const sigNew=!!sigPng&&!keep.sig;
    const storePages=!!w&&((!!scanImage&&!isRegen)||sigNew||(isRegen&&legacy));
    const pagesPromise=storePages?saveScanPages(w,
      {front:scanImage?{b64:scanImage.b64,mediaType:scanImage.mediaType,kind:(scanImage as any).kind}:null,others:otherPagesToUse,sigPng:sigPng||null},
      keep,(loaded?: any,total?: any)=>{ assetsLoaded=loaded; assetsTotal=total; reportUploadProgress(); }
    ).catch(()=>null):Promise.resolve(null);
    const [json,saved]=await Promise.all([docPromise,pagesPromise]);
    if(!json||json.error) throw new Error((json&&json.error)||'The server did not answer');
    if(showBlockingProgress) renderWorkerUploadProgress(tr('Uploaded successfully'),100);
    if(w){
      if(!json.kept){ w.docUrl=json.url; w.docSavedAt=new Date().toISOString(); w.docFileId=json.id; }
      w.docUploadFailed=false;
      if(saved) applySavedPages(w,saved);
      // Completeness flags for workerDocStatus(): what this saved document contains.
      if(!json.kept){ w.docHasSignature=!!sigPng; w.docExtraPages=Array.isArray(otherPagesToUse)?otherPagesToUse.length:0; }
      render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); autoSave();
      showToast(tr('Documents of {0} saved to {1}',{0:(w.name||''),1:(DOC_STORE)}));
      // The rescan target is cleared only by the live upload it was for.
      if(!isRegen&&window.__aiRescanWorkerId===rescanId) window.__aiRescanWorkerId=null;
      if(contractPages.length) void saveScanContract(w,contractPages);
    } else showToast(tr('File saved to {0}',{0:(DOC_STORE)}));
    // After the success toast's own 2.5s, so the two don't overwrite each other.
    if(firmMissing.length) setTimeout(()=>showToast(tr('⚠ The firm profile is incomplete — empty in Form 101: {0}',{0:(firmMissing.join(', '))}),4000),2600);
    return true;
  }catch(err: any){
    console.error(err);
    showToast(tr('Failed: {0}',{0:(err&&err.message||'')}));
    // Flag it on the worker so the "no document" badge catches a silent background failure.
    if(targetWorker){ targetWorker.docUploadFailed=true; autoSave(); render(); if(typeof renderWorkersPage==='function') renderWorkersPage(); }
    return false;
  }
  finally{
    // Only the live path owns the live scan's pages and the drawn signature.
    if(!isRegen){ window.__aiPacketOtherPages=[]; window.__wCapturedSigPng=undefined; }
  }
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
  let ok=await aiFillForm101(isId,workerId);
  if(!ok){
    await new Promise((r?: any)=>setTimeout(r,1500));
    window.__aiPacketOtherPages=keep.pages; window.__wCapturedSigPng=keep.sig;
    ok=await aiFillForm101(isId,workerId);
  }
  return ok;
}

// Rebuilds and re-uploads a worker's Form-101 PDF using their CURRENTLY
// saved data (address, income type, marital status, health fund, ...)
// instead of what was true when the document was last generated — without
// asking the manager to re-scan the physical ID/passport. Reads the pages and
// the signature back from Storage (loadStoredAssets, data/pages.ts) when the
// worker has them. This is the SAFE way to auto-regenerate on a background
// edit — unlike calling aiFillForm101 directly with no presetAssets (the
// "live" path), it never touches window.__aiScanImage/__aiPacketOtherPages,
// which could easily belong to a completely different worker's in-progress
// scan session. With nothing stored (a worker whose document has never been
// generated at all) it still proceeds — just with an empty scan/signature,
// producing a plain data-only PDF.
// newSigPng: a signature just drawn in the worker modal — it goes into this
// PDF and is stored for later rebuilds.
async function regenerateWorkerDoc(workerId?: any, newSigPng?: any){
  const w=workers.find((x?: any)=>x.id===workerId);
  if(!w) return false;
  // A signed Form 101 is never built again (docs/contracts.md → Signing): it changes only by a new signing.
  if(w.signedAt) return true;
  try{
    let assets: any={scanB64:null,scanMediaType:null,sigPng:null,extraPages:[]};
    if(hasStoredAssets(w)){
      // Not read (a network error): no rebuild — a PDF without its pages would replace the good one.
      const got=await loadStoredAssets(w);
      if(!got) return false;
      assets=got;
    }
    if(newSigPng){ assets.sigPng=newSigPng; assets.sigChanged=true; }
    const isId=w.docType!=='passport';
    return await aiFillForm101(isId,workerId,assets);
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
  const targets=workers.filter((w?: any)=>w.docUrl&&hasStoredAssets(w)&&!w.signedAt);
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
