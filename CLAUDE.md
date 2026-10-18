# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It describes **only the current state**. History, debugging trails and finished plans live in `archive/` (see below) — don't add narrative here.

**Session language:** the user communicates in Russian. Claude's own conversational output (explanations, status updates, questions) should be in Russian throughout — independent of what language the app's UI/code is in.

**UI text language:** all new user-facing UI text (tab labels, buttons, messages) must be in English. Most of the existing app is Hebrew (`lang="he"`); the `Бухгалтерия` (Accounting) tab is a Russian pocket added by mistake — don't repeat that. Existing Hebrew/Russian text doesn't need retranslating unless asked.

## What this is

A staff scheduling, payroll & GPS punch-clock PWA, served as static files from Firebase Hosting. No build step, no bundler, no package.json, no test suite — pages are self-contained HTML files with inline `<style>`/`<script>`.

**Stack:**
- **Frontend:** vanilla JS, static HTML on Firebase Hosting (project `schedule-odinson`). SheetJS (CDN) for Excel.
- **Backend / DB:** Google Apps Script web app (`apps-script/Код.js`) over a Google Sheet; Google Drive for worker documents.
- **Cloud Functions (Python 3.12, `functions/main.py`):** `fill_form_101` (PyMuPDF), `preprocess_scan` (OpenCV/Pillow), `gs_upload_proxy` (CORS relay to Apps Script).
- **AI:** Anthropic API, called only from Apps Script (`aiReadDoc` etc.).
- **CI/CD:** GitHub Actions on push to `main`.

**Multi-tenant:** a super-admin creates "firms" (tenants), each with its own login and isolated data (schedule, punches, Drive docs). Roles: `superadmin`, `tenant_admin`, `staff`, `supplier` (see Backend).

### Files

- `schedule-manager.html` — the manager/admin app (shifts, workers, clients, suppliers, payroll, exports, admin). RTL Hebrew, ~6000 lines.
- `scan-pipeline.js` — document-scanning pipeline (corner editor, alignment, OCR orchestration, field verification). Lazy-loaded by `ensureScanPipelineLoaded()` into `schedule-manager.html`'s global scope on first scan; entry points `startNewScan()` / `rescanWorkerDoc(workerId)` live in the HTML file and call `openAiScan()` after load.
- `worker-punch.html` — worker clock-in/out app, opened via a per-worker tokenized link (`/punch?t=<token>`).
- `supplier-portal.html` — supplier/agency app at `/supplier`; deliberately a separate, lighter file (see its section).
- `service-worker.js` — PWA offline shell (network-first, cache fallback). Never intercepts `script.google.com`.
- `manifest.json` / `manifest-punch.json` — PWA manifests.
- `apps-script/Код.js` — **the** backend source (deployed by CI). `apps-script/appsscript.json` (timezone, OAuth scopes `spreadsheets`, `script.external_request`, `drive`), `apps-script/.clasp.json`.
- `functions/` — Cloud Functions. `functions/assets/` holds `form101_fillable.pdf` + `heebo-hebrew.ttf`, the only copies used (single source of truth). Needs a local `venv/` (gitignored) for a manual `firebase deploy --only functions`: `python -m venv venv && pip install -r requirements.txt` inside `functions/`.
- `form101-field-map.md` — field-by-field map of the Form 101 template and how `main.py` fills each field. **Update it whenever `main.py`'s field handling or the template changes.**
- `scripts/refresh-clasp-login.sh` — re-auth helper for the Apps Script deploy (see Troubleshooting).
- `archive/` — not deployed (`firebase.json` ignores it). `HISTORY.md` (narrative/debugging history — add new multi-attempt stories here), `MULTI_TENANT_PLAN.md` (finished multi-tenant design doc), `CLAUDE-full-2026-10-02.md` (the previous, long version of this file with per-stage verification notes), `form101-field-map-pdflib-era.md`, and retired duplicates (`google-apps-script.js` — old mirror of `Код.js`; root copies of the PDF template/font).

## Commands

No npm/build/lint/test tooling — edit the HTML and reload.

- Local preview: `firebase emulators:start --only hosting`, or open the HTML files directly.
- Routing (`firebase.json`): `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`.
- `firebase.json` hosting `ignore` must keep `functions/**` (else `functions/venv` gets uploaded) and `archive/**`.
- **Deploy = merge to `main`.** GitHub Actions:
  - `deploy.yml` — Firebase Hosting, every push to `main`.
  - `deploy-apps-script.yml` — `clasp push --force && clasp deploy` on changes to `apps-script/**` (secrets `CLASP_CREDENTIALS`, `CLASP_DEPLOYMENT_ID`). Opens an Issue on failure.
  - `deploy-functions.yml` — on changes to `functions/**` or manual dispatch; builds a fresh venv; runtime pinned to `python312`. Opens an Issue on failure.
- When changing any cached file, bump `CACHE` in `service-worker.js` or clients keep stale HTML. Current: **v75**.

### Git workflow (enforced by hooks in `.claude/settings.json`)

- **`My_Work_Befor_PR`** is the standing work branch — use it instead of `main`; don't create ad-hoc branches per session (unless the session is told to use a specific branch).
- A `PostToolUse` hook auto-commits and pushes every file edit to the current branch (only when the session was started in this repo).
- A `PreToolUse` hook blocks force-pushes and any push to/while on `main`.
- A `SessionStart` hook injects `git status --short` + current branch.
- A `PostToolUse` hook on `gh pr create*` syncs this file / `archive/HISTORY.md` with the PR's diff.
- **"Deploy" means:** open one PR from the work branch into `main` covering everything since the last one, then merge it. **Never merge without asking the user first.**

## Architecture

### Backend: Google Apps Script (`apps-script/Код.js`)

All pages call the same web-app endpoint (`GS_URL`, hardcoded near the top of each page's `<script>`) with a shared `API_SECRET`, plus a session token (`gsAuth()` for POST bodies / `gsAuthQuery()` for GET queries in `schedule-manager.html`).

**Punch-link (worker token) access** is deliberately narrow: POST only `savePunch` / `savePushSubscription` (`WORKER_ACTIONS`; `savePunch` forces `workerId`/`workerName` to the token's owner via `_findWorkerByToken()`), GET only `loadSchedule`, which then returns just that worker (`id,name,token,clientIds,colorIdx`) and its own clients — never other workers, tokens, wages or billing.

**Auth & sessions:** HMAC-signed tokens (`SESSION_SECRET` in Script Properties), 6h TTL. `requireAuth()` re-reads the user's `Users` row on every request (`_loadLiveUser()`), so deactivation/deletion and role/permission/`supplierId` changes apply immediately. Sessions are **sliding** — `requireAuth()` reissues a token on every authenticated request (`refreshedToken`/`refreshedExpiresAt` via `_withRefreshedToken()`), picked up client-side by `applyRefreshedToken()`. The client's `window.fetch` wrapper detects the exact `SESSION_EXPIRED_ERROR` text, retries (`SESSION_RETRY_DELAYS_MS`), reports to `authFailure`, and only then logs out.

**Roles & permissions:** `Users` rows (`USERS_HEADERS`) carry `role`, `permissions` (JSON array of `workers, clients, suppliers, schedule, accounting, exports`, or `'*'`; missing = `'*'`) and `supplierId`. Legacy role `'tenant'` is normalized to `'tenant_admin'` at login. `requirePermission(auth, section)` gates only `staff`; every other role bypasses it. `saveSchedule` requires `'schedule'`. `requirePendingHoursApprover(auth)` allows only `tenant_admin`/`superadmin`.

**Supplier-role data filtering:** for `auth.role==='supplier'`, `loadSchedule`/`loadPunchLog` build responses from allow-lists so forbidden data is never serialized: `_stripWorkerForSupplier()` (own workers only; no wage fields; `supplierRates` replaced by a single flat `supplierRate`), `_stripClientForSupplier()` (`{id,name,object}` only), empty `suppliers`, punches reduced to `id/workerId/workerName/type/time/date/site/clientId`. Other roles get unmodified data. In `doPost()`, a supplier session may call only `SUPPLIER_ACTIONS` (`supplierAddWorker`, `supplierUpdateWorker`, `supplierDeleteWorker`, `logError`) — everything else is rejected up front. Suppliers edit workers only through `supplierAddWorker`/`supplierUpdateWorker`/`supplierDeleteWorker` (scoped by `auth.supplierId`, field allow-list `_supplierWorkerAllowedFields()`), never `saveSchedule`.

**GET actions:** `loadSchedule`, `loadPunchLog` (optional worker/date/type filters), `loadPendingHours`, `loadErrors` (superadmin only — the `Errors` sheet has no tenant column).

**POST actions** (all need `API_SECRET`; all but `login`/`authFailure` need a session):
- Auth/tenants: `login`, `createUser` (superadmin; new firm + `tenant_admin` owner), `updateTenant` (superadmin or the firm's `tenant_admin`), `loadTenantProfile`, `listTenants`, `setTenantActive`, `deleteTenant`. Phone/deductions-file fields are written with `setNumberFormat('@')` **before** `setValue()` to keep leading zeros.
- Users under a firm (superadmin any firm, `tenant_admin` own firm): `listUsers` (never returns hashes), `createTenantUser` (`staff`/`supplier` only), `updateUser`, `resetUserPassword`, `deleteUser` (the last two/three refuse `tenant_admin`/`superadmin` rows and cross-tenant edits).
- Schedule/punches: `saveSchedule` (optimistic concurrency via `baseSavedAt`; `clients.radius` coerced to number; every JSON cell guarded by `CELL_SAFE_LIMIT = 45000` → `{error, tooLarge:true}`), `savePunch`, `updatePunch`, `deletePunch`, `savePushSubscription`.
- AI (Anthropic, paid): `aiReadDoc` (main OCR; `ANTHROPIC_MODEL`, accuracy-first; returns fields + `fieldBoxes`, `photoBox`, `imageAlign`, `children`), `aiDetectAlign` (corners only, cheap `ANTHROPIC_ALIGN_MODEL`), `aiVerifyField` / `aiVerifyFields` (single / batched zoomed digit re-read), `aiReadSefach` (Israeli ID appendix), `aiReadHoursTable` (timesheet image → `{entries:[{date,inTime,outTime}]}`, never writes anything; blocked for suppliers).
- Hours-import approval queue (anti-fraud: imported hours never reach payroll without approval; suppliers blocked from all four): `savePendingHoursBatch` → `PendingHours_<tenantId>` rows with `status:'pending'` (written as plain text so Sheets doesn't turn dates/times into Dates; readers use `_cellText()` for older rows); `approvePendingHours` / `rejectPendingHours` (approver only). Approval writes IN+OUT through the normal `savePunch()` with `Notes = 'Imported ' + filename` and no GPS fields; re-approving is a no-op.
- Drive: `saveWorkerDoc` (Form 101 PDF into `Schedule manager APP/<CompanyName>/Workers`, deduped by the document number in the filename via `extractDocNumberFromFileName()` + `folder.searchFiles`; `previousFileId` trashes the old file only if it belongs to the caller's firm), `deleteWorkerDoc`, `saveWorkerAssets` / `loadWorkerAssets` (private JSON sidecar in `Workers/Assets` with raw scan, signature and extra pages, for regeneration without rescanning). Delete/load require `tenantId` and check `_fileBelongsToTenant()`.
- Telemetry: `logError`; `authFailure` (deliberately unauthenticated — reports session rejections to the `Errors` sheet).

**Sheets:** `Schedule` (one row per tenant: `SCHEDULE_HEADERS = TenantId, workers, clients, weekStart, savedAt, suppliers` — JSON blobs; `suppliers` is last for backward compat and defaults to `[]`), `PunchLog_<tenantId>` (one per firm; `_punchSheetName()`), `PunchLogArchive_<tenantId>` (punches older than ~12 months, moved weekly by `archiveOldPunchesAllTenants()`), `PendingHours_<tenantId>`, `Users`, `Tenants`, `Clients`, `PushSubscriptions`, `Backups` (daily snapshot incl. suppliers/weekStart; `restoreBackupRow(rowNum)` restores one row from the editor), `Errors` (last 500). The legacy shared `PunchLog` sheet is no longer read/written (kept as a safety net; `deleteTenant()` still cleans it for old tenants).

**Triggers / maintenance (run once manually from the editor):** `setupDailyBackup()`, `setupHourlyTrigger()` (shift-reminder pushes via `checkShiftReminders()`), `setupPunchArchiveTrigger()`. One-time, re-runnable migrations: `migrateToMultiTenant()`, `migrateUsersAddPermissionsColumns()`, `migratePunchLogToPerTenantSheets()`, plus a few schema-fix helpers.

### Cloud Functions (`functions/main.py`)

- `fill_form_101` — builds the Form 101 PDF from the client's JSON payload. PyMuPDF has no RTL shaping: Hebrew fields are blanked and redrawn via `python-bidi` (`set_hebrew()`); comb/LTR fields use PyMuPDF's own appearance. Checkboxes get a hand-drawn blue checkmark. `FIELD_RECT_NUDGES` holds per-field position tweaks. Signature is drawn at `SIG_RECT`; scan pages are appended as extra pages. Images are shrunk only here (`_shrink_for_embed()`, `EMBED_DPI=150`) — OCR already ran on full resolution upstream. Output via `doc.tobytes(garbage=4, deflate=True, deflate_images=True, clean=True)`. Full field map: `form101-field-map.md`.
- `preprocess_scan` — contrast/sharpness enhancement + blur check (`BLUR_VARIANCE_THRESHOLD`, Laplacian variance, measured after enhancement — raise it if blurry scans start passing). Its classical-CV auto-crop (`_find_document_quad`/`_warp_quad`) is dormant; cropping happens client-side.
- `gs_upload_proxy` — relays a JSON POST to `GS_URL` server-to-server and returns the response unchanged. Exists because a browser XHR with an `xhr.upload` listener always triggers a CORS preflight, which Apps Script (no `doOptions`) can't answer. All three functions parse bodies with `req.get_json(silent=True, force=True)` — the client may send `text/plain`.

### Client-side (`schedule-manager.html`)

- **State:** globals `workers`, `clients`, `suppliers`, `weekStart` + UI state; no framework — mutate, then `render()` (refreshes the Schedule pieces and whichever tab is open, `currentTab`).
- **Persistence:** Google Sheets is the source of truth; `localStorage` (`STORAGE_KEY()` → `schedMgr_v1_<tenantId>`, mirrored to legacy `schedMgr_v1` for `worker-punch.html`'s same-device bridge) is a cache/offline fallback. `loadData()` renders cache, then the server response. `autoSave()` debounces 800ms and refuses to persist an accidentally emptied `workers`/`clients` array.
- **Uploads:** `xhrPostJSON(url, body, onProgress)` posts `saveWorkerDoc`/`saveWorkerAssets` to `GS_UPLOAD_PROXY_URL` with real byte progress. It only attaches `xhr.upload.onprogress` when `onProgress` is passed, and only sets `Content-Type: application/json` for the proxy URL — **never add a Content-Type header or an upload listener to a request going straight to `GS_URL`** (forces a preflight Apps Script can't answer). Same session-expiry retry logic as the fetch wrapper.
- **XSS:** `esc(s)` escapes `&<>"'`; every `${...}` interpolating data into HTML must use it. Keep the `esc()` copies in all pages identical.
- **Payroll math — canonical, never reimplement:**
  - `groupPunchesIntoShifts(entries)` pairs a worker's whole punch history into shifts across midnight.
  - `analyzeDayPunches(entries, date)` pairs one day and flags anomalies.
  - `effectiveRates(w, clientId)`: `w.clientRates[clientId]` → client `defaultHourlyRate`/`defaultOtRate`/`defaultShabbatRate` → worker base rate.
  - `shiftPay(hours, w, isSat, clientId)` applies Israeli labour-law tiers via `israeliDayPay()` (8h ×1.0, 2h ×1.25, rest ×1.5; Saturday ×1.5/×1.75/×2.0) unless a flat OT/Shabbat override is set. Don't simplify.
- **Billing vs pay (separate figures, never mixed into `effectiveRates()`/`shiftPay()`):**
  - Supplier commission: flat ₪/h, `SUPPLIER_DEFAULT_RATE = 5`, override `w.supplierRates[supplierId].rate`, resolved by `supplierCommissionRate()`.
  - Client billing: `client.rateMode` `'tiered'` (law tiers off the client's `defaultHourlyRate`) or `'fixed'` (`fixedBillRate × hours`), via `clientBillPay()`.
  - Worker travel allowance: `w.travelAllowance` ₪ per worked day, shown as its own column added on top of wages.
- **Accounting tab** (`#sectionAccounting`, `renderAccounting()`): `renderSalary()` (sets `__lastSalaryEntries`, `__lastClientBillEntries`), `renderRateMatrix()`/`setClientRateOverride()`, `renderSupplierRateMatrix()`/`setSupplierRateOverride()` (commission only), `renderSupplierPayable()` (re-groups salary hours by supplier × commission; sets `__lastSupplierPayableRows`), `renderClientBillable()` (must never show supplier data — Client↔Supplier isolation), `renderPendingHours()` (Approve/Reject only for `tenant_admin`/`superadmin`; approving re-syncs punches via `syncPunchesFromGS()` before re-rendering salary).
- **Today tab** (`renderDashboard()`): On Site Now, Should Be Here, workers-by-supplier (`renderDashSuppliers()`), contract-expiry warnings (`workerExpiryStatus(w)`), Today's Log. Never gated.
- **Suppliers:** tenant-scoped entity (`name, color, phone, notes, bank, bankBranch, accountNumber, companyNumber`), Suppliers tab mirrors the Clients tab. A worker has at most one `supplierId` (but many `clientIds`). `deleteSupplier()` clears `w.supplierId`/`w.supplierRates[sid]`. Clients also have `companyNumber`. Workers list has client/supplier filters and group-by; exports (`exportPunchCSV`, `exportSalaryCSV`, Excel Statistics sheet) include a Supplier column.
- **Nav gating:** `hasPermission(section)` + `NAV_TAB_PERMISSION` + `applyNavPermissions()` hide tabs from `staff` logins (the Admin tab rides on `workers`). Visibility only — real enforcement is server-side.
- **Admin tab** (`#sectionAdmin`): sub-panes via `setupAdminPaneBar()` (runs from `switchTab()`, not `render()`) / `switchAdminPane()`: Punch Log (always), Users (`tenant_admin`+), Profile (`tenant_admin`+), Firms + Errors (superadmin). Firms pane includes the cross-firm payable summary (`renderSuperadminAccounting()`, fetches per firm with an explicit `asTenantId` without switching firms). Users pane: `renderAdminUsers()` scoped to the active firm (`activeTenantIdForAdmin()`), shared create/edit modal `#userFormOverlay`. Firm create/edit share one modal (`editFirmOverlay`, `__firmFormMode`). The Admin tab icon turns amber when the firm profile is incomplete (`firmProfileMissing()`).
- **Hours import:** worker card → `openHoursImportModal(workerId)`; Excel/CSV parsed client-side (`parseHoursExcelFile()`, headers `Date/In/Out`, also Russian `Дата/Вход/Выход`), images via `aiReadHoursTable` (`parseHoursImageFile()`; multi-page PDFs not supported); `submitHoursImportBatch()` → `savePendingHoursBatch`.
- **Shift exports:** `getWorkerMonthShifts()`, `exportShiftsDetail()` (worker card "Export hours"), `exportPayableSummary(rows)` (renders caller-computed rows; never recomputes). "PDF" = a print-ready page via `window.print()`.
- **Other exports:** `exportExcel` (SheetJS), `exportPDF`, `exportJSON`, `exportSalaryCSV`, `exportPunchCSV`.
- **Punches** store `clientId` (not just a site name) so history survives renames; resolve with `punchSite(e)`/`punchClientObject(e)`/`workerClientName(id)`. Admin punch log filters by IDs, not names.
- **Errors pane:** last ~100 `Errors` rows (`loadErrorsList(targetId)`), per-row copy button (`copyErrorRow()`). Superadmin only.

#### Worker modal (`showWorkerModal()`) and worker card (`openWorkerCard()`)

One screen for manual add, edit, and post-scan review. Check the template for field order.

- `w.name` = `docGiven + ' ' + docSurname`, derived on save; for older records with only `name`, the split fields are pre-filled on open (else the "name required" guard silently blocks saving).
- `__wDocType` → `commonFields.docType` on save (keeps foreign passports from being relabeled `israeli_id`).
- Supplier `<select>` (`wSupplierId`) and a collapsible bank section (`bank, bankBranch, bankAccountNumber`, `toggleBankWrap()`), plus `travelAllowance`.
- **Every save regenerates the Form 101 PDF** (`saveWorker()`):
  - new worker or rescan (`window.__aiRescannedWorkerId`) → blocking `autoUploadWithRetry()` with progress overlay, using the live scan; a rescan with no new extra pages carries the old sidecar's `extraPages` forward (`loadWorkerAssets`).
  - plain edit → background `regenerateWorkerDoc()` from the Drive sidecar, only if a field in `FORM101_WATCHED_FIELDS` changed.
  - `aiFillForm101()` uploads `saveWorkerDoc` and `saveWorkerAssets` concurrently; progress is combined by total bytes.
- Duplicate guard on create: `docId` vs every worker's `workerDocId()`.
- Deleting a worker trashes their Drive PDF and sidecar (best-effort).
- `isValidIsraeliId()` is a pure checksum; `verifyDigitFields()`/`verifyIdChecksum()` re-read failing digit fields via AI; a still-failing checksum shows an amber warning.
- Worker card: flat icon+text rows; address includes `houseNumber`; Objects/Rates block at the bottom, supplier row, buttons "Upload hours" / "Export hours".

#### AI document scan flow (`scan-pipeline.js`)

`onScanFileSelected` → manual corner editor (`renderScanQuadEditor`/`initScanQuad`/`attachQuadDrag`, 4 corner handles + 4 edge handles) → `confirmScanQuad()` warps via `warpQuadImage()` (≤1568px) → page queued (`window.__pendingScanPages`) → `processAllPendingPages()` runs each page through:
1. `autoPreAlignScan()` — `aiDetectAlign` corners → `refineQuadCorners()` (local gradient search, first qualifying peak outward) → warp, skipped when near-identity (`_isNearIdentityQuad()`).
2. `preAlignScan()` → `preprocess_scan` (enhance + blur check).
3. `aiReadDoc` → `verifyDigitFields()`/`verifyIdChecksum()` → merge pages (`mergeIsraeliIdFields`/`mergeScanPage`/`rebuildPrimaryFromPages`).
4. `finalTightenPass()` — per-side edge trim (`_scanSideEdge()`).

→ `renderScanPagesPrompt()` → `openWorkerModalFromScan()`. Multi-file uploads (`onScanFilesSelected`) skip the corner editor. `renderScanProgress()` shows sub-step progress. `_preAlignThenOcr()`/`runOcr()` are dormant. Before touching alignment thresholds read `archive/HISTORY.md` — many variants were tried and reverted.

### worker-punch.html

- `?t=<token>` opens that worker directly; otherwise a worker picker.
- `getLastEntry()` uses the most recent punch across all days to choose IN vs OUT.
- `openHistory()` pairs punches into shifts before grouping by date (overnight shifts stay whole).
- GPS anti-spoofing (`analyseGps`/`getLocation`): zero/low accuracy, impossible speed, suspiciously instant fixes.
- Offline-safe: `doPunch()` writes local `punchLog` and queues failed sends in `punchQueue`; `flushQueue()` keeps entries queued while it was sending.
- Remembers the link token in `localStorage.punchToken` and reuses it when launched as an installed PWA (manifest `start_url` has no `?t=`). Caches its own scoped data under `punchApp_cache_v1` (never the manager's `schedMgr_v1`).

### supplier-portal.html

Separate file so the manager app's rate/GPS code is never even loaded for a supplier (server-side stripping is the real boundary). Own session key `supplierPortal_session`.
- `submitLogin()` rejects any non-`supplier` role.
- Data from the same `loadSchedule`/`loadPunchLog` (already stripped server-side); a rejected session returns to the login screen, a network error shows Retry.
- My Workers: manual add/edit/delete via the three `supplier*Worker` actions (no AI scan here).
- My Hours: local copies of `getWorkerMonthShifts()`/`exportShiftsDetail()`/`exportPayableSummary()`; tariff is always the flat commission.
- Mini dashboard: on-site now, worker count, today's log.
- No hours import, no rate fields, no GPS data — by design.

### Shared conventions

- No modules/imports — global functions in one inline `<script>` per page.
- Pages **duplicate** helpers on purpose (no shared build): `GS_URL`/`API_SECRET`, `esc()`, `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `groupPunchesIntoShifts`, `analyzeDayPunches`. A fix in one must be mirrored in the others.
- Push notifications: `savePushSubscription`; `service-worker.js` handles `push`/`notificationclick`.
- Standing rule: a client never gets its own login, and no client-facing surface may contain supplier data (and vice versa — suppliers never see client billing).

## Troubleshooting

### Leading zero missing on a firm's phone / deductions number in Form 101
Pre-existing cell written before the `setNumberFormat('@')` guard (or by `migrateToMultiTenant()`). Fix: Admin → Firms → edit that firm and re-save the field.

### Document upload fails with "network error" or a session error
Check that nothing added a `Content-Type` header or an `xhr.upload` listener to a request going directly to `GS_URL` (CORS preflight — Apps Script has no `doOptions`), and that `gs_upload_proxy` still parses with `force=True`. Session rejections are logged to the `Errors` sheet as `source=authFailure` with the failing action.

### Spurious logout during the OCR burst (open)
A kick-out while `aiReadDoc`/`aiDetectAlign`/`aiVerifyField(s)` run (direct `GS_URL` calls) is still unexplained. On recurrence, check `authFailure` rows: which action failed and whether it recovered on retry.

### "Deploy Cloud Functions" fails with `iam.serviceAccounts.ActAs`
The `FIREBASE_SERVICE_ACCOUNT` identity needs **Service Account User** granted on the runtime service account's own Permissions tab (seen for both `schedule-odinson@appspot.gserviceaccount.com` and `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`). Also needed at times: Cloud Functions Admin, Service Usage Consumer, Cloud Build Editor, Artifact Registry Writer, Cloud Run Admin, Eventarc Event Receiver. Requires a human with IAM-admin rights. Re-run: `gh workflow run "Deploy Cloud Functions" --ref main`.

### "Deploy to Apps Script" fails with `invalid_grant` / `invalid_rapt`
Google Workspace (`stas@odinson.ltd`) forced OAuth re-auth, invalidating `CLASP_CREDENTIALS`. Run `scripts/refresh-clasp-login.sh` on a machine with a browser (Web OAuth client from Cloud project `schedule-manager-498317`, redirect `http://localhost:8085`; the creds JSON must contain `redirect_uris`). It updates the secret and re-triggers the workflow. The workflow opens an Issue "Apps Script deploy failing — clasp token needs refresh" when this happens.
