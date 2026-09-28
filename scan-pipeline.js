// scan-pipeline.js — AI document-scan pipeline for schedule-manager.html,
// lazy-loaded on demand (added 2026-09-28, optimization) — see
// ensureScanPipelineLoaded() in schedule-manager.html for the loader and
// CLAUDE.md's "Lazy-loaded scan pipeline" note for the full design.
// This file shares the SAME global scope as schedule-manager.html once
// loaded (a plain <script src>, not an ES module) — every function here is
// a normal global, exactly as if it were still inline in the main file, and
// it freely calls shared helpers (esc, showToast, GS_URL, API_SECRET,
// gsAuth, AVATAR_SIZE, ...) that live there. Do not add import/export here;
// see CLAUDE.md's "No modules/imports" convention.

// ===== AI Document Scanner (Anthropic Vision via Apps Script proxy) =====
function openAiScan(){
  document.getElementById('aiScanOverlay').classList.add('open');
  // New scan session — the "review pages" screen (renderScanPagesPrompt)
  // accumulates into these across possibly several photos (front + ספח +
  // ...), so they must start empty every time the overlay opens, not just
  // on the individual onScanFilesSelected()/onScanFileSelected() resets.
  window.__aiScanPageThumbs=[];
  window.__aiPrimaryParsed=null;
  window.__aiPageParsed=[];
  window.__pendingScanPages=[]; // not-yet-processed crops queued by processAllPendingPages() — see its own comment
  document.getElementById('aiScanStage').innerHTML=`
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn sm" onclick="document.getElementById('aiScanFile').click()">
        <i class="ti ti-camera"></i> העלה תמונה / PDF
      </button>
      <input type="file" id="aiScanFile" accept="image/*,application/pdf,.pdf" multiple
        style="display:none" onchange="onScanFilesSelected(this.files)">
      <div style="font-size:12px;color:var(--text3);line-height:1.5">
        תומך ב: דרכון זר, תעודת זהות ישראלית (שני הצדדים), סריקת PDF.
        אפשר לצלם את הדרכון בשלמותו — ה-AI ימצא את השדות בעצמו.
        אפשר לבחור כמה קבצים בבת אחת (חבילה מוכנה של טופס 101 + דרכון + חוזה) —
        טופס 101 ישן בחבילה יוחלף בשלנו, השאר יישמר כמו שהוא.
      </div>
    </div>`;
}

// Straightens/crops the scanned photo using the AI's reported rotation +
// bounding box (imageAlign, from aiReadDoc) — a phone photo of a document is
// rarely perfectly level or tightly framed, and this is what actually ends
// up embedded as the extra page in Form 101. Canvas 2D only does affine
// transforms (no true perspective correction for an angled shot), so this
// covers the common case — sideways/upside-down photos and loose framing —
// not a fully skewed/keystoned one. Falls back to the untouched image on any
// failure (missing data, load error, degenerate crop).
function alignScanImage(b64,mediaType,align){
  return new Promise(resolve=>{
    if(!align){ resolve({b64,mediaType}); return; }
    const img=new Image();
    img.onload=()=>{
      try{
        const iw=img.naturalWidth, ih=img.naturalHeight;
        const c=align.crop||{};
        const clamp01=v=>Math.max(0,Math.min(1,typeof v==='number'?v:0));
        const x0=clamp01(c.x0)*iw, y0=clamp01(c.y0)*ih;
        const x1=clamp01(c.x1!=null?c.x1:1)*iw, y1=clamp01(c.y1!=null?c.y1:1)*ih;
        const cw=x1-x0, ch=y1-y0;
        if(!(cw>4&&ch>4)) throw new Error('degenerate crop');
        const rotate=[0,90,180,270].includes(align.rotate)?align.rotate:0;
        const swap=rotate===90||rotate===270;
        const cv=document.createElement('canvas');
        cv.width=Math.round(swap?ch:cw); cv.height=Math.round(swap?cw:ch);
        const ctx=cv.getContext('2d');
        ctx.translate(cv.width/2,cv.height/2);
        ctx.rotate(rotate*Math.PI/180);
        ctx.drawImage(img,x0,y0,cw,ch,-cw/2,-ch/2,cw,ch);
        resolve({b64:cv.toDataURL('image/jpeg',0.92).split(',')[1],mediaType:'image/jpeg'});
      }catch(e){ resolve({b64,mediaType}); }
    };
    img.onerror=()=>resolve({b64,mediaType});
    img.src='data:'+mediaType+';base64,'+b64;
  });
}

// Entry point for the file picker (now `multiple`). A single non-PDF file
// (the common case — one phone photo of an ID/passport) keeps the exact
// existing single-photo flow (onScanFileSelected below), including the
// manual crop/align editor. Anything else — a PDF (one or more pages) or
// several files at once — is treated as a "ready packet": every page of
// every file is expanded, classified, and reassembled in aiFillForm101()
// (a fresh Form 101 is always generated there; any old Form-101-looking
// page found here is simply dropped, never reused).
async function onScanFilesSelected(fileList){
  const files=[...(fileList||[])];
  if(!files.length) return;
  window.__aiScanImage=null;
  window.__aiPacketOtherPages=[];
  window.__aiPageParsed=[];
  window.__aiAvatarB64=null;
  const isPdf=f=>f.type==='application/pdf'||/\.pdf$/i.test(f.name||'');
  if(files.length===1 && !isPdf(files[0])) return onScanFileSelected(files[0]);

  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>קורא קבצים…</span></div>';
  try{
    await _loadPdfJs();
    // Expand every selected file into a flat, ordered list of page images
    // ({b64, mediaType, text}) — text (from pdf.js's own text layer, free/
    // local) is only used to spot an already-filled Form 101 page below.
    const items=[];
    for(const file of files){
      if(isPdf(file)){
        const buf=await file.arrayBuffer();
        const pdf=await pdfjsLib.getDocument({data:buf}).promise;
        for(let n=1;n<=pdf.numPages;n++){
          const page=await pdf.getPage(n);
          const vp=page.getViewport({scale:2.5});
          const cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
          await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
          let text='';
          try{ const tc=await page.getTextContent(); text=tc.items.map(it=>it.str).join(' '); }catch(e){}
          items.push({b64:cv.toDataURL('image/png').split(',')[1], mediaType:'image/png', text});
        }
      } else {
        const b64=await new Promise((res,rej)=>{
          const r=new FileReader();
          r.onload=()=>res(r.result.split(',')[1]);
          r.onerror=rej; r.readAsDataURL(file);
        });
        items.push({b64, mediaType:file.type||'image/jpeg', text:''});
      }
    }
    // Classify: drop pages that are already a filled Form 101 (we always
    // generate our own, see aiFillForm101), find the first ID/passport page
    // for the worker card, keep everything else ("contract" etc.) as-is.
    let foundParsed=null;
    // An Israeli ID's biometric fields (dob, sex) live on the FRONT card, while
    // address/city/children live on a separate ספח (appendix) card — either one
    // can end up first in a multi-file selection. Originally this only checked
    // for missing address/city, so a ספח-first upload (front card and back card
    // as two separate files, ספח photographed/selected first) set foundParsed
    // from the ספח alone — which already has address+city — so `sefachNeeded`
    // came back false immediately and the actual front card was never sent
    // through aiReadDoc at all: dob/sex silently stayed blank even though the
    // front card was right there in "other pages". Generalized to track ANY
    // missing core field (not just address/city) and keep checking subsequent
    // pages — regardless of which physical card came first — merging in
    // whatever each one contributes, until every core field is filled or pages
    // run out. Foreign passports carry all their fields on one page, so this
    // never fires for that path (nothing is ever missing after the first hit).
    // CORE_FIELDS/missingCore are module-scope now (shared with
    // processAllPendingPages() below) — see their own comment.
    let needMore=false;
    const otherPages=[];
    for(let i=0;i<items.length;i++){
      const it=items[i];
      stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
        +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
        +'<span>קורא עמוד '+(i+1)+' מתוך '+items.length+'…</span></div>';
      if(/כרטיס\s*עובד|0101\/130/.test(it.text||'')) continue; // старая Форма 101 — отбрасываем
      let thisPageParsed=null;
      if(!foundParsed){
        try{
          const resp=await fetch(GS_URL,{method:'POST',body:JSON.stringify({action:'aiReadDoc',secret:API_SECRET,...gsAuth(),image:it.b64,mediaType:it.mediaType})});
          const json=await resp.json();
          const p=json&&json.parsed;
          if(p&&(p.type==='israeli_id'||p.type==='passport')){
            // Same zoomed-in digit re-check as the single-photo path (runOcr) —
            // a wrong ID/date digit is just as costly whether it came from one
            // photo or a multi-file packet.
            foundParsed=p.fieldBoxes?await verifyDigitFields(p,it.b64,it.mediaType):p;
            foundParsed=await verifyIdChecksum(foundParsed,it.b64,it.mediaType);
            window.__aiScanImage={b64:it.b64,mediaType:it.mediaType};
            window.__aiAvatarB64=p.photoBox?await cropPortraitAvatar(it.b64,it.mediaType,p.photoBox):null;
            needMore=missingCore(foundParsed);
            window.__aiPageParsed=[foundParsed]; // primary page's own data — parallel to __aiScanImage
            continue; // эта страница уже сохранена как window.__aiScanImage, в "прочие" не дублируем
          }
        }catch(e){ console.error(e); }
      } else if(needMore){
        try{
          const resp=await fetch(GS_URL,{method:'POST',body:JSON.stringify({action:'aiReadDoc',secret:API_SECRET,...gsAuth(),image:it.b64,mediaType:it.mediaType})});
          const json=await resp.json();
          const p=json&&json.parsed;
          if(p&&p.type==='israeli_id'){
            // Reuse the same field list/merge the single-page-at-a-time flow
            // uses (ID_CORE_FIELDS/mergeIsraeliIdFields), not just the four
            // fields CORE_FIELDS/missingCore tracks for "keep looking at more
            // pages" — this page's own read (p) already has houseNumber/
            // maritalStatus available whenever it was worth OCR'ing at all,
            // and the old hand-rolled loop here dropped both silently.
            foundParsed=mergeIsraeliIdFields(foundParsed,p);
            thisPageParsed=p;
            // The ID number is also printed on the ספח, but per user feedback a
            // raw cross-page OCR disagreement isn't itself warning-worthy — the
            // ספח's own single read hasn't been through the same zoomed
            // re-verification as foundParsed.idNo, so a mismatch here is more
            // likely a ספח misread than a real problem. The existing checksum
            // check (verifyIdChecksum, already run on foundParsed above) is the
            // one signal that actually surfaces a warning; not duplicated here.
          }
          needMore=missingCore(foundParsed);
          // Note: no `continue` here even when this page's data got merged —
          // this page's own photo (commonly the ספח) still needs to fall
          // through to the otherPages.push() below so it's kept in the
          // assembled PDF. It used to be silently discarded once its data
          // was merged in, so the ספח was read but never actually saved.
        }catch(e){ console.error(e); }
      }
      // Kept parallel to otherPages (both pushed exactly once per loop
      // iteration that reaches here) so removeExtraScanPage() can rebuild
      // foundParsed from scratch after a page is dropped — see
      // rebuildPrimaryFromPages(). null for a page never sent through OCR.
      window.__aiPageParsed.push(thisPageParsed);
      otherPages.push({b64:it.b64,mediaType:it.mediaType});
    }
    window.__aiPacketOtherPages=otherPages;
    if(!foundParsed){
      stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">לא נמצאה תעודת זהות/דרכון בקבצים שהועלו<br><br>'
        +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
      return;
    }
    window.__aiParsed=foundParsed;
    window.__aiPrimaryParsed=foundParsed;
    // Feeds the same review screen the single-page loop (finishPageScan)
    // uses, so a batch selection (e.g. front+ospח chosen together from the
    // gallery) can still add further pages or just finish from there,
    // instead of jumping straight into the worker modal.
    window.__aiScanPageThumbs=[window.__aiScanImage,...otherPages];
    renderScanPagesPrompt();
  }catch(err){
    console.error(err);
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאה: '
      +(err&&err.message||'')+'<br><br>'
      +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
  }
}

// Step 1 of the single-photo scan flow: turn one picked photo/PDF page into
// a plain image and hand it straight to the manual corner-adjustment editor
// — no server call at all yet. The cropped result is queued (see
// confirmScanQuad's __scanEditPurpose==='collectPage' branch) rather than
// processed immediately; processAllPendingPages() sends the whole queue
// through preAlignScan/OCR together once the user is done adding pages.
// Reached either directly (a single non-PDF file), as "Заново" from the
// multi-file flow above, or from the pending/review screens' own "add page"
// buttons (renderPendingPagesPrompt/renderScanPagesPrompt).
async function onScanFileSelected(file){
  if(!file) return;
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>מעלה תמונה…</span></div>';
  try{
    const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name||'');
    let b64, mediaType;
    if(isPdf){
      await _loadPdfJs();
      const buf=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:buf}).promise;
      const page=await pdf.getPage(1);
      const vp=page.getViewport({scale:2.5});
      const cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
      await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
      b64=cv.toDataURL('image/png').split(',')[1]; mediaType='image/png';
    } else {
      b64=await new Promise((res,rej)=>{
        const r=new FileReader();
        r.onload=()=>res(r.result.split(',')[1]);
        r.onerror=rej; r.readAsDataURL(file);
      });
      mediaType=file.type||'image/jpeg';
    }
    ({b64,mediaType}=await downscaleForUpload(b64,mediaType));
    // Manual crop/straighten runs BEFORE any server call (moved 2026-09-26,
    // per user request) — the editor works on the raw downscaled photo (no
    // contrast/sharpness boost yet, no upload). window.__scanEditPurpose=
    // 'collectPage' tells confirmScanQuad()/skipScanQuad() below to just add
    // the cropped result to window.__pendingScanPages and show the pending-
    // pages queue (renderPendingPagesPrompt) — NOT to send anything to the
    // server yet. This lets the user crop as many pages as they want (front
    // card, ספח, contract, ...) with zero network calls in between; only
    // processAllPendingPages() (triggered by that screen's "process" button)
    // sends the whole queue through preAlignScan/aiReadDoc, once, in one go.
    window.__scanEditPurpose='collectPage';
    renderScanQuadEditor(b64,mediaType,{tl:{x:0,y:0},tr:{x:1,y:0},br:{x:1,y:1},bl:{x:0,y:1}});
  }catch(err){
    console.error(err);
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאה: '
      +(err&&err.message||'')+'<br><br>'
      +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
  }
}
// Dedicated "just the ספח" path — bypasses aiReadDoc's type:"israeli_id" vs
// "passport" classification entirely by calling the narrow aiReadSefach
// backend action instead, which already knows it's looking at an address
// side and never has to guess a document type. Added because aiReadDoc kept
// misclassifying the back of a biometric ID card (no photo/name on it)
// even after several rounds of prompt tweaks aimed at that classification —
// removing the need to classify is more robust than trying to make the
// classification itself more reliable. Mirrors onScanFileSelected exactly
// (blur-check pre-pass, then hand off to the AI call) — the actual merge-
// vs-primary decision and the corner-adjustment/perspective-warp step are
// shared with the general flow (runSefachOcr below hands off to the same
// renderScanQuadEditor()/confirmScanQuad()/finishPageScan() pipeline runOcr
// uses), so a ספח photo gets the exact same straightening treatment a
// passport/front photo does — it was previously finalized straight off the
// blur-check's rough crop, with no auto-align or manual corner fix at all.
async function onSefachFileSelected(file){
  if(!file) return;
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>מעלה תמונה…</span></div>';
  try{
    const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name||'');
    let b64, mediaType;
    if(isPdf){
      await _loadPdfJs();
      const buf=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:buf}).promise;
      const page=await pdf.getPage(1);
      const vp=page.getViewport({scale:2.5});
      const cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
      await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
      b64=cv.toDataURL('image/png').split(',')[1]; mediaType='image/png';
    } else {
      b64=await new Promise((res,rej)=>{
        const r=new FileReader();
        r.onload=()=>res(r.result.split(',')[1]);
        r.onerror=rej; r.readAsDataURL(file);
      });
      mediaType=file.type||'image/jpeg';
    }
    ({b64,mediaType}=await downscaleForUpload(b64,mediaType));
    const pre=await preAlignScan(b64,mediaType);
    if(pre.blurry){
      stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">התמונה מטושטשת מדי, צלמו שוב<br><br>'
        +'<button class="btn sm" onclick="renderScanPagesPrompt()">שוב</button></div>';
      return;
    }
    runSefachOcr(pre.b64,pre.mediaType);
  }catch(err){
    console.error(err);
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאה: '
      +(err&&err.message||'')+'<br><br>'
      +'<button class="btn sm" onclick="renderScanPagesPrompt()">שוב</button></div>';
  }
}
// aiReadSefach's own analog of runOcr() — same align/corner-editor handoff,
// just a narrower AI call and no digit-field/checksum re-verification (the
// ספח side has no ID number to verify). aiReadSefach's response always
// includes type:"israeli_id" (hardcoded server-side, not detected) so the
// shared finishPageScan()/mergeIsraeliIdFields() pipeline treats it exactly
// like any other israeli_id page once the user confirms the corner edit.
async function runSefachOcr(b64,mediaType){
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>קורא ספח…</span>'
    +'<div class="progress-bar"></div></div>';
  try{
    const resp=await fetch(GS_URL,{
      method:'POST',
      body:JSON.stringify({action:'aiReadSefach',secret:API_SECRET,...gsAuth(),image:b64,mediaType:mediaType})
    });
    const json=await resp.json();
    if(!json||json.error){
      stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאת AI: '
        +((json&&json.error)||'אין תגובה')+'<br><br>'
        +'<button class="btn sm" onclick="renderScanPagesPrompt()">שוב</button></div>';
      return;
    }
    window.__aiParsed=json.parsed;
    // Tags this result as "a ספח-only read" for finishPageScan() below — its
    // own idNo (if any) must never become authoritative on its own, only
    // used as a cross-check against a front page's verified idNo, since it
    // never went through verifyDigitFields/verifyIdChecksum the way a front
    // scan's idNo did.
    if(window.__aiParsed) window.__aiParsed.__isSefachScan=true;
    const align=json.parsed&&json.parsed.imageAlign;
    const rotateDeg=align&&[0,90,180,270].includes(align.rotate)?align.rotate:0;
    const upright=rotateDeg?await alignScanImage(b64,mediaType,{rotate:rotateDeg,crop:{x0:0,y0:0,x1:1,y1:1}}):{b64,mediaType};
    const corners=validQuadCorners(align&&align.corners)
      ? {tl:rotatePointFrac(align.corners.tl,rotateDeg),tr:rotatePointFrac(align.corners.tr,rotateDeg),
         br:rotatePointFrac(align.corners.br,rotateDeg),bl:rotatePointFrac(align.corners.bl,rotateDeg)}
      : {tl:{x:0,y:0},tr:{x:1,y:0},br:{x:1,y:1},bl:{x:0,y:1}};
    // Unlike onScanFileSelected's now-pre-OCR editor, this one still runs
    // AFTER the AI call (aiReadSefach already happened above) — tag it so
    // confirmScanQuad()/skipScanQuad() finish the page directly instead of
    // routing to runOcr(). No UI currently reaches this function (the
    // "הוסף ספח בלבד" button was removed 2026-09-21, kept working in case
    // it's re-added later), but it must stay correct either way.
    window.__scanEditPurpose='sefach';
    renderScanQuadEditor(upright.b64,upright.mediaType,corners);
  }catch(err){
    console.error(err);
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאה: '
      +(err&&err.message||'')+'<br><br>'
      +'<button class="btn sm" onclick="renderScanPagesPrompt()">שוב</button></div>';
  }
}

// Downscales a photo client-side, BEFORE it's ever uploaded anywhere, to the
// same ~1800px cap preprocess_scan already works at internally server-side
// (MAX_WORK_DIM in functions/main.py) — the server throws away anything
// above that resolution anyway, so uploading a full phone-camera-resolution
// photo first (often 3000-4000px+, several MB) is pure wasted upload time on
// the slowest leg of the whole pipeline (mobile network), only to have the
// server immediately shrink it. Never upscales (a photo already at or below
// the cap is returned untouched). Best-effort: any failure here just falls
// through to uploading the original image unchanged, so a hiccup never
// blocks the scan.
const UPLOAD_MAX_DIM=1800;
function downscaleForUpload(b64,mediaType){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const iw=img.naturalWidth, ih=img.naturalHeight;
        const scale=Math.min(1,UPLOAD_MAX_DIM/Math.max(iw,ih,1));
        if(scale>=1){ resolve({b64,mediaType}); return; }
        const cv=document.createElement('canvas');
        cv.width=Math.round(iw*scale); cv.height=Math.round(ih*scale);
        const ctx=cv.getContext('2d');
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,0,0,cv.width,cv.height);
        resolve({b64:cv.toDataURL('image/jpeg',0.9).split(',')[1],mediaType:'image/jpeg'});
      }catch(e){ resolve({b64,mediaType}); }
    };
    img.onerror=()=>resolve({b64,mediaType});
    img.src='data:'+mediaType+';base64,'+b64;
  });
}
// Step 1.4: a server-side OpenCV+Pillow pass (functions/main.py,
// preprocess_scan) that (a) rejects an obviously-too-blurry photo before any
// AI call is spent on it, and (b) contrast/sharpness-enhances what's left.
// Geometric auto-crop is defined server-side but deliberately dormant (see
// preprocess_scan_image's own comment in functions/main.py) — the user always
// crops by hand in renderScanQuadEditor instead.
// Moved (2026-09-26, per user request, for server economy) to run AFTER the
// user's own manual crop/warp instead of before: onScanFileSelected now hands
// the RAW downscaled photo straight to renderScanQuadEditor, and this
// function only runs once confirmScanQuad()/skipScanQuad() have already
// produced the small, cropped-to-just-the-document image — so its resize/
// enhance/blur-check all work over far fewer pixels than when they covered
// the whole photo including background. Returns {b64,mediaType} to proceed
// with, or {blurry:true} if the (already-cropped) photo should be rejected.
// NOTE: BLUR_VARIANCE_THRESHOLD in functions/main.py was calibrated against
// a full-frame photo, not a cropped-to-document one — the pixel population
// feeding the Laplacian-variance calc changed with this reorder, so that
// threshold may need re-verification against a real blurry photo cropped the
// same way, same as the pre-existing pre/post-enhancement calibration note.
async function preAlignScan(b64,mediaType){
  try{
    const resp=await fetch(PREPROCESS_SCAN_FN_URL,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({image:b64})
    });
    const json=await resp.json();
    if(!resp.ok||!json||json.error) return {b64,mediaType};
    if(json.reason==='blurry') return {blurry:true};
    if(!json.ok) return {b64,mediaType};
    return {b64:json.imageBase64,mediaType:json.mediaType||'image/jpeg'};
  }catch(e){
    console.error(e);
    return {b64,mediaType}; // network/decode hiccup — fall through fully unchanged
  }
}

// Step 1.5 — REVIVED 2026-09-26 (was dormant 2026-09-21 through today): a
// fast, cheap AI call (aiDetectAlign, Haiku) that reads ONLY the document's
// rotation and corners (no field extraction), then auto-straightens the
// photo — now called from processAllPendingPages() on each queued page,
// right before preAlignScan()'s classical-CV attempt. It was originally
// removed because the manual corner-adjustment editor runs before OCR now
// and the user positions the rectangle themselves, so an AI-guessed
// starting point seemed unnecessary — but real-world testing this same day
// showed manual crops routinely staying rough (card occupying ~20-35% of
// frame, not tightly boxed) and the classical OpenCV detector genuinely
// failing to find a clean document contour on an actual real photo (uneven
// background, real lighting) even after hardening — a vision-model read is
// inherently more robust on messy real photos than hand-tuned edge
// heuristics, and cheap enough (small prompt, no field extraction, Haiku)
// to run on every queued page. Best-effort: any failure here (network
// error, bad AI response, image decode failure) just falls through to the
// original image unchanged, so a hiccup here never blocks the scan.
async function autoPreAlignScan(b64,mediaType){
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>מיישר את התמונה…</span></div>';
  try{
    const resp=await fetch(GS_URL,{
      method:'POST',
      body:JSON.stringify({action:'aiDetectAlign',secret:API_SECRET,...gsAuth(),image:b64,mediaType:mediaType})
    });
    const json=await resp.json();
    const align=json&&json.ok&&json.align;
    if(!align) return {b64,mediaType};
    const rotateDeg=[0,90,180,270].includes(align.rotate)?align.rotate:0;
    const upright=rotateDeg?await alignScanImage(b64,mediaType,{rotate:rotateDeg,crop:{x0:0,y0:0,x1:1,y1:1}}):{b64,mediaType};
    if(!validQuadCorners(align.corners)) return upright;
    const corners={
      tl:rotatePointFrac(align.corners.tl,rotateDeg), tr:rotatePointFrac(align.corners.tr,rotateDeg),
      br:rotatePointFrac(align.corners.br,rotateDeg), bl:rotatePointFrac(align.corners.bl,rotateDeg)
    };
    const dims=await new Promise(res=>{
      const im=new Image();
      im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});
      im.onerror=()=>res(null);
      im.src='data:'+upright.mediaType+';base64,'+upright.b64;
    });
    if(!dims) return upright;
    const refined=await refineQuadCorners(upright.b64,upright.mediaType,corners);
    // Skip the warp+JPEG-re-encode entirely when the refined quad is already
    // the untouched full frame (2026-09-27, optimization) — a real scan photo
    // typically goes through several of these warp passes in sequence
    // (autoPreAlignScan -> refineWithAiAlign -> finalTightenPass -> the PDF
    // embed step's own resize), each one a needless JPEG generation-loss
    // round-trip when the corners describe no actual crop/rotation at all.
    if(_isNearIdentityQuad(refined)) return upright;
    const toPx=p=>({x:p.x*dims.w,y:p.y*dims.h});
    const quadPx={tl:toPx(refined.tl),tr:toPx(refined.tr),br:toPx(refined.br),bl:toPx(refined.bl),imgW:dims.w,imgH:dims.h};
    return await warpQuadImage(upright.b64,upright.mediaType,quadPx);
  }catch(e){
    console.error(e);
    return {b64,mediaType};
  }
}

// Crops a tight fractional box {x0,y0,x1,y1} (as reported by aiReadDoc's own
// "fieldBoxes", relative to the exact image bytes it was given) out of that
// same image, upscaling small crops so the AI sees the digits at a real
// pixel size instead of a handful of blurry pixels — same reasoning as the
// MAXDIM bump above, just applied to one field instead of the whole photo.
// Resolves null on any failure (bad box, decode error) — verifyField below
// treats that as "skip this field", never as an error to surface to the user.
function cropFieldImage(b64,mediaType,box){
  return new Promise(resolve=>{
    if(!box||typeof box.x0!=='number'||typeof box.x1!=='number'){ resolve(null); return; }
    const img=new Image();
    img.onload=()=>{
      try{
        const iw=img.naturalWidth, ih=img.naturalHeight;
        const clamp01=v=>Math.max(0,Math.min(1,typeof v==='number'?v:0));
        // A little margin around the model's own (tight) box — helps it read
        // digits that lean into the edge without including the field label.
        const mx=(box.x1-box.x0)*0.15, my=(box.y1-box.y0)*0.5;
        const x0=clamp01(box.x0-mx)*iw, y0=clamp01(box.y0-my)*ih;
        const x1=clamp01(box.x1+mx)*iw, y1=clamp01(box.y1+my)*ih;
        const cw=x1-x0, ch=y1-y0;
        if(!(cw>2&&ch>2)) throw new Error('degenerate field box');
        const MINW=500;
        const scale=Math.max(1,MINW/cw);
        const cv=document.createElement('canvas');
        cv.width=Math.round(cw*scale); cv.height=Math.round(ch*scale);
        const ctx=cv.getContext('2d');
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,x0,y0,cw,ch,0,0,cv.width,cv.height);
        resolve({b64:cv.toDataURL('image/png').split(',')[1],mediaType:'image/png'});
      }catch(e){ resolve(null); }
    };
    img.onerror=()=>resolve(null);
    img.src='data:'+mediaType+';base64,'+b64;
  });
}

// Crops the person's own portrait photo out of a document scan, given
// aiReadDoc's "photoBox" (same coordinate space/convention as fieldBoxes
// above, see cropFieldImage's comment). Unlike cropFieldImage (built for thin
// text-field strips), this pads modestly on all sides and forces a SQUARE
// output — expanding the shorter side around its own center, never
// stretching — so it looks right as a round avatar, then downsizes to
// AVATAR_SIZE and re-encodes as JPEG (a worker photo needs to render
// instantly in list rows, not stay full-resolution). Resolves null on any
// failure (missing/degenerate box, decode error) — same best-effort
// convention as cropFieldImage: never blocks or fails the scan.
function cropPortraitAvatar(b64,mediaType,box){
  return new Promise(resolve=>{
    if(!box||typeof box.x0!=='number'||typeof box.x1!=='number'){ resolve(null); return; }
    const img=new Image();
    img.onload=()=>{
      try{
        const iw=img.naturalWidth, ih=img.naturalHeight;
        const clamp01=v=>Math.max(0,Math.min(1,typeof v==='number'?v:0));
        const padX=(box.x1-box.x0)*0.1, padY=(box.y1-box.y0)*0.1;
        const x0=clamp01(box.x0-padX)*iw, y0=clamp01(box.y0-padY)*ih;
        const x1=clamp01(box.x1+padX)*iw, y1=clamp01(box.y1+padY)*ih;
        const cw=x1-x0, ch=y1-y0;
        if(!(cw>4&&ch>4)) throw new Error('degenerate photo box');
        const side=Math.min(Math.max(cw,ch),iw,ih);
        let sx0=x0-(side-cw)/2, sy0=y0-(side-ch)/2;
        sx0=Math.max(0,Math.min(iw-side,sx0)); sy0=Math.max(0,Math.min(ih-side,sy0));
        const cv=document.createElement('canvas');
        cv.width=AVATAR_SIZE; cv.height=AVATAR_SIZE;
        const ctx=cv.getContext('2d');
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,sx0,sy0,side,side,0,0,AVATAR_SIZE,AVATAR_SIZE);
        resolve(cv.toDataURL('image/jpeg',0.85).split(',')[1]);
      }catch(e){ resolve(null); }
    };
    img.onerror=()=>resolve(null);
    img.src='data:'+mediaType+';base64,'+b64;
  });
}

// One field's re-verification round-trip: crop -> aiVerifyField -> trimmed
// text or null. Never throws — a network/AI failure here just means this
// field's original aiReadDoc reading is kept, not blanked.
async function verifyField(b64,mediaType,box,kind){
  const crop=await cropFieldImage(b64,mediaType,box);
  if(!crop) return null;
  try{
    const resp=await fetch(GS_URL,{
      method:'POST',
      body:JSON.stringify({action:'aiVerifyField',secret:API_SECRET,...gsAuth(),image:crop.b64,mediaType:crop.mediaType,kind})
    });
    const json=await resp.json();
    return (json&&json.ok&&json.value)?json.value:null;
  }catch(e){ console.error(e); return null; }
}

// Batched sibling of verifyField (added 2026-09-28, optimization) — see
// aiVerifyFields' own server-side comment for why: this replaces N parallel
// aiVerifyField round-trips (N separate Apps Script executions) with one
// Apps Script call carrying all the crops. jobs: [{field,kind,box}, ...].
// Returns a plain {field: value} map; a field the model couldn't read (or a
// totally failed/malformed response) is simply absent, same as verifyField
// returning null for that field — callers already treat a missing value as
// "keep the original OCR reading."
async function verifyFieldsBatch(jobs,b64,mediaType){
  const crops=await Promise.all(jobs.map(j=>cropFieldImage(b64,mediaType,j.box)));
  const ready=jobs.map((j,i)=>({field:j.field,kind:j.kind,crop:crops[i]})).filter(j=>j.crop);
  if(!ready.length) return {};
  try{
    const resp=await fetch(GS_URL,{
      method:'POST',
      body:JSON.stringify({action:'aiVerifyFields',secret:API_SECRET,...gsAuth(),
        jobs:ready.map(j=>({field:j.field,kind:j.kind,image:j.crop.b64,mediaType:j.crop.mediaType}))})
    });
    const json=await resp.json();
    return (json&&json.ok&&json.values)?json.values:{};
  }catch(e){ console.error(e); return {}; }
}

// Israeli ID check-digit validation (Luhn-style, the government's own
// formula) — pure arithmetic, no AI call, instant and free. The 9th digit is
// derived from the first eight, so this catches most single-digit OCR
// misreads (the actual failure mode — a 3 read as an 8, say). It can't say
// WHICH digit is wrong, and a two-digit swap can occasionally still pass,
// so it's a strong signal, not a guarantee.
function isValidIsraeliId(id){
  if(!/^\d{9}$/.test(id)) return false;
  let sum=0;
  for(let i=0;i<9;i++){
    const step=Number(id[i])*((i%2)+1); // alternating weight 1,2,1,2,...
    sum+=step>9?step-9:step;
  }
  return sum%10===0;
}

// Cross-checks idNo against its own check digit after the digit-verification
// pass above. A pass needs no further action. A fail gets exactly one more
// targeted re-read of the same box (the check digit is free, so it's worth
// spending one more AI call trying to fix it automatically) — if that still
// doesn't check out, stop trying to fix it automatically and instead record
// `idChecksumOk:false` so the worker modal can flag the field for the human
// to look at, rather than silently keeping a number that's provably wrong.
async function verifyIdChecksum(parsed,b64,mediaType){
  if(!parsed||parsed.type!=='israeli_id'||!parsed.idNo) return parsed;
  if(isValidIsraeliId(parsed.idNo)){ parsed.idChecksumOk=true; return parsed; }
  if(parsed.fieldBoxes&&parsed.fieldBoxes.idNo){
    const retry=await verifyField(b64,mediaType,parsed.fieldBoxes.idNo,'digits9');
    if(retry&&/^\d{9}$/.test(retry)) parsed.idNo=retry;
  }
  parsed.idChecksumOk=isValidIsraeliId(parsed.idNo);
  return parsed;
}

// Re-verifies the pure-digit, form-critical fields (idNo/dob/expiry/
// passportNo) that aiReadDoc reported a fieldBoxes entry for, replacing the
// original value only when the zoomed-in re-read comes back in the expected
// shape (9 digits for an Israeli ID, DD/MM/YYYY for a date) — a malformed or
// empty re-read is discarded, keeping the original aiReadDoc value rather
// than risking overwriting a correct reading with a worse one. The (few)
// field checks go through ONE combined AI call (verifyFieldsBatch, 2026-09-28
// optimization — was Promise.all over separate verifyField calls, one Apps
// Script execution each; see verifyFieldsBatch's/aiVerifyFields' own
// comments for why that mattered).
async function verifyDigitFields(parsed,b64,mediaType){
  if(!parsed||!parsed.fieldBoxes) return parsed;
  const isDigits9=s=>typeof s==='string'&&/^\d{9}$/.test(s);
  const isDate=s=>typeof s==='string'&&/^\d{2}[\/.]\d{2}[\/.]\d{4}$/.test(s);
  const jobs=[];
  if(parsed.type==='israeli_id'){
    // Skip the zoomed idNo re-read when the RAW extraction already passes
    // its own Luhn-style check digit (isValidIsraeliId, below) — a passing
    // checksum on a plausible read is already a strong correctness signal
    // (a random OCR digit swap essentially never happens to still produce
    // a valid check digit), so this saves a whole AI round-trip in the
    // common case where the first read was already right. verifyIdChecksum()
    // still runs afterward and independently re-verifies/flags this exact
    // same way whether this job ran or not — nothing here weakens that check,
    // it just avoids redundantly re-confirming a number that's already
    // provably consistent.
    if(parsed.fieldBoxes.idNo && !isValidIsraeliId(parsed.idNo)) jobs.push({field:'idNo',kind:'digits9'});
    if(parsed.fieldBoxes.dob)  jobs.push({field:'dob',kind:'date'});
  } else if(parsed.type==='passport'){
    if(parsed.fieldBoxes.passportNo) jobs.push({field:'passportNo',kind:'passportNo'});
    if(parsed.fieldBoxes.dob)        jobs.push({field:'dob',kind:'date'});
    if(parsed.fieldBoxes.expiry)     jobs.push({field:'expiry',kind:'date'});
  }
  if(!jobs.length) return parsed;
  const values=await verifyFieldsBatch(jobs.map(j=>({field:j.field,kind:j.kind,box:parsed.fieldBoxes[j.field]})),b64,mediaType);
  jobs.forEach(j=>{
    const val=values[j.field];
    if(!val) return;
    if(j.kind==='digits9'){ if(isDigits9(val)) parsed[j.field]=val; }
    else if(j.kind==='date'){ if(isDate(val)) parsed[j.field]=val.replace(/\./g,'/'); }
    else { parsed[j.field]=val; } // passportNo — format varies by country, trust the trimmed re-read
  });
  return parsed;
}

// Step 2: send the (already auto-straightened) photo/page to the AI for
// full field extraction — it also proposes its own imageAlign, used below
// to pre-fill the manual corner editor for the final scan embedded in the PDF.
async function runOcr(b64,mediaType){
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>ה-AI קורא את המסמך…</span>'
    +'<div class="progress-bar"></div></div>';
  try{
    const resp=await fetch(GS_URL,{
      method:'POST',
      body:JSON.stringify({action:'aiReadDoc',secret:API_SECRET,...gsAuth(),image:b64,mediaType:mediaType})
    });
    const json=await resp.json();
    if(!json||json.error){
      stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאת AI: '
        +((json&&json.error)||'אין תגובה')+'<br><br>'
        +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
      return;
    }
    window.__aiParsed=json.parsed;
    // Only overwrite when THIS page actually yields a crop — in the
    // multi-page loop (finishPageScan) a later page (e.g. ספח, which has no
    // portrait photo) must not blank out an avatar already found on an
    // earlier page in the same session.
    if(json.parsed&&json.parsed.photoBox){
      const avatarCrop=await cropPortraitAvatar(b64,mediaType,json.parsed.photoBox);
      if(avatarCrop) window.__aiAvatarB64=avatarCrop;
    }
    // Re-verify the pure-digit, form-critical fields (ID number, dates) on a
    // tight zoomed-in crop of exactly where aiReadDoc says it read them — a
    // wrong digit here goes straight into a real Form 101, so this is worth
    // one extra small AI call per field even though the main read already
    // returned a value. Best-effort: never blocks the scan on failure, and
    // never blanks a field that already had a plausible value.
    if(json.parsed&&json.parsed.fieldBoxes){
      stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
        +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
        +'<span>בודק שוב את הספרות…</span></div>';
      window.__aiParsed=await verifyDigitFields(json.parsed,b64,mediaType);
    }
    window.__aiParsed=await verifyIdChecksum(window.__aiParsed,b64,mediaType);
    // No AI-seeded corner editor step here (removed 2026-09-21, per user
    // request) — the photo was already manually cropped/straightened BEFORE
    // this OCR call ran (see onScanFileSelected/confirmScanQuad), so
    // b64/mediaType already IS a usable, embed-ready image on its own.
    // aiReadDoc's own imageAlign (rotate+corners) comes back for free in
    // this SAME response — added 2026-09-21 as a fine TIGHTENING pass on top
    // of the user's own crop (never a replacement: refineWithAiAlign() below
    // falls back to the untouched b64/mediaType on any missing/implausible/
    // failed alignment), since by this point the user has already isolated
    // one document in frame — the AI can no longer confuse two documents the
    // way the removed OpenCV auto-crop used to.
    const finalImg=await refineWithAiAlign({b64,mediaType},json.parsed&&json.parsed.imageAlign);
    finishPageScan(finalImg);
  }catch(err){
    console.error(err);
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">שגיאה: '
      +(err&&err.message||'')+'<br><br>'
      +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
  }
}
// Sharpens the AI's rough corner guess the way a real scanner app does:
// walk short strips perpendicular to each of the 4 sides, find where the
// luminance jumps hardest (the true document/background edge) near each
// sample point, fit a line through those edge points per side, then recompute
// corners as line-line intersections. Pure client-side pixel math — no AI
// call — so it only makes an already-decent guess more precise; if a side's
// signal is too weak/noisy to trust (low contrast, busy background) that
// side's two corners just fall back to the original AI guess instead of
// risking a worse snap.
function refineQuadCorners(b64,mediaType,cornersFrac){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const REFDIM=1200;
        const scale=Math.min(1,REFDIM/Math.max(img.naturalWidth,img.naturalHeight,1));
        const w=Math.max(1,Math.round(img.naturalWidth*scale)), h=Math.max(1,Math.round(img.naturalHeight*scale));
        const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        const ctx=cv.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(img,0,0,w,h);
        const data=ctx.getImageData(0,0,w,h).data;
        const lum=(x,y)=>{
          x=Math.max(0,Math.min(w-1,Math.round(x))); y=Math.max(0,Math.min(h-1,Math.round(y)));
          const i=(y*w+x)*4;
          return 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
        };
        const toPx=p=>({x:p.x*w,y:p.y*h});
        const Q={tl:toPx(cornersFrac.tl),tr:toPx(cornersFrac.tr),br:toPx(cornersFrac.br),bl:toPx(cornersFrac.bl)};
        const SIDES=[['tl','tr'],['tr','br'],['br','bl'],['bl','tl']];
        // N/MARGIN/SEARCH widened and subpixel parabolic peak interpolation added
        // (2026-09-26, per user report of visible residual tilt/black sliver even
        // after this pass) — the original integer-step search snapped each edge
        // point to the nearest whole pixel, which on a card photographed at a
        // shallow angle can leave a fraction-of-a-degree bias per side that adds
        // up across the whole quad into a visibly crooked result; more samples
        // per side (12->20) and a slightly tighter margin (0.18->0.12, sampling
        // closer to the true corners) also give the line fit more/better data.
        const N=20, MARGIN=0.12, SEARCH=Math.round(Math.max(w,h)*0.04)+6;
        const sidePoints={};
        for(const [a,b] of SIDES){
          const A=Q[a],B=Q[b];
          const dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy)||1;
          const nx=-dy/len, ny=dx/len; // unit normal, perpendicular to this side
          const pts=[];
          for(let i=0;i<N;i++){
            const t=MARGIN+(1-2*MARGIN)*(i/(N-1));
            const px=A.x+dx*t, py=A.y+dy*t;
            const grads=[];
            for(let s=-SEARCH;s<=SEARCH;s++){
              grads.push(Math.abs(lum(px+nx*(s+1),py+ny*(s+1))-lum(px+nx*(s-1),py+ny*(s-1))));
            }
            // Nearest-qualifying-peak selection (2026-09-28, replacing
            // "strongest gradient anywhere in the window") — a real
            // low-contrast/worn card edge can be WEAKER than a printed text
            // line sitting further inside the search window (a bold header
            // row's own edge routinely out-contrasts a faded physical card
            // boundary), so picking the single strongest gradient in the
            // whole window reliably jumped PAST the true (nearby, if faint)
            // edge onto that text line instead — verified on a real photo: a
            // deliberately accurate starting quad still got a corner pulled
            // ~40px inward by exactly this, onto the document's own header
            // text. Searching outward from the starting guess (s=0) and
            // taking the FIRST local peak that clears the threshold fixes
            // this precisely because the true edge, when there's any signal
            // for it at all, is expected to be the nearest one — a stronger
            // but farther false peak (text, a crease) no longer wins just
            // for being more contrasty. "Local peak" (>= both neighbors) is
            // required so a single noisy sample near center can't win over a
            // real peak one step further out. Falls back to the old
            // any-index behavior via the same >12 flat threshold — the value
            // itself is unchanged, only WHICH qualifying point is picked.
            const mid=SEARCH;
            let bi=-1;
            for(let d=0;d<=SEARCH&&bi===-1;d++){
              const idxs=d===0?[mid]:[mid-d,mid+d];
              for(const idx of idxs){
                if(idx<0||idx>=grads.length) continue;
                const g=grads[idx];
                const gl=idx>0?grads[idx-1]:-Infinity, gr=idx<grads.length-1?grads[idx+1]:-Infinity;
                if(g>12&&g>=gl&&g>=gr){ bi=idx; break; }
              }
            }
            if(bi===-1) continue;
            // Subpixel refine: fit a parabola through the peak and its two
            // neighbors and take its vertex, rather than snapping to whichever
            // whole-pixel step happened to score highest.
            let sub=0;
            if(bi>0&&bi<grads.length-1){
              const y0=grads[bi-1], y1=grads[bi], y2=grads[bi+1];
              const denom=(y0-2*y1+y2);
              if(Math.abs(denom)>1e-6) sub=0.5*(y0-y2)/denom;
            }
            const best=(bi-SEARCH)+Math.max(-1,Math.min(1,sub));
            pts.push({x:px+nx*best,y:py+ny*best});
          }
          sidePoints[a+b]=pts.length>=Math.ceil(N*0.5)?pts:null;
        }
        // Total-least-squares line fit (handles near-vertical/horizontal sides
        // equally, unlike an ordinary y=mx+b regression): returns a line as
        // ax+by=c with (a,b) the unit normal.
        const fitLine=pts=>{
          if(!pts) return null;
          const n=pts.length;
          const mx=pts.reduce((s,p)=>s+p.x,0)/n, my=pts.reduce((s,p)=>s+p.y,0)/n;
          let sxx=0,syy=0,sxy=0;
          for(const p of pts){ const dx=p.x-mx,dy=p.y-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
          const theta=0.5*Math.atan2(2*sxy,sxx-syy);
          const a=Math.sin(theta), b=-Math.cos(theta);
          return {a,b,c:a*mx+b*my};
        };
        const lines={
          top:fitLine(sidePoints.tltr), right:fitLine(sidePoints.trbr),
          bottom:fitLine(sidePoints.brbl), left:fitLine(sidePoints.bltl)
        };
        const intersect=(L1,L2,fallback)=>{
          if(!L1||!L2) return fallback;
          const det=L1.a*L2.b-L2.a*L1.b;
          if(Math.abs(det)<1e-6) return fallback;
          const x=(L1.c*L2.b-L2.c*L1.b)/det, y=(L1.a*L2.c-L2.a*L1.c)/det;
          return (isFinite(x)&&isFinite(y))?{x,y}:fallback;
        };
        const refined={
          tl:intersect(lines.top,lines.left,Q.tl), tr:intersect(lines.top,lines.right,Q.tr),
          br:intersect(lines.bottom,lines.right,Q.br), bl:intersect(lines.bottom,lines.left,Q.bl)
        };
        // A refined corner that lands far from the AI's own guess is more
        // likely a bad line fit than a real correction — keep the original.
        // Raised 0.12->0.35 (2026-09-27) — real-world testing showed a card
        // with a busy surface pattern (e.g. an Israeli ID's holographic
        // watermark) can push aiDetectAlign's initial guess off by well over
        // 12% of the frame on one or more corners; the OLD floor then
        // rejected just THAT corner's (perfectly accurate, verified <1px
        // error in testing) correction while accepting the other three,
        // producing an inconsistent, visibly warped quad — worse than either
        // the fully raw guess or the fully corrected one. 0.35 comfortably
        // covers the corrections seen in testing (up to ~11% of frame) while
        // the separate in-bounds check right below still rejects a truly
        // wild intersection (near-parallel lines projecting far off-canvas).
        const maxDrift=0.35*Math.max(w,h);
        const out={};
        for(const k of ['tl','tr','br','bl']){
          const r=refined[k], o=Q[k];
          const ok=Math.hypot(r.x-o.x,r.y-o.y)<=maxDrift&&r.x>=-4&&r.y>=-4&&r.x<=w+4&&r.y<=h+4;
          out[k]={x:(ok?r.x:o.x)/w,y:(ok?r.y:o.y)/h};
        }
        resolve(out);
      }catch(e){ resolve(cornersFrac); }
    };
    img.onerror=()=>resolve(cornersFrac);
    img.src='data:'+mediaType+';base64,'+b64;
  });
}
function validQuadCorners(c){
  if(!c) return false;
  return [c.tl,c.tr,c.br,c.bl].every(p=>p&&typeof p.x==='number'&&typeof p.y==='number'&&p.x>=-0.1&&p.x<=1.1&&p.y>=-0.1&&p.y<=1.1);
}
// Shoelace-formula area of a fractional quad (tl/tr/br/bl in [0,1] space),
// as a fraction of the full 1x1 frame — used by refineWithAiAlign() below to
// reject an implausibly aggressive AI-guessed crop before trusting it.
function quadAreaFrac(c){
  const pts=[c.tl,c.tr,c.br,c.bl];
  let area=0;
  for(let i=0;i<4;i++){ const a=pts[i], b=pts[(i+1)%4]; area+=a.x*b.y-b.x*a.y; }
  return Math.abs(area)/2;
}
// True when a fractional quad is (within a tiny tolerance) exactly the
// untouched full frame — {tl:(0,0),tr:(1,0),br:(1,1),bl:(0,1)} — used to skip
// a warpQuadImage() call that would just re-encode the image as a lossy
// no-op copy. A real scan photo passes through several of these tightening
// passes in sequence; skipping the ones that have nothing to actually crop
// avoids needless JPEG generation loss and CPU time.
function _isNearIdentityQuad(c,eps){
  eps=eps||0.01;
  return Math.abs(c.tl.x-0)<eps&&Math.abs(c.tl.y-0)<eps&&
    Math.abs(c.tr.x-1)<eps&&Math.abs(c.tr.y-0)<eps&&
    Math.abs(c.br.x-1)<eps&&Math.abs(c.br.y-1)<eps&&
    Math.abs(c.bl.x-0)<eps&&Math.abs(c.bl.y-1)<eps;
}
// Best-effort fine-tightening pass on top of the user's own manual crop,
// using aiReadDoc's own imageAlign.corners — which comes back for free in
// the SAME response already fetched for field extraction, no extra AI call.
// Deliberately ignores imageAlign.rotate: the user already oriented the
// photo correctly via the corner editor's own rotate buttons before this
// ran, and re-applying the AI's own rotate guess on top risks flipping an
// already-correctly-oriented photo.
// Trust floor lowered from 50% to 8% of frame (2026-09-26, per real-world
// testing) — the 50% floor assumed the user's manual crop already left
// mostly-document in frame (a pure TIGHTENING pass), but real usage crops
// far more loosely (a real photo tested: card occupying ~20-35% of the
// manually-cropped frame, black background making up the rest) — that
// floor rejected the AI's own CORRECT card-boundary guess every time,
// exactly the case this was meant to help with. The classical OpenCV
// detector (preprocess_scan, server-side) independently struggles on this
// same real photo (verified: neither Canny-edge nor brightness-threshold
// segmentation reliably closes a clean contour around a card on an
// uneven/non-pure-black real background) — a vision-model guess is the
// more robust source of truth here, so it deserves a floor that only
// guards against a truly degenerate case (AI locking onto a small internal
// sub-element, e.g. just the portrait photo, typically far under 8% of
// even a rough crop), not one that assumes the crop was already tight.
async function refineWithAiAlign(finalImg,align){
  if(!align||!validQuadCorners(align.corners)) return finalImg;
  const areaFrac=quadAreaFrac(align.corners);
  if(areaFrac<0.08) return finalImg;
  // Skip the warp+JPEG-re-encode when the AI's own corners already describe
  // the untouched full frame (2026-09-27, optimization — see
  // _isNearIdentityQuad's own comment in autoPreAlignScan).
  if(_isNearIdentityQuad(align.corners)) return finalImg;
  // Local pixel-level verification (2026-09-28) — this function used to warp
  // straight to the AI's own reported corners with no further check, unlike
  // autoPreAlignScan() (which always runs an AI guess through
  // refineQuadCorners() before trusting it). That asymmetry was a real,
  // confirmed gap: on a real worn ID card, aiReadDoc's imageAlign.corners
  // came back significantly off (the exact photo isn't reproducible here —
  // no live AI call — but refineQuadCorners run directly against the real
  // image, starting from an independently-verified-accurate guess, still
  // needed real correction, confirming this specific document's edges are
  // genuinely hard to place from a single vision read). Running the AI's
  // corners through the same local refinement autoPreAlignScan already
  // trusts gives this path the same real-pixel sanity check instead of
  // blind faith in a single AI call.
  const refined=await refineQuadCorners(finalImg.b64,finalImg.mediaType,align.corners);
  if(_isNearIdentityQuad(refined)) return finalImg;
  const dims=await new Promise(res=>{
    const im=new Image();
    im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});
    im.onerror=()=>res(null);
    im.src='data:'+finalImg.mediaType+';base64,'+finalImg.b64;
  });
  if(!dims) return finalImg;
  const toPx=p=>({x:p.x*dims.w,y:p.y*dims.h});
  const quadPx={tl:toPx(refined.tl),tr:toPx(refined.tr),br:toPx(refined.br),bl:toPx(refined.bl),imgW:dims.w,imgH:dims.h};
  try{ return await warpQuadImage(finalImg.b64,finalImg.mediaType,quadPx); }
  catch(e){ console.error(e); return finalImg; }
}
// Final self-tightening pass (2026-09-27, real-device test) — a thin
// background sliver was still visible in the final embedded photo despite
// aiDetectAlign finding a reasonable quad and refineWithAiAlign applying its
// own tightening: the debug log showed refineWithAiAlign's own corners were
// full-width (x:0 to x:1, i.e. no horizontal change at all) that particular
// run, so whatever thin left/right sliver survived autoPreAlignScan's own
// corner detection was never re-examined afterward — only the AI-guessed
// crop rect got applied, never a fresh pixel-level check of the (by now
// nearly-final) image's own edges. Runs unconditionally on the result of
// every page's alignment chain, regardless of whether refineWithAiAlign
// itself fired: starts from a small fixed inward margin (the sliver, if any,
// is expected to be thin at this point) and reuses refineQuadCorners' own
// real-edge-detection (with its existing safe no-op fallback on low/no
// signal, verified elsewhere against pure noise) to trim it if a confident
// edge is found just inside that margin. Skips the extra warp+re-encode
// entirely when nothing meaningful was found (refined ~= the starting
// guess), so a photo that's already tight pays no extra cost.
// Each of the 4 sides is checked FULLY INDEPENDENTLY here (unlike
// refineQuadCorners' line-intersection approach, which needs BOTH sides
// meeting at a corner to have a signal before it can move that corner at
// all) — real-device testing found exactly the case this misses: a photo
// already perfectly cropped top/bottom (no edge signal there at all, correct
// fallback: unchanged) but with a thin left/right background sliver still
// left over — since every corner touches one horizontal + one vertical side,
// requiring an intersection meant the well-detected left/right edges could
// never move a corner on their own, and the sliver survived untouched. This
// function instead treats the image as already axis-aligned (a safe
// assumption at this late a stage, after the full perspective warp already
// ran) and finds each side's own inward position independently — a side
// with no confident signal just keeps its starting margin, with no
// dependency on any other side.
function _scanSideEdge(lum,w,h,axis,fixedFrac,alongLo,alongHi,inwardSign,startFrac){
  const N=16, SEARCH=Math.round(Math.max(w,h)*0.06)+8;
  const alongLen=(axis==='x')?h:w;
  const offsets=[];
  for(let i=0;i<N;i++){
    const t=alongLo+(alongHi-alongLo)*(i/(N-1));
    const along=t*alongLen;
    const fixedPx=fixedFrac*((axis==='x')?w:h);
    const grads=[];
    for(let s=-SEARCH;s<=SEARCH;s++){
      const p=fixedPx+inwardSign*s;
      const g=(axis==='x')?Math.abs(lum(p+1,along)-lum(p-1,along)):Math.abs(lum(along,p+1)-lum(along,p-1));
      grads.push(g);
    }
    let bi=0; for(let k=1;k<grads.length;k++) if(grads[k]>grads[bi]) bi=k;
    const sorted=grads.slice().sort((a,b)=>a-b), medianGrad=sorted[Math.floor(sorted.length/2)];
    if(grads[bi]>12&&grads[bi]>2*medianGrad){
      let sub=0;
      if(bi>0&&bi<grads.length-1){ const y0=grads[bi-1],y1=grads[bi],y2=grads[bi+1]; const den=y0-2*y1+y2; if(Math.abs(den)>1e-6) sub=0.5*(y0-y2)/den; }
      offsets.push((bi-SEARCH)+Math.max(-1,Math.min(1,sub)));
    }
  }
  if(offsets.length<Math.ceil(N*0.4)) return null; // not enough signal — leave this side alone
  offsets.sort((a,b)=>a-b);
  const medianOffset=offsets[Math.floor(offsets.length/2)];
  return startFrac+(inwardSign*medianOffset)/((axis==='x')?w:h);
}
async function finalTightenPass(img){
  if(!img||!img.b64) return img;
  const dims=await new Promise(res=>{
    const im=new Image();
    im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});
    im.onerror=()=>res(null);
    im.src='data:'+img.mediaType+';base64,'+img.b64;
  });
  if(!dims) return img;
  const w=dims.w,h=dims.h;
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  const ctx=cv.getContext('2d',{willReadFrequently:true});
  const decoded=await new Promise(res=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=()=>res(null); im.src='data:'+img.mediaType+';base64,'+img.b64; });
  if(!decoded) return img;
  ctx.drawImage(decoded,0,0,w,h);
  const data=ctx.getImageData(0,0,w,h).data;
  const lum=(x,y)=>{ x=Math.max(0,Math.min(w-1,Math.round(x))); y=Math.max(0,Math.min(h-1,Math.round(y))); const i=(y*w+x)*4; return 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; };
  const margin=0.03;
  // inwardSign=+1 means "search toward larger coordinates from this edge" (left/top), -1 means toward smaller (right/bottom).
  const left=_scanSideEdge(lum,w,h,'x',margin,0.1,0.9,+1,margin);
  const right=_scanSideEdge(lum,w,h,'x',1-margin,0.1,0.9,-1,1-margin);
  const top=_scanSideEdge(lum,w,h,'y',margin,0.1,0.9,+1,margin);
  const bottom=_scanSideEdge(lum,w,h,'y',1-margin,0.1,0.9,-1,1-margin);
  const x0=left!=null?left:0, x1=right!=null?right:1, y0=top!=null?top:0, y1=bottom!=null?bottom:1;
  if(x0<0.005&&x1>0.995&&y0<0.005&&y1>0.995) return img;
  const quadPx={tl:{x:x0*w,y:y0*h},tr:{x:x1*w,y:y0*h},br:{x:x1*w,y:y1*h},bl:{x:x0*w,y:y1*h},imgW:w,imgH:h};
  try{ return await warpQuadImage(img.b64,img.mediaType,quadPx); }
  catch(e){ console.error(e); return img; }
}
// 0/90/180/270° rotation of a fraction-space point (x,y in [0,1]), matching
// the pixel rotation alignScanImage performs on the image itself.
function rotatePointFrac(pt,deg){
  const x=pt.x, y=pt.y;
  switch(((deg%360)+360)%360){
    case 90: return {x:1-y,y:x};
    case 180: return {x:1-x,y:1-y};
    case 270: return {x:y,y:1-x};
    default: return {x,y};
  }
}

// Step 3: corner-adjustment editor, pre-filled with the AI's guess (or a
// full-frame default) — dragging the 4 handles is always available, "Готово"
// perspective-warps the quad flat like a scanner, "Пропустить" uses the
// image as-is.
function renderScanQuadEditor(b64,mediaType,cornersFrac){
  window.__scanEdit={b64,mediaType};
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML=`
    <div style="font-size:12px;color:var(--text2);margin-bottom:8px">ה-AI סימן מסגרת סביב המסמך — גררו את הנקודות כדי לתקן, ואז «סיום».</div>
    <div id="scanEditWrap" style="position:relative;display:inline-block;max-width:100%;touch-action:none;background:#111;line-height:0">
      <img id="scanEditImg" src="data:${mediaType};base64,${b64}" draggable="false"
        style="display:block;max-width:100%;max-height:46vh;user-select:none;-webkit-user-drag:none">
      <svg id="scanQuadSvg" style="position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none">
        <polygon id="scanQuadPoly" points="" fill="rgba(79,142,247,0.15)" stroke="#4f8ef7" stroke-width="2"></polygon>
        <line class="quad-side-handle" data-side="top" stroke="transparent" stroke-width="24"></line>
        <line class="quad-side-handle" data-side="right" stroke="transparent" stroke-width="24"></line>
        <line class="quad-side-handle" data-side="bottom" stroke="transparent" stroke-width="24"></line>
        <line class="quad-side-handle" data-side="left" stroke="transparent" stroke-width="24"></line>
        <circle class="quad-handle" data-c="tl" r="13"></circle><circle class="quad-handle" data-c="tr" r="13"></circle>
        <circle class="quad-handle" data-c="br" r="13"></circle><circle class="quad-handle" data-c="bl" r="13"></circle>
      </svg>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn sm" onclick="rotateScanQuad(270)" title="סובב שמאלה"><i class="ti ti-rotate-2"></i></button>
      <button class="btn sm" onclick="rotateScanQuad(90)" title="סובב ימינה"><i class="ti ti-rotate-clockwise-2"></i></button>
    </div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn" onclick="skipScanQuad()">דלג</button>
      <button class="btn accent" onclick="confirmScanQuad()">סיום</button>
    </div>`;
  const img=document.getElementById('scanEditImg');
  // img.complete/naturalWidth can already be true synchronously right after
  // the innerHTML assignment above (a data: URI needs no network fetch) —
  // BEFORE the browser has laid out the freshly-inserted DOM. Reading
  // img.clientWidth/clientHeight at that exact moment returned 0 (confirmed
  // by direct reproduction), which locked window.__quadRect's imgW/imgH at 0
  // forever: attachQuadDrag()'s move handler clamps every drag into
  // [0,imgW]x[0,imgH], so a 0-sized box traps every corner at (0,0) no
  // matter how the user drags them. warpQuadImage() then divides by that
  // same 0 (naturalWidth/quadPx.imgW), producing NaN/degenerate output that
  // throws inside confirmScanQuad()'s try — silently caught, falling back to
  // the ORIGINAL uncropped photo. That's the exact "рамка не подгоняет фото"
  // symptom: no error shown, crop just silently never applied.
  // A single requestAnimationFrame (the original fix) assumes one frame is
  // always enough time for the browser to finish decoding a large data: URI
  // photo and lay it out — not guaranteed on slower/mobile hardware, where
  // this exact bug was seen recurring even with the rAF defer in place.
  // img.decode() is the actual right tool: its promise resolves only once
  // the image is fully decoded and ready to paint, regardless of how many
  // frames that takes. One more rAF after it still runs, to let a layout
  // pass actually happen using that now-known intrinsic size before reading
  // clientWidth. Falls back to the rAF-only approach if decode() throws or
  // isn't supported.
  const startQuad=()=>{
    const go=()=>requestAnimationFrame(()=>initScanQuad(cornersFrac));
    if(!img.decode){ go(); return; }
    // img.decode() has been seen to never settle at all (neither resolve nor
    // reject) for a large data: URI on some mobile browsers — left alone,
    // that means initScanQuad()/attachQuadDrag() never run, the rectangle
    // never becomes interactive, and dragging silently does nothing (the
    // final crop then always falls back to whatever confirmScanQuad reads
    // from a never-initialized/stale window.__quadRect). A capped wait
    // guarantees the editor still becomes usable even when decode() hangs.
    let started=false;
    const once=()=>{ if(started) return; started=true; go(); };
    img.decode().then(once).catch(once);
    setTimeout(once,1200);
  };
  startQuad();
}
function initScanQuad(cornersFrac){
  const img=document.getElementById('scanEditImg');
  if(!img) return;
  const w=img.clientWidth, h=img.clientHeight;
  const clamp01=v=>Math.max(0,Math.min(1,typeof v==='number'?v:0));
  const at=k=>({x:clamp01(cornersFrac[k].x)*w,y:clamp01(cornersFrac[k].y)*h});
  window.__quadRect={tl:at('tl'),tr:at('tr'),br:at('br'),bl:at('bl'),imgW:w,imgH:h};
  paintQuad();
  attachQuadDrag();
}
// SIDE_CORNERS maps each edge's drag handle to the two true corners it
// translates together — shared by paintQuad() (to draw the invisible drag
// line along that edge) and attachQuadDrag() (to move both endpoints as one
// rigid unit, "sliding" that whole side in/out without touching the corners
// of the adjacent sides).
const SIDE_CORNERS={top:['tl','tr'],right:['tr','br'],bottom:['br','bl'],left:['bl','tl']};
function paintQuad(){
  const r=window.__quadRect;
  if(!r) return;
  const poly=document.getElementById('scanQuadPoly');
  if(poly) poly.setAttribute('points',[r.tl,r.tr,r.br,r.bl].map(p=>p.x+','+p.y).join(' '));
  Object.keys(SIDE_CORNERS).forEach(side=>{
    const [a,b]=SIDE_CORNERS[side];
    const line=document.querySelector('.quad-side-handle[data-side="'+side+'"]');
    if(line){ line.setAttribute('x1',r[a].x); line.setAttribute('y1',r[a].y); line.setAttribute('x2',r[b].x); line.setAttribute('y2',r[b].y); }
  });
  const cx=(r.tl.x+r.tr.x+r.br.x+r.bl.x)/4, cy=(r.tl.y+r.tr.y+r.br.y+r.bl.y)/4;
  // Corner handles drawn inset from the true corner toward the quad's own
  // centroid — 6.5pt as of 2026-09-27 (up from 3.5pt, per user request: still
  // hard to grab a corner sitting right at the photo's edge). Purely visual;
  // window.__quadRect[key] (the true corner used for cropping) is untouched.
  const inset=6.5;
  ['tl','tr','br','bl'].forEach(k=>{
    const c=document.querySelector('.quad-handle[data-c="'+k+'"]');
    if(!c) return;
    const p=r[k];
    const dx=cx-p.x, dy=cy-p.y;
    const dist=Math.hypot(dx,dy)||1;
    const vx=p.x+dx/dist*inset, vy=p.y+dy/dist*inset;
    c.setAttribute('cx',vx); c.setAttribute('cy',vy);
  });
}
function attachQuadDrag(){
  const svg=document.getElementById('scanQuadSvg');
  if(!svg) return;
  svg.querySelectorAll('.quad-handle').forEach(h=>{
    h.addEventListener('pointerdown',e=>{
      e.preventDefault(); e.stopPropagation();
      const key=h.dataset.c;
      const wrap=document.getElementById('scanEditWrap');
      const move=ev=>{
        const rect=wrap.getBoundingClientRect();
        const r=window.__quadRect;
        r[key]={x:Math.max(0,Math.min(r.imgW,ev.clientX-rect.left)),y:Math.max(0,Math.min(r.imgH,ev.clientY-rect.top))};
        paintQuad();
      };
      const up=()=>{ window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); };
      window.addEventListener('pointermove',move);
      window.addEventListener('pointerup',up);
    });
  });
  // Whole-edge drag (added 2026-09-27, per user request — "let me move the
  // whole horizontal/vertical line, not just one corner at a time"): grabbing
  // the line between two corners translates BOTH of them by the same pointer
  // delta, sliding that entire side in/out as a rigid unit while the other
  // two corners (and thus the adjacent sides) stay put — the standard
  // photo-crop-tool "drag an edge" gesture, useful when a whole side needs
  // the same nudge rather than fixing each of its two corners separately.
  svg.querySelectorAll('.quad-side-handle').forEach(h=>{
    h.addEventListener('pointerdown',e=>{
      e.preventDefault(); e.stopPropagation();
      const [ka,kb]=SIDE_CORNERS[h.dataset.side];
      const r=window.__quadRect;
      const start={x:e.clientX,y:e.clientY};
      const orig={a:{...r[ka]},b:{...r[kb]}};
      const move=ev=>{
        const dx=ev.clientX-start.x, dy=ev.clientY-start.y;
        const clamp=p=>({x:Math.max(0,Math.min(r.imgW,p.x+dx)),y:Math.max(0,Math.min(r.imgH,p.y+dy))});
        r[ka]=clamp(orig.a); r[kb]=clamp(orig.b);
        paintQuad();
      };
      const up=()=>{ window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); };
      window.addEventListener('pointermove',move);
      window.addEventListener('pointerup',up);
    });
  });
}
async function rotateScanQuad(deg){
  const {b64,mediaType}=window.__scanEdit;
  const r=window.__quadRect;
  const frac=k=>({x:r[k].x/r.imgW,y:r[k].y/r.imgH});
  const rotated={tl:rotatePointFrac(frac('tl'),deg),tr:rotatePointFrac(frac('tr'),deg),
    br:rotatePointFrac(frac('br'),deg),bl:rotatePointFrac(frac('bl'),deg)};
  const img=await alignScanImage(b64,mediaType,{rotate:deg,crop:{x0:0,y0:0,x1:1,y1:1}});
  renderScanQuadEditor(img.b64,img.mediaType,rotated);
}
// window.__scanEditPurpose tells these two where to go next: 'preOcr' (the
// normal case now — see onScanFileSelected) means the user just finished
// marking up a RAW, not-yet-enhanced photo — the cropped result is queued
// (window.__pendingScanPages) for later batch processing, NOT sent anywhere
// yet (see onScanFileSelected's comment and processAllPendingPages() below);
// anything else (only 'sefach', currently unreachable via UI but kept
// working — see runSefachOcr) means OCR already ran and this is finishing
// the page directly, same as before.
//
// _preAlignThenOcr()/runOcr() (below) are DORMANT as of 2026-09-26 — nothing
// in the live UI sets __scanEditPurpose='preOcr' anymore (onScanFileSelected
// now always uses 'collectPage'), so neither function is currently reached.
// Left defined, working, in case an immediate single-page-no-batch fast path
// is wanted again later; processAllPendingPages() below does its own
// preAlignScan+aiReadDoc call per queued page rather than calling these.
async function _preAlignThenOcr(b64,mediaType){
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br><span>משפר איכות…</span></div>';
  const pre=await preAlignScan(b64,mediaType);
  if(pre.blurry){
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">התמונה מטושטשת מדי, צלמו שוב<br><br>'
      +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
    return;
  }
  runOcr(pre.b64,pre.mediaType);
}
async function confirmScanQuad(){
  const {b64,mediaType}=window.__scanEdit;
  const r=window.__quadRect;
  const stage=document.getElementById('aiScanStage');
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br><span>מיישר את הסריקה…</span></div>';
  let finalImg;
  try{ finalImg=await warpQuadImage(b64,mediaType,r); }
  catch(e){ console.error(e); finalImg={b64,mediaType}; }
  if(window.__scanEditPurpose==='collectPage'){
    if(!window.__pendingScanPages) window.__pendingScanPages=[];
    window.__pendingScanPages.push(finalImg);
    renderPendingPagesPrompt();
  } else finishPageScan(finalImg);
}
function skipScanQuad(){
  if(window.__scanEditPurpose==='collectPage'){
    if(!window.__pendingScanPages) window.__pendingScanPages=[];
    window.__pendingScanPages.push(window.__scanEdit);
    renderPendingPagesPrompt();
  } else finishPageScan(window.__scanEdit);
}
// Fields carried by an Israeli ID's ספח (appendix) card that the front side
// doesn't have — shared between the multi-file batch path
// (onScanFilesSelected) and the new one-page-at-a-time loop below, so both
// use the same definition of "still missing" / "worth merging in".
const ID_CORE_FIELDS=['dob','sex','address','houseNumber','city','maritalStatus'];
// The narrower subset worth re-scanning MORE pages for (not just merging
// whatever a page happens to have) — shared by onScanFilesSelected (the
// no-crop multi-file batch path) and processAllPendingPages() (the
// manual-crop-then-batch path) so both use the same "keep looking" gate.
const CORE_FIELDS=['dob','sex','address','city'];
const missingCore=p=>p&&p.type==='israeli_id'&&CORE_FIELDS.some(f=>!p[f]);
function mergeIsraeliIdFields(primary,extra){
  if(!primary||primary.type!=='israeli_id'||!extra||extra.type!=='israeli_id') return primary;
  for(const f of ID_CORE_FIELDS){ if(!primary[f]&&extra[f]) primary[f]=extra[f]; }
  if((!primary.children||!primary.children.length)&&Array.isArray(extra.children)&&extra.children.length) primary.children=extra.children;
  return primary;
}
// Seeds a fresh primary record from the first-scanned page's raw parsed
// data. Shared by finishPageScan() (normal flow) and rebuildPrimaryFromPages()
// (replaying after a page is removed) so both compute the exact same result
// for the same set of pages.
function initPrimaryFromFirstPage(current){
  current=current||{};
  const isSefachRead=!!current.__isSefachScan;
  const currentIdNo=/^\d{9}$/.test(current.idNo||'')?current.idNo:'';
  const primary={...current};
  window.__aiPendingSefachIdNo=null;
  // A ספח-only read's idNo is never authoritative on its own — it hasn't
  // been through the zoomed digit re-verification a front scan's idNo gets
  // (verifyDigitFields/verifyIdChecksum). Keep it aside purely to cross-check
  // against a front page's idNo if one shows up later in the same session.
  if(isSefachRead){
    primary.idNo='';
    if(currentIdNo) window.__aiPendingSefachIdNo=currentIdNo;
  }
  return primary;
}
// Merges one later-scanned page's raw parsed data into the primary record.
// Shared by finishPageScan() (normal incremental flow) and
// rebuildPrimaryFromPages() (removeExtraScanPage()'s replay), so both compute
// the exact same result for the same set of pages regardless of when/why
// this runs. `current` may be null (a batch-scanned page that was never sent
// through OCR because earlier pages already filled every field worth
// re-scanning for) — a no-op in that case.
function mergeScanPage(primary,current){
  if(!current) return primary;
  const isSefachRead=!!current.__isSefachScan;
  const currentIdNo=/^\d{9}$/.test(current.idNo||'')?current.idNo:'';
  if(isSefachRead){
    if(primary.idNo&&currentIdNo&&currentIdNo!==primary.idNo) primary.idMismatch=true;
    else if(!primary.idNo&&currentIdNo) window.__aiPendingSefachIdNo=currentIdNo;
  } else if(currentIdNo){
    // A front-scan page's idNo is always authoritative over a ספח's —
    // cross-check against any ספח read seen earlier in this session first.
    if(window.__aiPendingSefachIdNo&&currentIdNo!==window.__aiPendingSefachIdNo) primary.idMismatch=true;
    if(!primary.idNo) primary.idNo=currentIdNo;
  }
  return mergeIsraeliIdFields(primary,current);
}
// Recomputes window.__aiPrimaryParsed from scratch out of window.__aiPageParsed
// (each page's own raw parsed data, kept parallel to __aiScanPageThumbs) —
// used after removeExtraScanPage() drops a page, so a bad/misread extra page's
// contribution (address, city, house number, marital status, children,
// idMismatch, ...) doesn't silently keep living on in the primary record just
// because only the page's thumbnail was removed, not the data it merged in.
function rebuildPrimaryFromPages(){
  const pages=window.__aiPageParsed||[];
  if(!pages.length){ window.__aiPrimaryParsed=null; return; }
  let primary=initPrimaryFromFirstPage(pages[0]);
  for(let i=1;i<pages.length;i++) primary=mergeScanPage(primary,pages[i]);
  window.__aiPrimaryParsed=primary;
}
// Called once a single page's OCR + corner-confirmation is done (whichever
// page — first or an added one). The FIRST page scanned in this session
// becomes the primary document (window.__aiScanImage / __aiPrimaryParsed);
// every page after that only MERGES its blank-filling fields (address/city/
// children — see mergeIsraeliIdFields) into the primary record and its own
// image goes to window.__aiPacketOtherPages instead of replacing the
// primary — this is what lets a separately-photographed ספח add its data
// without wiping out the front card's name/dob/sex/ID number. Ends by
// showing the review screen (add another page, or finish) rather than
// jumping straight to the worker modal, so ספח (or a contract page, etc.)
// can be added before the worker record is actually opened.
function finishPageScan(finalImg){
  if(!window.__aiScanPageThumbs) window.__aiScanPageThumbs=[];
  if(!window.__aiPacketOtherPages) window.__aiPacketOtherPages=[];
  if(!window.__aiPageParsed) window.__aiPageParsed=[];
  const isFirstPage=window.__aiScanPageThumbs.length===0;
  const current=window.__aiParsed||{};
  if(isFirstPage){
    window.__aiScanImage=finalImg;
    window.__aiPrimaryParsed=initPrimaryFromFirstPage(current);
  } else {
    window.__aiPrimaryParsed=mergeScanPage(window.__aiPrimaryParsed,current);
    window.__aiPacketOtherPages.push(finalImg);
  }
  window.__aiPageParsed.push(current);
  window.__aiScanPageThumbs.push(finalImg);
  renderScanPagesPrompt();
}
// Pending-pages queue (added 2026-09-26, per user request): shown while the
// user is still cropping pages, BEFORE any of them has touched the server.
// window.__pendingScanPages holds { b64, mediaType } entries straight out of
// warpQuadImage/the raw skipped photo — no preAlignScan, no aiReadDoc yet.
// "Добавить страницу" re-enters onScanFileSelected (crop only, still no
// network call); "Обработать" hands the whole queue to
// processAllPendingPages() in one shot. Every thumbnail is removable here
// (unlike renderScanPagesPrompt()'s card #1) since nothing has been
// classified as "the primary page" yet at this stage — that only happens
// once processAllPendingPages() actually reads the documents.
function renderPendingPagesPrompt(){
  const stage=document.getElementById('aiScanStage');
  const pages=window.__pendingScanPages||[];
  stage.innerHTML=`
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12px;color:var(--text2)">${pages.length} תמונות ממתינות לעיבוד</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${pages.map((p,i)=>`
          <div style="position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--border2);flex-shrink:0">
            <img src="data:${p.mediaType};base64,${p.b64}" style="width:100%;height:100%;object-fit:cover;display:block">
            <span style="position:absolute;bottom:1px;left:1px;font-size:9px;background:rgba(0,0,0,0.6);color:#fff;padding:0 3px;border-radius:3px">${i+1}</span>
            <button type="button" onclick="removePendingScanPage(${i})" style="position:absolute;top:1px;right:1px;width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,0.7);color:#fff;border:none;font-size:10px;line-height:1;cursor:pointer;padding:0">✕</button>
          </div>`).join('')}
      </div>
      <input type="file" id="aiScanFilePending" accept="image/*,application/pdf,.pdf" style="display:none" onchange="onScanFileSelected(this.files[0]); this.value='';">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" type="button" onclick="document.getElementById('aiScanFilePending').click()"><i class="ti ti-plus"></i> הוסף עמוד</button>
        <button class="btn sm accent" type="button" ${pages.length?'':'disabled'} onclick="processAllPendingPages()"><i class="ti ti-check"></i> עבד ${pages.length||''} עמודים</button>
      </div>
    </div>`;
}
function removePendingScanPage(i){
  if(!window.__pendingScanPages) return;
  window.__pendingScanPages.splice(i,1);
  renderPendingPagesPrompt();
}
// Sends the WHOLE pending queue through preAlignScan+aiReadDoc, once, page by
// page — this is the one point in the whole "collect first, process later"
// flow that actually talks to the server. Mirrors onScanFilesSelected's own
// classify/merge loop (first israeli_id/passport page found becomes primary,
// verified via verifyDigitFields/verifyIdChecksum; later pages merge missing
// core fields via mergeIsraeliIdFields until none are missing; anything past
// that point is kept as-is with no further AI call) rather than reusing
// finishPageScan()'s naive "first page scanned = primary" rule, which has no
// way to recover if an ospח or contract photo happens to get cropped first —
// exactly the bug CORE_FIELDS/missingCore's own comment already describes
// for the batch-file path.
// Resumable: if the user already finished one batch and is now adding more
// pages from renderScanPagesPrompt()'s own "add page" button (which also
// goes through onScanFileSelected → the pending queue, same as the first
// batch), this picks up the EXISTING primary/otherPages/pageParsed instead of
// starting over, so a second small batch just extends the first one.
//
// One blurry page aborts the loop and is dropped from the queue on its own —
// per user decision, the rest of the (already-cropped) queue is preserved
// rather than losing the whole batch over one bad photo.
async function processAllPendingPages(){
  const queue=(window.__pendingScanPages||[]).slice();
  if(!queue.length) return;
  const stage=document.getElementById('aiScanStage');
  if(!window.__aiScanPageThumbs) window.__aiScanPageThumbs=[];
  if(!window.__aiPacketOtherPages) window.__aiPacketOtherPages=[];
  if(!window.__aiPageParsed) window.__aiPageParsed=[];
  // Resuming detection reads __aiPrimaryParsed/__aiParsed directly rather than
  // __aiScanPageThumbs.length — a blurry-page abort below commits __aiPrimaryParsed
  // (partial progress) but does NOT populate __aiScanPageThumbs (that only happens
  // on this function's own full-success tail), so checking the thumbs array here
  // made a resumed "process" after an abort wrongly look like a fresh start,
  // discarding the already-found primary record and re-reading pages from scratch.
  const resuming=!!(window.__aiPrimaryParsed||window.__aiParsed);
  let foundParsed=resuming?(window.__aiPrimaryParsed||window.__aiParsed||null):null;
  let needMore=missingCore(foundParsed);
  const otherPages=resuming?window.__aiPacketOtherPages.slice():[];
  let pageParsed=resuming?window.__aiPageParsed.slice():[];
  for(let i=0;i<queue.length;i++){
    const pct=Math.round((i/queue.length)*100);
    stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
      +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
      +'<span>מעבד עמוד '+(i+1)+' מתוך '+queue.length+'… ('+pct+'%)</span>'
      +'<div class="progress-bar-real"><div style="width:'+pct+'%"></div></div></div>';
    let it=queue[i];
    // Cheap Haiku-based corner detection (autoPreAlignScan/aiDetectAlign,
    // revived 2026-09-26 — see its own comment for the full history) runs
    // BEFORE preAlignScan's classical-CV attempt: a real-photo diagnostic
    // this same day showed the OpenCV detector (_find_document_quad)
    // failing to close a clean contour on an actual scan (uneven, non-pure-
    // black real background) even after hardening — a vision-model read is
    // inherently more robust on messy real photos than hand-tuned edge
    // heuristics, and this is cheap enough (small prompt, no field
    // extraction, Haiku) to run on every queued page. preAlignScan's own
    // classical-CV pass still runs afterward as a harmless no-cost fallback
    // (it already safely no-ops when it can't find a confident quad).
    try{ it=await autoPreAlignScan(it.b64,it.mediaType); }
    catch(e){ console.error(e); }
    let pre;
    try{ pre=await preAlignScan(it.b64,it.mediaType); }
    catch(e){ console.error(e); pre={b64:it.b64,mediaType:it.mediaType}; }
    if(pre.blurry){
      // `queue` is a snapshot (.slice() above) of window.__pendingScanPages
      // taken before this loop started — pages at indices 0..i-1 have already
      // been consumed into foundParsed/otherPages this run, and the page at i
      // is the blurry one being dropped, so the real queue must become
      // whatever comes AFTER it (queue.slice(i+1)), not just "everything minus
      // the one blurry item" — leaving the already-consumed prefix in
      // window.__pendingScanPages made a later "process" reprocess (and
      // duplicate into otherPages) pages that were already merged in.
      window.__pendingScanPages=queue.slice(i+1);
      window.__aiPacketOtherPages=otherPages;
      window.__aiPageParsed=pageParsed;
      if(foundParsed){ window.__aiParsed=foundParsed; window.__aiPrimaryParsed=foundParsed; }
      stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">תמונה '+(i+1)+' מטושטשת מדי, הוסרה מהתור. צלמו אותה מחדש<br><br>'
        +'<button class="btn sm" onclick="renderPendingPagesPrompt()">חזרה לתור</button></div>';
      return;
    }
    it={b64:pre.b64,mediaType:pre.mediaType};
    let thisPageParsed=null;
    if(!foundParsed){
      try{
        const resp=await fetch(GS_URL,{method:'POST',body:JSON.stringify({action:'aiReadDoc',secret:API_SECRET,...gsAuth(),image:it.b64,mediaType:it.mediaType})});
        const json=await resp.json();
        const p=json&&json.parsed;
        if(p&&(p.type==='israeli_id'||p.type==='passport')){
          foundParsed=p.fieldBoxes?await verifyDigitFields(p,it.b64,it.mediaType):p;
          foundParsed=await verifyIdChecksum(foundParsed,it.b64,it.mediaType);
          // Routed through initPrimaryFromFirstPage() (2026-09-27, unifying
          // with rebuildPrimaryFromPages()'s own logic — see that function's
          // comment) rather than used directly: this flow's own pages are
          // never __isSefachScan-tagged (only the dedicated aiReadSefach path
          // sets that), so the only practical effect here is resetting any
          // stale window.__aiPendingSefachIdNo left over from elsewhere in the
          // tab — cheap, harmless hygiene, and keeps this branch computing the
          // exact same shape of primary record removeExtraScanPage()'s replay
          // (rebuildPrimaryFromPages) would, so removing a later page never
          // recomputes the primary any differently than how it was first built.
          foundParsed=initPrimaryFromFirstPage(foundParsed);
          // Avatar crop uses photoBox coordinates, which are relative to `it`
          // as sent to aiReadDoc — must run BEFORE refineWithAiAlign below
          // changes the image's coordinate space.
          window.__aiAvatarB64=p.photoBox?await cropPortraitAvatar(it.b64,it.mediaType,p.photoBox):null;
          // Free tightening pass on the user's own manual crop, using
          // imageAlign from this SAME aiReadDoc response — no extra AI call,
          // matches runOcr()'s dormant single-page equivalent (see its own
          // comment). Falls back to the untouched `it` on any missing/
          // implausible corners or a failed warp.
          window.__aiScanImage=await finalTightenPass(await refineWithAiAlign(it,p.imageAlign));
          needMore=missingCore(foundParsed);
          pageParsed=[foundParsed];
          continue; // this page's image is __aiScanImage — not duplicated into otherPages
        }
      }catch(e){ console.error(e); }
    } else if(needMore){
      try{
        const resp=await fetch(GS_URL,{method:'POST',body:JSON.stringify({action:'aiReadDoc',secret:API_SECRET,...gsAuth(),image:it.b64,mediaType:it.mediaType})});
        const json=await resp.json();
        const p=json&&json.parsed;
        if(p&&p.type==='israeli_id'){
          // mergeScanPage() (2026-09-27, was mergeIsraeliIdFields() directly)
          // — unifies with rebuildPrimaryFromPages()'s own merge logic (used
          // when a page is later removed via removeExtraScanPage(), see its
          // comment) so removing a page never recomputes the primary record
          // any differently than how this loop first built it. Also a real
          // fix on its own: mergeIsraeliIdFields() alone never backfills a
          // missing idNo from a later page (idNo isn't in ID_CORE_FIELDS),
          // silently leaving it blank even when a later-scanned page read it
          // fine; mergeScanPage() does.
          foundParsed=mergeScanPage(foundParsed,p);
          thisPageParsed=p;
          it=await refineWithAiAlign(it,p.imageAlign);
        }
        needMore=missingCore(foundParsed);
      }catch(e){ console.error(e); }
    }
    // A page needing no aiReadDoc call at all (every core field already
    // complete by the time it's reached) never runs refineWithAiAlign — but
    // finalTightenPass is independent of aiReadDoc's imageAlign, so it still
    // applies here to catch a residual background sliver on this page too.
    it=await finalTightenPass(it);
    pageParsed.push(thisPageParsed);
    otherPages.push(it);
  }
  stage.innerHTML='<div style="text-align:center;padding:26px;color:var(--text2);font-size:14px">'
    +'<i class="ti ti-loader-2 spin" style="font-size:20px"></i><br><br>'
    +'<span>הושלם (100%)</span>'
    +'<div class="progress-bar-real"><div style="width:100%"></div></div></div>';
  window.__pendingScanPages=[];
  window.__aiPacketOtherPages=otherPages;
  window.__aiPageParsed=pageParsed;
  if(!foundParsed){
    stage.innerHTML='<div style="color:#ff6b78;padding:14px;font-size:13px">לא נמצאה תעודת זהות/דרכון בתמונות שהועלו<br><br>'
      +'<button class="btn sm" onclick="openAiScan()">שוב</button></div>';
    return;
  }
  window.__aiParsed=foundParsed;
  window.__aiPrimaryParsed=foundParsed;
  window.__aiScanPageThumbs=[window.__aiScanImage,...otherPages];
  renderScanPagesPrompt();
}
// Review screen shown after a batch of pages has actually been processed
// (processAllPendingPages()): a thumbnail strip of everything read so far in
// this session, a button to crop and queue one more page (front card, ספח,
// contract...) — this goes through onScanFileSelected → the SAME pending-
// pages queue as the first batch (renderPendingPagesPrompt), not straight
// back to the server, so "one more page" after review still batches — and a
// "done" button that hands off to the worker modal. Card #1 (the primary
// page) has no remove button — removing it would mean restarting the whole
// session (rescan), which "Отмена"/closing the overlay already covers.
function renderScanPagesPrompt(){
  const stage=document.getElementById('aiScanStage');
  const pages=window.__aiScanPageThumbs||[];
  stage.innerHTML=`
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:12px;color:var(--text2)">נסרקו ${pages.length} עמוד${pages.length===1?'':'ים'}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${pages.map((p,i)=>`
          <div style="position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--border2);flex-shrink:0">
            <img src="data:${p.mediaType};base64,${p.b64}" style="width:100%;height:100%;object-fit:cover;display:block">
            <span style="position:absolute;bottom:1px;left:1px;font-size:9px;background:rgba(0,0,0,0.6);color:#fff;padding:0 3px;border-radius:3px">${i+1}</span>
            ${i>0?`<button type="button" onclick="removeExtraScanPage(${i})" style="position:absolute;top:1px;right:1px;width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,0.7);color:#fff;border:none;font-size:10px;line-height:1;cursor:pointer;padding:0">✕</button>`:''}
          </div>`).join('')}
      </div>
      <input type="file" id="aiScanFileExtra" accept="image/*,application/pdf,.pdf" style="display:none" onchange="onScanFileSelected(this.files[0]); this.value='';">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" type="button" onclick="document.getElementById('aiScanFileExtra').click()"><i class="ti ti-plus"></i> הוסף עמוד</button>
        <button class="btn sm accent" type="button" onclick="finishScanPages()"><i class="ti ti-check"></i> סיום</button>
      </div>
    </div>`;
}
function removeExtraScanPage(i){
  if(i<=0) return; // primary page — not removable here, see comment above
  window.__aiScanPageThumbs.splice(i,1);
  window.__aiPacketOtherPages.splice(i-1,1);
  if(window.__aiPageParsed) window.__aiPageParsed.splice(i,1);
  // Whatever this page's own data contributed to __aiPrimaryParsed (address,
  // city, house number, marital status, children, an idMismatch flag, ...)
  // must not silently survive just because only the thumbnail was removed —
  // recompute the primary record from the pages that are actually still here.
  rebuildPrimaryFromPages();
  renderScanPagesPrompt();
}
function finishScanPages(){
  const finalParsed=window.__aiPrimaryParsed||window.__aiParsed;
  window.__aiParsed=finalParsed;
  openWorkerModalFromScan(finalParsed);
}

// Shared handoff from the scan pipeline into the unified worker modal, once
// OCR + corner-confirmation are done — replaces the old separate
// renderAiResult() result screen entirely. A rescan of an existing worker
// (window.__aiRescanWorkerId, set by rescanWorkerDoc()) reopens THAT worker
// in edit mode with fresh OCR values layered over their existing record; a
// fresh scan opens a blank worker in add mode. window.__aiScanImage /
// window.__aiPacketOtherPages are left untouched here (already set by the
// scan flow itself) — showWorkerModal()/saveWorker() read them directly.
function openWorkerModalFromScan(p){
  closeModal('aiScanOverlay');
  if(!p){ showToast('לא ניתן לפענח את תגובת ה-AI'); return; }
  const isId=p.type==='israeli_id';
  const _nrm=s=>String(s||'').replace(/\s+/g,' ').trim();
  // Only include a key when THIS scan actually found a value for it. A scan
  // of just the back/ספח side of an ID has no name/dob/sex on it — for a
  // FRESH worker that's fine (the field just stays blank, same as before),
  // but for a RESCAN of an existing worker (ocrFields gets spread over
  // {...workers[idx], ...ocrFields} below) an unconditional empty string
  // used to silently overwrite already-correct data captured from an
  // earlier scan of the front side. Mirrors the same guard already used for
  // avatarB64 just below.
  const setIfPresent=(obj,key,val)=>{ const v=_nrm(val); if(v) obj[key]=v; };
  const ocrFields={
    docType: isId?'israeli_id':'passport',
    // Display-only — not one of saveWorker()'s commonFields, so it never
    // actually gets persisted onto the worker record; just flags the docId
    // field in the modal below when the ID checksum check failed.
    idChecksumOk: p.idChecksumOk,
    // Same display-only treatment — set by finishPageScan() when a later
    // page's own idNo read (e.g. from the ספח) disagreed with the primary
    // one already captured from the front.
    idMismatch: p.idMismatch,
  };
  setIfPresent(ocrFields,'docGiven',p.given);
  setIfPresent(ocrFields,'docSurname',p.surname);
  setIfPresent(ocrFields,'docId',isId?p.idNo:p.passportNo);
  setIfPresent(ocrFields,'docDob',p.dob);
  setIfPresent(ocrFields,'docSex',p.sex);
  setIfPresent(ocrFields,'docExpiry',p.expiry);
  // Only set the key when a portrait was actually cropped from this scan —
  // an omitted key leaves an existing avatar (on a rescan) untouched instead
  // of wiping it out just because this particular photo had no photoBox.
  if(window.__aiAvatarB64) ocrFields.avatarB64=window.__aiAvatarB64;
  if(isId){
    setIfPresent(ocrFields,'address',p.address);
    setIfPresent(ocrFields,'houseNumber',p.houseNumber);
    setIfPresent(ocrFields,'city',p.city);
    // Most Israeli ID documents don't print marital status at all — this
    // only fires on the rare variant that does (aiReadDoc's own prompt
    // returns "" when it's not visible, per setIfPresent above). Maps the
    // AI's plain-English value onto the <select>'s own option values; an
    // unrecognized/empty AI value leaves the field for manual entry, same
    // as always.
    const MARITAL_AI_MAP={single:'marital_single',married:'marital_married',divorced:'marital_divorced',widowed:'marital_widowed'};
    if(p.maritalStatus&&MARITAL_AI_MAP[p.maritalStatus]) ocrFields.maritalStatus=MARITAL_AI_MAP[p.maritalStatus];
    if(Array.isArray(p.children)&&p.children.length) ocrFields.docChildren=p.children.map(c=>({name:_nrm(c.name),idNo:_nrm(c.idNo),dob:_nrm(c.dob)}));
  }
  const rescanId=window.__aiRescanWorkerId;
  window.__aiRescanWorkerId=null;
  if(rescanId){
    const idx=workers.findIndex(w=>w.id===rescanId);
    if(idx>=0){
      editingWorkerIdx=idx;
      // Survives until saveWorker() consumes it (unlike window.__aiRescanWorkerId
      // above, which is cleared immediately here) — saveWorker() runs later,
      // after the manager reviews/edits fields in the modal and presses save,
      // and needs to know THEN whether this specific edit session started from
      // a fresh physical rescan (use the live window.__aiScanImage/
      // __aiPacketOtherPages, upload path) or is just a plain field edit on an
      // existing worker (use the Drive sidecar, regenerate path). See
      // saveWorker()'s own comment at the matching check.
      window.__aiRescannedWorkerId=rescanId;
      showWorkerModal({...workers[idx],...ocrFields});
      return;
    }
  }
  editingWorkerIdx=null;
  showWorkerModal({...blankWorkerDefaults(),...ocrFields});
}

// Flattens the quadrilateral the user positioned into a plain rectangular
// image — a true perspective warp (unlike alignScanImage's rotate+crop),
// so a document photographed at an angle comes out looking scanner-flat.
function warpQuadImage(b64,mediaType,quadPx){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const sx=img.naturalWidth/quadPx.imgW, sy=img.naturalHeight/quadPx.imgH;
        const toSrc=p=>({x:p.x*sx,y:p.y*sy});
        const out=warpQuadToRect(img,[toSrc(quadPx.tl),toSrc(quadPx.tr),toSrc(quadPx.br),toSrc(quadPx.bl)]);
        resolve({b64:out.toDataURL('image/jpeg',0.92).split(',')[1],mediaType:'image/jpeg'});
      }catch(e){ reject(e); }
    };
    img.onerror=()=>reject(new Error('image load failed'));
    img.src='data:'+mediaType+';base64,'+b64;
  });
}
// Classic "unit square → arbitrary quad" projective mapping (Heckbert):
// solves the 8-coefficient homography from 4 point correspondences.
function computeSquareToQuadHomography(quad){
  const [p0,p1,p2,p3]=quad;
  const dx1=p1.x-p2.x, dx2=p3.x-p2.x, dx3=p0.x-p1.x+p2.x-p3.x;
  const dy1=p1.y-p2.y, dy2=p3.y-p2.y, dy3=p0.y-p1.y+p2.y-p3.y;
  let g=0,h=0;
  if(Math.abs(dx3)>1e-9||Math.abs(dy3)>1e-9){
    const det=dx1*dy2-dx2*dy1;
    g=det?(dx3*dy2-dx2*dy3)/det:0;
    h=det?(dx1*dy3-dx3*dy1)/det:0;
  }
  return {
    a:p1.x-p0.x+g*p1.x, b:p3.x-p0.x+h*p3.x, c:p0.x,
    d:p1.y-p0.y+g*p1.y, e:p3.y-p0.y+h*p3.y, f:p0.y,
    g, h
  };
}
function applyHomography(H,u,v){
  const denom=H.g*u+H.h*v+1;
  return {x:(H.a*u+H.b*v+H.c)/denom, y:(H.d*u+H.e*v+H.f)/denom};
}
function bilinearSample(data,sw,sh,x,y){
  const x0=Math.floor(x), y0=Math.floor(y);
  const x1=Math.min(x0+1,sw-1), y1=Math.min(y0+1,sh-1);
  const fx=x-x0, fy=y-y0;
  const idx=(xx,yy)=>(yy*sw+xx)*4;
  const out=[0,0,0,0];
  for(let c=0;c<4;c++){
    const v00=data[idx(x0,y0)+c], v10=data[idx(x1,y0)+c], v01=data[idx(x0,y1)+c], v11=data[idx(x1,y1)+c];
    out[c]=v00*(1-fx)*(1-fy)+v10*fx*(1-fy)+v01*(1-fx)*fy+v11*fx*fy;
  }
  return out;
}
function warpQuadToRect(img,quadSrcPx){
  const sw=img.naturalWidth, sh=img.naturalHeight;
  const srcCv=document.createElement('canvas'); srcCv.width=sw; srcCv.height=sh;
  const sctx=srcCv.getContext('2d'); sctx.drawImage(img,0,0);
  const srcData=sctx.getImageData(0,0,sw,sh).data;
  const [tl,tr,br,bl]=quadSrcPx;
  const topLen=Math.hypot(tr.x-tl.x,tr.y-tl.y), botLen=Math.hypot(br.x-bl.x,br.y-bl.y);
  const leftLen=Math.hypot(bl.x-tl.x,bl.y-tl.y), rightLen=Math.hypot(br.x-tr.x,br.y-tr.y);
  // Anthropic's vision models don't benefit past ~1568px on the long edge
  // (internally resized above that) — this was capped lower (1400) than that
  // ceiling for no real reason, losing detail on small print (dates, the
  // 9-digit ID number) on a worn/creased card for no size or cost saving.
  const MAXDIM=1568;
  let outW=Math.round((topLen+botLen)/2), outH=Math.round((leftLen+rightLen)/2);
  const scale=Math.min(1,MAXDIM/Math.max(outW,outH,1));
  outW=Math.max(20,Math.round(outW*scale)); outH=Math.max(20,Math.round(outH*scale));
  const H=computeSquareToQuadHomography([tl,tr,br,bl]);
  const outCv=document.createElement('canvas'); outCv.width=outW; outCv.height=outH;
  const octx=outCv.getContext('2d');
  const outData=octx.createImageData(outW,outH);
  const od=outData.data;
  for(let j=0;j<outH;j++){
    const v=j/((outH-1)||1);
    for(let i=0;i<outW;i++){
      const u=i/((outW-1)||1);
      const p=applyHomography(H,u,v);
      const cx=Math.max(0,Math.min(sw-1,p.x)), cy=Math.max(0,Math.min(sh-1,p.y));
      const [r,g,b]=bilinearSample(srcData,sw,sh,cx,cy);
      const o=(j*outW+i)*4;
      od[o]=r; od[o+1]=g; od[o+2]=b; od[o+3]=255;
    }
  }
  octx.putImageData(outData,0,0);
  return outCv;
}


let _pdfjsLoading=null;
function _loadPdfJs(){
  if(window.pdfjsLib) return Promise.resolve();
  if(_pdfjsLoading) return _pdfjsLoading;
  _pdfjsLoading=new Promise((res,rej)=>{
    const sc=document.createElement('script');
    sc.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    sc.onload=()=>{ try{ pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; }catch(e){} res(); };
    sc.onerror=()=>rej(new Error('pdf.js CDN failed'));
    document.head.appendChild(sc);
  });
  return _pdfjsLoading;
}
