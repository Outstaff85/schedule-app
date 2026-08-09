# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A staff scheduling & GPS punch-clock PWA for a single client ("Odinson"), served as static files from Firebase Hosting. There is no build step, no bundler, no package.json, and no test suite — the two pages are self-contained HTML files with inline `<style>` and `<script>`.

- `schedule-manager.html` — the manager/admin app (shifts, workers, clients, payroll, exports). RTL, Hebrew (`lang="he"`), ~3000 lines.
- `worker-punch.html` — the worker-facing clock-in/out app, opened via a per-worker tokenized link. ~1000 lines.
- `service-worker.js` — PWA offline shell (network-first, cache fallback).
- `manifest.json` / `manifest-punch.json` — separate installable-PWA manifests for the two apps.
- `google-apps-script.js` — the backend Apps Script source code (backed by Google Sheets database). Deployed separately to `script.google.com` but tracked here for reference/documentation.
- `apps-script/appsscript.json` — Google Apps Script project configuration (timezone, runtime version, web app access rules). Configures the Apps Script project deployed to `script.google.com`.
- `apps-script/.clasp.json` — Google Apps Script CLI (clasp) configuration linking the local source to the deployed project via `scriptId`.
- `form101_fillable.pdf` — Israeli tax form template filled in-app via pdf-lib (see AI/passport scan flow below).

## Commands

There is no npm/build/lint/test tooling. Development is edit-the-HTML-and-reload.

- Local preview: `firebase emulators:start --only hosting` (uses `firebase.json` rewrites), or just open the HTML files directly in a browser.
- Deploy: Push to `origin/main` (or `origin/HEAD`); GitHub Actions workflows automatically deploy both the static hosting and backend:
  - `.github/workflows/deploy.yml` — deploys `schedule-manager.html`, `worker-punch.html`, and supporting files to Firebase Hosting (project alias `schedule-odinson`, see `.firebaserc`).
  - `.github/workflows/deploy-apps-script.yml` — deploys Google Apps Script source (anything in `apps-script/`) via `clasp push --force` and `clasp deploy` to the configured Apps Script project (requires `CLASP_CREDENTIALS` and `CLASP_DEPLOYMENT_ID` GitHub secrets).
  - No manual `firebase deploy` or `clasp` commands are needed.
- Routing: `firebase.json` rewrites `/` → `schedule-manager.html` and `/punch` → `worker-punch.html`.

When bumping the service worker's cache (`CACHE` constant in `service-worker.js`), increment the version string (e.g. `schedule-mgr-v3` → `v4`) or clients will keep serving stale cached HTML after deploy.

## Architecture

### Backend: Google Apps Script

Both HTML files talk to the **same** Google Apps Script Web App endpoint (`GS_URL`, a `script.google.com/macros/.../exec` URL hardcoded near the top of the `<script>` block in each file), authenticated with a hardcoded shared secret (`API_SECRET` = `'odinson-7Kq2x9'`). The Apps Script project (backed by a Google Sheet) is the actual database. Source code is in `apps-script/` (tracked here and auto-deployed via GitHub Actions when pushed to `main`). Configuration is in `apps-script/appsscript.json` (project settings: timezone, runtime, web app access). The project ID in `apps-script/.clasp.json` links the local source to the deployed Apps Script via clasp. Requests are plain `fetch()` calls with an `action` field selecting the server-side operation:

**GET endpoints:**
- `loadSchedule` — fetch workers/clients/weekStart/savedAt.
- `loadPunchLog` — fetch punch entries (with optional worker/date/type filters).
- `calcSalary` — compute daily/worker hours from punch log.

**POST endpoints (write actions, require `API_SECRET`):**
- `saveSchedule` — persist workers/clients/weekStart; includes optimistic concurrency control (rejects if `baseSavedAt` conflicts with server version). `clients.radius` always coerced to NUMBER (default 100m).
- `savePunch`, `updatePunch`, `deletePunch` — punch-clock entries with GPS data.
- `savePushSubscription` — web push subscription registration.
- `aiReadDoc` — server-side AI document OCR via Anthropic API (passport/Israeli ID extraction, stored in Script Properties: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`).
- `logError` — client error telemetry.

**Backend sheets:**
- `Schedule` (key/value pairs: workers JSON, clients JSON, weekStart, savedAt).
- `PunchLog` (append-only columns: ID, WorkerID, Worker, Type, Time, Date, Timestamp, Site, Distance(m), GPS Accuracy(m), GPS Suspicious, GPS Warnings, Notes, EditedAt, ClientID; see migration notes below).
- `Salary` (computed dynamically from PunchLog).
- `Clients` (human-readable tab: Name, Address, Lat, Lng, Radius(m), Notes).
- `PushSubscriptions` (web push endpoints).
- `Backups` (daily snapshot for disaster recovery).
- `Errors` (client error log, last 500 entries).

**Backend utilities:**
- `backupNow()` / `setupDailyBackup()` — daily 2am backup of Schedule to Backups sheet.
- `restoreBackupRow(rowNum)` — manual restore from Backups.
- `checkShiftReminders()` / `setupHourlyTrigger()` — hourly check for upcoming shifts, send push notifications.
- `normalizeClients(clients)` — enforce numeric radius on load/save.
- `migrateAddClientIdColumn()` — one-time migration to add the `ClientID` column to an existing PunchLog sheet (run once from the Apps Script editor after deploying the version that includes this column; safely handles sheets where the column already exists).
- `fixPunchLogHeaderDrift()` — one-time fix for sheets where an earlier code version wrote GPS Suspicious/GPS Warnings data to columns K:L but the row-1 headers still showed the old 'Notes'/'EditedAt' labels (causing loadPunchLog to silently skip those fields). Rewrites headers K1:N1 only, never touches data rows. Safe to run more than once; detects if headers are already correct.
- `fixGpsAccuracyHeaderLabel()` — one-time fix: rewrites column J's header from the legacy 'QR Verified' label (from before GPS-only verification) to 'GPS Accuracy(m)' so that `loadPunchLog()`'s name-based lookup matches the positionally-written GPS accuracy data. Rewrites J1 only, never touches data rows. Safe to run more than once; detects if header is already correct.
- `backfillOfficeAClientId()` — one-time backfill for historical punches: sets `clientId='c1'` on punches where `site='Office A'` and `clientId` is empty, recovering the client link for punches recorded before the clientId field existed and before client c1 was renamed. Only updates rows with no clientId, so safe to run more than once; never overwrites an existing (possibly correctly-chosen) clientId.
- `formatPunchLogSheet()` — visual formatting pass for the PunchLog sheet: bolds/colors the header row, freezes it, and auto-fits column widths to match the style already used in Clients/Backups/Errors tabs. Formatting only (never touches data). Safe to run more than once; worth re-running after adding a column since new header cells don't inherit existing bold/background styling.

The service worker explicitly never intercepts requests to `script.google.com` (`service-worker.js:31`) — the API always goes straight to network.

### Client-side state & persistence (schedule-manager.html)

- In-memory globals: `workers`, `clients`, `weekStart`, plus UI state like `selectedClientId`, `editingWorkerIdx`. No framework — state mutation is followed by a manual `render()` call.
- `render()` fans out to per-section renderers: `renderStats`, `renderGanttHeader`/`renderGanttBody` (the schedule grid), `renderWorkerList`, `renderWorkersPage`, `renderClientsPage`, `renderDashboard`, `renderSalary`, `renderAdmin`, `renderClientLogs`.
- **Google Sheets is the source of truth; `localStorage` (`schedMgr_v1` / `schedMgr_v1_bak`) is only a cache/offline fallback.** `loadData()` renders cached data instantly, then overwrites with the Sheets response. `autoSave()` debounces writes (800ms), writes to `localStorage` first, then pushes to Sheets via `gsSave`; it also has an "empty state" guard that refuses to persist an accidentally-cleared `workers`/`clients` array over existing cached data.
- Each worker has a generated `token` (`genToken`) used to build their personal punch-clock link (`buildPunchLink`) — this token is the `t=`/`token=` query param `worker-punch.html` reads to skip worker selection.
- **Payroll math (refactored for overnight-shift correctness):** 
  - `analyzeDayPunches(entries, date)` pairs a single day's IN/OUT punches chronologically and sums hours, flagging anomalies (double-in, out without in, >12h shift, open shifts, etc.). Used for per-day analysis and anomaly detection.
  - `groupPunchesIntoShifts(entries)` pairs a worker's *entire punch history* chronologically into shift-buckets **independent of calendar-day boundaries** — so an IN before midnight and OUT after midnight stay in one bucket (tagged by opening punch date) instead of splitting into two half-shifts that `analyzeDayPunches` can't pair (whose hours would otherwise vanish from payroll). This is critical for overnight-shift hours to be counted. Returns buckets `{date, entries}` with the date of the IN punch.
  - `shiftPay(hours, w, isSat)` calculates total pay for one shift using per-shift payroll logic: **default applies `israeliDayPay` law tiers** (8h regular at ×1.0, next 2h at ×1.25, rest at ×1.5; Saturday ×1.5/×1.75/×2.0), but **respects per-worker `otRate` and `shabbatRate` overrides** (single flat ₪/h rate replacing law tiers for all OT/Shabbat hours in that shift, same as before). This unifies payroll logic: manager's salary table, CSV exports, and PDF documents all route through `shiftPay`, ensuring no drift.
  - The dashboard's salary table (`renderSalary`) and exports (`exportSalaryCSV`) use `groupPunchesIntoShifts` + `analyzeDayPunches` + `shiftPay` to compute totals — ensures overnight shifts track correctly and hours are not lost at midnight boundaries.
  - `israeliDayPay`, `wRegRate`/`wOtRate`/`wShabRate`, `PAY_RULES`, and `shiftPay` encode Israeli overtime/Shabbat law — domain-specific; do not simplify without verifying intent with labour-law domain expertise.
- **XSS protection:** Critical — all user-supplied text (worker names, client names, notes, addresses, phone, email, sites) interpolated into HTML templates must be wrapped in `esc()` — HTML-escapes `&<>"'` to prevent injection. Apply `esc()` on ALL `${...}` expressions inside template strings building HTML from data, especially worker/client/punch display. The `esc()` function is defined early in the script (after `uid()`) and is the single source of truth for HTML-safe interpolation. This is a foundational security requirement — never interpolate untrusted data directly into HTML templates.
- **Punch entry `clientId` tracking:** Punch entries include a `clientId` field (client ID, not just name), enabling geofence/client-specific analytics and historical accuracy. When editing a punch, the site selector stores the client's ID (or `__custom__` sentinel for unmapped sites), preserving the association even if client names/assignments change later. Two helper functions:
  - `punchSite(e)` — resolves the site name to display: prefers punch's own `clientId` (looks up client name), falls back to stored site name, then worker's current client assignment. Used for UI display.
  - `punchClientObject(e)` — retrieves the client's object/branch name as *recorded at punch time*, preferring punch `clientId` over worker's current assignment — critical for preserving historical accuracy when worker-client relationships change. Used in salary exports.
  - Edit flow: site select uses `clientId` values; legacy entries without `clientId` fall back to the stored site name.
- **Admin punch log filtering:** Worker filter now uses `workerId` (matched against punch `workerId`, not `workerName`), de-duplicating by ID so duplicate names don't collapse into one filter option. This is critical when two workers share the same name. Lookup is keyed by `workerId` throughout admin log, salary export, and client logs view. When rendering filter dropdowns, build a `Map` of `workerId → workerName` from the punch log, then sort by name, to ensure each worker ID appears once.
- Exports: `exportExcel` (SheetJS/xlsx, loaded from CDN), `exportPDF`, `exportJSON`, `exportSalaryCSV`, `exportPunchCSV`. Salary export (`exportSalaryCSV`) now uses `groupPunchesIntoShifts()` to pair overnight shifts correctly before calculating hours and pay per shift.
- Admin panel: `renderAdmin()` and `renderClientLogs()` display punch log with filtering by workerId/clientId/date/type. Edit/delete operations on punches (`editPunchEntry`, `savePunchEntry`, `deletePunchEntry`) now store `clientId` alongside punch data for historical client link preservation.
- The AI document scan / passport / Form 101 flow (`openAiScan`, `openPassportScan`, `parseMRZ`, `parseHRZ`, `copyForm101`, `passportToWorker`, `fillForm101`) is a distinct subsystem: it lazy-loads Tesseract.js and PDF.js from CDN, OCRs an uploaded ID/passport image, extracts MRZ/HRZ fields, and can push the result into a new worker or fill `form101_fillable.pdf` via pdf-lib.
- Mobile responsiveness: admin punch log table wraps in a horizontal-scroll container (`overflow-x: auto`) on narrow screens, with `min-width: 760px` on the table itself to prevent column collapse. The table container is a nested `<div>` inside the admin-table-wrap to enable independent horizontal scrolling.

### worker-punch.html

- Reads a per-worker `token` from the URL (`URL_TOKEN`) to jump straight to that worker's punch screen; without a token it shows a worker picker (`renderWorkerGrid`).
- `getLastEntry(log, wid)` returns the most recent punch entry for a worker **across all days** (not just today). This determines whether to show "Clock IN" or "Clock OUT" in the UI, and powers the "In since" / "Last: X (out)" status in the worker grid.
- GPS anti-spoofing lives in `analyseGps`/`getLocation`: flags zero/low accuracy, impossibly fast movement between two readings (`haversine` distance ÷ time), suspicious device speed, and instant geolocation responses (`GPS_REQUEST_MS`) as signs of a mocked location, before allowing a punch within `SITE.radius` of the client site.
- Offline-safe punches: `doPunch()` always writes to `localStorage` (`punchLog`) and also queues to `punchQueue` (`getQueue`/`saveQueue`/`queueEntry`) when the Sheets `savePunch` call fails, for later resync.
- `updateScheduleManager` reaches into the *same-origin* `schedMgr_v1` localStorage key to reflect a punch back into the manager app's cached schedule — this only works when both apps share local storage (i.e. same browser/device), it's not a sync mechanism across devices.

### Shared conventions across both files

- No modules/imports — everything is global functions/consts inside one inline `<script>` per file. When adding functionality, follow this style rather than introducing bundling.
- **XSS protection:** All user-supplied text is wrapped in `esc()` — a helper that HTML-escapes `&<>"'` to prevent injection. Use it on all `${...}` expressions inside template strings building HTML from data.
- Both files duplicate constants like `GS_URL`/`API_SECRET` and helpers like `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `urlB64ToUint8` (`worker-punch.html` has `urlB64ToUint8WP`), and the `esc()` XSS-protection function — this is intentional (no shared build), so a fix in one file (e.g. the API URL after rotating the Apps Script deployment, or an improvement to `esc()`) usually needs to be mirrored in the other.
- Push notifications: both files subscribe via `savePushSubscription`; `service-worker.js` handles `push`/`notificationclick`.
- Auto-commit: `.claude/settings.json` runs a `PostToolUse` hook on `Write|Edit|NotebookEdit` that stages, commits, and pushes to `origin/HEAD` automatically after every file change made by Claude Code in this repo. Each push to `origin/main` triggers the GitHub Actions deploy workflow.
