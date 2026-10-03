# Apps Script backend (`apps-script/Код.js`)

The original backend: a Google Apps Script Web App over one Google Sheet. Since stage 8 it is no longer the main backend ([backend.md](backend.md)), but it is still used for:
- devices switched to `?backend=sheets` (the full fallback);
- files saved to Drive before the switch (`loadWorkerAssets` / `deleteWorkerDoc` with a Drive id);
- the migration source (`exportForMigration`, called by `migrate_from_sheets` and `migrate_files`);
- the Errors / Timings sheets, merged into the Admin panes.

`apps-script/Код.js` is what is deployed (`clasp push && clasp deploy` on a push to `main` touching `apps-script/**`). `google-apps-script.js` at the repo root is an identical copy — keep the two the same. `apps-script/appsscript.json`: timezone Asia/Jerusalem, V8, the web app runs as the deploying user with anonymous access, scopes `spreadsheets`, `script.external_request` (Anthropic), `drive`.

Script Properties (never in the code): `SESSION_SECRET` (signs session tokens; the same value is the `GS_SESSION_SECRET` secret of the `login` function), `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` (default `claude-sonnet-5`) and `ANTHROPIC_ALIGN_MODEL` (default `claude-haiku-4-5-20251001`).

## Requests and auth

- **`GS_URL`** — the deployment URL, hard-coded in `schedule-manager.html`, `worker-punch.html`, `supplier-portal.html`, `functions/main.py` and `functions-auth/main.py`; change them together if it rotates.
- **`API_SECRET`** (`odinson-7Kq2x9`) — a shared key that is public in the page source: a deterrent, not real auth.
- **Session tokens:** stateless `<base64url payload>.<HMAC-SHA256 signature>` with `{userId, username, role, tenantId, permissions, supplierId, exp}`; `SESSION_TTL_MS` = 6 h. `requireAuth(body)` verifies `body.token`, lets a superadmin act on `body.asTenantId`, and issues a fresh token on every request (sliding expiry) — `_withRefreshedToken()` adds `refreshedToken` / `refreshedExpiresAt` to the reply. Failure: "Сессия истекла или недействительна — войдите заново".
- **`requirePermission(auth, section)`** — gates only `staff` logins (their `permissions` must be `'*'` or contain the section); every other role passes.
- **`doPost`** order:
  1. `login` — no auth;
  2. `authFailure`, `logError`, `logTiming`, `logBatch` — only `secret === API_SECRET`, so telemetry works without a session;
  3. the worker-link actions `savePunch`, `updatePunch`, `deletePunch`, `savePushSubscription` with `secret` + `workerToken` → the firm is found by `findTenantIdByWorkerToken()` (scans every firm's workers JSON);
  4. everything else → `requireAuth`.
  
  A thrown `{error}` is returned as the reply.
- **`doGet`**: `ping` (no auth, wakes a cold instance); with `workerToken` the firm comes from the token (no auth object), else `requireAuth`. Actions: `loadSchedule` (default), `loadPunchLog`, `loadErrors`, `loadTimings`, `loadPendingHours`. A `callback` parameter wraps the reply as JSONP (the punch page's fallback).

**Worker-link gap:** with a worker token, `savePunch` does not check that the punch is for that token's worker, and `updatePunch` / `deletePunch` can change any punch of the firm by id. The Firestore `punch` function accepts only `load` / `savePunch` for its own worker.

## Sheets

| Sheet | Content |
|---|---|
| `Users` | `USERS_HEADERS`: `id, username, passwordHash, passwordSalt, role, tenantId, active, createdAt, permissions, supplierId`. Password = SHA-256 hex of `password + ':' + salt` |
| `Tenants` | `tenantId, companyName, deductionsFileNumber, phone, street, streetNumber, city, createdAt`, plus `driveFolderId` (added on first Drive use). Written as text (`setNumberFormat('@')`) so phone and deductions numbers keep leading zeros |
| `Schedule` | one row per firm, `SCHEDULE_HEADERS`: `TenantId, workers (JSON), clients (JSON), weekStart, savedAt, suppliers (JSON), workerCount, clientCount` |
| `Avatars_<t>` | `WorkerId, Avatar` — worker photos kept out of the workers cell |
| `PunchLog_<t>` | `PUNCH_HEADERS`: `ID, WorkerID, Worker, Type (IN/OUT), Time, Date (dd/MM/yyyy), Timestamp, Site, Distance(m), GPS Accuracy(m), GPS Suspicious (YES/NO), GPS Warnings ('; '), Notes, EditedAt, ClientID, TenantId`; rows colored green/red |
| `PunchLogArchive_<t>` | punches older than a year, same columns |
| `PunchLog` | the legacy shared punch sheet — no longer read or written, kept as a safety net |
| `PendingHours_<t>` | `RowId, BatchId, WorkerId, ClientId, Date, InTime, OutTime, UploadedBy, UploadedAt, FileName, Status` |
| `Backups` | `When, TenantId, Workers, Clients, Suppliers, Schedule JSON` — daily, 30 rows kept per firm |
| `Errors` | `When, Page, Role, Worker, Message, Source, Stack` — last 500 |
| `Timings` | `When, Kind, TotalMs, TenantId, User, Role, Details` — last 2000 |
| `PushSubscriptions` | `WorkerName, Role, Endpoint, P256dh, Auth, SavedAt, TenantId` |

`Salary` and `Clients` constants still exist but nothing uses those sheets.

## Schedule (workers, clients, suppliers)

- **`readScheduleMap(sh, t)`** finds the firm's row by the TenantId column and reads only that row (a bad JSON cell reads as `[]`).
- **`loadSchedule(t, auth)`** — clients through `normalizeClients()` (`lat` / `lng` numbers or null, `radius` a positive number, default 100). Photos are merged back from `Avatars_<t>` (`_mergeAvatars`) only for a logged-in caller — a worker link gets none. A supplier caller gets the stripped view ([supplier-portal.md](supplier-portal.md)).
- **`saveSchedule(data, baseSavedAt, t, auth)`**:
  - `requirePermission(auth, 'schedule')`;
  - **empty-payload guard:** no workers and no clients coming in while the sheet has some → `{skipped:true}`, nothing written;
  - **conflict:** `baseSavedAt` differs from the stored `savedAt` → `{conflict:true, serverSavedAt}`;
  - photos are split out (`_splitAvatars`; a photo over 49,000 characters is dropped) and synced to `Avatars_<t>` only when the set changed (`_syncAvatars`);
  - a workers, clients or suppliers JSON over 45,000 characters → `{tooLarge:true}` (a Sheets cell holds ~50,000);
  - written by `_writeScheduleRow()` (also used by the supplier actions), which sets `savedAt` and the two counts; returns `{ok, savedAt}`.
- **Backups:** `backupNow()` (trigger from `setupDailyBackup()`, ~02:00 daily) appends a row per firm. `restoreBackupRow(rowNum)` (manual) is **broken**: it reads the 5th column (the suppliers count) as the JSON and passes JSON strings as arrays.

## Punches

- `savePunch(entry, t)` appends a row; a missing `date` is filled from `ts` (Asia/Jerusalem).
- `loadPunchLog(filter, t, auth, sheetName?)` reads the firm's live sheet (or the archive for the migration). Rows are filtered by worker name / type / supplier's workers **before** mapping, `filter.date` after. A supplier gets only `id, workerId, workerName, type, time, date, ts, site, clientId`.
- `updatePunch` (type, time, site, notes, clientId, sets EditedAt), `deletePunch` — by id in the firm's live sheet.
- `deletePunchesByMonths({months})` — `tenant_admin` / `superadmin`; removes the months (by `Date`, else `Timestamp`) from the live and archive sheets, rewriting each in one pass.
- **Archive:** `archiveOldPunchesAllTenants()` (weekly trigger from `setupPunchArchiveTrigger()`, ~03:00) moves rows older than a year from every `PunchLog_*` to `PunchLogArchive_*`. So the Sheets-mode app loads about the last 12 months.

## Users and firms

Same rules as the Firestore versions in `functions-auth/core.py` ([backend.md](backend.md)):
- `login` — lower-cased username; an inactive row → "Аккаунт отключён"; role `'tenant'` → `tenant_admin`; empty permissions → `'*'`. The reply carries `tenantProfile`, and for a superadmin also `tenants` (the Firms list).
- `createUser` — superadmin; a new firm (Tenants row) and its `tenant_admin`.
- `listUsers`, `createTenantUser` (staff/supplier only), `updateUser`, `resetUserPassword`, `deleteUser` — superadmin or the firm's `tenant_admin`; never touch a `tenant_admin` / `superadmin` row.
- `updateTenant` (also renames the firm's Drive folder), `loadTenantProfile`, `listTenants` (reads only the TenantId, savedAt and count columns of Schedule; an older row without counts is parsed once), `setTenantActive` (the firm's users' `active`), `deleteTenant` (Tenants and Users rows, the Schedule row, the firm's Avatars / PunchLog / archive sheets, legacy punch rows, push rows, and **trashes the firm's Drive folder**).
- Firestore mode answers all of these from `users_admin`; Apps Script only serves a `?backend=sheets` device.

## Hours-import queue

- `savePendingHoursBatch` — refused for a supplier; rows with status `pending`.
- `loadPendingHours` — batches grouped by `BatchId`; refused for a supplier.
- `approvePendingHours` / `rejectPendingHours` — `requirePendingHoursApprover()` (`tenant_admin` / `superadmin`). Approve calls `savePunch()` for an IN and, when there is an out time, an OUT per row, with `notes: 'Imported from <file>'` and no GPS fields, then marks the rows `approved`. Only `pending` rows are touched, so approving twice creates nothing.

## AI actions

All call the Anthropic Messages API with `ANTHROPIC_API_KEY`, return JSON or `{error}` ("AI вернул нечитаемый ответ"; "Ответ ИИ обрезан лимитом max_tokens" when `stop_reason` is `max_tokens`). How the app uses them: [scan.md](scan.md).

| Action | Model | `max_tokens` | Returns |
|---|---|---|---|
| `aiReadDoc` | `ANTHROPIC_MODEL` | 8000 | passport or Israeli ID fields, `fieldBoxes`, `photoBox`, `children`, `spouse`; system prompt cached |
| `aiReadSefach` | `ANTHROPIC_MODEL` | 4500 | an extra Israeli page: address, house number, city, marital status, sex, spouse, children, idNo |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` | 200 | `{kind, rotate (0/90/180/270), corners {tl,tr,br,bl} as fractions}` |
| `aiVerifyField` | `ANTHROPIC_MODEL` | 50 | one zoomed field (`digits9`, `date`, `passportNo`); empty when unreadable |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | 200 | several fields in one call: `{values:{field:value}}` |
| `aiReadHoursTable` | `ANTHROPIC_MODEL` | 4000 | `{entries:[{date, inTime, outTime}]}` from a timesheet photo; refused for a supplier |

The Israeli and passport rules are in two shared strings, `IL_ID_FIELD_MAP` and `PASSPORT_FIELD_MAP` (page kinds A/B/C and the old laminated card's fixed field order, joined ID groups, Gregorian dates only, holder vs spouse vs child numbers, the MRZ cross-check). **After editing any prompt here, regenerate `functions-auth/ai_prompts.json`** (`node tests/auth/apps_script_ai.js prompts > functions-auth/ai_prompts.json`) — `tests/auth/test_ai.py` fails otherwise.

## Drive files

Folder: `Schedule manager APP/<company name>/Workers` (`_companyFolder()` — found by the cached `driveFolderId`, else by name with the tenant id as the folder description; restored from the trash if needed), with `Assets` and `Documents` subfolders.

- `saveWorkerDoc` — the Form 101 PDF into `Workers`, shared "anyone with the link"; trashes `previousFileId`, files of the same name, and other files with the same document number (`extractDocNumberFromFileName` = the longest run of 5+ digits; found with `searchFiles`). Returns `{ok, url, id}`.
- `saveWorkerAssets` — the scan sidecar JSON into `Assets` (not shared), with the same replace/dedupe.
- `saveWorkerFile` — a worker document into `Documents`, shared by link; `requirePermission(auth, 'workers')`.
- `loadWorkerAssets` / `deleteWorkerDoc` — only a file inside the firm's own folders (`_fileBelongsToTenant`).

## Telemetry

- `logError` — a row in `Errors`; `logTiming` — a row in `Timings`; `logBatch` — up to 60 items in one write per sheet (`_appendCapped`).
- `authFailure` — logs a client-seen "session expired" with the reason the token was rejected (`_tokenRejectReason`: missing, malformed, bad-signature, expired N min ago, valid-now) — never the token itself.
- `loadErrors` (last 100) and `loadTimings` (last 500) — superadmin only (the sheets mix every firm).

## Migration export (`exportForMigration`, superadmin)

- `part:'meta'` — every Users row (with hashes), every Tenants row, the firm ids in Schedule.
- `part:'tenant'` — one firm: workers (photos merged), clients, suppliers, weekStart, savedAt, live and archived punches, pending-hours batches (dates as `dd/MM/yyyy`, times `HH:mm`).
- `part:'file'` — one Drive file of that firm as `{name, mimeType, b64}`; `{missing:true}` when it is gone.

Read-only — nothing here writes to the sheets.

## Leftovers and one-time functions

- `checkShiftReminders()` — an empty stub so an old hourly trigger ends at once; delete that trigger in the Apps Script editor.
- `savePushSubscription` — stores subscriptions; nothing sends pushes.
- One-time / manual (safe to re-run): `migrateToMultiTenant`, `migratePunchLogToPerTenantSheets`, `migrateUsersAddPermissionsColumns`, `migrateAddClientIdColumn`, `fixPunchLogHeaderDrift`, `fixGpsAccuracyHeaderLabel`, `backfillOfficeAClientId`, `formatPunchLogSheet`.

## Troubleshooting

- **"Deploy to Apps Script" fails with `invalid_grant` / `invalid_rapt`:** the Workspace account periodically forces OAuth re-login, which invalidates the refresh token in the `CLASP_CREDENTIALS` secret. Fix on a machine with a browser: `scripts/refresh-clasp-login.sh` (logs in through the Web OAuth client, sets the secret with `gh secret set`, re-runs the workflow). `clasp login --creds` needs a `redirect_uris` array inside the creds JSON. The workflow opens an Issue "Apps Script deploy failing — clasp token needs refresh".
- **A firm's phone or deductions number prints without its leading zero:** an old Tenants cell stored as a number. Re-save it through Admin → Firms → edit. (The Firestore migration warns about such phones.)
