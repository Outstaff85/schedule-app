# Document scan (passport / Israeli ID)

Turns photos or PDFs of an ID or passport into a filled worker form. Two parts (owner, 2026-10-18): **the scanner** finds, cuts and straightens the documents — the camera, the frame, the corners (`src/scan/`, the server's `find` / `cut`; see The scan window below); **the scan process** reads them — the AI reads, the digit checks, merging the pages, the worker form and Form 101 (today `scan-pipeline.js`; when it moves to the new stack, `src/scan-process/`). Most of the scan process is in `scan-pipeline.js`. It is lazy-loaded the first time a scan starts and shares the global scope of `schedule-manager.html` (no modules). The entry points and the upload helpers stay in `schedule-manager.html`.

The worker modal that the scan opens is in [workers.md](workers.md); the PDF built from the result is in [form101.md](form101.md).

## Entry points (schedule-manager.html)

- **`startNewScan()`** — the "Scan passport" button.
- **`rescanWorkerDoc(workerId)`** — a scan tagged to an existing worker; sets `window.__aiRescanWorkerId`.
- **`rescanFromWorkerModal()`** / **`rescanFromWorkerCard(wi)`** — "Scan / Rescan" in the worker window and card, keeping the window's form as a draft (`ManagerIsland.editorDraft()`, the React window — [workers.md](workers.md)).

**The scan window** (since S2, docs/scan-plan.md): `startNewScan()`, `rescanWorkerDoc()` and a rescan from the worker window (when no scan is in memory) open the new window first — `openNewScan()` (`src/manager/page/scan.ts`) → `openScanner()` (`src/scan/open.tsx`); its pages then go to the reading below. See **The scan window** further down.

Both:
1. warm the Cloud Functions (`warmCloudFunctions(SCAN_WARM_URLS())` — `{"ping":true}` to `preprocess_scan`, `fill_form_101` and `ai_read`; at most once per URL every 4 min, results in `__fnWarm`);
2. load the pipeline (`ensureScanPipelineLoaded()`);
3. call `openNewScan()`, which opens the scan window and, on Done, `openAiScan()` with the window's pages queued as ready (`{ready:true, upright, blurry}` in `__pendingScanPages`) and `processAllPendingPages()` started. Phase 1 skips the alignment and enhancement of a ready page; a page with no face (`upright` false) still asks `aiDetectAlign` for its turn and kind. The old queue screen and its "+" tile (Path A / B below) stay as they were, reached from the review screen.

`openAiScan()` opens `#aiScanOverlay` and resets every per-scan global:
`__aiScanPageThumbs`, `__aiPrimaryParsed`, `__aiParsed`, `__aiScanImage`, `__aiPacketOtherPages`, `__aiAvatarB64`, `__aiPageParsed`, `__pendingScanPages`, `__scanReplace`.

There is no separate upload screen: it opens straight on the page queue (`renderPendingPagesPrompt()`). The queue then shows the empty "+" tile and a short note on the supported documents. The file input accepts images and PDFs, several at once (`_onScanFilesPicked`):
- one photo → `onScanFileSelected` (Path A, through the corner editor);
- several files, or a PDF → `_queueScanFiles`: every page of every file (`filesToUploadPages`; a shrunk photo keeps its original as the page's photo twin) becomes a queue tile of its own, in order, without the corner editor — Phase 1 aligns it like any page. A page whose text looks like an old filled Form 101 (`כרטיס עובד` / `0101/130`) is left out, with a toast;
- taking a new photo for a tile (`__scanReplace`) uses the first file only.

## Upload preparation (schedule-manager.html, shared by every upload)

| Function | What it does |
|---|---|
| `downscaleForUpload(b64, mediaType)` | Shrinks to `UPLOAD_MAX_DIM` = 1800 px (JPEG 0.9). Never upscales; any failure returns the original. |
| `fileToUploadPages(file)` | → `[{b64, mediaType, text, fileName}]`. An image is one page. A PDF goes through pdf.js (`_loadPdfJs()`, cdnjs 3.11.174) at scale 2.5, all pages in parallel, keeping the text layer in `text`. |
| `filesToUploadPages(files)` | All files in parallel, as one ordered list. |
| `fileForStorage(file)` | One file kept whole: an image is shrunk, anything else is sent as-is. Used by worker documents. |

**Rule:** a new upload feature must go through these and send its per-page requests in parallel.

## The AI calls

All of them are sent as `fetch(API_URL, …)`; the dispatcher passes them to the `ai_read` Cloud Function ([backend.md](backend.md) → `ai.py`). Independent calls are sent in parallel, and `ai_read` serves them from one instance — the pattern, client and server, is in [backend.md](backend.md) → Parallel AI calls.

| Action | Model | Used for |
|---|---|---|
| `aiReadDoc` | `ANTHROPIC_MODEL` | Full read of the main page: `type` (`israeli_id` / `passport`), names, numbers, dates, sex, address, children, spouse; for the name cross-check also `latinSurname` / `latinGiven` (the holder's Latin spelling when the page prints one) and `mrzName` (MRZ line 1 from its 6th character); `fieldBoxes` (boxes of the digit fields and of given name, surname, address, house number, city); `photoBox` (the portrait) |
| `aiReadSefach` | `ANTHROPIC_MODEL` | An extra Israeli-ID page (ספח or card back): address, house number, city, marital status, sex, spouse, children; `idNo`, `given` and `surname` of the holder for cross-check; `fieldBoxes` for address, house number, city. Always `type:'israeli_id'`. With `part:'holder'` / `part:'family'` it returns only the holder's fields (names, ID, address, marital status, sex, `fieldBoxes`) or only `spouse` + `children` |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` (Haiku) | Rotation and the page `kind` (no corners since S1: the old path below then only turns the page, with no AI crop): `id_front` / `id_back` / `sefach` / `passport` / `contract` / `other`. A failed call leaves the page as cropped; the error goes to Admin → Errors as `console.warn('aiDetectAlign failed: …')` (`readSefachPage` does the same for `aiReadSefach`) |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | Batched zoomed re-read of several fields (kinds `digits9`, `date`, `passportNo`, `hebrewText`, `latinName`, `houseNumber`) |
| `aiVerifyField` | `ANTHROPIC_MODEL` | One zoomed re-read (the ID retry) |
| `aiFindField` | `ANTHROPIC_MODEL` | One missing field searched for on the worker's page photos, from the worker modal or card ([workers.md](workers.md) → field search) |

The prompts live in `functions-auth/ai_prompts.json` — see [backend.md](backend.md).

## Path A — one photo (with the corner editor)

A single non-PDF file → `onScanFileSelected(file)`:

1. **Downscale** the photo (`downscaleForUpload`) — the photo as taken is kept on the device (`__scanEditOrig`) for sharper field crops (see "Sharper field crops" below) — then open the corner editor on the raw photo, with no server call yet (`__scanEditPurpose='collectPage'`). See "Corner editor" below.
2. **Confirm or skip.** `confirmScanQuad()` perspective-warps the quad flat (`warpQuadImage`); `skipScanQuad()` keeps the photo as-is. Either way the page is pushed to `__pendingScanPages` and the queue screen shows (`renderPendingPagesPrompt()`: the same page grid, "+" tile and main button as the review screen).
3. **`processAllPendingPages()`** — the only step that talks to the server:
   - **Resume:** if a primary record and its image already exist (pages added after a first batch), the run continues that record.
   - **Early read** (fresh scan): page 1 is sent to `aiReadDoc` straight away, as cropped. If it is an ID or passport, its digits are re-checked while Phase 1 runs.
   - **Phase 1, all pages in parallel:**
     1. `autoPreAlignScan()` → `aiDetectAlign`: rotate (`alignScanImage`); the prompt no longer gives corners, so the corner refine and warp (`refineQuadCorners`, `warpQuadImage`) are skipped and the page stays as the user cropped it. It returns the page `kind`.
     2. `preAlignScan()` → `preprocess_scan`: contrast and sharpness up, then the blur check. Returns `{blurry:true}` or the enhanced image. The request carries the manager's ID token (`Authorization: Bearer`); without it the function answers 401 ([backend.md](backend.md) → Cloud Functions).
   - **Phase 2, reads:**
     - **Primary.** The first page that is not a contract/other (`isNonIdKind`) and reads as an `israeli_id` or `passport` becomes the primary. The early result is used for page 1 when it worked; otherwise the aligned page is read now. Then:
       - `verifyDigitFields()` and `verifyIdChecksum()`;
       - `initPrimaryFromFirstPage()`;
       - the avatar crop (`cropPortraitAvatar` — switched off, gives null);
       - `finalTightenPass()` for the stored image `__aiScanImage`.
     - **Extra pages.** Which following pages get a read is `extraReadWanted(primary, kind)`: after an Israeli-ID primary, every page of kind `sefach` (the ספח is a folded sheet, often photographed in parts, and the children or spouse can be on a later part), and any page while the primary is still missing a core field (`missingCore`: dob, sex, address, city); after a passport, only pages of kind `sefach` or `id_back` (`PASSPORT_EXTRA_KINDS` — see Merging pages → passport + ספח). They are read with `extraPageReader(kind)`:
       - `passport` → no AI read;
       - `id_front` → `readFrontPage` (`aiReadDoc`);
       - everything else (`sefach`, `id_back`, `contract`, `other`, unknown) → `readSefachPage` (`aiReadSefach`). This includes `contract` and `other` because the align model often files the paper ספח (a printed form) under those kinds.
       
       `readSefachPage` sends two `aiReadSefach` requests at once, `part:'holder'` and `part:'family'`, and merges them: writing the long answer is what takes the time, and two halves are written in parallel. If either half fails it makes one full read instead. A card back is split too, because the align model has filed a paper ספח under `id_back`. These reads start in the background (`prefetchSefachFrom(start, primaryRead)`) as soon as the primary's read is known. They are merged in page order with `mergeScanPage()`. Every extra page also goes through `finalTightenPass()` and is kept in `__aiPacketOtherPages`. Extra pages are read only while the primary still misses core fields, so a real contract costs one read at most, and `aiReadSefach` returns nothing for it.
   - **A blurry page** stops the run there: earlier pages are kept, the blurry one is dropped, later ones stay queued. The message says which page.
   - **Progress** shows through `renderScanProgress(label, pct)`; a `scan` timing is reported.
4. **Review screen** — `renderScanPagesPrompt()`. The page grid is shared with the queue screen (`_scanPagesGrid`): at least 180 px per page (one per row on a phone), each page shown whole (`object-fit:contain`, so leftover background is visible), a ✕ in the corner of every page. Tapping a page scans it again (`rescanScanPage(screen, i)`); a translucent round refresh sign sits in its middle. The last tile is an empty dashed slot with a translucent "+" that adds a page. The new photo goes through the corner editor, then `_queueScanPage()` puts it in the old page's place. On the queue screen it simply replaces that page. On the review screen `_replaceReviewPage(i, img)` aligns and enhances only that photo and reads it: page 1 with the full read (`aiReadDoc`, digit re-check), any other page with the reader its kind calls for (`extraPageReader`). The record is then rebuilt from every page's own read (`rebuildPrimaryFromPages`), so the other pages are not read again. A blurry photo, a failed read, or a page 1 that is not an ID or passport keeps the old page (toast). The main button, full width, is pinned to the bottom of the modal (`_scanPagesButtons`): "Done" → `finishScanPages()` → `openWorkerModalFromScan()` (on the queue screen, "Process N pages"). Adding a page (the "+" tile) goes back to step 1 and the queue. Removing pages:
   - `removeExtraScanPage(i)` drops page i and recomputes the primary from the remaining pages (`rebuildPrimaryFromPages()`, which replays `initPrimaryFromFirstPage` + `mergeScanPage` over `__aiPageParsed`).
   - For page 1 it calls `removePrimaryScanPage()`: after a confirm, the next page becomes page 1 and the record is rebuilt from the remaining pages' reads, without reading anything again. With no pages left the scan starts over. `rebuildPrimaryFromPages` takes the document type from the first page that has one.

   The scan modal is 680 px wide.

## Path B — several files or a PDF (no corner editor)

`onScanFilesSelected(files)` — no longer reached from the UI (several files and PDFs go to the queue, see Entry points); kept working:

1. Expand every page (`filesToUploadPages`). An image that was shrunk keeps its original (`orig`), which becomes the page's photo twin (`hi`, no geometry steps).
2. A page whose text looks like an old filled Form 101 (`כרטיס עובד` or `0101/130`) is dropped.
3. All other pages are classified in parallel (`classifyPage` → `aiDetectAlign`, kind only).
4. In order: the first non-contract page that `aiReadDoc` reads as an ID/passport becomes the primary (digit check, `initPrimaryFromFirstPage`), and the following pages' reads are prefetched as in Path A. Later pages are read and merged by the same `extraReadWanted` rule. Every page except the primary is kept as an extra page.
5. A `scanFiles` timing is reported, then the same review screen.

The pages are not aligned, enhanced or tightened in this path.

## Digit verification

- **Normalizing:** `_normScanDigits(s)` joins grouped digits (`0 1234567 8` → `012345678`); `_normScanDate(s)` pads to `DD/MM/YYYY`.
- **`verifyDigitFields(parsed, b64, mediaType, hi)`** builds jobs from `fieldBoxes`:
  - Israeli ID: `idNo` and `dob` (all re-read every time in the same call; `__idZoomed` is set, so `verifyIdChecksum` does not read the same box again);
  - passport: `passportNo`, `dob`, `expiry` (a field taken from the MRZ with a right check digit — `passportNoFromMrz` / `dobFromMrz` / `expiryFromMrz`, set by `ai_read` — has no box and is not re-read; without an MRZ, `ai_read` swaps a reversed issue / expiry pair back and marks an implausibly short validity as "check");
  - both (`_pushTextJobs`): every boxed `given`, `surname`, `address` and `city` (`hebrewText`; a passport's names `latinName`) and `houseNumber` (`houseNumber`). All of them go in the same one call. A field left empty is searched for after the scan instead (`autoFindMissingScanFields`, [workers.md](workers.md)).
  
  `verifyFieldsBatch()` crops each box with a margin (`_fieldCrop`: from the photo twin when the page has one, else `cropFieldImage` from the page, scaled to at least 500 px wide; at most 1100 px), then sends one `aiVerifyFields` for all of them. `_applyZoomedRead` keeps only a readable value of the right shape (9 digits, `DD/MM/YYYY`, an uppercased passport number, a house number without spaces, text with single spaces):
  - **digits and dates** — the zoomed value replaces the first read. For the ID number the check digit decides: a first read that passes it is kept over a zoomed one that does not, and a zoomed one that passes it is taken without a mark;
  - **text** (`hebrewText`, `latinName`, `houseNumber`) — the zoomed value is kept beside the first read in `parsed.__zoom` and never replaces it on its own. The names are picked later from all their readings (Merging pages → holder's name); street, house number and town keep the first read.
  
  When the zoomed value differs from the first read (names aside), the field goes into `parsed.__uncertain`.
- **Sharper field crops.** The read page was shrunk to `UPLOAD_MAX_DIM`, so a zoomed crop of it is only a stretched copy. Each queued page carries a photo twin `hi = {src, ops}`: the photo as taken plus the geometry steps the page went through — the corner editor's warp (`{quad}`), and `autoPreAlignScan`'s rotation (`{rotate}`) and warp (`{quad}`), returned as its `ops` (`preprocess_scan` keeps the geometry). `_hiFieldCrop(hi, box, page)` maps the box corners back through those steps (`_hiMapPoint`: the warp's own homography, the opposite rotation) onto the photo (decoded once, `_hiSource`), copies out only that region and warps it straight. It returns null — and the page crop is used — when the photo is no sharper there (less than 1.2× the page's pixels). Only the crops are uploaded; the twin is never stored (`__aiScanImage` / `__aiPacketOtherPages` hold plain pages). About half a second for a scan's fields on a phone. Pages without a photo (a PDF, a page re-read from storage) work as before.
- **`verifySefachFields(parsed, b64, mediaType)`** does the same for the ספח read's address, house number and city. It runs in `readSefachPage` and `runSefachOcr`.
- **"Check this" marks:** `openWorkerModalFromScan` collects the uncertain fields whose value is the one on screen (`_scanUncertainKeys` over `__aiPageParsed`) into `ocrFields.__scanCheck`. The modal frames them in amber with a note (`markScanUncertain`) until the field is edited; the note's 🔍 link reads that field again (the editor's recheck in `WorkerEditor.tsx`, [workers.md](workers.md) → field search). This is display only and never saved.
- **`verifyIdChecksum(parsed, b64, mediaType, hi)`** uses `isValidIsraeliId(id)` (check digit). If it fails, one `aiVerifyField` retry of the ID box follows, unless `verifyDigitFields` already re-read that box zoomed (`parsed.__idZoomed`). The result is `parsed.idChecksumOk`; a still-failing number shows an amber warning in the modal.

## Merging pages

- **Fields:**
  - `ID_CORE_FIELDS` = dob, sex, address, houseNumber, city, maritalStatus — filled only where the primary is empty (`mergeIsraeliIdFields`);
  - children — from every page, each child once (by ID number, else name);
  - spouse — taken from the first page that has one.
- **ID number from a ספח:** an `idNo` read from a ספח (`__isSefachScan`) is never trusted on its own. It is kept in `__aiPendingSefachIdNo` to cross-check a front page; a disagreement sets `idMismatch`.
- **Front page after the ספח:** it also fills an empty `given`, `surname` and `expiry`.
- **Passport + ספח** (per user decision 2026-10-04): a ספח or ID card back merged into a passport primary (`_passportHolderIsIsraeli`) makes the holder an Israeli resident, recorded like an Israeli ID, as Form 101 needs. `type` becomes `israeli_id`; the Hebrew names, ID number, address and family come from the ספח. The passport's Latin names and MRZ name line become the name references; its dates, sex and `passportNo` stay. The ID number has only its check digit as a check (`idChecksumOk`). An Israeli passport itself is read as `israeli_id` by `aiReadDoc` (Hebrew names, Latin ones as `latinSurname` / `latinGiven`, `idNo` from its Identity No., `passportNo`), and then reads its ספח like an ID card.
- **The holder's name** (`_resolveScanNames`, run by `initPrimaryFromFirstPage` and `mergeScanPage`, so a page removal replays it). `_addScanNameReads` collects on the primary (`__names`) every reading of `given` / `surname`: the front's first read (`full`, kept in `__full`), its zoomed re-read (`zoom`), and the ספח / card back's copy (`sefach`, pages read by `readSefachPage` are tagged `__fromSefachReader`); and the references: the Latin spelling (`latinSurname` / `latinGiven`, Hebrew names only) and the MRZ names (`mrzName` → `_mrzNames`). `_pickScanName` then:
  1. all readings agree → that value; marked "check" only when a reference does not match it;
  2. a reference decides — the reading whose letters match it best, clearly better than the others (`_nameRefDistance`: for Hebrew, consonant classes of the Hebrew letters vs the Latin spelling, `_hebSkeleton` / `_latSkeleton` aligned by `_skeletonAlign`, so a ד misread as ר no longer matches D; for a passport, the letters against the MRZ). Usual spelling noise is allowed: ו spelled V, ח spelled H, צ as Z, כ as CH. A different consonant, or one missing or extra, counts as suspicious, and marks even a reading all sources agree on. Vowel letters (ו, י) are not compared: names are written with and without them (משה = MOSHE);
  3. two readings agree against a third → the majority;
  4. otherwise the first read stays and the field is marked "check" (`__uncertain`).

## Into the worker modal (`openWorkerModalFromScan(p)`)

It builds `ocrFields` only from values this scan actually found (`setIfPresent`), so a rescan never blanks existing data:
- `docType`, `docGiven`, `docSurname`, `docId`, `docDob`, `docSex`, `docExpiry`;
- Israeli ID: address, house number, city, marital status (from `single` / `married` / `divorced` / `widowed`), children, spouse. A spouse sets married when no status was read;
- `idChecksumOk` / `idMismatch` (display only).

Which worker it opens:
- a rescan (`__aiRescanWorkerId`) opens that worker;
- a new scan whose document number matches an existing worker opens **that** worker instead of a new one (toast);
- in both cases `__aiRescannedWorkerId` is set, so `saveWorker()` rebuilds Form 101 from this scan;
- otherwise a blank new worker opens.

Either way, a draft from `rescanFromWorkerModal()` is then put back (`applyWorkerDraft()`): typed values stay, empty fields take the scan's.

The scan images stay in `__aiScanImage` / `__aiPacketOtherPages` for the upload.

## Corner editor

- **Drawing:** `renderScanQuadEditor(b64, mediaType, cornersFrac)` draws the photo inside `#scanEditWrap`, with an 18 px dark margin (`QUAD_PAD`) and an SVG quad: 4 corner handles and a grip bar on each side. It waits for `img.decode()` (at most 1.2 s), then one frame, before `initScanQuad()` reads the size.
- **Dragging:** `attachQuadDrag()` listens on the whole wrap. `quadHitTest()` picks the nearest corner within 36 px (`QUAD_CORNER_HIT`), else the nearest side within 32 px (`QUAD_EDGE_HIT`); dragging a side moves both of its corners. It uses pointer capture and handles `pointercancel`. The wrap is `touch-action:none` and carries `.no-swipe`, so on a phone a drag that starts on the photo, a handle or the quad never starts the window's swipe-down close ([app-core.md](app-core.md) → Layout).
- **Rotate:** `rotateScanQuad(±90)`.
- **Done / Skip:** `confirmScanQuad()` / `skipScanQuad()`.

## Image geometry helpers

- `warpQuadImage(b64, mediaType, quadPx)` → `warpQuadToRect()` — a true perspective warp (homography, bilinear sampling), long edge capped at 1568 px, JPEG 0.92.
- **Card edge test** (`_edgeTools.isCardEdge`): a colour jump counts as the card's edge only when the strip just inside it (3–10 px) has the card's colour (the median colour of the card's middle) and the stretch outside it, out to the end of the search, does not: at most 20 % of its points may look like the card, never two in a row. Printed text near the edge (the ID front's header line and vertical number) fails it, since there is card past the ink, and so does table clutter.
- `refineQuadCorners(b64, mediaType, corners, opts)` snaps an approximate quad to real edges on a ≤1200 px copy. For each of 20 samples per side it searches from the guess (`opts.inward` / `opts.outward`, default 4 % + 6 px each way) for the nearest jump that passes the card edge test, then takes the strongest jump within 4 px. Each side's line is fitted robustly (refit on inliers, at least 40 % of the samples) and kept only if the edge test passes on the line at 60 % of the sample positions. A side without such a line keeps the guess's side; the other sides still move their corners along it.
- `finalTightenPass(img)` is `refineQuadCorners` run from the whole frame, searching up to 15 % inward. It trims a background sliver or a wider tilted band (a strip of table under the card) along its tilt. An already tight page, or a card the colour of the background, is left untouched.
- `alignScanImage()` rotates by 0/90/180/270° and crops a box; `rotatePointFrac()` maps corners to match.
- `cropPortraitAvatar(b64, mediaType, photoBox)` → switched off (owner 2026-10-13, `SCAN_AVATARS = false`): always null, no photo is taken from a document, and `readDoc` no longer asks the AI for a `photoBox` (shorter replies); when on it gives a square 160 px JPEG (`AVATAR_SIZE`), black and white (`grayscaleCanvas`, schedule-manager.html).

## The scan window (`src/scan/`)

A `Window` (a bottom sheet on a phone) — `Scanner.tsx`:
- **Models on the phone** start when the window opens (`engine.ts`): background threads (`worker.ts` over `core.ts` — the site's own copy of what the scanner lab proved, apart from the lab: ONNX Runtime and the models from the site's own `/scan/`, put there at deploy by `scripts/scan/fetch-models.sh` from the firm's Storage) run the light corner model (`lite.onnx`) and the face finder (`yunet.onnx`, run at 320) — 2 GPU threads (ONNX Runtime 1.30), else single-thread CPU threads (half the cores, at most 3; 1.22), else one; the way that worked is remembered on the device (`localStorage` `scanWay1`). Camera stays disabled until they are ready; if they cannot start, photos still work.
- **Camera:** each frame scaled to 256 px and sent to a free thread; the corners smoothed and carried between answers by the tracker (`track.ts`, pyramidal Lucas–Kanade on a 320 px gray copy); a thin frame, red while searching, green after 0.25 s on the edges; **the shot is taken by itself after 1 s held still**, then not again until the document leaves that place (taken away, turned over, the next one put down) — `Capture` takes one at any time.
- **A shot** is cut and turned upright on the phone at once (the thread's warp + face turn) and shown in the strip; the full frame (≤ 2400 px) goes to `preprocess_scan` with `find` and the live corners (`server.ts`, the ID token, at most 4 in flight); the server's pages replace the phone's cut (a photo with two documents → two pages); without the server the phone's cut is kept.
- **Photos or PDF:** `filesToUploadPages` (every page; old filled Form 101 pages left out), every page to `preprocess_scan` with `find` at once (4 in flight); each page's documents join the strip in order; a page the server cannot work on is kept whole.
- **Corners** (`Corners.tsx`, S6): a tap on a page the server found opens its photo with the frame (the corners on the whole photo; a photo on a white page is mapped back from its box); each corner is dragged (a loupe above the finger, 2.5×); **Apply** sends the photo with the corners to `preprocess_scan` with `cut` (`cutPage`), and the page is replaced by the server's cut, marked **Corrected**. A page cut on the phone (no server) has no corners to correct.
- Each page can be removed (🗑). **Done (n)** waits for the pages still with the server and resolves `openScanner()` with `{b64, mediaType, turn, blurry}` per page; closing the window resolves null.
- **Training examples** (S6, docs/scan-plan.md): on Done, every page the server found becomes an example `{cornersModel, cornersFixed, source}` — a corrected page also carries `image`, a 256×256 JPEG of the part of the photo the model looked at (never the photo); `sendFeedback` (`server.ts`) queues them on the phone (`localStorage` `scanFeedbackQueue`, at most 60) and sends them to `scan_feedback` in the background, 10 at a time; what cannot be sent waits for the next time the window opens.
- Covered by the browser test "scan window" (a picked photo, the server's answer mocked: two documents → two pages → the reading).

## Contracts

An extra page that `aiDetectAlign` calls `contract` and whose read has no ID number and no names is marked `contract` in `__aiPacketOtherPages` (`processAllPendingPages`). `aiFillForm101` (`src/manager/page/scan.ts`) leaves those pages out of Form 101 and, once the worker's documents are saved, `saveScanContract()` puts them together as one PDF (`imagesToPdf`, `src/scan/pdf.ts` — a page per photo, A4 wide, JPEG as is) and saves it to the worker's documents as type `contract` (`saveWorkerFile`, one retry); a failure is a toast and an Admin → Errors entry. Its end date is not read. Browser test: "scan contract".

## Training examples (`scan_feedback`, `functions/feedback.py`)

`POST scan_feedback` (a manager login's ID token, `gate.claims_of`): `{"action":"add","examples":[…]}` — at most 20; each checked by `feedback.check` (4 corners in 0..1; a page moved at least 0.005 must carry a JPEG of at most 80 KB); a page moved less is only counted (`right`); a moved one is kept: the copy in Storage `training/scan/<YYYY-MM>/<id>.jpg`, the record in Firestore `scanTraining/<id>` (`cornersModel`, `cornersFixed`, `moved`, `source`, `model` — the server's model version, `tenantId`, `image`, `createdAt`, `deleteAt` = +365 days), and `scanTrainingStats/current` counts (`newSince`, `kept`, `right`, `movedSum`). `{"action":"stats"}` (the super-admin only) returns the counts and `due` (`newSince` ≥ 200): the bell shows the super-admin **Time to retrain the scanner** (`scanTrainingNotice`, `src/manager/page/header.ts`, read at most every 6 hours). No client reads or writes these collections or `training/` (no rule grants them); the copies and records go after 12 months (the Firestore TTL on `scanTraining.deleteAt` in `firestore.indexes.json`; the Storage lifecycle rule on `training/`, set by `scripts/scan/storage_lifecycle.py` in deploy-rules.yml). Tests: `tests/auth/test_scan_feedback.py`, the browser test "scan window corners".

## Server-side finding (`preprocess_scan` with `find`)

The new scanner's server step (docs/scan-plan.md → S1), called by the scan window (`src/scan/server.ts`). With `{"image", "cut": [[x, y] ×4]}` instead it cuts one page exactly by those corners (the user's, 0..1 of the photo — `cut_scan_page`), turns it upright by its face and enhances it (`source` `user`). The models are those of the site's version, `functions/scan_models_version.txt` (the same as `scripts/scan/models-version` — a test checks it). `POST preprocess_scan` with `{"image": <base64>, "find": true, "corners": [[x, y] ×4]}` (corners optional: the phone's live frame, 0..1, top-left first, clockwise) answers `{"ok": true, "size": [w, h], "pages": [...]}`; each page: `quad` (0..1 of its photo), `box` (the photo's place on a white page, pixels, or `null`), `source` (`model` — the corner model; `phone` — the phone's corners kept; `more` — another document on the same photo; `photo` — a photo on a white page with no frame in it, whole; `whole` — nothing found, the whole picture), `turn` (clockwise quarter-turns applied by the face; −1 no face, −2 the face finder failed), `blurry` / `blurVariance`, `imageBase64` (JPEG, enhanced, at most 1800 px). The photo is worked on at most 2400 px.

`find_scan_pages()` (`functions/main.py`) → `docfind.find_documents()` (`functions/docfind.py`), the scanner lab's steps in Python:

1. `photos_on_page` — a white page (a form's page, a PDF, a screenshot) is cut into its photos: bands of rows mostly not white, at least 12 % high, their sides from the columns; a mostly dark band (a screenshot's bar) is not a photo; a picture whose rest is not mostly white is not a white page; and when the model sees a document on the whole picture outside the bands, it is a plain photo.
2. On each photo: the accurate model (sa24, fp32), then the light one; when neither is sure, the same inside a 10 % margin of the background's colour (a document cut by the photo's edge, or cut to its edges already). Sure corners must be convex, cover over 3 % and be no longer than 3 : 1. Then `refine_edges` pulls each side onto the strongest edge within 1.2 % of the long side, kept only when the edges are clearly stronger.
3. Not sure: the phone's corners (a whole picture), else the photo whole.
4. `find_next` — up to 4 documents: the found ones painted over in the background's colour, then the margin, then the two widest strips beside the first; accurate model only (the light one finds false second documents); a frame overlapping a found one by over 30 % is that one.
5. Each page cut flat (`warp`, cubic) and turned upright by YuNet (all 4 turns scored, eyes above the mouth); then the contrast / sharpness step and the blur check of the old path.

The models (`sa24.onnx`, `lite.onnx`, `yunet640.onnx`) are read from Storage `models/scan/base-v1/` once per instance (`_scan_models()`, ONNX Runtime CPU, 2 threads); the function's service account needs read access to the bucket. Tests: `tests/auth/test_scan_find.py` (a stand-in model; the real models are checked by hand on the owner's photos).

## Unreachable code kept

- `runOcr()` / `_preAlignThenOcr()` — the old one-page-at-a-time path; nothing sets `__scanEditPurpose='preOcr'`.
- `onSefachFileSelected()` / `runSefachOcr()` — the "ספח only" path; its button was removed. It still reads `imageAlign`, which the AI no longer returns, so it would start from the full frame.
