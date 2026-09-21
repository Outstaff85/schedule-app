# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Session language:** the user communicates in Russian. Claude's own conversational output (explanations, status updates, questions) should be in Russian throughout — independent of what language the app's UI/code is in.

**UI text language:** all new user-facing UI text (tab labels, buttons, messages) must be in English going forward. Most of the existing app is Hebrew (`lang="he"`); the `Бухгалтерия` (Accounting) tab is a Russian pocket added by mistake — don't repeat that. Existing Hebrew/Russian text doesn't need retranslating unless asked.

## What this is

A staff scheduling & GPS punch-clock PWA for a single client ("Odinson"), served as static files from Firebase Hosting. No build step, no bundler, no package.json, no test suite — the two pages are self-contained HTML files with inline `<style>`/`<script>`.

**Multi-tenant:** a super-admin creates "firms" (tenants) with their own login; each firm's data (schedule, punches, Drive docs) is isolated. See `MULTI_TENANT_PLAN.md` for the data model, auth design, and status. `apps-script/Код.js`/`google-apps-script.js` require session tokens on top of the legacy `API_SECRET`; `schedule-manager.html` has a login screen plus `gsAuth()`/`gsAuthQuery()` wrappers sending that token on every request.

### Files

- `schedule-manager.html` — the manager/admin app (shifts, workers, clients, payroll, exports). RTL, Hebrew (`lang="he"`), ~5000+ lines.
- `worker-punch.html` — the worker-facing clock-in/out app, opened via a per-worker tokenized link.
- `service-worker.js` — PWA offline shell (network-first, cache fallback). Never intercepts `script.google.com` — the API always goes straight to network.
- `manifest.json` / `manifest-punch.json` — installable-PWA manifests for the two apps.
- `google-apps-script.js` — backend Apps Script source (mirrors `apps-script/Код.js`, the one actually deployed). Backed by a Google Sheet acting as the database.
- `apps-script/appsscript.json` — Apps Script project config (timezone, runtime, web app access, OAuth scopes: `spreadsheets`, `script.external_request` for the Anthropic API, `drive`).
- `apps-script/.clasp.json` — clasp config linking local source to the deployed Apps Script project.
- `form101_fillable.pdf` / `heebo-hebrew.ttf` — source copies at repo root; the client no longer fetches these. `functions/assets/` holds the copies the Cloud Function actually uses. Re-sync `functions/assets/` from these if the template/font is ever updated.
- `form101-field-map.md` — verified field-by-field map of `form101_fillable.pdf` (every AcroForm field's name/rect/Hebrew label/meaning). **Consult and update whenever touching `functions/main.py`'s field rects or the PDF template changes** — drift between this map and the code is a known source of "fields land in the wrong place" bugs.
- `functions/` — Python Cloud Functions: `fill_form_101` (builds the Form 101 PDF via PyMuPDF) and `preprocess_scan` (OpenCV+Pillow contrast enhancement followed by blur check, before the manual crop editor). Has its own `venv/` (gitignored) — `firebase deploy --only functions` expects a pre-built virtualenv and won't create one; run `python -m venv venv && pip install -r requirements.txt` inside `functions/` before deploying from a fresh clone. **Note:** the blur threshold (`BLUR_VARIANCE_THRESHOLD`) was calibrated against pre-enhancement images; as of 2026-09-21 the check runs after enhancement, so post-enhancement blurry photos score higher on the Laplacian variance test — if genuinely blurry scans start passing in practice, raise the threshold.
- `MULTI_TENANT_PLAN.md` — data model, auth design, and status tracker for the multi-tenant feature.

## Commands

No npm/build/lint/test tooling — edit the HTML and reload.

- Local preview: `firebase emulators:start --only hosting`, or open the HTML files directly.
- Routing: `firebase.json` rewrites `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`.
- **Deploy = push to `main` (via PR, see below).** GitHub Actions deploys on every push to `main`:
  - `.github/workflows/deploy.yml` — Firebase Hosting (project `schedule-odinson`).
  - `.github/workflows/deploy-apps-script.yml` — `clasp push --force && clasp deploy` for `apps-script/` (needs `CLASP_CREDENTIALS`/`CLASP_DEPLOYMENT_ID` secrets).
  - `.github/workflows/deploy-functions.yml` — deploys `functions/` on any push touching `functions/**`, or via manual `workflow_dispatch`. Builds a fresh venv in CI. `firebase.json`'s `functions[0].runtime` is pinned to `"python312"` for a deterministic runtime. On failure it opens/updates a GitHub Issue with likely causes — see Troubleshooting below for the known IAM permission gaps.
- When bumping the service worker's cache (`CACHE` constant in `service-worker.js`), increment the version string or clients keep serving stale HTML after deploy.
- `firebase.json`'s hosting `ignore` list must include `functions/**`, or `firebase deploy --only hosting` sweeps the entire `functions/venv` into the public hosting bucket.

### Git workflow (enforced by hooks in `.claude/settings.json`)

- **`My_Work_Befor_PR`** is the standing work branch — check it out (or resume the cloud session on it) at the start of work instead of `main`. Don't create ad-hoc branches per session.
- A `PostToolUse` hook auto-commits and pushes every file edit to the **current branch** (`git push origin HEAD`). This only fires in a session whose working directory *is* this repo at session start — a session rooted elsewhere that reaches this repo only via absolute paths/`cd` never loads this project's `.claude/settings.json`, so no auto-commits happen there.
- A `PreToolUse` hook blocks any `git push` that force-pushes, targets `main` by name, or runs while the current branch is `main`.
- A `SessionStart` hook injects `git status --short` + current branch as context automatically.
- A `PostToolUse` hook on `gh pr create*` diffs the PR's full range against this file and updates it via an agent — so this file should stay reasonably in sync with the code across PRs.
- **"Deploy" means: open a PR from `My_Work_Befor_PR` into `main` covering everything accumulated since the last one, then merge it — merging is what triggers the real deploy.** Never push/reset directly to `main`. Batch accumulated changes into one PR per deploy request rather than one PR per edit.
- **Never merge a PR without asking the user first.** Pushing to the feature branch needs no confirmation; merging to `main` always does.

## Architecture

### Backend: Google Apps Script

Both HTML files talk to the same Apps Script Web App endpoint (`GS_URL`, hardcoded near the top of each file's `<script>`), authenticated with a hardcoded shared secret (`API_SECRET`). Source lives in `apps-script/` (auto-deployed on push to `main`).

**GET endpoints:** `loadSchedule`, `loadPunchLog` (optional worker/date/type filters), `calcSalary`.

**POST endpoints** (require `API_SECRET`, and a session token except for `login`):
- Auth/tenant: `login`, `createUser` (super-admin, creates a firm), `updateTenant` (edit firm profile, returns refreshed `profile`), `loadTenantProfile`, `listTenants`/`setTenantActive`/`deleteTenant` (super-admin). **Critical:** `createUser`/`updateTenant` format phone/deductions-file-number fields as plain text (`setNumberFormat('@')`) *before* `setValue()`, or Sheets auto-coerces the digit string to a number and drops leading zeros (Israeli phone numbers, deductions file numbers) — corrupting what Form 101 prints. Pre-existing rows written before this guard, or via `migrateToMultiTenant()`'s initial tenant row, can still have this corruption; see Troubleshooting.
- Schedule/punches: `saveSchedule` (optimistic concurrency via `baseSavedAt`; `clients.radius` always coerced to a number), `savePunch`/`updatePunch`/`deletePunch`, `savePushSubscription`.
- AI document scan (all call the paid Anthropic API, all require `API_SECRET`):
  - `aiReadDoc` — main OCR call (passport/Israeli ID). Uses `ANTHROPIC_MODEL` (Script Properties; default `claude-sonnet-5` — deliberately not the cheap model, since a misread digit corrupts a real tax form). `max_tokens: 8000`, prompt-caching enabled. On JSON-parse failure, checks `stop_reason==='max_tokens'` to report truncation specifically rather than a generic parse error. Response includes `fieldBoxes` (bounding boxes for digit fields, for zoomed re-verification), `photoBox` (portrait location, used by `cropPortraitAvatar()` to build the worker avatar thumbnail), `imageAlign` (`{rotate, corners, crop}` for straightening), and `children` (Israeli ID ספח appendix, if present).
  - `aiDetectAlign` — lightweight rotate+corners-only sibling on a separate `ANTHROPIC_ALIGN_MODEL` (default Haiku). Currently **dormant** (not called by the client — the manual corner editor runs before OCR now, so an AI-guessed starting point isn't needed) but kept working.
  - `aiVerifyField` — re-reads a single already-extracted digit field from a tight zoomed crop (`kind`: `digits9`/`date`/`passportNo`). Uses the same accuracy-first `ANTHROPIC_MODEL` as `aiReadDoc`. Returns empty string rather than guessing if illegible.
  - `aiReadSefach` — narrow sibling of `aiReadDoc` for when the photo is known to be the address/ospח side of an Israeli ID (avoids `aiReadDoc`'s front/back type misclassification). Always returns `type:"israeli_id"`.
- Drive/documents: `saveWorkerDoc` (stores the assembled Form 101 PDF under `Schedule manager APP/<CompanyName>/Workers`, deduped by the ID/passport number extracted from the filename via `extractDocNumberFromFileName()`; accepts `previousFileId` to trash the exact old file), `deleteWorkerDoc` (by `fileId` or `fileName`), `saveWorkerAssets`/`loadWorkerAssets` (a private JSON sidecar in a `Workers/Assets` subfolder holding the raw scan image + signature + extra pages, so a later field edit can regenerate the same PDF without re-scanning; also deduped by document number).
- `logError` — client error telemetry.

**Sheets:** `Schedule` (key/value: workers JSON, clients JSON, weekStart, savedAt), `PunchLog` (append-only, includes `ClientID`, `GPS Accuracy(m)`, `GPS Suspicious`, `GPS Warnings`), `Salary` (computed dynamically), `Clients`, `PushSubscriptions`, `Backups` (daily snapshot), `Errors` (last 500).

**Notable backend utilities:** `extractDocNumberFromFileName()` (longest run of 5+ digits — the stable identifier across rescans), `backupNow()`/`setupDailyBackup()`, `checkShiftReminders()`/`setupHourlyTrigger()` (push notifications for upcoming shifts), `normalizeClients()`. A handful of one-time migration/fix functions exist for historical sheet-schema drift (header renames, missing columns) — safe to re-run, look them up in `apps-script/Код.js` if a sheet looks like it needs one.

### Client-side (schedule-manager.html)

- In-memory globals: `workers`, `clients`, `weekStart`, plus UI state (`selectedClientId`, `editingWorkerIdx`). No framework — mutate state, then call `render()`. `render()` refreshes the Schedule tab's own pieces every time, plus whichever *other* tab is currently open (keyed off `currentTab`) — so a mutation while sitting on e.g. the Workers tab reflects immediately rather than only after switching tabs away and back.
- **Google Sheets is the source of truth; `localStorage` is a cache/offline fallback only.** `loadData()` renders cached data instantly, then overwrites with the Sheets response. `autoSave()` debounces writes (800ms) and refuses to persist an accidentally-cleared `workers`/`clients` array over existing cached data. The cache key is scoped per tenant (`STORAGE_KEY()` → `schedMgr_v1_<tenantId>`) so switching firms as super-admin can't flash a different firm's stale cache; writes also mirror to the legacy unscoped `schedMgr_v1` key purely so `worker-punch.html`'s same-device `updateScheduleManager()` bridge keeps working.
- Each worker has a `token` (`genToken()`) used to build their personal punch-clock link (`buildPunchLink(w)`); `worker-punch.html` reads it via `?t=`.
- **XSS (CRITICAL):** `esc(s)` HTML-escapes `&<>"'`. Every `${...}` interpolating data into an HTML template must call it. Both HTML files have identical `esc()` definitions that must stay in sync.
- **Payroll math — canonical functions, never reimplement:**
  - `groupPunchesIntoShifts(entries)` pairs a worker's *entire* punch history into shift-buckets independent of calendar-day boundaries, so an overnight IN→OUT stays one shift instead of splitting (and losing hours) at midnight. Used by the salary table, CSV export, and punch-log analysis alike.
  - `analyzeDayPunches(entries, date)` pairs one calendar day's punches and flags anomalies (double-in, out-without-in, >12h shift, open shifts).
  - `effectiveRates(w, clientId)` resolves hourly rates through a 3-tier chain: per-worker-per-client override (`w.clientRates[clientId]`) → client's `defaultHourlyRate` → worker's base rate. `shiftPay(hours, w, isSat, clientId)` applies Israeli labour-law tiers (8h ×1.0, next 2h ×1.25, rest ×1.5; Saturday ×1.5/×1.75/×2.0) via `israeliDayPay()`, unless a flat OT/Shabbat override rate is set. This is domain-specific labour-law logic — don't simplify without expertise.
  - Client per-object default rates live on the client record (`defaultHourlyRate`/`defaultOtRate`/`defaultShabbatRate`, editable in the Add/Edit Client modal); the per-(worker,client) override matrix lives under the **Бухгалтерия** (Accounting) tab (`renderRateMatrix()`/`setClientRateOverride()`).
- **Бухгалтерия (Accounting) tab** (`#sectionAccounting`) holds all payroll/rate UI (`renderSalary()` + `renderRateMatrix()`). The Today/Dashboard tab (`renderDashboard()`) only shows real-time attendance: On Site Now, Should Be Here, Contract Expiry, Today's Log.
- **Contract-expiry warning** (opt-in per worker: `expiryEnabled`/`expiryMonths`/`expiryWarnMonths`): `workerExpiryStatus(w)` computes `{level:'warning'|'overdue', deadline}` purely from `startDate`, no backend involvement. Shown as a badge in the worker list/table and as a card on the Today tab when any worker is flagged.
- **Punch `clientId` tracking:** punches store the client's ID (not just a site name string), so payroll/history stay accurate even if worker-client assignments or client names change later. `punchSite(e)`/`punchClientObject(e)`/`workerClientName(id)` resolve display name vs. historical-at-punch-time client.
- Admin punch log filters by `workerId`/`clientId` (not name), so two workers sharing a name don't collapse together.
- Exports: `exportExcel` (SheetJS/xlsx from CDN), `exportPDF`, `exportJSON`, `exportSalaryCSV`, `exportPunchCSV` — salary export goes through `groupPunchesIntoShifts()` like everything else.

#### Worker modal (`showWorkerModal()`)

Single screen for adding a worker by hand, editing an existing one, and reviewing/completing a document scan — there's no separate post-OCR screen. Field order has shifted several times by request; check the actual template rather than assuming a layout. Notable behavior:

- `w.name` is derived from `docGiven + ' ' + docSurname` on every save. **A worker whose record predates this split (only has `name`, no `docGiven`/`docSurname`) gets those fields derived on the fly when the modal opens** (split on first space) — this is display-only until an actual save persists it. Without this fallback the name fields render blank for such a worker, and `saveWorker()`'s "name required" guard then silently no-ops the entire save (nothing persisted, no toast) if the manager doesn't happen to retype the name.
- `__wDocType` (seeded from `w.docType`, defaulting to `'israeli_id'`) is captured into `commonFields.docType` on save — needed so a worker scanned from a foreign passport doesn't get silently relabeled `israeli_id` after its first PDF upload (which is what happens if `docType` isn't threaded through explicitly).
- **Every save auto-generates/uploads the Form 101 PDF in the background.** New-worker path: blocking `autoUploadWithRetry()` (spinner overlay, one retry on failure) using the live scan globals (`window.__aiScanImage`/`__aiPacketOtherPages`). Edit path: non-blocking `regenerateWorkerDoc()` (toast on completion) whenever a field in `FORM101_WATCHED_FIELDS` actually changed — this reads the scan/signature back from the Drive sidecar (`w.assetsFileId`) rather than the live globals, since those could belong to an unrelated in-progress scan elsewhere in the same tab. `FORM101_WATCHED_FIELDS` = `docId, address, houseNumber, city, incomeType, otherIncomeType, docSurname, docGiven, maritalStatus, healthFund, workStartDate, phone, docSex, docDob, docChildren`. A worker that's never had a document generated still regenerates fine (empty scan/signature, text-only PDF).
- Duplicate-worker guard on creation: a new worker's `docId` is checked against every existing worker's `workerDocId()` (not name — a document number is unique to one person); `confirm()` on a match, cancel aborts creation entirely.
- Deleting a worker also trashes their Drive PDF (`w.docFileId`, falling back to parsing `w.docUrl`) and asset sidecar (`w.assetsFileId`), best-effort.
- Digit-field verification: `isValidIsraeliId()` is a pure Luhn-style checksum (no AI call). `verifyDigitFields()`/`verifyIdChecksum()` re-verify OCR'd digit fields via a zoomed `aiVerifyField` re-read when the checksum doesn't already pass; a still-failing checksum surfaces as an amber warning under the docId field rather than silently keeping a wrong number.

#### AI document scan flow

`onScanFileSelected`/`onScanFilesSelected` → `preAlignScan()` (server contrast enhance + blur check, no crop) → **manual corner-adjustment editor** (`renderScanQuadEditor`/`initScanQuad`/`attachQuadDrag`, drag 4 SVG handles) → `confirmScanQuad()` perspective-warps the quad flat via `warpQuadImage()` (homography math: `computeSquareToQuadHomography`/`applyHomography`/`bilinearSample`, output capped at 1568px long edge) → `runOcr()` (calls `aiReadDoc`, then `verifyDigitFields`/`verifyIdChecksum`, then `refineWithAiAlign()`) → `finishPageScan()`.

- The corner editor runs **before** OCR, not after — the user positions the rectangle themselves on the raw photo; no AI-guessed starting rectangle. `initScanQuad()` reads the displayed `<img>`'s `clientWidth/clientHeight` to build the coordinate space — this must happen after both image decoding and layout are complete. A single `requestAnimationFrame` (the old fix) assumes one frame suffices for the browser to decode a large data-URI photo on all hardware; on slower/mobile devices this wasn't guaranteed, and the bug recurred even with the rAF defer. `renderScanQuadEditor()` now uses `img.decode()` (resolves only when the image is fully decoded, regardless of frame count), followed by one more rAF for layout — it falls back to the rAF-only approach if decode() throws or isn't supported. **Critical:** on some mobile browsers, `decode()` can apparently never settle (neither resolve nor reject) for a large data: URI, which prevented `initScanQuad()`/`attachQuadDrag()` from ever running, leaving the crop rectangle stuck non-interactive. The call is now capped at 1.2s with `setTimeout()` — if decode hangs, the timeout fires anyway and lets the editor become usable (fallback to uncropped original if crop never ran). Reading `clientWidth` before both are complete reads `0`, which locks the crop rectangle at a degenerate point and makes `warpQuadImage()` throw — silently caught, falling back to the *uncropped* original photo. The 4 corner drag handles are radius=20 (40px diameter) to meet ~44px touch-target guidelines on mobile; pointerdown hits only the visible circle (no padding), so a larger radius makes dragging more reliable on small screens.
- `preprocess_scan` (the Python endpoint) runs contrast enhancement before the blur check, then geometrically does **not** crop. (It used to auto-crop via OpenCV contour detection, but that broke the case of two documents photographed together, cropping one away before the user could pick it.) The blur threshold was calibrated on pre-enhanced images; enhancement can inflate variance scores, so if obviously blurry scans start passing, `BLUR_VARIANCE_THRESHOLD` may need adjustment.
- Multi-file / multi-page uploads (`onScanFilesSelected`): each page is classified (an already-filled Form 101 is dropped and always regenerated fresh; the first ID/passport page becomes primary; a ספח page's blank-filling fields — `dob/sex/address/city/houseNumber/maritalStatus` — merge into the primary record regardless of which physical card came first). Every page after the first lands in `renderScanPagesPrompt()`, a thumbnail-strip review screen ("add another page" / "done") before `openWorkerModalFromScan()` opens the worker modal.
- Worker's own mobile number is a plain modal field (`#wPhone`), not scanned — printed on the PDF via a synthetic `worker_phone` field (no real AcroForm field there).
- Each page's own raw parsed data is kept in `window.__aiPageParsed` (parallel to the `renderScanPagesPrompt()` thumbnail strip). Removing a page (`removeExtraScanPage()`) doesn't just drop its thumbnail — it recomputes the primary record from scratch via `rebuildPrimaryFromPages()`/`mergeScanPage()`, so a bad/misread extra page's merged fields (address, city, marital status, an `idMismatch` flag, ...) don't silently survive its own removal.
- `runOcr()`'s `refineWithAiAlign()`: `aiReadDoc`'s response includes `imageAlign` (rotate+corners) at no extra cost (same call already made for field extraction) — used as a fine TIGHTENING pass on top of the user's own manual crop, never a replacement. Ignores `imageAlign.rotate` entirely (the user already oriented the photo correctly via the corner editor's rotate buttons) and requires the guessed quad to cover at least half the frame (`quadAreaFrac()`) before trusting it, falling back to the untouched image otherwise — an AI auto-crop was previously removed (see `preprocess_scan` note above) specifically because it could confuse two documents in one photo; by the time this runs the user has already isolated one, so that failure mode doesn't apply here, but a wildly-wrong AI guess must still never be allowed to crop away content the user deliberately kept.

#### Form 101 PDF generation (server-side, `functions/main.py`)

`aiFillForm101()` client-side only assembles a JSON payload (name/dob/sex/id/address/marital/health fund/children/employer profile/signature PNG/extra scan pages) and POSTs to `FORM101_FN_URL`; the Python Cloud Function (PyMuPDF) builds the actual PDF bytes and returns `{pdfBase64, fileName}`. See `form101-field-map.md` for the field/rect map.

- Fields are addressed by name on `form101_fillable.pdf`'s own AcroForm markup (`Form101Builder.set_hebrew()`/`set_comb()`/`set_text_centered()`) — there's no from-scratch field creation except `SIG_RECT` (the signature image, which needs a rect since it's an image, not a form field). One field is mapped despite its name: `employer_zeut_num` actually holds the **worker's own** Israeli ID number (verified by position, not name).
- PyMuPDF has no RTL/BiDi shaping — every Hebrew-capable field is corrected via `python-bidi`'s `get_display()`, then the field's auto-generated appearance is blanked and the corrected text is hand-drawn on the page (`_blank_appearance()`/`_draw_rtl_text()`). Comb (digit) fields don't need this — LTR digit runs render fine through PyMuPDF's own appearance.
- Children: 6 template row-slots (`CHILD_FIELD_SUFFIXES`), each scanned child's combined name split on the first space into given/surname.
- `FIELD_RECT_NUDGES` holds small per-field `(dx, dy)` point offsets applied to the actual widget rect for one-off position corrections — add further nudges here rather than re-editing the PDF template by hand.
- `functions/venv` must exist locally before `firebase deploy --only functions` (see Files above); CI builds its own venv fresh and never touches the committed one.

### worker-punch.html

- Reads `?t=<token>` to jump straight to that worker's screen; without one, shows a worker picker.
- `getLastEntry()` looks at a worker's most recent punch **across all days** (not just today) to decide Clock IN vs. OUT.
- `openHistory()`'s per-day totals pair punches into shifts chronologically (its own from-scratch port of `groupPunchesIntoShifts`, since this file doesn't import from `schedule-manager.html`) *before* grouping by date — grouping by calendar day first would split an overnight shift's hours across two days and lose them from the worker's own history view.
- GPS anti-spoofing (`analyseGps`/`getLocation`): flags zero/low accuracy, impossibly fast movement between readings, and suspiciously instant geolocation responses before allowing a punch within the site's radius.
- Offline-safe punches: `doPunch()` always writes to local `punchLog`, and queues to `punchQueue` for later resync if the Sheets `savePunch` call fails.

### Shared conventions across both files

- No modules/imports — everything is global functions/consts inside one inline `<script>` per file; follow this style rather than introducing bundling.
- Both files **duplicate** constants and helpers on purpose (no shared build): `GS_URL`/`API_SECRET`, `esc()`, `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `groupPunchesIntoShifts`, `analyzeDayPunches`. A fix in one (API URL rotation, `esc()` improvement, payroll logic) must be mirrored in the other.
- Push notifications: both subscribe via `savePushSubscription`; `service-worker.js` handles `push`/`notificationclick`.

## Troubleshooting

### A tenant's phone / deductions file number prints without its leading zero on Form 101

`createUser`/`updateTenant` already guard against this for new writes (see Backend section above). If it's still happening, the cell is **pre-existing data** written before that guard existed, or via `migrateToMultiTenant()`'s initial tenant row — it's stored as a plain Sheets number and stays broken until rewritten. Fix: Super-admin → Фирмы → edit (pencil) that firm and re-save the phone/deductions field through the normal form; the protected write path fixes it going forward.

### "Deploy Cloud Functions" CI fails with "Missing permissions required for functions deploy" / `iam.serviceAccounts.ActAs`

The `FIREBASE_SERVICE_ACCOUNT` identity needs the **Service Account User** role (`roles/iam.serviceAccountUser`) granted *directly on the runtime service account's own Permissions tab* (not the project's general IAM page) — this is a per-resource grant, `iam.serviceAccounts.actAs`. Needs a human with IAM-admin rights in GCP Console; cannot be done via `gh`/CLI.

This has recurred against more than one service account on this project: first `schedule-odinson@appspot.gserviceaccount.com` (App Engine default), then `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` (Compute Engine default — the actual 2nd-gen Cloud Functions runtime identity, since they run on Cloud Run under the hood). If a *third* service account shows up in a future `actAs` error, grant it the same way — this is a known pattern for first-time 2nd-gen Functions setups on a project, not a misconfiguration. Also needed at various points: Cloud Functions Admin, Service Usage Consumer, Cloud Build Editor, Artifact Registry Writer, Cloud Run Admin, Eventarc Event Receiver (project-level roles, for "API not enabled"/403 errors during early deploy steps).

The workflow's `firebase deploy` command passes `--force` to auto-accept the Artifact Registry cleanup-policy prompt (otherwise fails non-interactively) — unrelated to the actAs errors, but would be the next failure once those are fixed.

Re-run via `gh workflow run "Deploy Cloud Functions" --ref main` after granting a role, or wait for the next push touching `functions/**`.

### "Deploy to Apps Script" CI fails with `invalid_grant` / `invalid_rapt`

Cause: this is a Google Workspace account (`stas@odinson.ltd`), and Workspace periodically forces OAuth re-authentication for the scopes `clasp` uses, invalidating the refresh token in the `CLASP_CREDENTIALS` secret. This re-auth is a real browser login — cannot be scripted in CI.

Fix: run `scripts/refresh-clasp-login.sh` on a machine with a browser. It logs in via the Web OAuth client at `H:\Tokens\Google api.json` (Cloud Console project `schedule-manager-498317`, redirect URI `http://localhost:8085`), pushes the fresh token to the `CLASP_CREDENTIALS` secret via `gh secret set`, then re-triggers via `gh workflow run "Deploy to Apps Script"`.

Note: `clasp login --creds` requires a `redirect_uris` array *inside* the creds JSON itself, or it fails immediately with "Invalid redirect URL" before opening a browser.

`deploy-apps-script.yml` self-detects this failure and opens/updates a GitHub Issue titled "Apps Script deploy failing — clasp token needs refresh" pointing at the fix script — watch for that Issue rather than the Actions tab.
