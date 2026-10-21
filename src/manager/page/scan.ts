// The manager page's own script, part "scan": the scan's entry points (the scanner, its reading into the worker window); Form 101's build and upload are part "form101".
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { SCAN_WARM_URLS, warmCloudFunctions } from '../logic/functions';
import { tr } from '../logic/i18n';
import { workerDocId } from '../logic/workers';
import { openScanner } from '../../scan/open';
import type { ScannedPage } from '../../scan/Scanner';
import { readScan, resetScan, sessionPages } from '../../scan-process/session';
import { workerFields } from '../../scan-process/worker';
import { showToast } from '../toast';
Object.defineProperties(window, {
  "openWorkerModalFromScan": {get: () => openWorkerModalFromScan, configurable: true},
  "startNewScan": {get: () => startNewScan, configurable: true},
});

// --- Upload preparation (shared by every file upload) -------------------------
// downscaleForUpload(), fileToUploadPages(), filesToUploadPages(),
// fileForStorage(), _loadPdfJs() are src/manager/logic/uploads.ts (CLAUDE.md →
// Uploads).

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
    found=await readScan(list.map(p=>({b64:p.b64,mediaType:p.mediaType,kind:p.kind||null,upright:p.turn>=0||!!p.kind,...(p.mrz?{mrz:p.mrz}:{})})),progress);
    return found?null:tr('No ID card or passport was found in the pages — add a photo of one');
  }});
  if(!pages||!found) return;
  openWorkerModalFromScan(found.record,found.reads);
}
// The scan's record into the worker window (scan-process/worker.ts gives the
// fields). A rescan of an existing worker (window.__aiRescanWorkerId, set by
// the worker window) reopens THAT worker with the scan's
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
