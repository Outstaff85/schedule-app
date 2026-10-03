# Document scan (passport / Israeli ID)

Turns photos or PDFs of an ID or passport into a filled worker form. Most of the code is in `scan-pipeline.js`. It is lazy-loaded the first time a scan starts and shares the global scope of `schedule-manager.html` (no modules). The entry points and the upload helpers stay in `schedule-manager.html`.

The worker modal that the scan opens is in [workers.md](workers.md); the PDF built from the result is in [form101.md](form101.md).

## Entry points (schedule-manager.html)

- **`startNewScan()`** — the "Скан паспорта" button.
- **`rescanWorkerDoc(workerId)`** — "Scan / Rescan" in the worker modal; sets `window.__aiRescanWorkerId`.

Both:
1. warm the Cloud Functions (`warmCloudFunctions(SCAN_WARM_URLS())` — `{"ping":true}` to `preprocess_scan`, `fill_form_101` and `ai_read`; at most once per URL every 4 min, results in `__fnWarm`);
2. load the pipeline (`ensureScanPipelineLoaded()`);
3. call `openAiScan()`.

`openAiScan()` opens `#aiScanOverlay` and resets every per-scan global:
`__aiScanPageThumbs`, `__aiPrimaryParsed`, `__aiParsed`, `__aiScanImage`, `__aiPacketOtherPages`, `__aiAvatarB64`, `__aiPageParsed`, `__pendingScanPages`.

The file input accepts images and PDFs, several at once.

## Upload preparation (schedule-manager.html, shared by every upload)

| Function | What it does |
|---|---|
| `downscaleForUpload(b64, mediaType)` | Shrinks to `UPLOAD_MAX_DIM` = 1800 px (JPEG 0.9). Never upscales; any failure returns the original. |
| `fileToUploadPages(file)` | → `[{b64, mediaType, text, fileName}]`. An image is one page. A PDF goes through pdf.js (`_loadPdfJs()`, cdnjs 3.11.174) at scale 2.5, all pages in parallel, keeping the text layer in `text`. |
| `filesToUploadPages(files)` | All files in parallel, as one ordered list. |
| `fileForStorage(file)` | One file kept whole: an image is shrunk, anything else is sent as-is. Used by worker documents. |

**Rule:** a new upload feature must go through these and send its per-page requests in parallel.

## The AI calls

All of them are sent as `fetch(API_URL, …)`; the dispatcher passes them to the `ai_read` Cloud Function ([backend.md](backend.md) → `ai.py`).

| Action | Model | Used for |
|---|---|---|
| `aiReadDoc` | `ANTHROPIC_MODEL` | Full read of the main page: `type` (`israeli_id` / `passport`), names, numbers, dates, sex, address, children, spouse; `fieldBoxes` (boxes of the digit fields); `photoBox` (the portrait) |
| `aiReadSefach` | `ANTHROPIC_MODEL` | An extra Israeli-ID page (ספח or card back): address, house number, city, marital status, sex, spouse, children, `idNo` for cross-check. Always `type:'israeli_id'` |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` (Haiku) | Rotation, 4 corners and the page `kind`: `id_front` / `id_back` / `sefach` / `passport` / `contract` / `other` |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | Batched zoomed re-read of several digit fields |
| `aiVerifyField` | `ANTHROPIC_MODEL` | One zoomed re-read (the ID retry) |

The prompts live in `functions-auth/ai_prompts.json` — see [backend.md](backend.md).

## Path A — one photo (with the corner editor)

A single non-PDF file → `onScanFileSelected(file)`:

1. **Downscale** the photo (`downscaleForUpload`), then open the corner editor on the raw photo, with no server call yet (`__scanEditPurpose='collectPage'`). See "Corner editor" below.
2. **Confirm or skip.** `confirmScanQuad()` perspective-warps the quad flat (`warpQuadImage`); `skipScanQuad()` keeps the photo as-is. Either way the page is pushed to `__pendingScanPages` and the queue screen shows (`renderPendingPagesPrompt()`: thumbnails, remove, "Add page", "Process N pages").
3. **`processAllPendingPages()`** — the only step that talks to the server:
   - **Resume:** if a primary record and its image already exist (pages added after a first batch), the run continues that record.
   - **Early read** (fresh scan): page 1 is sent to `aiReadDoc` straight away, as cropped. If it is an ID or passport, its digits are re-checked and the portrait is cropped from that same image, while Phase 1 runs.
   - **Phase 1, all pages in parallel:**
     1. `autoPreAlignScan()` → `aiDetectAlign`: rotate (`alignScanImage`), refine the corners on pixels (`refineQuadCorners`), and warp (`warpQuadImage`). The warp is skipped when the quad is the full frame (`_isNearIdentityQuad`). It returns the page `kind`.
     2. `preAlignScan()` → `preprocess_scan`: contrast and sharpness up, then the blur check. Returns `{blurry:true}` or the enhanced image.
   - **Phase 2, reads:**
     - **Primary.** The first page that is not a contract/other (`isNonIdKind`) and reads as an `israeli_id` or `passport` becomes the primary. The early result is used for page 1 when it worked; otherwise the aligned page is read now. Then:
       - `verifyDigitFields()` and `verifyIdChecksum()`;
       - `initPrimaryFromFirstPage()`;
       - the avatar crop (`cropPortraitAvatar`);
       - `finalTightenPass()` for the stored image `__aiScanImage`.
     - **Extra pages.** While an Israeli-ID primary is still missing a core field (`missingCore`: dob, sex, address, city), extra pages are read with `extraPageReader(kind)`:
       - `contract` / `other` / `passport` → no AI read;
       - `id_front` → `readFrontPage` (`aiReadDoc`);
       - `sefach` / `id_back` / unknown → `readSefachPage` (`aiReadSefach`).
       
       These reads start in the background (`prefetchSefachFrom`) as soon as the primary is known to be missing fields. They are merged in page order with `mergeScanPage()`. Every extra page also goes through `finalTightenPass()` and is kept in `__aiPacketOtherPages`.
   - **A blurry page** stops the run there: earlier pages are kept, the blurry one is dropped, later ones stay queued. The message says which page.
   - **Progress** shows through `renderScanProgress(label, pct)`; a `scan` timing is reported.
4. **Review screen** — `renderScanPagesPrompt()`: thumbnails (page 1 is not removable), "Add page" (back to step 1 and the queue), "Done" → `finishScanPages()` → `openWorkerModalFromScan()`. `removeExtraScanPage(i)` drops a page and recomputes the primary from the remaining pages (`rebuildPrimaryFromPages()`, which replays `initPrimaryFromFirstPage` + `mergeScanPage` over `__aiPageParsed`).

## Path B — several files or a PDF (no corner editor)

`onScanFilesSelected(files)` (also the entry for one PDF):

1. Expand every page (`filesToUploadPages`).
2. A page whose text looks like an old filled Form 101 (`כרטיס עובד` or `0101/130`) is dropped.
3. All other pages are classified in parallel (`classifyPage` → `aiDetectAlign`, kind only).
4. In order: the first non-contract page that `aiReadDoc` reads as an ID/passport becomes the primary (digit check, avatar), and the following pages' reads are prefetched as in Path A. Later pages merge while `missingCore` holds. Every page except the primary is kept as an extra page.
5. A `scanFiles` timing is reported, then the same review screen.

The pages are not aligned, enhanced or tightened in this path.

## Digit verification

- **Normalizing:** `_normScanDigits(s)` joins grouped digits (`0 1234567 8` → `012345678`); `_normScanDate(s)` pads to `DD/MM/YYYY`.
- **`verifyDigitFields(parsed, b64, mediaType)`** builds jobs from `fieldBoxes`:
  - Israeli ID: `idNo` (only when its checksum fails) and `dob`;
  - passport: `passportNo`, `dob`, `expiry`.
  
  `verifyFieldsBatch()` crops each box with a margin and scales it to at least 500 px wide (`cropFieldImage`), then sends one `aiVerifyFields`. A value replaces the original only when it has the right shape: 9 digits, `DD/MM/YYYY`, or an uppercased passport number.
- **`verifyIdChecksum(parsed, …)`** uses `isValidIsraeliId(id)` (check digit). If it fails, one `aiVerifyField` retry of the ID box follows. The result is `parsed.idChecksumOk`; a still-failing number shows an amber warning in the modal.

## Merging pages

- **Fields:**
  - `ID_CORE_FIELDS` = dob, sex, address, houseNumber, city, maritalStatus — filled only where the primary is empty (`mergeIsraeliIdFields`);
  - children — taken when the primary has none;
  - spouse — taken from the first page that has one.
- **ID number from a ספח:** an `idNo` read from a ספח (`__isSefachScan`) is never trusted on its own. It is kept in `__aiPendingSefachIdNo` to cross-check a front page; a disagreement sets `idMismatch`.
- **Front page after the ספח:** it also fills an empty `given`, `surname` and `expiry`.

## Into the worker modal (`openWorkerModalFromScan(p)`)

It builds `ocrFields` only from values this scan actually found (`setIfPresent`), so a rescan never blanks existing data:
- `docType`, `docGiven`, `docSurname`, `docId`, `docDob`, `docSex`, `docExpiry`, `avatarB64`;
- Israeli ID: address, house number, city, marital status (from `single` / `married` / `divorced` / `widowed`), children, spouse. A spouse sets married when no status was read;
- `idChecksumOk` / `idMismatch` (display only).

Which worker it opens:
- a rescan (`__aiRescanWorkerId`) opens that worker;
- a new scan whose document number matches an existing worker opens **that** worker instead of a new one (toast);
- in both cases `__aiRescannedWorkerId` is set, so `saveWorker()` rebuilds Form 101 from this scan;
- otherwise a blank new worker opens.

The scan images stay in `__aiScanImage` / `__aiPacketOtherPages` for the upload.

## Corner editor

- **Drawing:** `renderScanQuadEditor(b64, mediaType, cornersFrac)` draws the photo inside `#scanEditWrap`, with an 18 px dark margin (`QUAD_PAD`) and an SVG quad: 4 corner handles and a grip bar on each side. It waits for `img.decode()` (at most 1.2 s), then one frame, before `initScanQuad()` reads the size.
- **Dragging:** `attachQuadDrag()` listens on the whole wrap. `quadHitTest()` picks the nearest corner within 36 px (`QUAD_CORNER_HIT`), else the nearest side within 32 px (`QUAD_EDGE_HIT`); dragging a side moves both of its corners. It uses pointer capture and handles `pointercancel`.
- **Rotate:** `rotateScanQuad(±90)`.
- **Done / Skip:** `confirmScanQuad()` / `skipScanQuad()`.

## Image geometry helpers

- `warpQuadImage(b64, mediaType, quadPx)` → `warpQuadToRect()` — a true perspective warp (homography, bilinear sampling), long edge capped at 1568 px, JPEG 0.92.
- `refineQuadCorners()` snaps an approximate quad to real edges on a ≤1200 px copy. Searching outward, it takes the first edge strong enough, not the strongest one in the window. A side with a weak signal keeps the original corners.
- `finalTightenPass(img)` checks each of the 4 sides independently from a 3 % margin (`_scanSideEdge`, median of 16 samples) and trims a thin background sliver. Nothing changes when no confident edge is found.
- `alignScanImage()` rotates by 0/90/180/270° and crops a box; `rotatePointFrac()` maps corners to match.
- `cropPortraitAvatar(b64, mediaType, photoBox)` → a square 160 px JPEG (`AVATAR_SIZE`).

## Unreachable code kept

- `runOcr()` / `_preAlignThenOcr()` — the old one-page-at-a-time path; nothing sets `__scanEditPurpose='preOcr'`.
- `onSefachFileSelected()` / `runSefachOcr()` — the "ספח only" path; its button was removed. It still reads `imageAlign`, which the AI no longer returns, so it would start from the full frame.
