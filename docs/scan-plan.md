# Scanner rebuild plan

The approved plan for the new document scanner: automatic edge detection, a live frame in the camera, two documents in one photo split into two pages, a queue for multi-page uploads, all of it on the new stack (`src/scan/`). The current scanner is described in docs/scan.md; it stays in place until stage S4 and is deleted only in S5, with the owner's permission.

Status: **planned** — no stage started. Each stage is merged only with the owner's OK.

## Models (chosen after tests on the owner's photos)

- **DocAligner** `fastvit_sa24` heatmap model (Apache-2.0) — the four corners of a document. fp32 83 MB on the server; **fp16 42 MB** on the phone (the same accuracy; int8 is broken — not used). Input `img` [1,3,256,256] RGB/255, output `heatmap` [1,4,128,128]; a corner = the centroid of the largest blob over 0.3; confident when every corner's peak is ≥ 0.5.
- **OpenCV candidates** next to it (multi-Canny contours, Otsu color segmentation, GrabCut), scored by side contrast in Lab, aspect 1.25–2.0, refined to the gradient lines. DocAligner wins when it is confident and OpenCV found fewer than two documents.
- **MRZScanner** (mrzscanner-docsaid, detection + recognition ONNX, ~0.5 s) for passports, with the ICAO check digits (7,3,1) on the passport number, birth date and expiry.
- Rejected: U²-Net (not needed), DocTr / DocGeoNet / UVDoc / page-dewarp (they spoil the image), FastMRZ (AGPL + Tesseract), int8 models.

## Stages

### S1 — server

- `preprocess_scan` (`functions/main.py`) requires a signed-in user's ID token.
- Detection: DocAligner + OpenCV as above; **two documents in one photo** → two quads; after one document is found it is masked and searched again (photos where the second document was missed); a document inside a screenshot frame is searched inside the frame.
- **Several documents on one photo** (an ID, its ספח, a bank card…; up to 4): each next one is looked for on the photo with every found one painted over — by the accurate model, then the light one — then with a 10 % margin around the photo, then in the strip beside the first; it runs even when the accurate model does not confirm the first. The owner's tablecloth screenshot, cropped to its photo: ID, ספח and bank card all found. A page that is not wanted (a bank card, a part of an old Form 101 in a screenshot) is classified "other" by Haiku and **left unsaved by default** on the review screen (the owner can keep it).
- **Speed of the search for more documents:** the ways of one step (accurate / light model, painted, with the margin, the strips) run one after another and stop at the first that finds one — on the phone that is faster than running them all at once (tried: 6.0 → 8.8 s on a three-document photo, since the slow accurate model then runs every way and the threads share the CPU). On the server the ways of a step can go as one batch through the model.
- **Photos on a white page** (owner, 2026-10-18: uploads are usually white pages — a form's page, a PDF, a phone screenshot — with photos of the documents in them): every band of rows mostly not white (at least 12 % high) is a photo, its sides from the columns mostly not white inside it; each photo is cut out and goes through on its own, and their documents make one list of pages. A photo with no document frame in it is a document already cut to its edges and becomes a page whole. On the owner's screenshots: the tablecloth screenshot → ID, ספח, bank card; a two-photo Form 101 screenshot → ID and ספח; plain photos untouched. Shown in the scanner lab; the server does the same.
- **Two documents on one photo** (a passport and its ספח): after the first, the accurate model looks again on the photo with the first painted over in the background's colour, then with a 10 % margin of that colour around it (a document cut off by the photo's edge then lies whole inside and its corners land on the edge), then in the widest strip left beside it; a frame overlapping the first by over 30 % is the same one. On the owner's photos: 6 of 6 two-document photos split, no extra page on any one-document photo (the light model alone finds the second in 1 of 5, so the split belongs to the accurate model — the server). The phone shows the first page at once; the second appears when the server returns it. Shown in the scanner lab, where the accurate model is on the phone.
- MRZ read and check digits for passports.
- **Haiku only for pages without a face** (owner, 2026-10-18): a page whose face set it upright (ID card, passport) is not sent to `aiDetectAlign` — its turn is the phone's, its kind comes with its read; a page with no face (the ספח, a contract) still goes to Haiku for its kind and turn. One decides the turn, never both, so the two never fight. The `detectAlign` prompt drops the corners (the model gives them) and `tests/auth/ai_golden.json` changes with it.
- The models stored as fp16 (deploy size limit) or loaded from Cloud Storage at cold start.
- **Settings for parallel pages:** the function is CPU-bound (ONNX + OpenCV), not an AI wait — `cpu=2`, `memory=2GiB`, `concurrency=2`, `max_instances=10`; no shared per-request state, so several pages run on several instances at once.
- Tests in `tests/auth`/`functions` for the detection (the quads on fixed synthetic images), the MRZ check digits and the auth check.

### S2 — React scan window (`src/scan/`)

- The corner editor with the found frames (several frames on one photo), a loupe while dragging a corner.
- **Queue screen for uploads (photos and PDFs) — parallel:**
  - after the files are picked, every page is sent to `preprocess_scan` at once, **at most 4 in flight** (phone memory); PDF pages are rendered one by one and each goes out as soon as it is rendered;
  - the preparation of the images (rotation, downscale, PDF → images) runs in a Web Worker, so the screen never freezes;
  - each page appears in the queue as soon as its frame is found (a green mark); the user corrects page 1 while the rest are still being detected; a photo with two documents becomes two pages in the queue;
  - on Done, the AI reads, the digit verification and the MRZ of all pages start at once (`Promise.all`) and are merged in page order (CLAUDE.md → Parallel AI calls).
- Through the shared upload helpers (`filesToUploadPages` / `downscaleForUpload` / `fileForStorage`).
- **Background threads (Web Workers, no special headers needed):** the image preparation (rotation, downscale, PDF → images, 2–4 pages at once), the detection model and the perspective warp each run off the page's thread, so the screen and the queue stay smooth while pages are processed.

### S2b — camera with a live frame

Proven on the owner's Android phone with the scanner lab (see below, 2026-10-18): live frame 13 frames/s, the screen at 60 frames/s, the shot shown in 0.18 s.

- **Models on the phone:** the light DocAligner model (5 MB) for the live frame, the accurate one (42 MB, fp16 weights with fp32 math — a plain fp16 conversion gives zeros on WebGPU) for the shot. On the first tap of Scan both download in the background over any network, with the progress shown; **the first time, scanning is enabled only once they are ready**; then they come from the cache (Android: Background Fetch; iOS: a resumable download). Both are warmed up at load.
- **On the phone only the light model** (owner, 2026-10-18): the accurate model runs on the server (S1), not on the phone. The phone downloads ~12 MB — the light model (4.4 MB), the face finder (0.2 MB) and one ONNX Runtime (1.30, ~7 MB) — instead of ~56 MB: ~5 s on 4G the first time, ~1–2 s from the cache after. The shot is shown at once, cut by the live frame (0.2–4.5 % off the accurate corners on the owner's photos), and the page is sent **whole with the live frame's corners**; the server finds the exact corners (accurate model, fp32, plus OpenCV on the edges), cuts the page and reads it, so the stored and read page is the accurate one. The lab keeps the accurate model on the phone to compare.
- **Where they run** — tried in this order, each way dropped if it fails or stays silent for 25 s, the way that worked remembered on the device:
  1. the live model on the **GPU** (WebGPU, ONNX Runtime 1.30) in two background threads, the accurate model on the **CPU** (ONNX Runtime 1.22) in its own background thread;
  2. the live model on the CPU in several single-thread background threads (half the cores, at most 3), frames handed to them in turn, plus the accurate model's thread.
  Before the GPU is used, each model is run on a drawn card with known corners in both memory layouts (NCHW / NHWC); a GPU that gets it wrong is not used (seen on the owner's phone: the GPU ran the light model right only in NCHW with 1.30, and never the accurate one). CPU threads inside a background thread hang on Android Chrome, so the CPU uses several single-thread background threads instead; no cross-origin isolation headers are needed.
- **Frames:** each camera frame is scaled to 256×256 on the GPU (`createImageBitmap`) and handed to a background thread as is — no full-size copy in the page.
- **Following between the model's answers** (`scan-lab/track.js`): on every camera frame, up to 16 textured points inside the document are followed on a 320 px gray copy (pyramidal Lucas–Kanade, checked forward and back) and their affine motion moves the frame; a model answer that comes back late is carried forward by the motion since its frame. So the frame keeps up at the camera's rate (~30 frames/s, ~14 ms per frame) while the model runs at ~13; movement also restarts the autocapture countdown.
- **The frame on screen:** a thin line, no corner dots; red while searching, green once it has sat on the document's edges for 0.25 s; it glides toward the latest result on every screen frame. **Autocapture** when the green frame has held still for 1 s (a countdown shown); a Capture button too.
- **The shot** is shown at once, straightened by the live frame; the accurate model then refines the corners in the background and replaces the shot if they moved.
- **Upright:** the straightened shot is turned upright by the face on the document — a small face finder (YuNet, MIT, 0.2 MB, run at 320×320 — `scripts/scan-lab/yunet_dyn.py` frees its fixed 640 input) is run on all 4 quarter-turns (a first-turn shortcut was tried and dropped: the finder places the eyes above the mouth even on an upside-down face, so only comparing the 4 turns is right) and the turn with a face whose eyes are above its mouth wins (40 of 40 turned right on the owner's photos). A document with no face (the ספח) keeps its turn on the phone and is set upright on the server with its reading. A text-direction model (RapidOrientation) was tried and dropped: it takes upright Hebrew documents for upside down.

### Scanner lab (`/scan-lab/`)

A standing tool kept in the repo for trying and tuning the scanner's on-device part on a real phone, so S2b and later changes start from it, not from scratch.

- **The models are the firm's own copies** (owner, 2026-10-18): the base models (DocAligner `sa24.onnx` and `lite.onnx`, Apache-2.0; YuNet `yunet640.onnx`, MIT) are kept in the project's Firebase Storage under `models/scan/base-v1/` (`scripts/scan-lab/model_store.py`, the deploy's service account; no client access — the Storage rules grant none there). A deploy takes them from there; only a model not stored yet is downloaded from its authors, once, and stored. Their licences are served next to the lab (`scan-lab/THIRD-PARTY.txt`).
- **Files:** `scan-lab/index.html` (the page: model and engine pickers, the camera with the live frame, Photo…, Capture, the figures — runs on, frames/s, ms per frame, confidence, model load, camera size, screen frames/s, capture ms — and a log), `scan-lab/scan-core.js` (shared by the page and its worker: model download into the Cache Storage, sessions with the GPU self-test and time limits, corners, warp, the face-based upright turn), `scan-lab/scan-worker.js` (the background thread), `scripts/scan-lab/w16.py` (fp16 weights with fp32 math) `scripts/scan-lab/fetch-models.sh` (the models — from the firm's Storage — and ONNX Runtime 1.22 / 1.30, put next to the lab at deploy, kept in the Actions cache; no model file is committed) and `scripts/scan-lab/yunet_dyn.py` (frees YuNet's input size).
- **Where:** live at `/scan-lab/` (deploy.yml puts the models next to it; `firebase.json` gives `/scan-lab` `Cache-Control: no-cache`), opened from **Admin → Scanner lab** (a super-admin tile, `src/manager/Admin.tsx`). A branch that touches it gets a preview copy first (`.github/workflows/scan-lab-preview.yml`, Firebase preview channel `scan-test`, 7 days): `https://schedule-odinson--scan-test-<id>.web.app/scan-lab/`.
- It is a plain page outside the React app on purpose — a lab for the models, with no data, no login and nothing stored but the models in the browser's cache; the product's scanner is built in `src/scan/` (S2, S2b) from what the lab proved.

### Contracts in the scan (owner, 2026-10-18)

- Pages found to be a **contract** (a page Haiku calls a contract that reads as no ספח: no ID number and no names) are saved to the worker's documents as **one PDF of type "Contract"** (all the contract pages of the scan, in order) — the worker's contracts, with its expiry reminder — not into the Form 101 packet as now.
- The contract's end date is **not** read by AI: the owner sets it when wanted (Add document / the document's expiry), as today.
- On the review screen every page shows its kind (ID, ספח, Passport, Contract, Other) and a tap changes it before saving; "Other" pages are left unsaved by default.
- A new worker's contract is uploaded after the worker is created, with one retry; a failed upload shows the worker's "Upload failed" notice with a retry. Covered by a browser test: several files, the contract in the worker's documents, a failed upload.

### S6 — the models learn from the corrections (after S1–S2; owner, 2026-10-18)

- **What is learned from:** every correction on the review screen — corners moved, a page's kind changed — is a training example: a 256×256 copy of the page (not the photo) with the right corners and kind, kept in Firebase Storage `training/scan/` (no client access; auto-deleted after a period the owner sets — open). Statistics from day one: how often and how far the corners are moved.
- **What is trained:** the light and the accurate DocAligner models (Apache-2.0: the fine-tuned weights are the firm's own); later a small page-kind model (ID / ספח / passport / contract / other) that replaces Haiku's kind. Not trained: YuNet (already right), the MRZ reader (check digits), Haiku / Sonnet (Anthropic's — only their prompts and examples improve).
- **Where:** on the owner's PC (RTX 4070, 12 GB: ~15–30 min for both corner models on ~500 examples), so the examples never leave the firm's hands; the copies are deleted from the PC after the run.
- **How:** a repo skill, `/scan-train` (`.claude/skills/scan-train/`), run in Claude Code on the PC: download the new examples → train → an exam against a fixed set of photos with known answers (the old model against the new) → a "before → after" report → on the owner's yes, the new model goes to `models/scan/v<N>/` in Storage and `current.json` points at it; the phones take it by its ETag. The old versions stay for a rollback. The training code is in `scripts/scan-train/`.
- **The agent:** a scheduled task, once a month, counts the new examples and runs the exam on the current model; when ~200 new examples are in or the score drops, it tells the owner to run `/scan-train`. It never trains nor swaps a model itself.

### S3 — reading in TypeScript

- Port the reading, digit verification and page merging from `scan-pipeline.js` to TS with equivalence tests; the Hebrew strings hardcoded in `scan-pipeline.js` go through `tr()`.
- `aiDetectAlign` loses the corners from its prompt (the model gives them now); `functions-auth/ai_prompts.json` and `tests/auth/ai_golden.json` change together.
- Fine deskew and the exact ratios of ID cards and passports.

### S4 — switch

- The new window is the default; the old one is disabled but kept.

### S5 — delete the old scanner

- Only after the owner's checks and explicit permission: `scan-pipeline.js` and the page's scan window.

## Expected time

- ID + appendix (ספח): from ~45–90 s to ~20–35 s; passport: from ~35–60 s to ~15–25 s.
- An upload of 6 pages: from ~2–3 min to ~25–40 s; the first page can be corrected after ~3–5 s.
- Cost: within the Blaze free tier.
