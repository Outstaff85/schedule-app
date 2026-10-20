# Document scan (passport / Israeli ID)

Turns photos or PDFs of an ID or passport into a filled worker form. Two parts (owner, 2026-10-18): **the scanner** finds, cuts and straightens the documents — the camera, the frame, the corners, the page kinds (`src/scan/`, the server's `find` / `cut`; The scan window below); **the scan process** reads them — the AI reads, the zoomed re-reads and check digits, merging the pages into one record, the worker form (`src/scan-process/`; Reading below). Both are on the new stack, bundled into the manager page's module. The old pipeline (`scan-pipeline.js`: its own scan window, corner editor, queue and review screens, client-side alignment and tightening) was removed in S5 (2026-10-19, docs/scan-plan.md); a frozen copy, `tests/scan/legacy.js`, is kept only for the comparison test.

The worker window that the scan opens is in [workers.md](workers.md); the PDF built from the result is in [form101.md](form101.md).

## Entry points (`src/manager/page/scan.ts`)

- **`startNewScan()`** — the "Scan passport" button.
- **`rescanFromWorkerModal()`** (`worker-window.ts`) / **`rescanFromWorkerCard(wi)`** — "Scan / Rescan" in the worker window and card, keeping the window's form as a draft (`ManagerIsland.editorDraft()`, the React window — [workers.md](workers.md)). When the window came from a scan still in memory (`__aiScanImage`, the same worker), the scanner opens with this session's pages already in it (Scan again below).

Each warms the Cloud Functions (`warmCloudFunctions(SCAN_WARM_URLS())` — `{"ping":true}` to `fill_form_101` and `ai_read`; at most once per URL every 4 min) and calls **`openNewScan(sameSession?)`**: `openScanner({initial, read})` (`src/scan/open.tsx`) with the scan process as its `read`; once the pages are read, `openWorkerModalFromScan(record, reads)`. A new scan (`sameSession` false) first forgets the last one (`resetScan()`, `src/scan-process/session.ts`); so does New worker (`openAddWorker`).

## Upload preparation (`src/manager/logic/uploads.ts`, shared by every upload)

| Function | What it does |
|---|---|
| `downscaleForUpload(b64, mediaType)` | Shrinks to `UPLOAD_MAX_DIM` = 1800 px (JPEG 0.9). Never upscales; any failure returns the original. |
| `fileToUploadPages(file)` | → `[{b64, mediaType, text, fileName}]`. An image is one page. A PDF goes through pdf.js (`loadPdfJs()`, cdnjs 3.11.174) at scale 2.5, all pages in parallel, keeping the text layer in `text`. |
| `filesToUploadPages(files)` | All files in parallel, as one ordered list. |
| `fileForStorage(file)` | One file kept whole: an image is shrunk, anything else is sent as-is. Used by worker documents. |

**Rule:** a new upload feature must go through these and send its per-page requests in parallel.

## The AI calls

All of them are sent as `fetch(API_URL, …)`; the dispatcher passes them to the `ai_read` Cloud Function ([backend.md](backend.md) → `ai.py`). Independent calls are sent in parallel, and `ai_read` serves them from one instance — the pattern, client and server, is in [backend.md](backend.md) → Parallel AI calls.

| Action | Model | Used for |
|---|---|---|
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` (Haiku) | The page `kind` (`id_front` / `id_back` / `sefach` / `passport` / `contract` / `other`) and its upright turn (0 / 90 / 180 / 270), no corners — asked by the scan window for every cut page the firm's document type model is not sure of (`src/scan/doctype.ts`; S7), and by the reading only for a page with no face and no kind |
| `aiReadDoc` | `ANTHROPIC_MODEL` | Full read of the main page: `type` (`israeli_id` / `passport`), names, numbers, dates, sex, address, children, spouse; for the name cross-check also `latinSurname` / `latinGiven` (the holder's Latin spelling when the page prints one) and `mrzName` (MRZ line 1 from its 6th character); `fieldBoxes` (boxes of the digit fields and of given name, surname, address, house number, city) |
| `aiReadSefach` | `ANTHROPIC_MODEL` | An extra Israeli-ID page (ספח or card back): address, house number, city, marital status, sex, spouse, children; `idNo`, `given` and `surname` of the holder for cross-check; `fieldBoxes` for address, house number, city. Always `type:'israeli_id'`. With `part:'holder'` / `part:'family'` it returns only the holder's fields (names, ID, address, marital status, sex, `fieldBoxes`) or only `spouse` + `children` |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | Batched zoomed re-read of several fields of one page (kinds `digits9`, `date`, `passportNo`, `hebrewText`, `latinName`, `houseNumber`) |
| `aiVerifyField` | `ANTHROPIC_MODEL` | One zoomed re-read (the ID number's retry) |
| `aiFindField` | `ANTHROPIC_MODEL` | Missing fields searched for on the worker's page photos, from the worker window or card ([workers.md](workers.md) → field search) |

A failed request is "nothing read" (the field keeps what it had); `aiDetectAlign` / `aiReadSefach` errors go to Admin → Errors as `console.warn(…)`. The prompts live in `functions-auth/ai_prompts.json` — see [backend.md](backend.md).

## The scan window (`src/scan/`)

**The scanner is the scanner lab's own page, copied as it is** (owner, 2026-10-19: "the scan must be the lab's — copy the lab's module as it is and plug it in"): `scan/` holds a copy of `scan-lab/` (`index.html`, `scan-core.js`, `scan-worker.js`, `track.js` — only their paths `/scan-lab/` → `/scan/` and the model cache's name `scan-models` changed), served at `/scan/` with its own models and ONNX Runtime (`scripts/scan/fetch-models.sh` at deploy: `lite.onnx`, `sa24_w16.onnx`, `yunet.onnx`, `ort/`, `ort130/` — the lab's names). Everything the lab does is what the site does: the live frame, the auto shot, the accurate model on the phone refining the corners and finding the other documents on a photo, the upright turn by the face, a picked photo (one image; a white page cut into its photos). A change tried in the lab reaches the site by copying the four files again.

A `Window` (a bottom sheet on a phone) — `Scanner.tsx`:
- **The lab page** in an `iframe` (`/scan/?embed=1`, `allow="camera"`). The one file added to the copy, `scan/embed.js`, acts only with `?embed=1` inside a frame: it hides the lab's tools (the model pickers, the background-thread and follow toggles, the figures, the log) and, when a shot is done (its corners refined, the other documents found) or a picked photo is done, posts its pages to the window: `{type: 'scan-pages', key, pages: [data URLs], answers}` (`key`: `s<n>` a shot, `f<n>` a photo; `answers`: per page the document type model's answer — `{doctype, conf, turn, turnConf}`, read with the lab's own session `doctypeSess` as its `doctypeNote` does — or `null` while this version has no such model).
- **The strip**: the window takes the messages of its own origin only; a key seen before replaces that shot's pages; each new page gets its kind and turn at once, as Admin → Scanner's document type mode says (`doctypeMode()`, the `mode` call, read when the window opens; shadow when it cannot be read): **Off** — Haiku's (`detectDoctype`, `aiDetectAlign`); **Shadow** — Haiku's, the model's answer kept beside it (`doctypeShadow`) for the example only; **Mixed** — the model's when it is sure of the type and the turn (both ≥ 0.9, `SURE`), else Haiku's. A turned page is set upright by `rotateImage`.
- **Page kinds** (`doctype.ts`): the kind shown under each page, changed with a tap (ID card, ID card back, Appendix (ספח), Passport, Contract, Other); an **Other** page is dimmed and not saved unless its kind is changed. A **Contract** page goes to the worker's documents as one PDF (`saveScanContract`, `src/scan/pdf.ts`).
- Each page can be removed (🗑). **Done (n)** (n: the pages to be saved) stops the camera (the frame is emptied), waits for the kinds, sends the pages' document type examples in the background (`examples` → `sendFeedback`, see Training examples below), then runs `read` — the scan process — **in the same window**, with its progress; when it succeeds the window closes and the worker window opens with what was read; an error keeps the window open with the pages and the error under them.
- **Starting pages** (`initial`, Scan again): shown first, with their kinds; they can be removed or have their kind changed.
- Closing the window (outside tap, swipe down) empties the frame, which stops the camera.
- Covered by the browser test "scan window" (the lab page in the frame and its copy served at `/scan/`; its pages posted: a shot's one page, then the same shot refined into two; Haiku's kinds mocked → Other, Contract → the reading → the worker window), "scan window, Mixed" (the model's sure answer skips Haiku; Done's examples) and "scan, the save after it" (H8a).

## Reading (`src/scan-process/`)

`readScan(pages, progress)` (`session.ts`) runs `readPages()` (`read.ts`) over the scanner's pages `{b64, mediaType, kind, upright}` (`upright`: turned by its face, or with a kind — Haiku turned it):

1. **Turn:** a page with no face and no kind asks `aiDetectAlign` for its turn and kind (all such pages at once) and is turned (`rotateImage`).
2. **Primary:** the first page that is not a contract / other (`isNonIdKind`) and that `aiReadDoc` reads as an `israeli_id` or `passport` is the primary. Page 1's read starts as soon as it is upright; as soon as it says ID card or passport, the following pages' reads start too (in the background, `extraReadWanted` with that read), while page 1's digits and text are re-read zoomed (`verifyDigitFields`, `verifyIdChecksum`, Zoomed re-reads below). Then `initPrimary()`.
3. **Extra pages**, merged strictly in page order (`mergePage`, Merging pages below). Which pages get a read is `extraReadWanted(primary, kind)`: after an Israeli-ID primary, every page of kind `sefach` (the ספח is a folded sheet, often photographed in parts, and the children or spouse can be on a later part), and any page while the primary still misses a core field (`missingCore`: dob, sex, address, city); after a passport, only `sefach` or `id_back`. The reader is `extraPageReader(kind)` (`ai.ts`):
   - `passport` → no AI read;
   - `id_front` → `readFrontPage` (`aiReadDoc`);
   - everything else (`sefach`, `id_back`, `contract`, `other`, unknown) → `readSefachPage` (`aiReadSefach`) — `contract` and `other` too, because the align model often files the paper ספח (a printed form) under them. It sends `part:'holder'` and `part:'family'` at once (writing the long answer is what takes the time; two halves are written in parallel) and merges them; if either half fails, one full read. Its text fields are re-read zoomed (`verifySefachFields`).
   
   A page read before the primary is found (a contract first) is kept, unread.
4. **Result:** `{record, pages}` — every page with its kind, its own read, `primary`, and `contract` (a page the AI calls a contract whose read has no ID number and no names: the worker's contract, Contracts below). No ID card or passport → null, and nothing is stored. Otherwise the primary page goes to `window.__aiScanImage` and the others (with `kind`, `contract`) to `window.__aiPacketOtherPages` — what Form 101's upload reads ([form101.md](form101.md)).

- **Progress:** `progress(text, pct)` — Straightening the pages, Reading the document (page i of n), Checking the digits again, Reading the appendix, All pages read — shown by the scan window.
- **Cache** (`imageKey`: a fingerprint of the page's image): every step of a page (its turn, its read, the primary's verified read, an extra read) is kept for the session, and a fresh copy is used each time (the merge never changes a kept read). A failed step is not kept. So reading again after Scan again reads only the pages that changed (a new page, a re-cut one); a page read twice in one run (a page 1 that is not a document) is read once.
- **Timing:** one `scan` entry (Admin → Timings): pages, kinds, `primaryReadMs`, `verifyMs`, `extraWaitMs`, `docType`, `aborted: no-document`.
- **Not done here any more** (S5): the page is not aligned, enhanced or tightened on the phone — the scanner's cut (DocAligner's corners, the user's correction) is final; there is no high-resolution twin for the zoomed crops (the server's page, ≤ 1800 px, is the source); a blurry page does not stop the reading.

### Zoomed re-reads (`verify.ts`, `crop.ts`)

- **Normalizing** (`ids.ts`): `normDigits(s)` joins grouped digits (`0 1234567 8` → `012345678`); `normDate(s)` pads to `DD/MM/YYYY`; `isValidIsraeliId(id)` — the check digit.
- **`verifyDigitFields(parsed, verify)`** builds jobs from `fieldBoxes`:
  - Israeli ID: `idNo` and `dob` (re-read every time in the same call; `__idZoomed` is set, so `verifyIdChecksum` does not read the same box again);
  - passport: `passportNo`, `dob`, `expiry` (a field taken from the MRZ with a right check digit — `passportNoFromMrz` / `dobFromMrz` / `expiryFromMrz`, set by `ai_read` — has no box and is not re-read; without an MRZ, `ai_read` swaps a reversed issue / expiry pair back and marks an implausibly short validity as "check");
  - both (`textJobs`): every boxed `given`, `surname`, `address` and `city` (`hebrewText`; a passport's names `latinName`) and `houseNumber` (`houseNumber`). All in the same one call. A field left empty is searched for after the scan instead (`autoFindMissingScanFields`, [workers.md](workers.md)).

  `verifierFor(page)` (`ai.ts`) cuts each box with a margin out of the page (`cropField`: 15 % sideways, 50 % up and down; enlarged to at least 500 px wide, at most 1100 px), then sends one `aiVerifyFields` for all of them. `applyZoomedRead` keeps only a readable value of the right shape (9 digits, `DD/MM/YYYY`, an uppercased passport number, a house number without spaces, text with single spaces):
  - **digits and dates** — the zoomed value replaces the first read. For the ID number the check digit decides: a first read that passes it is kept over a zoomed one that does not, and a zoomed one that passes it is taken without a mark;
  - **text** (`hebrewText`, `latinName`, `houseNumber`) — the zoomed value is kept beside the first read in `parsed.__zoom` and never replaces it on its own. The names are picked later from all their readings (Merging pages → holder's name); street, house number and town keep the first read.

  When the zoomed value differs from the first read (names aside), the field goes into `parsed.__uncertain`.
- **`verifySefachFields(parsed, verify)`** does the same for the ספח read's text fields.
- **`verifyIdChecksum(parsed, verifyOne)`**: if the ID number fails its check digit, one `aiVerifyField` retry of its box follows, unless it was already re-read zoomed. The result is `parsed.idChecksumOk`; a still-failing number shows an amber warning in the worker window.
- **"Check this" marks:** `workerFields` (`worker.ts`) collects the uncertain fields whose value is the one on screen (`uncertainKeys` over the record and the pages' reads) into `__scanCheck`. The worker window frames them in amber with a note (`markScanUncertain`) until the field is edited; the note's 🔍 link reads that field again (the editor's recheck in `WorkerEditor.tsx`, [workers.md](workers.md) → field search). Display only, never saved.

### Merging pages (`merge.ts`, `names.ts`)

The record is a pure function of the pages' own reads, in page order (`initPrimary` + `mergePage`; `rebuild(reads)` replays it).
- **Fields:**
  - `ID_CORE_FIELDS` = dob, sex, address, houseNumber, city, maritalStatus — filled only where the primary is empty (`mergeIsraeliIdFields`);
  - children — from every page, each child once (by ID number, else name);
  - spouse — taken from the first page that has one;
  - an ID number only where the primary has none.
- **Front page after the ספח:** it also fills an empty `given`, `surname` and `expiry`.
- **Passport + ספח** (per user decision 2026-10-04): a ספח or ID card back merged into a passport primary (`passportHolderIsIsraeli`) makes the holder an Israeli resident, recorded like an Israeli ID, as Form 101 needs. `type` becomes `israeli_id`; the Hebrew names, ID number, address and family come from the ספח. The passport's Latin names and MRZ name line become the name references; its dates, sex and `passportNo` stay. The ID number has only its check digit as a check (`idChecksumOk`). An Israeli passport itself is read as `israeli_id` by `aiReadDoc` (Hebrew names, Latin ones as `latinSurname` / `latinGiven`, `idNo` from its Identity No., `passportNo`), and then reads its ספח like an ID card.
- **The holder's name** (`resolveNames`, run by `initPrimary` and `mergePage`). `addNameReads` collects on the primary (`__names`) every reading of `given` / `surname`: the front's first read (`full`, kept in `__full`), its zoomed re-read (`zoom`), and the ספח / card back's copy (`sefach`, pages read by `readSefachPage` are tagged `__fromSefachReader`); and the references: the Latin spelling (`latinSurname` / `latinGiven`, Hebrew names only) and the MRZ names (`mrzName` → `mrzNames`). `pickName` then:
  1. all readings agree → that value; marked "check" only when a reference does not match it;
  2. a reference decides — the reading whose letters match it best, clearly better than the others (for Hebrew, consonant classes of the Hebrew letters vs the Latin spelling, `hebSkeleton` / `latSkeleton` aligned by `skeletonAlign`, so a ד misread as ר no longer matches D; for a passport, the letters against the MRZ). Usual spelling noise is allowed: ו spelled V, ח spelled H, צ as Z, כ as CH. A different consonant, or one missing or extra, counts as suspicious, and marks even a reading all sources agree on. Vowel letters (ו, י) are not compared: names are written with and without them (משה = MOSHE);
  3. two readings agree against a third → the majority;
  4. otherwise the first read stays and the field is marked "check" (`__uncertain`).

### Into the worker window (`openWorkerModalFromScan(record, reads)`, `src/manager/page/scan.ts`)

`workerFields(record, reads)` (`worker.ts`) gives only the values this scan actually found, so a rescan never blanks existing data:
- `docType`, `docGiven`, `docSurname`, `docId`, `docDob`, `docSex`, `docExpiry`;
- Israeli ID: address, house number, city, marital status (from `single` / `married` / `divorced` / `widowed`), children, spouse. A spouse sets married when no status was read;
- `idChecksumOk` and `__scanCheck` (display only).

Which worker it opens:
- a rescan (`__aiRescanWorkerId`) opens that worker;
- a new scan whose document number matches an existing worker opens **that** worker instead of a new one (toast);
- in both cases `__aiRescannedWorkerId` is set, so `saveWorker()` rebuilds Form 101 from this scan;
- otherwise a blank new worker opens.

Either way, a draft from `rescanFromWorkerModal()` is then put back (`applyWorkerDraft()`): typed values stay, empty fields take the scan's; then the empty fields are searched for (`autoFindMissingScanFields`).

### Scan again

`sessionPages()` (`session.ts`) gives this session's pages, the primary first, as the scanner's starting pages; Done reads the whole set again through the same cache, so only the added or re-cut pages cost AI calls, and the record is rebuilt from every page's read — a page removed takes its data with it.

## Contracts

An extra page that the scanner calls `contract` and whose read has no ID number and no names is marked `contract` in `__aiPacketOtherPages`. `aiFillForm101` (`src/manager/page/scan.ts`) leaves those pages out of Form 101 and, once the worker's documents are saved, `saveScanContract()` puts them together as one PDF (`imagesToPdf`, `src/scan/pdf.ts` — a page per photo, A4 wide, JPEG as is) and saves it to the worker's documents as type `contract` (`saveWorkerFile`, one retry). Its end date is not read. A failure is a toast and an Admin → Errors entry, and marks the worker `contractUploadFailed`: a red **Contract not saved** notice on the plate and card (`workerNotices`, `src/manager/page/workers.ts`, with Add document as its action) until a contract document is added (`ManagerBridge.addDocs` clears it). Browser tests: "scan contract", "scan contract not saved".

## Training examples (`scan_feedback`, `functions/feedback.py`)

The scan window sends, on Done, an example per page with a type (`examples`, `src/scan/Scanner.tsx`): `source: "page"` (cut by the phone — no corners, no edges copy), `doctypeModel` (Haiku's or the model's), `doctypeBy`, `doctypeFixed` (the type the user left), `doctypeShadow` (Shadow), and a 256×256 copy of the page (`pageCopy`) when its type was changed or for one right page in five (`keep`); they go through the phone's queue (`sendFeedback`, `localStorage` `scanFeedbackQueue`, at most 60, sent 10 at a time, again when the window next opens if offline).

`POST scan_feedback` (a manager login's ID token, `gate.claims_of`): `{"action":"mode"}` → `{doctypeMode}` (any manager login: the scan window's mode). `{"action":"add","examples":[…]}` — at most 20; each checked by `feedback.check` (a `page` example takes the whole page as its corners and needs no edges copy; otherwise 4 corners in 0..1; a page moved at least 0.005 must carry a JPEG of at most 80 KB, and so must a page whose kind was changed — `pageImage`; a `keep` page may carry one); a page neither moved nor changed is only counted (`right`); a kept one: its copies in Storage `training/scan/<YYYY-MM>/<id>.jpg` (the corners') and `<id>-page.jpg` (the kind's), the record in Firestore `scanTraining/<id>` (`edgesModel`, `edgesFixed`, `moved`, `source`, `model` — the server's model version, `doctypeModel`, `doctypeFixed`, `tenantId`, `image`, `pageImage`, `createdAt`, `deleteAt` = +365 days), and `scanTrainingStats/current` counts (`edgesSince` — corners moved, or a kind changed on an example with corners; a `page` example never counts here (`edges_correction`), `kept`, `right`, `movedSum`, `doctypesSince.<kind>` — each kept page copy by the kind the user left). `{"action":"stats"}` (the super-admin only) returns the counts, `due` (`edgesSince` ≥ 200), `kinds` and `doctypesDue` (every kind but `other` ≥ 100, docs/scan-plan.md → S7): the bell shows the super-admin **Time to retrain the scanner** (`scanEdgesNotice`) and **Enough pages for the document type model** (`scanDoctypeNotice`, both `src/manager/page/header.ts`, read at most every 6 hours). No client reads or writes these collections or `training/` (no rule grants them); the copies and records go after 12 months (the Firestore TTL on `scanTraining.deleteAt` in `firestore.indexes.json`; the Storage lifecycle rule on `training/`, set by `scripts/scan/storage_lifecycle.py` in deploy-rules.yml). Tests: `tests/auth/test_scan_feedback.py`, the browser test "scan window, Mixed".

## Server-side finding — removed

The server's own finding (`preprocess_scan`, `functions/docfind.py`, its models' Storage mirror `scripts/scan/mirror.py`) was removed on 2026-10-19: the site's scanner is the lab's page, which finds, cuts and turns every page on the phone (docs/history.md). `docfind.py` lives on in `scripts/scan-train/` for the training's exam only.

## Tests

- `tests/scan/compare.test.mjs` (`npm run test:scan`, in CI): the old reading (`tests/scan/legacy.js`, never edited) and `src/scan-process/` read 600 generated scans through the same stand-in AI and must give the same record, stored pages and worker fields, with no more AI calls ([tests.md](tests.md)).
- The browser tests above; `tests/auth/test_scan_feedback.py`, `test_scan_gate.py`.
