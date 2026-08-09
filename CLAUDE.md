# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A staff scheduling & GPS punch-clock PWA for a single client ("Odinson"), served as static files from Firebase Hosting. There is no build step, no bundler, no package.json, and no test suite — the two pages are self-contained HTML files with inline `<style>` and `<script>`.

- `schedule-manager.html` — the manager/admin app (shifts, workers, clients, payroll, exports). RTL, Hebrew (`lang="he"`), ~3000 lines.
- `worker-punch.html` — the worker-facing clock-in/out app, opened via a per-worker tokenized link. ~1000 lines.
- `service-worker.js` — PWA offline shell (network-first, cache fallback).
- `manifest.json` / `manifest-punch.json` — separate installable-PWA manifests for the two apps.
- `form101_fillable.pdf` — Israeli tax form template filled in-app via pdf-lib (see AI/passport scan flow below).

## Commands

There is no npm/build/lint/test tooling. Development is edit-the-HTML-and-reload.

- Local preview: `firebase emulators:start --only hosting` (uses `firebase.json` rewrites), or just open the HTML files directly in a browser.
- Deploy: Push to `origin/main` (or `origin/HEAD`); a GitHub Actions workflow automatically deploys to Firebase Hosting (project alias `schedule-odinson`, see `.firebaserc`). No manual `firebase deploy` step is needed.
- Routing: `firebase.json` rewrites `/` → `schedule-manager.html` and `/punch` → `worker-punch.html`.

When bumping the service worker's cache (`CACHE` constant in `service-worker.js`), increment the version string (e.g. `schedule-mgr-v3` → `v4`) or clients will keep serving stale cached HTML after deploy.

## Architecture

### Backend: Google Apps Script, not in this repo

Both HTML files talk to the **same** Google Apps Script Web App endpoint (`GS_URL`, a `script.google.com/macros/.../exec` URL hardcoded near the top of the `<script>` block in each file), authenticated with a hardcoded shared secret (`API_SECRET`). This Apps Script project (backed by a Google Sheet) is the actual database — its source is **not** part of this repository (`firebase.json` even lists `google-apps-script.js` in its `ignore` array as a placeholder). Requests are plain `fetch()` calls with an `action` field selecting the server-side operation:

- `saveSchedule`, `loadSchedule` — the whole workers/clients/schedule blob.
- `savePunch`, `updatePunch`, `deletePunch`, `loadPunchLog` — punch-clock entries.
- `savePushSubscription` — web push registration.
- `aiReadDoc` — server-side AI document OCR (used by the passport/ID scan flow).
- `logError` — client error reporting.

The service worker explicitly never intercepts requests to `script.google.com` (`service-worker.js:31`) — the API always goes straight to network.

### Client-side state & persistence (schedule-manager.html)

- In-memory globals: `workers`, `clients`, `weekStart`, plus UI state like `selectedClientId`, `editingWorkerIdx`. No framework — state mutation is followed by a manual `render()` call.
- `render()` fans out to per-section renderers: `renderStats`, `renderGanttHeader`/`renderGanttBody` (the schedule grid), `renderWorkerList`, `renderWorkersPage`, `renderClientsPage`, `renderDashboard`, `renderSalary`, `renderAdmin`, `renderClientLogs`.
- **Google Sheets is the source of truth; `localStorage` (`schedMgr_v1` / `schedMgr_v1_bak`) is only a cache/offline fallback.** `loadData()` renders cached data instantly, then overwrites with the Sheets response. `autoSave()` debounces writes (800ms), writes to `localStorage` first, then pushes to Sheets via `gsSave`; it also has an "empty state" guard that refuses to persist an accidentally-cleared `workers`/`clients` array over existing cached data.
- Each worker has a generated `token` (`genToken`) used to build their personal punch-clock link (`buildPunchLink`) — this token is the `t=`/`token=` query param `worker-punch.html` reads to skip worker selection.
- Payroll math (`israeliDayPay`, `wRegRate`/`wOtRate`/`wShabRate`, `PAY_RULES`) encodes Israeli overtime/Shabbat pay rules — treat these as domain-specific and don't "simplify" without checking the intent of each rate function.
- Exports: `exportExcel` (SheetJS/xlsx, loaded from CDN), `exportPDF`, `exportJSON`, `exportSalaryCSV`, `exportPunchCSV`.
- The AI document scan / passport / Form 101 flow (`openAiScan`, `openPassportScan`, `parseMRZ`, `parseHRZ`, `copyForm101`, `passportToWorker`) is a distinct subsystem: it lazy-loads Tesseract.js and PDF.js from CDN, OCRs an uploaded ID/passport image, extracts MRZ/HRZ fields, and can push the result into a new worker or fill `form101_fillable.pdf` via pdf-lib.

### worker-punch.html

- Reads a per-worker `token` from the URL (`URL_TOKEN`) to jump straight to that worker's punch screen; without a token it shows a worker picker (`renderWorkerGrid`).
- `getLastEntry(log, wid)` returns the most recent punch entry for a worker **across all days** (not just today). This determines whether to show "Clock IN" or "Clock OUT" in the UI, and powers the "In since" / "Last: X (out)" status in the worker grid.
- GPS anti-spoofing lives in `analyseGps`/`getLocation`: flags zero/low accuracy, impossibly fast movement between two readings (`haversine` distance ÷ time), suspicious device speed, and instant geolocation responses (`GPS_REQUEST_MS`) as signs of a mocked location, before allowing a punch within `SITE.radius` of the client site.
- Offline-safe punches: `doPunch()` always writes to `localStorage` (`punchLog`) and also queues to `punchQueue` (`getQueue`/`saveQueue`/`queueEntry`) when the Sheets `savePunch` call fails, for later resync.
- `updateScheduleManager` reaches into the *same-origin* `schedMgr_v1` localStorage key to reflect a punch back into the manager app's cached schedule — this only works when both apps share local storage (i.e. same browser/device), it's not a sync mechanism across devices.

### Shared conventions across both files

- No modules/imports — everything is global functions/consts inside one inline `<script>` per file. When adding functionality, follow this style rather than introducing bundling.
- Both files duplicate constants like `GS_URL`/`API_SECRET` and helpers like `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `urlB64ToUint8` (`worker-punch.html` has `urlB64ToUint8WP`) — this is intentional (no shared build), so a fix in one file (e.g. the API URL, after rotating the Apps Script deployment) usually needs to be mirrored in the other.
- Push notifications: both files subscribe via `savePushSubscription`; `service-worker.js` handles `push`/`notificationclick`.
- Auto-commit: `.claude/settings.json` runs a `PostToolUse` hook on `Write|Edit|NotebookEdit` that stages, commits, and pushes to `origin/HEAD` automatically after every file change made by Claude Code in this repo. Each push to `origin/main` triggers the GitHub Actions deploy workflow.
