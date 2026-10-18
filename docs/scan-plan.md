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
- MRZ read and check digits for passports.
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

- On the first tap of Scan the fp16 model (42 MB) starts downloading in the background over **any network** (no Wi-Fi needed), with the progress shown ("Downloading the model: X / 42 MB"); **the first time, scanning is enabled only once the download is finished**; then it comes from the cache. Android: Background Fetch; iOS: a resumable download.
- The model runs on the phone's GPU (WebGPU) where available, else on the CPU (WASM); on the phone the model runs one frame at a time (the GPU queue is serial — parallel runs would only cost memory).
- A live frame over the camera like CamScanner: the light model (5 MB) draws the frame on every camera frame and the drawn frame glides toward it on every screen frame; at capture the frozen frame goes once through the accurate model for the exact corners; both models are warmed up at load (the first GPU run compiles its shaders).
- A thin frame with no corner dots: red while searching, green once it sits on the document's edges; autocapture when the green frame has held still for 1.5 s (a countdown shown).
- The models and the warp run in a background thread (Web Worker); the page only draws the camera picture and the frame, so the frame never stutters while the model works.
- **GPU self-check:** after loading, each model is run on the GPU on a drawn card with known corners; when the GPU gets it wrong (seen on a real Android phone: the GPU ran, the corners were wrong), that model runs on the CPU instead.
- The phone model is stored as fp16 weights with fp32 math (`Cast` in front of each weight): a plain fp16 conversion gives zeros on WebGPU.
- Multithreaded CPU (WASM threads) needs the page cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`); on the manager page this can break the sign-in popup and cross-origin fonts/images, so it is turned on there only after a separate check and with the owner's OK.
- The test page `scan-test/` and its workflow `.github/workflows/scan-test-preview.yml` (a Firebase preview channel) are temporary and are removed before any PR into `main`.

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
