# Backend: Firestore, Storage and Cloud Functions

Since stage 8 every device runs on Firestore unless switched back with `?backend=sheets` (see [app-core.md](app-core.md) → backend switch). This file covers the Firebase side: the browser data layer, the Cloud Functions, the data model, the security rules, tests and deploys. The Apps Script side (still the Sheets fallback, the migration source and the store of pre-switch Drive files) is in [apps-script.md](apps-script.md). The plan and its decisions: [firestore-plan.md](firestore-plan.md).

Project `schedule-odinson`; Firestore and the `functions-auth` functions in **europe-west3** (Frankfurt); the `functions/` functions in us-central1.

## Data model (Firestore)

| Path | Content | Written by |
|---|---|---|
| `tenants/{t}` | firm profile: `companyName, deductionsFileNumber, phone, street, streetNumber, city`, `createdAt`, `active`, `workerCount`, `clientCount` | `users_admin`, migration; a `tenant_admin` may update only the profile fields |
| `tenants/{t}/workers/{id}` | the worker object exactly as the app keeps it, plus `sortIndex` (list position) | the app (`saveSchedule`) |
| `tenants/{t}/clients/{id}`, `…/suppliers/{id}` | same, with `sortIndex` | the app |
| `tenants/{t}/settings/schedule` | `weekStart`, `savedAt` | migration |
| `tenants/{t}/punches/{id}` | a punch ([accounting.md](accounting.md) → the punch) with `ts` as a Timestamp, `day` (`yyyy-MM-dd` or null), `archived`; `tsRaw` when the sheet timestamp was unreadable | the app, the `punch` function, an approved hours batch |
| `tenants/{t}/pendingHours/{batchId}` | `{status, fileName, uploadedBy, createdBy, uploadedAt, createdAt, rows:[{rowId, workerId, clientId, date, inTime, outTime}]}` | the app |
| `users/{uid}` | `username, tenantId, role, permissions ('*' or list), supplierId, active, createdAt` | functions only |
| `authSecrets/{uid}` | `algo ('scrypt' or 'sha256'), salt, hash, sheetHash, failCount, lastFailAt` | functions only |
| `usernames/{name}` | `{uid}` — keeps usernames unique | functions only |
| `workerTokens/{token}` | `{tenantId, workerId}` — written by the migration and cleaned up on firm delete; **nothing reads it** (the `punch` function finds a token by a collection-group query on `workers.token`) | migration |
| `pushSubscriptions/{sha256(endpoint)}` | a worker's push subscription | `punch` |
| `errors/{auto}`, `timings/{auto}` | telemetry rows (`when, page, role, worker, message, source, stack` / `when, kind, totalMs, tenantId, user, role, details`) | any signed-in caller; login refusals by `login` |

Indexes (`firestore.indexes.json`): punches `workerId + ts`; pendingHours `status + createdAt desc`; a single-field override on `workers.token` with collection-group scope (needed by `punch`).

**Storage:** `tenants/<t>/workers/<workerId>/{form101|assets|docs}/<ms>-<name>`. The object path is the file id kept on the worker (`docFileId`, `assetsFileId`, `docs[].fileId`); the PDF and documents also get a download URL (`docUrl`, `docs[].url`), the sidecar does not. Any file id that does not start with `tenants/` is a Drive id and goes to Apps Script.

## Browser data layer (`firestore-backend.js`)

Loaded by `loadFirestoreBackend()` in each page that needs it (manager app, supplier portal; the punch page does not use it). One global, `initFirestoreBackend()`:

- imports the Firebase SDK `FB_VERSION` 12.19.0 (app, auth, firestore, storage) from gstatic;
- web config from Hosting's `/__/firebase/init.json`, or `window.FIREBASE_WEB_CONFIG`;
- `localStorage.fsEmulator` = a host → Firestore 8080, Auth 9099, Storage 9199 (tests);
- waits for `auth.authStateReady()`.

It returns:

| Function | What it does |
|---|---|
| `login(username, password)` | `login` function → `signInWithCustomToken`; returns the function's reply |
| `currentUser()`, `idToken()`, `signOut()` | `signOut` also stops the punch listener |
| `loadSchedule(t, track=true)` | workers, clients, suppliers (sorted by `sortIndex`, then id) and settings. Remembers each document's signature (`sig()`, key-order independent, plus the position) as the reference for the next save; `track=false` (another firm) does not |
| `saveSchedule(t, data)` | writes only documents whose signature or position changed, deletes the ones that are gone, in batches of 450. Reloads first if the reference belongs to another firm |
| `listenPunches(t, onChange, since)` | `onSnapshot` on punches with `ts ≥ since`; resolves with the first snapshot, every later snapshot (this device's own writes included) goes to `onChange`. Without `since`: 13 months back |
| `punchesBetween(t, from, to)` | one read of `[from, to)` |
| `punchesOfBatch(t, batchId)` | punches with ids starting `imp-<batchId>-` |
| `savePunch` / `updatePunch` / `deletePunch` | `updatePunch` writes only `type, time, site, notes, clientId` and `editedAt` |
| `uploadWorkerFile(t, body, onProgress)` | `saveWorkerDoc` → `form101/`, `saveWorkerAssets` → `assets/` (a JSON `{scanB64, scanMediaType, sigPng, extraPages}`), `saveWorkerFile` → `docs/`; `uploadBytesResumable` with real byte progress; returns `{ok, id: path, url}` (no url for the sidecar) |
| `handleAction(action, params, ctx, gsFetch)` | answers an Apps Script action in Apps Script's own JSON shape, or `null` to leave it to Apps Script (below) |

**`handleAction`** — the manager app's fetch wrapper sends the actions in its `FS_ACTIONS` list here (see [app-core.md](app-core.md)). The firm is `params.asTenantId || ctx.tenantId`.

- `logBatch` / `logError` / `logTiming` → `errors` / `timings` documents (max 60 per batch, fields clipped); `null` before sign-in, so they fall back to Apps Script.
- Users and firms (`listTenants, setTenantActive, deleteTenant, createUser, updateTenant, loadTenantProfile, listUsers, createTenantUser, updateUser, resetUserPassword, deleteUser`) → `users_admin` with the ID token.
- The AI actions (`aiReadDoc, aiReadSefach, aiDetectAlign, aiVerifyField, aiVerifyFields, aiReadHoursTable`) → `ai_read`.
- `loadWorkerAssets` / `deleteWorkerDoc` → `users_admin` for a `tenants/…` id, else `null` (Apps Script, Drive).
- `loadErrors` (100) / `loadTimings` (500) — super-admin only: Firestore rows merged with the Apps Script sheet rows (`gsFetch`, given up after 8 s), newest first.
- `loadSchedule` / `loadPunchLog` for another firm (super-admin summary): `loadSchedule(t, false)`; punches from the 1st of this month minus 7 days (`punchesOnce`).
- `deletePunchesByMonths` — `tenant_admin` / `superadmin` only; per month, punches with `day` in the month plus punches without `day` whose `ts` is in it.
- Hours queue: `savePendingHoursBatch` (refused for a supplier), `loadPendingHours` (all batches), `approvePendingHours` (approver only; for every row an IN and an OUT punch `imp-<batch>-<row>-in|out` with `notes: 'Imported from <file>'` and the batch status in **one** batch write, so approving twice creates nothing new), `rejectPendingHours`.

## Cloud Functions — `functions-auth/` (codebase `auth`, europe-west3)

A separate codebase so a login never loads OpenCV/PyMuPDF. `main.py` holds the HTTP wrappers (CORS `*`, POST only, the body parsed with `force=True`); the logic is in the other modules. Each function returns JSON, errors as `{error}` (Russian texts where the app shows them).

| Function | Auth | Module | Notes |
|---|---|---|---|
| `login` | none | `core.login` | 30 s; secret `GS_SESSION_SECRET`; `{ping:true}` warms it |
| `users_admin` | `Bearer <ID token>`, checked with `check_revoked` | `core.run_action`, `files.run` | a superadmin's firm = `asTenantId` |
| `migrate_from_sheets` | `{gsToken}` of a super-admin | `migrate.migrate` | 540 s, 1 GB |
| `migrate_files` | `{gsToken}` of a super-admin | `filemove.move_all` | 540 s, 1 GB |
| `punch` | the worker link token | `portal.punch_action` | 30 s; `{ping:true}` |
| `supplier` | `Bearer <ID token>` of a supplier | `portal.supplier_action` | |
| `ai_read` | `Bearer <ID token>`, role superadmin/tenant_admin/staff | `ai.run` | 120 s, 512 MB; secret `ANTHROPIC_API_KEY`; `{ping:true}` |

Minting custom tokens needs the runtime service account to hold "Service Account Token Creator".

### `core.py` — login, users, firms

- **Login:** username lower-cased → `usernames/{name}` → `users/{uid}` + `authSecrets/{uid}`.
  - An inactive user gets "Аккаунт отключён".
  - 5 wrong passwords in a row lock the account for 5 minutes ("Слишком много неверных попыток — подождите N мин."); the counter restarts after the window.
  - A migrated `sha256` hash (SHA-256 of `password + ':' + salt`, Apps Script's) is replaced by scrypt (N=2¹⁴, r=8, p=1) on the first good login.
  - Every refusal is written to `errors` with its reason (`on_refused`) — never the password or hash; the user only sees "Неверный логин или пароль".
  - The reply: `{ok, token (custom token), uid, username, role, tenantId, permissions, supplierId, tenantProfile}` plus `gsToken` / `gsExpiresAt` — an Apps Script session token minted here (`gs_session_token`, the same HMAC-SHA256 `<payload>.<signature>` format and 6 h TTL as Apps Script `createSessionToken`), so a Firestore login never waits for Apps Script.
  - Custom-token claims (`claims_for`): `role` (`'tenant'` normalized to `tenant_admin`), `perms` (`['*']`, a list, or `[]` for a supplier), `tenantId`, `supplierId`.
- **Users** (superadmin: any firm; `tenant_admin`: own firm only):
  - `listUsers` — never returns hashes;
  - `createTenantUser` — role `staff` or `supplier` only, password ≥ 8, a supplier needs `supplierId`; the `usernames` doc is created in the same batch, so a taken name fails the whole batch ("Такой логин уже существует");
  - `updateUser` (`permissions`, `supplierId`, `active`), `resetUserPassword`, `deleteUser` — refuse a `tenant_admin` / `superadmin` target and another firm's user; each revokes the user's Firebase sessions (delete removes the Auth user).
- **Firms** (superadmin): `createUser` (a new firm + its `tenant_admin`; profile strings stay strings, so no leading-zero loss), `listTenants` (profile, active, worker/client counts by aggregation, `savedAt`), `setTenantActive` (the firm and all its users; deactivation revokes their sessions), `deleteTenant` (recursive delete of `tenants/{t}`, its users, secrets, usernames and `workerTokens`). `updateTenant` — superadmin or the firm's own `tenant_admin`. `loadTenantProfile`.
  - `deleteTenant` leaves the firm's Drive folder **and its Storage files** (`tenants/<t>/…` in the bucket) in place.

### `files.py` — reading and deleting Storage files

`users_admin` actions `loadWorkerAssets` and `deleteWorkerDoc` with `{fileId: <storage path>}`:
- manager roles only; the path must be under `tenants/<caller's firm>/workers/` (no `..`, no `//`);
- delete needs superadmin, `tenant_admin`, or staff with `workers`;
- `loadWorkerAssets` returns `{ok, scanB64, scanMediaType, sigPng, extraPages}` like Apps Script.

Uploads do not go through here: the browser writes to Storage directly (`uploadWorkerFile`), and `storage.rules` decide. Reading through a function avoids having to set CORS on the bucket.

### `portal.py` — worker link and supplier portal

See [punch.md](punch.md) and [supplier-portal.md](supplier-portal.md) for the pages.

- **`punch`:** the token is looked up by a collection-group query on `workers.token`; none or two matches → "Unknown worker link".
  - `load` → `{workers:[{id, name, colorIdx, token, clientIds}], clients:[{id, name, object, lat, lng, radius}]}` — only this worker and their sites.
  - `savePunch` — only for this worker; type `in`/`out`; the punch id may not contain `/`; an existing document of another worker is never overwritten. Stored fields: `workerName, type, time, date, site, dist, gpsAccuracy, gpsSuspicious, gpsWarnings (≤20, clipped), notes, clientId`, plus `id, workerId, day, archived:false, ts`. `set()`, so a re-sent punch is the same document. The page's `lat`/`lng`/`gpsVerified`… are not kept.
  - `savePushSubscription`, `logError` (no token needed).
- **`supplier`:** role `supplier` with `tenantId` and `supplierId` in the claims, else "Только для роли поставщика".
  - `loadSchedule` → own workers through `strip_worker` (the allow-list + `supplierRate`), clients as `{id, name, object}`, `suppliers: []`;
  - `loadPunchLog` → own workers' punches of the last 13 months with `id, workerId, workerName, type, time, date, site, clientId, ts` (`workerId in` queries of 30);
  - `supplierAddWorker` / `supplierUpdateWorker` / `supplierDeleteWorker` with the `SUPPLIER_EDITABLE` list; same rules as Apps Script.

### `ai.py` — `ai_read`

A port of the six Apps Script AI actions with the same requests, reply handling and result shapes. The prompt texts are **not** retyped: `ai_prompts.json` is generated from `apps-script/Код.js` by `node tests/auth/apps_script_ai.js prompts > functions-auth/ai_prompts.json` — **regenerate it after editing a prompt in Apps Script.** Models: env `ANTHROPIC_MODEL` (default `claude-sonnet-5`) and `ANTHROPIC_ALIGN_MODEL` (default `claude-haiku-4-5-20251001`). `tests/auth/test_ai.py` runs the real Apps Script code in Node and requires identical requests and results.

### `migrate.py` — Copy to Firestore (`migrate_from_sheets`)

Started from Admin → Firms → "Copy to Firestore" ([admin.md](admin.md)). Reads Apps Script `exportForMigration` (`meta`, then `tenant` per firm, 4 firms in parallel) and **mirrors**: documents keep their sheet ids; Firestore documents the sheets no longer have are deleted, and firms no longer in the sheets are deleted with everything under them. So a re-run never duplicates — and **overwrites anything entered on Firestore since** (hence the REPLACE prompt in the app).
- Users: invalid or duplicate usernames are reported and skipped; `authSecrets` keeps an already-upgraded scrypt hash while the sheet hash (`sheetHash`) is unchanged.
- Workers / clients / suppliers get `sortIndex` = sheet order; an id that can't be a Firestore id, an empty key or a list inside a list is reported, not fatal.
- Punches (live and archived) get `ts` as a Timestamp (or `tsRaw`), `day`, `archived`.
- Pending-hours batches become `pendingHours` documents.
- A phone without its leading zero is reported as a warning.
- The reply is per firm: sheet vs Firestore counts, errors, warnings, `ok`.

### `filemove.py` — Move files to Firebase (`migrate_files`)

Started from Admin → Firms → "Move files to Firebase". For every worker of every firm in Firestore, each file still on Drive (`docFileId` or the id inside `docUrl`, `assetsFileId`, `docs[].fileId`) is fetched through `exportForMigration` part `file` and written to the same Storage path the app uses, with a `firebaseStorageDownloadTokens` download URL; then the worker record points at the copy. 6 files in parallel. Drive is never changed; a Storage id is skipped, so a re-run moves only what is left; a file gone from Drive counts as missing; after 420 s it stops and reports `partial` ("Not finished — run again").

## Cloud Functions — `functions/` (codebase `default`, us-central1)

- `fill_form_101` — builds the Form 101 PDF ([form101.md](form101.md)).
- `preprocess_scan` — contrast/sharpness enhancement and the blur check ([scan.md](scan.md)). Its classical-CV auto-crop (`_find_document_quad` / `_warp_quad`) is dormant; the section comment above it that says "re-enabled" is out of date.
- `gs_upload_proxy` — relays a JSON body to Apps Script server-to-server and returns the reply. It exists because a browser XHR to Apps Script with an upload-progress listener needs a CORS preflight Apps Script cannot answer. Used for Sheets-mode uploads only; Firestore mode uploads to Storage.

All three answer `{"ping":true}` at once (warm-up). `functions/venv` must exist before `firebase deploy --only functions` from a local machine (`python -m venv venv && pip install -r requirements.txt`); CI builds its own. `functions/assets/` holds the PDF template and font the function uses.

## Security rules

**`firestore.rules`** — identities come from the custom-token claims.
- `manager(t)` = superadmin, or a `tenant_admin` / `staff` of firm `t`. A supplier never reads Firestore directly (wages and GPS can't be hidden field by field) — it goes through `supplier`.
- `tenants/{t}`: read by managers; update by a superadmin, or by its `tenant_admin` touching only the profile fields; create/delete superadmin.
- workers, clients, suppliers, settings: read by managers; write by superadmin, `tenant_admin`, or staff with `schedule` — so a staff login without `schedule` gets `gsSave()` → false.
- punches: read and write by any manager of the firm.
- pendingHours: read by managers; create only as `status:'pending'` with `createdBy` = the caller; update/delete only superadmin or `tenant_admin`.
- `users/{uid}`: read by the user, a superadmin, or that firm's `tenant_admin`; never written by clients. `authSecrets`, `usernames`, `workerTokens`, `pushSubscriptions`: functions only.
- `errors`, `timings`: create by anyone signed in, read by a superadmin.

**`storage.rules`** — `tenants/{t}/**`: read by managers of the firm; create/update/delete by superadmin, `tenant_admin`, or staff with `workers`; files under 25 MB.

## Tests

- **Rules:** `tests/rules/rules.test.mjs` on the Firestore + Storage emulators — `cd tests/rules && npm install && npm test`.
- **Functions:** `tests/auth/test_core.py`, `test_migrate.py`, `test_portal.py`, `test_ai.py`, `test_files.py` (in-memory bucket), `test_filemove.py` on the Firestore + Auth emulators — `cd tests/rules && PYTHON=<python with firebase-admin and pytest> npm run test:auth`. The Apps Script session token minted by `login` is checked against the real `verifySessionToken()` of `apps-script/Код.js`, run in Node.

## Deploys (push to `main`)

| Workflow | Runs on | Does |
|---|---|---|
| `deploy.yml` | every push to `main` | Firebase Hosting (live channel) |
| `deploy-functions.yml` | `functions/**`, `functions-auth/**`, `tests/auth/**`, `apps-script/Код.js`, or manual | builds both venvs, runs `tests/auth` on the emulators (a failure stops the deploy), `firebase deploy --only functions --force`; on failure opens/updates a GitHub Issue |
| `deploy-rules.yml` | `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `tests/rules/**`, or manual | rules tests, then deploys rules, indexes and storage; on failure opens an Issue (usual causes: the service account lacks Firebase Rules Admin / Cloud Datastore Index Admin, or Storage is not enabled) |
| `deploy-apps-script.yml` | `apps-script/**`, or manual | `clasp push --force && clasp deploy` ([apps-script.md](apps-script.md)) |

`firebase.json`: both codebases pinned to `python312`; Hosting rewrites `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`; the Hosting `ignore` list must keep `functions/**` (otherwise the venv is uploaded as public files), `functions-auth/**`, `tests/**`, the rules files, `*.md` and `docs/**`. HTML and `service-worker.js` are served `no-cache`. When `service-worker.js` changes, bump its `CACHE` version (now `schedule-mgr-v105`).

### Known deploy failures

- **"Missing permissions required for functions deploy" / `iam.serviceAccounts.ActAs`** — the `FIREBASE_SERVICE_ACCOUNT` identity needs **Service Account User** granted on the runtime service account's own Permissions tab (it happened for both `schedule-odinson@appspot.gserviceaccount.com` and `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`; grant a new one the same way). Early deploy steps also needed Cloud Functions Admin, Service Usage Consumer, Cloud Build Editor, Artifact Registry Writer, Cloud Run Admin, Eventarc Event Receiver. Needs a human with IAM rights in the GCP Console. `--force` in the workflow accepts the Artifact Registry cleanup-policy prompt.
- Re-run after a fix: run the workflow manually, or push a change under its paths.
