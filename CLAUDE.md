# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A staff scheduling & GPS punch-clock PWA for a single client ("Odinson"), served as static files from Firebase Hosting. There is no build step, no bundler, no package.json, and no test suite — the two pages are self-contained HTML files with inline `<style>` and `<script>`.

- `schedule-manager.html` — the manager/admin app (shifts, workers, clients, payroll, exports). RTL, Hebrew (`lang="he"`), ~3200 lines.
- `worker-punch.html` — the worker-facing clock-in/out app, opened via a per-worker tokenized link. ~1000 lines.
- `service-worker.js` — PWA offline shell (network-first, cache fallback).
- `manifest.json` / `manifest-punch.json` — separate installable-PWA manifests for the two apps.
- `google-apps-script.js` — the backend Apps Script source code (backed by Google Sheets database). Deployed separately to `script.google.com` but tracked here for reference/documentation.
- `apps-script/appsscript.json` — Google Apps Script project configuration (timezone, runtime version, web app access rules). Configures the Apps Script project deployed to `script.google.com`.
- `apps-script/.clasp.json` — Google Apps Script CLI (clasp) configuration linking the local source to the deployed project via `scriptId`.
- `form101_fillable.pdf` — Israeli tax form template filled in-app via pdf-lib with fontkit support for Hebrew. See AI/document-scan flow below.
- `heebo-hebrew.ttf` — Heebo Hebrew+Latin TTF font subset (OFL licensed, bundled same-origin). Required for proper Hebrew glyph rendering in Form 101 PDF filling when embedding custom fonts via fontkit; loaded via `_loadHeeboFont()` (offline-safe, cache-first).

## Commands

There is no npm/build/lint/test tooling. Development is edit-the-HTML-and-reload.

- Local preview: `firebase emulators:start --only hosting` (uses `firebase.json` rewrites), or just open the HTML files directly in a browser.
- Deploy: Push to `origin/main`; GitHub Actions workflows automatically deploy both static hosting and backend on every commit:
  - `.github/workflows/deploy.yml` — deploys `schedule-manager.html`, `worker-punch.html`, and supporting files to Firebase Hosting (project alias `schedule-odinson`, see `.firebaserc`). **No manual `firebase deploy` step is used** — a push to main is what triggers the deploy.
  - `.github/workflows/deploy-apps-script.yml` — deploys Google Apps Script source (anything in `apps-script/`) via `clasp push --force` and `clasp deploy` to the configured Apps Script project (requires `CLASP_CREDENTIALS` and `CLASP_DEPLOYMENT_ID` GitHub secrets).
- Routing: `firebase.json` rewrites `/` → `schedule-manager.html` and `/punch` → `worker-punch.html`.

When bumping the service worker's cache (`CACHE` constant in `service-worker.js`), increment the version string (e.g. `schedule-mgr-v3` → `v4`) or clients will keep serving stale cached HTML after deploy. PostToolUse hook auto-commits and pushes to main on every file edit.

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
- `aiReadDoc` — server-side AI document OCR via Anthropic API (passport/Israeli ID extraction, stored in Script Properties: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`). For Israeli IDs, includes extraction of registered children from the ספח (appendix card) if present, returned as `children` array with each child's name, ID number, and DOB.
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
- Each worker has a generated `token` (`genToken()`) used to build their personal punch-clock link (`buildPunchLink(w)`) — this token is the `t=` query param `worker-punch.html` reads to skip worker selection.
- **XSS Protection (CRITICAL):** `esc(s)` function HTML-escapes user-supplied text (`&<>"'`) to prevent injection. Every `${...}` interpolation of data into HTML templates **must** call `esc()`. This is foundational security — defined early in the script after `uid()` and used consistently throughout all render functions (worker names, client names, addresses, phone numbers, notes, punch sites, contacts, etc.). Any new feature interpolating user text must apply `esc()` to the value.
- **Payroll math (canonical overnight-shift logic):** Five functions form the core:
  - `analyzeDayPunches(entries, date)` pairs a single calendar day's IN/OUT punches chronologically and sums hours, flagging anomalies (double-in, out-without-in, >12h shift, open shifts, etc.). Returns `{hours, warnings}`. Used for per-day analysis and anomaly detection in the admin dashboard.
  - `groupPunchesIntoShifts(entries)` pairs a worker's *entire punch history* chronologically into shift-buckets **independent of calendar-day boundaries** — an IN before midnight and OUT after midnight stay in one bucket (tagged by opening punch date) instead of splitting into two half-shifts that `analyzeDayPunches` can't pair (whose hours would otherwise vanish from payroll). **Critical for overnight-shift accuracy.** Returns buckets `{date, entries}` with the date of the IN punch. **This is the canonical function used in all three payroll contexts:** salary table render, salary CSV export, and punch log analysis. Never duplicate its logic. Ensures chronological pairing across all punches (not just today's).
  - `shiftPay(hours, w, isSat)` calculates total pay for one shift: **default applies `israeliDayPay` law tiers** (8h regular at ×1.0, next 2h at ×1.25, rest at ×1.5; Saturday ×1.5/×1.75/×2.0), but **respects per-worker `otRate` and `shabbatRate` overrides** (single flat ₪/h rate replacing law tiers for all OT/Shabbat hours). Unifies payroll: manager's salary table, CSV exports, all route through `shiftPay`. Never replicate this logic.
  - `israeliDayPay(hours, rate, isSat)` implements the law tiers; `wRegRate(w)`, `wOtRate(w)`, `wShabRate(w)` fetch effective rates (base or per-worker overrides); `PAY_RULES` constants encode thresholds (regularMax 8h, ot1Span 2h, otMult 1.25, shabbatMult 1.5).
  - Dashboard salary table (`renderSalary`) and CSV export (`exportSalaryCSV`) use `groupPunchesIntoShifts` → `analyzeDayPunches` → `shiftPay` to compute totals. Ensures overnight shifts never split across midnight, hours are counted once, and pay is correct.
  - Israeli labour law encoding: domain-specific; do not simplify without labour-law expertise. The `shiftPay()` function is the single source of truth for payroll calculations (all three contexts call it).
- **Punch entry `clientId` tracking:** Punch entries include a `clientId` field (client ID UUID, not just name), enabling geofence/client-specific analytics and historical accuracy even when client names/worker assignments change. When editing a punch, the site select stores the client's ID (or `__custom__` sentinel for unmapped legacy sites), preserving the association. Three helper functions work together:
  - `punchSite(e)` — resolves the site name to display: prefers punch's own `clientId` (looks up current client name), falls back to stored site name string (for legacy entries), then worker's current client assignment. Used for UI display (dashboard, admin table, client logs). Always escaped via `esc()` when interpolated into HTML.
  - `punchClientObject(e)` — retrieves the client's object/branch name as *recorded at punch time*, preferring punch `clientId` over worker's current assignment — critical for payroll accuracy when worker-client relationships change. Used in salary CSV export to show which object was staffed on punch date.
  - `workerClientName(workerId)` — falls back helper: returns worker's current client assignment (for punches recorded before `clientId` existed).
  - Edit flow (`editPunchEntry`/`savePunchEntry`): site select now stores `clientId` values; if `__custom__` is chosen, the stored site name string is preserved (legacy behavior); clearing the site clears `clientId`. Manual punch creation (`saveManualPunch`) records the punch with `clientId` from the selected client.
- **Admin punch log filtering and rendering:** Worker filter now uses `workerId` (matched against punch `workerId`, not `workerName`), de-duplicating by ID so duplicate names don't collapse. Critical when two workers share the same name. Rendering filter dropdowns: build a `Map` of `workerId → workerName` from the punch log, sort by name, so each worker ID appears once with correct current name. Client filter is keyed by `clientId`, enabling filtering by client assignment at punch-record time (even if assignments changed since). **Responsive design:** Punch table is wrapped in a horizontal scroll container (`<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">`), with table `min-width:760px` to ensure columns don't collapse on mobile. Worker name cells, client badge pills, and date/site columns all use `white-space:nowrap` to prevent text wrapping and keep names intact. This ensures the punch log remains readable on narrow screens without hiding columns.
- Exports: `exportExcel` (SheetJS/xlsx, loaded from CDN), `exportPDF`, `exportJSON`, `exportSalaryCSV`, `exportPunchCSV`. Salary export (`exportSalaryCSV`) now uses `groupPunchesIntoShifts()` to pair overnight shifts correctly before calculating hours and pay per shift.
- Admin panel: `renderAdmin()` and `renderClientLogs()` display punch log with filtering by workerId/clientId/date/type. Edit/delete operations on punches (`editPunchEntry`, `savePunchEntry`, `deletePunchEntry`) now store `clientId` alongside punch data for historical client link preservation.
- **AI document scan / Form 101 flow** (`openAiScan`, `aiFillForm101`, `aiToWorker`, `renderAiResult`): uploads photo or PDF to backend Apps Script, which uses **Anthropic Vision API** to OCR and extract passport/Israeli ID fields (`aiReadDoc` action). Server-side only — client-side OCR (Tesseract.js MRZ parser) and passport MRZ scanner removed for better accuracy and lighter JS footprint.
  - **Scan results normalization:** After AI extraction, child-name fields are normalized via `_nrm(s)` — collapses multiple spaces, trims whitespace, ensuring clean data in `window.__aiScanChildren` array. This array is populated from Israeli ID scans (if the ID has registered children in its ספח appendix) and displayed in the Form 101 UI.
  - **Form 101 pre-fill UI:** After scanning, users set two optional fields before PDF generation:
    - **For Israeli ID:** `aiIdWork` (date started), `aiIdFund` (health fund), `aiIdMarital` (marital status) — populate the corresponding PDF fields.
    - **For foreign passport:** `aiPpWork` (date started), `aiPpFund` (health fund) — populate the corresponding PDF fields.
    Each scan path is independent; user customizes before generating the PDF.
  - **Form 101 PDF filling enhancements:**
    - **Text field font sizing:** `setSize(name, size)` helper overrides template default font via `acroField.setDefaultAppearance('/Helv NNpt Tf 0 g')`, making text readable. Applied to `surname` (11pt), `given_name` (11pt), `addr_street` (11pt), `addr_city` (11pt), `hf_name` (10pt), `id_top2` (13pt) — sizes tuned to fit field boxes.
    - **PDF form field combing:** Fields like `dob`, `tax_year`, `passport_no` are printed with per-character boxes. `setComb(name, maxLen, value, size)` helper uses `fld.enableCombing()` to spread each character into its own box. Applied to `dob` (8 chars = DDMMYYYY), `tax_year` (4 chars = YYYY), `passport_no` (13 chars). Sets explicit size to prevent pdf-lib's auto-sizing from overflowing boxes vertically. For fields with no underlying form field (just printed boxes), `drawCombRaw(text, maxLen, rect, size)` manually draws characters evenly spaced across the given box coordinates — used for work-start date and children table.
    - **Work-start date (תאריך תחילת העבודה בשנת המס):** No form field on template — just printed comb box. `fillWorkStart(isoDate)` refactored helper extracts date parts and calls `drawCombRaw()` to fill the date box (DDMMYYYY format) at coordinates `{x:30.75, y:450.42, width:90.64, height:21.01}`. Called by both Israeli ID and foreign passport paths.
    - **Children table (ג. פרטים על ילדיי...):** New feature for Israeli ID scans. Template has 10 printed rows (no form fields) for child ID, DOB, and name. Data comes from `window.__aiScanChildren` array (populated by AI scan via `aiReadDoc` action, each child normalized via `_nrm()`). `aiFillForm101()` iterates children, draws each field via `drawCombRaw()` into the corresponding row's box: ID (9 chars, numeric), DOB (8 chars, DDMMYYYY), Name (right-aligned with `page1.drawText()` using Heebo or system font). Skips eligibility checkboxes (rows 1–2 of the "בן/בת" column) — user marks these by hand since they require parent declaration, not something a scan can provide. Only Israeli-ID path surfaces children (from the ID's ספח).
    - **Heebo Hebrew font (offline-safe):** `_loadHeeboFont()` loads `heebo-hebrew.ttf` as bundled same-origin asset, avoiding CDN. `_loadFontkit()` lazy-loads fontkit from CDN (required by pdf-lib to embed custom fonts). Hebrew-aware text setter `setH(name, value)` calls `setText()` first, then `updateAppearances(customFont)` to re-render field appearance stream with Hebrew glyphs. For multi-word RTL text (e.g. two Hebrew words), the fix manually redraws text via `page1.drawText()` after blanking the widget's buggy appearance to avoid doubled glyphs. Falls back to ASCII if Heebo unavailable. Form dict's `NeedAppearances=false` tells viewers to use our appearance streams, not re-render. `HEALTH_FUND_HE` maps enum codes (`Clalit`, `Maccabi`, etc.) to Hebrew names.

### worker-punch.html

- Reads a per-worker `token` from the URL (`URL_TOKEN`) to jump straight to that worker's punch screen; without a token it shows a worker picker (`renderWorkerGrid`).
- `getLastEntry(log, wid)` returns the most recent punch entry for a worker **across all days** (not just today). This determines whether to show "Clock IN" or "Clock OUT" in the UI, and powers the "In since" / "Last: X (out)" status in the worker grid.
- GPS anti-spoofing lives in `analyseGps`/`getLocation`: flags zero/low accuracy, impossibly fast movement between two readings (`haversine` distance ÷ time), suspicious device speed, and instant geolocation responses (`GPS_REQUEST_MS`) as signs of a mocked location, before allowing a punch within `SITE.radius` of the client site.
- Offline-safe punches: `doPunch()` always writes to `localStorage` (`punchLog`) and also queues to `punchQueue` (`getQueue`/`saveQueue`/`queueEntry`) when the Sheets `savePunch` call fails, for later resync.
- `updateScheduleManager` reaches into the *same-origin* `schedMgr_v1` localStorage key to reflect a punch back into the manager app's cached schedule — this only works when both apps share local storage (i.e. same browser/device), it's not a sync mechanism across devices.

### Shared conventions across both files

- No modules/imports — everything is global functions/consts inside one inline `<script>` per file. When adding functionality, follow this style rather than introducing bundling.
- **XSS protection (CRITICAL):** All user-supplied text is wrapped in `esc()` — a helper that HTML-escapes `&<>"'` to prevent injection. Use it on every `${...}` expression inside template strings building HTML from data. The `esc()` function is the single source of truth for HTML-safe interpolation (defined after `uid()`). This is a foundational security requirement. Both files have the same `esc()` definition and it must be kept in sync.
- Both files duplicate constants and helpers: `GS_URL`/`API_SECRET`, `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `urlB64ToUint8` (`worker-punch.html` has `urlB64ToUint8WP`), and the `esc()` function. This duplication is intentional (no shared build). A fix in one file (API URL rotation, `esc()` improvement) must be mirrored in the other to avoid drift.
- Push notifications: both files subscribe via `savePushSubscription` action; `service-worker.js` handles `push` events and `notificationclick`.
- **Auto-deploy on commit:** `.claude/settings.json` runs a `PostToolUse` hook on `Write|Edit|NotebookEdit` that stages, commits (with co-author trailer), and pushes to `origin/HEAD` automatically after every file change made by Claude Code. Each push to `origin/main` triggers GitHub Actions deploy workflows (no manual `firebase deploy` or `clasp` commands needed).
