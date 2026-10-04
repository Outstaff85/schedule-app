# Document scan (passport / Israeli ID)

Turns photos or PDFs of an ID or passport into a filled worker form. Most of the code is in `scan-pipeline.js`. It is lazy-loaded the first time a scan starts and shares the global scope of `schedule-manager.html` (no modules). The entry points and the upload helpers stay in `schedule-manager.html`.

The worker modal that the scan opens is in [workers.md](workers.md); the PDF built from the result is in [form101.md](form101.md).

## Entry points (schedule-manager.html)

- **`startNewScan()`** — the "Скан паспорта" button.
- **`rescanWorkerDoc(workerId)`** — a scan tagged to an existing worker; sets `window.__aiRescanWorkerId`.
- **`rescanFromWorkerModal()`** / **`rescanFromWorkerCard(wi)`** — "Scan / Rescan" in the worker modal and card, keeping the form as a draft ([workers.md](workers.md)).

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
| `aiReadDoc` | `ANTHROPIC_MODEL` | Full read of the main page: `type` (`israeli_id` / `passport`), names, numbers, dates, sex, address, children, spouse; `fieldBoxes` (boxes of the digit fields and of given name, surname, address, house number, city); `photoBox` (the portrait) |
| `aiReadSefach` | `ANTHROPIC_MODEL` | An extra Israeli-ID page (ספח or card back): address, house number, city, marital status, sex, spouse, children, `idNo` for cross-check; `fieldBoxes` for address, house number, city. Always `type:'israeli_id'` |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` (Haiku) | Rotation, 4 corners and the page `kind`: `id_front` / `id_back` / `sefach` / `passport` / `contract` / `other`. A failed call leaves the page as cropped; the error goes to Admin → Errors as `console.warn('aiDetectAlign failed: …')` (`readSefachPage` does the same for `aiReadSefach`) |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | Batched zoomed re-read of several fields (kinds `digits9`, `date`, `passportNo`, `hebrewText`, `latinName`, `houseNumber`) |
| `aiVerifyField` | `ANTHROPIC_MODEL` | One zoomed re-read (the ID retry) |
| `aiFindField` | `ANTHROPIC_MODEL` | One missing field searched for on the worker's page photos, from the worker modal or card ([workers.md](workers.md) → field search) |

The prompts live in `functions-auth/ai_prompts.json` — see [backend.md](backend.md).

## Path A — one photo (with the corner editor)

A single non-PDF file → `onScanFileSelected(file)`:

1. **Downscale** the photo (`downscaleForUpload`), then open the corner editor on the raw photo, with no server call yet (`__scanEditPurpose='collectPage'`). See "Corner editor" below.
2. **Confirm or skip.** `confirmScanQuad()` perspective-warps the quad flat (`warpQuadImage`); `skipScanQuad()` keeps the photo as-is. Either way the page is pushed to `__pendingScanPages` and the queue screen shows (`renderPendingPagesPrompt()`: the same page grid, "+" tile and main button as the review screen).
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
       - `passport` → no AI read;
       - `id_front` → `readFrontPage` (`aiReadDoc`);
       - everything else (`sefach`, `id_back`, `contract`, `other`, unknown) → `readSefachPage` (`aiReadSefach`). This includes `contract` and `other` because the align model often files the paper ספח (a printed form) under those kinds.
       
       These reads start in the background (`prefetchSefachFrom`) as soon as the primary is known to be missing fields. They are merged in page order with `mergeScanPage()`. Every extra page also goes through `finalTightenPass()` and is kept in `__aiPacketOtherPages`. Extra pages are read only while the primary still misses core fields, so a real contract costs one read at most, and `aiReadSefach` returns nothing for it.
   - **A blurry page** stops the run there: earlier pages are kept, the blurry one is dropped, later ones stay queued. The message says which page.
   - **Progress** shows through `renderScanProgress(label, pct)`; a `scan` timing is reported.
4. **Review screen** — `renderScanPagesPrompt()`. The page grid is shared with the queue screen (`_scanPagesGrid`): at least 180 px per page (one per row on a phone), each page shown whole (`object-fit:contain`, so leftover background is visible), a ✕ in the corner of every page. Tapping a page scans it again (`rescanScanPage(screen, i)`); a translucent round refresh sign sits in its middle. The last tile is an empty dashed slot with a translucent "+" that adds a page. The new photo goes through the corner editor, then `_queueScanPage()` puts it in the old page's place. On the queue screen it simply replaces that page. On the review screen `_replaceReviewPage(i, img)` aligns and enhances only that photo and reads it: page 1 with the full read (`aiReadDoc`, digit re-check, portrait crop), any other page with the reader its kind calls for (`extraPageReader`). The record is then rebuilt from every page's own read (`rebuildPrimaryFromPages`), so the other pages are not read again. A blurry photo, a failed read, or a page 1 that is not an ID or passport keeps the old page (toast). The main button, full width, is pinned to the bottom of the modal (`_scanPagesButtons`): "Done" → `finishScanPages()` → `openWorkerModalFromScan()` (on the queue screen, "Process N pages"). Adding a page (the "+" tile) goes back to step 1 and the queue. Removing pages:
   - `removeExtraScanPage(i)` drops page i and recomputes the primary from the remaining pages (`rebuildPrimaryFromPages()`, which replays `initPrimaryFromFirstPage` + `mergeScanPage` over `__aiPageParsed`).
   - For page 1 it calls `removePrimaryScanPage()`: after a confirm, the next page becomes page 1 and the record is rebuilt from the remaining pages' reads, without reading anything again; the portrait is cleared. With no pages left the scan starts over. `rebuildPrimaryFromPages` takes the document type from the first page that has one.

   The scan modal is 680 px wide.

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
  - Israeli ID: `idNo` and `dob` (all re-read every time in the same call; `__idZoomed` is set, so `verifyIdChecksum` does not read the same box again);
  - passport: `passportNo`, `dob`, `expiry`;
  - both (`_pushTextJobs`): every boxed `given`, `surname`, `address` and `city` (`hebrewText`; a passport's names `latinName`) and `houseNumber` (`houseNumber`). All of them go in the same one call. A field left empty is searched for after the scan instead (`autoFindMissingScanFields`, [workers.md](workers.md)).
  
  `verifyFieldsBatch()` crops each box with a margin and scales it to at least 500 px wide (`cropFieldImage`), then sends one `aiVerifyFields` for all of them. `_applyZoomedRead` takes the zoomed value when it is readable and has the right shape (9 digits, `DD/MM/YYYY`, an uppercased passport number, a house number without spaces, text with single spaces). For the ID number the check digit decides: a first read that passes it is kept over a zoomed one that does not, and a zoomed one that passes it is taken without a mark. When the final value differs from the first read, the field goes into `parsed.__uncertain`.
- **`verifySefachFields(parsed, b64, mediaType)`** does the same for the ספח read's boxed address, house number and city. It runs in `readSefachPage` and `runSefachOcr`.
- **"Check this" marks:** `openWorkerModalFromScan` collects the uncertain fields whose value is the one on screen (`_scanUncertainKeys` over `__aiPageParsed`) into `ocrFields.__scanCheck`. The modal frames them in amber with a note (`markScanUncertain`) until the field is edited. This is display only and never saved.
- **`verifyIdChecksum(parsed, …)`** uses `isValidIsraeliId(id)` (check digit). If it fails, one `aiVerifyField` retry of the ID box follows, unless `verifyDigitFields` already re-read that box zoomed (`parsed.__idZoomed`). The result is `parsed.idChecksumOk`; a still-failing number shows an amber warning in the modal.

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

Either way, a draft from `rescanFromWorkerModal()` is then put back (`applyWorkerDraft()`): typed values stay, empty fields take the scan's.

The scan images stay in `__aiScanImage` / `__aiPacketOtherPages` for the upload.

## Corner editor

- **Drawing:** `renderScanQuadEditor(b64, mediaType, cornersFrac)` draws the photo inside `#scanEditWrap`, with an 18 px dark margin (`QUAD_PAD`) and an SVG quad: 4 corner handles and a grip bar on each side. It waits for `img.decode()` (at most 1.2 s), then one frame, before `initScanQuad()` reads the size.
- **Dragging:** `attachQuadDrag()` listens on the whole wrap. `quadHitTest()` picks the nearest corner within 36 px (`QUAD_CORNER_HIT`), else the nearest side within 32 px (`QUAD_EDGE_HIT`); dragging a side moves both of its corners. It uses pointer capture and handles `pointercancel`.
- **Rotate:** `rotateScanQuad(±90)`.
- **Done / Skip:** `confirmScanQuad()` / `skipScanQuad()`.

## Image geometry helpers

- `warpQuadImage(b64, mediaType, quadPx)` → `warpQuadToRect()` — a true perspective warp (homography, bilinear sampling), long edge capped at 1568 px, JPEG 0.92.
- **Card edge test** (`_edgeTools.isCardEdge`): a colour jump counts as the card's edge only when the strip just inside it (3–10 px) has the card's colour (the median colour of the card's middle) and the stretch outside it, out to the end of the search, does not: at most 20 % of its points may look like the card, never two in a row. Printed text near the edge (the ID front's header line and vertical number) fails it, since there is card past the ink, and so does table clutter.
- `refineQuadCorners(b64, mediaType, corners, opts)` snaps an approximate quad to real edges on a ≤1200 px copy. For each of 20 samples per side it searches from the guess (`opts.inward` / `opts.outward`, default 4 % + 6 px each way) for the nearest jump that passes the card edge test, then takes the strongest jump within 4 px. Each side's line is fitted robustly (refit on inliers, at least 40 % of the samples) and kept only if the edge test passes on the line at 60 % of the sample positions. A side without such a line keeps the guess's side; the other sides still move their corners along it.
- `finalTightenPass(img)` is `refineQuadCorners` run from the whole frame, searching up to 15 % inward. It trims a background sliver or a wider tilted band (a strip of table under the card) along its tilt. An already tight page, or a card the colour of the background, is left untouched.
- `alignScanImage()` rotates by 0/90/180/270° and crops a box; `rotatePointFrac()` maps corners to match.
- `cropPortraitAvatar(b64, mediaType, photoBox)` → a square 160 px JPEG (`AVATAR_SIZE`).

## Unreachable code kept

- `runOcr()` / `_preAlignThenOcr()` — the old one-page-at-a-time path; nothing sets `__scanEditPurpose='preOcr'`.
- `onSefachFileSelected()` / `runSefachOcr()` — the "ספח only" path; its button was removed. It still reads `imageAlign`, which the AI no longer returns, so it would start from the full frame.
