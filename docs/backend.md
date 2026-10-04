# Backend: Firestore, Storage and Cloud Functions

The whole backend: the browser data layer, the Cloud Functions, the data model, the security rules, tests and deploys. There is no other backend — the old Google Apps Script / Google Sheets one was removed (2026-10-03; its code is in git history before that date, and the spreadsheet itself is left untouched as an archive). The plan the move followed: [firestore-plan.md](firestore-plan.md).

Project `schedule-odinson`; Firestore and the `functions-auth` functions in **europe-west3** (Frankfurt); the `functions/` functions in us-central1.

## Data model (Firestore)

| Path | Content | Written by |
|---|---|---|
| `tenants/{t}` | firm profile: `companyName, deductionsFileNumber, phone, street, streetNumber, city`, `createdAt`, `active`, `workerCount`, `clientCount` | `users_admin`; a `tenant_admin` may update only the profile fields |
| `tenants/{t}/workers/{id}` | the worker object exactly as the app keeps it, plus `sortIndex` (list position); `hrId` = the HR login it belongs to | the app (`saveSchedule`), the `supplier` function |
| `tenants/{t}/clients/{id}`, `…/suppliers/{id}` | same, with `sortIndex` | the app |
| `tenants/{t}/settings/schedule` | `weekStart`, `savedAt` — copied from the sheets by the old migration; nothing writes it now | — |
| `tenants/{t}/punches/{id}` | a punch ([accounting.md](accounting.md) → the punch) with `ts` as a Timestamp, `day` (`yyyy-MM-dd`), `archived`, `hrId` (the worker's HR, when it has one); `tsRaw` when a migrated sheet timestamp was unreadable | the app, the `punch` function, an approved hours batch |
| `tenants/{t}/pendingHours/{batchId}` | `{status, fileName, uploadedBy, createdBy, uploadedAt, createdAt, rows:[{rowId, workerId, clientId, date, inTime, outTime}]}` | the app |
| `users/{uid}` | `username, tenantId, role, permissions ('*' or list), supplierId, active, createdAt, fullName` (the person's name the app shows), `phone`; for `hr` also `ownOnly` | functions only |
| `authSecrets/{uid}` | `algo ('scrypt', or 'sha256' until the user's next login), salt, hash, failCount, lastFailAt` | functions only |
| `usernames/{name}` | `{uid}` — keeps usernames unique | functions only |
| `workerTokens/{token}` | left over from the migration; nothing reads or writes it (the `punch` function finds a token by a collection-group query on `workers.token`) | — |
| `pushSubscriptions/{sha256(endpoint)}` | a worker's push subscription | `punch` |
| `errors/{auto}`, `timings/{auto}` | telemetry rows (`when, page, role, worker, message, source, stack` / `when, kind, totalMs, tenantId, user, role, details`) | any signed-in caller; login refusals by `login` |

Indexes (`firestore.indexes.json`): punches `workerId + ts` and `hrId + ts` (an own-workers HR's punch queries); pendingHours `status + createdAt desc`; a single-field override on `workers.token` with collection-group scope (needed by `punch`).

**Storage:** `tenants/<t>/workers/<workerId>/{form101|assets|docs}/<ms>-<name>`. The object path is the file id kept on the worker (`docFileId`, `assetsFileId`, `docs[].fileId`); the PDF and documents also get a download URL (`docUrl`, `docs[].url`), the sidecar does not.

## Browser data layer (`firestore-backend.js`)

Loaded by `loadFirestoreBackend()` in the manager app and the supplier portal (the punch page talks only to the `punch` function). One global, `initFirestoreBackend()`:

- imports the Firebase SDK `FB_VERSION` 12.19.0 (app, auth, firestore, storage) from gstatic;
- web config from Hosting's `/__/firebase/init.json`, or `window.FIREBASE_WEB_CONFIG`;
- `localStorage.fsEmulator` = a host → Firestore 8080, Auth 9099, Storage 9199 (tests);
- waits for `auth.authStateReady()`.

An own-workers HR login (claims `role:'hr'`, `own:true`, read once per sign-in by `myClaims()`) may only read its own workers and their punches, and the rules check the query: `hrOnly()` gives its uid, and every read of workers, punches and pending hours then adds `where('hrId'|'createdBy', '==', uid)`. `saveSchedule` skips clients / suppliers for an HR without that section (`mayWrite`).

It returns:

| Function | What it does |
|---|---|
| `login(username, password)` | `login` function → `signInWithCustomToken`; returns the function's reply |
| `currentUser()`, `idToken()`, `signOut()` | `signOut` also stops the punch listener |
| `loadSchedule(t, track=true)` | workers (an own-workers HR: only its own), clients, suppliers (sorted by `sortIndex`, then id) and settings. Remembers each document's signature (`sig()`, key-order independent, plus the position) as the reference for the next save; `track=false` (another firm) does not |
| `saveSchedule(t, data)` | writes only documents whose signature or position changed, deletes the ones that are gone, in batches of 450. Reloads first if the reference belongs to another firm |
| `listenPunches(t, onChange, since)` | `onSnapshot` on punches with `ts ≥ since`; resolves with the first snapshot, every later snapshot (this device's own writes included) goes to `onChange`. Without `since`: 13 months back |
| `punchesBetween(t, from, to)` | one read of `[from, to)` |
| `punchesOfBatch(t, batchId)` | punches with ids starting `imp-<batchId>-` |
| `savePunch` / `updatePunch` / `deletePunch` | `savePunch` stamps the worker's current `hrId` (`punchDoc`, from the last load/save — `workerHr`); `updatePunch` writes only `type, time, site, notes, clientId` and `editedAt` |
| `uploadWorkerFile(t, body, onProgress)` | `saveWorkerDoc` → `form101/`, `saveWorkerAssets` → `assets/` (a JSON `{scanB64, scanMediaType, sigPng, extraPages}`), `saveWorkerFile` → `docs/`; `uploadBytesResumable` with real byte progress; returns `{ok, id: path, url}` (no url for the sidecar); an own-workers HR's files carry `hrId` in their metadata |
| `handleAction(action, params, ctx)` | answers one named data action (below) with a JSON reply, or `null` when there is no such action |

**`handleAction`** — the manager app's `fetch(API_URL, …)` dispatcher calls it ([app-core.md](app-core.md) → Data calls). `ctx` is `{role, username, tenantId}`; the firm is `params.asTenantId || ctx.tenantId`.

- `logBatch` / `logError` / `logTiming` → `errors` / `timings` documents (max 60 per batch, fields clipped); before the Firebase sign-in → `{ok:false, skipped:true}`.
- Any other action before the sign-in → the session-expired error.
- Users and firms (`listTenants, setTenantActive, deleteTenant, createUser, updateTenant, loadTenantProfile, listUsers, createTenantUser, updateUser, resetUserPassword, deleteUser, checkWorkerDoc, updateMyName`) → `users_admin` with the ID token.
- The AI actions (`aiReadDoc, aiReadSefach, aiDetectAlign, aiVerifyField, aiVerifyFields, aiReadHoursTable, aiFindField`) → `ai_read`.
- `loadWorkerAssets` / `deleteWorkerDoc` → `users_admin` for a `tenants/…` id. Any other id: delete answers `{ok:true}` (nothing of ours to delete), load answers "Файл не найден".
- `loadErrors` / `loadTimings` — super-admin only, newest first. With `from` / `to` (ISO times; the panes' period picker) only that period, up to 2000 errors / 5000 timings; without them the newest 100 / 500.
- `loadSchedule` / `loadPunchLog` for another firm (super-admin summary): `loadSchedule(t, false)`; punches from the 1st of this month minus 7 days (`punchesOnce`).
- `deletePunchesByMonths` — `tenant_admin` / `superadmin` only; per month, punches with `day` in the month plus punches without `day` whose `ts` is in it.
- `setPunchesHr` (`{workerIds, hrId}`) — owner / super-admin only: sets (or clears) `hrId` on every punch of those workers.
- Hours queue: `savePendingHoursBatch` (refused for a supplier), `loadPendingHours` (all batches; an own-workers HR only its own), `approvePendingHours` (approver only; for every row an IN and an OUT punch, with the worker's `hrId`, `imp-<batch>-<row>-in|out` with `notes: 'Imported from <file>'` and the batch status in **one** batch write, so approving twice creates nothing new), `rejectPendingHours`.

## Cloud Functions — `functions-auth/` (codebase `auth`, europe-west3)

A separate codebase so a login never loads OpenCV/PyMuPDF. `main.py` holds the HTTP wrappers (CORS `*`, POST only, the body parsed with `force=True`); the logic is in `core.py`, `files.py`, `portal.py` and `ai.py`. Each function returns JSON, errors as `{error}` (Russian texts where the app shows them).

| Function | Auth | Module | Notes |
|---|---|---|---|
| `login` | none | `core.login` | 30 s; `min_instances=0` (no standing cost; the login screen's `{ping:true}` wakes it while the user types, but after a long idle the first login can still wait for a cold start) |
| `users_admin` | `Bearer <ID token>`, checked with `check_revoked` | `core.run_action`, `files.run` | a superadmin's firm = `asTenantId`; after `deleteTenant` also `files.delete_tenant_files` |
| `punch` | the worker link token | `portal.punch_action` | 30 s; `{ping:true}` |
| `supplier` | `Bearer <ID token>` of a supplier | `portal.supplier_action` | |
| `ai_read` | `Bearer <ID token>`, role superadmin/tenant_admin/staff/hr | `ai.run` | 300 s, 512 MB, 1 CPU, up to 20 requests at once per instance (a scan's parallel calls share one warm instance); secret `ANTHROPIC_API_KEY`; `{ping:true}` |

Minting custom tokens needs the runtime service account to hold "Service Account Token Creator".

### `core.py` — login, users, firms

- **Login:** username lower-cased → `usernames/{name}` → `users/{uid}` + `authSecrets/{uid}`.
  - An inactive user gets "Аккаунт отключён".
  - 5 wrong passwords in a row lock the account for 5 minutes ("Слишком много неверных попыток — подождите N мин."); the counter restarts after the window.
  - A user who has not logged in since the move still has the old `sha256` hash (SHA-256 of `password + ':' + salt`); it is replaced by scrypt (N=2¹⁴, r=8, p=1) on the first good login.
  - Every refusal is written to `errors` with its reason (`on_refused`) — never the password or hash; the user only sees "Неверный логин или пароль".
  - The reply: `{ok, token (custom token), uid, username, role, tenantId, permissions, supplierId, tenantProfile, ownOnly, fullName}`.
  - Custom-token claims (`claims_for`): `role` (`'tenant'` normalized to `tenant_admin`), `perms` (`['*']`, a list, or `[]` for a supplier), `tenantId`, `supplierId`; for `hr` also `own` ("only own workers", true unless `ownOnly` is false).
- **Users** (superadmin: any firm; `tenant_admin`: own firm only):
  - `listUsers` — never returns hashes;
  - `createTenantUser` — role `staff`, `hr` or `supplier` only, password ≥ 8, a supplier needs `supplierId`, stores `fullName` and `phone` for every role; an HR needs `fullName` (also stores `ownOnly` default true; permissions default `['workers']`); the `usernames` doc is created in the same batch, so a taken name fails the whole batch ("Такой логин уже существует");
  - `updateUser` (`permissions`, `supplierId`, `active`; `fullName` / `phone` for every role, which alone don't revoke — an HR's name can't be emptied; for HR `ownOnly`), `resetUserPassword`, `deleteUser` — refuse a `tenant_admin` / `superadmin` target and another firm's user; each revokes the user's Firebase sessions (delete removes the Auth user).
- **`updateMyName`** (`{fullName}`, any signed-in user, owner and super-admin included): sets the caller's own `fullName`; an HR's can't be empty.
- **`checkWorkerDoc`** (superadmin, tenant_admin, staff, hr; `{docId, workerId?}`): is a worker with this document number (`docId`, `passportNo` or `israeliId`, compared on letters and digits only) already in the caller's firm, other than `workerId` — `{ok, exists}`, nothing else, so an own-workers HR learns no other worker's data.
- **Firms** (superadmin): `createUser` (a new firm + its `tenant_admin`, whose `fullName` is `ownerName`; profile strings stay strings, so no leading-zero loss), `listTenants` (profile, active, worker/client counts by aggregation, `savedAt`), `setTenantActive` (the firm and all its users; deactivation revokes their sessions), `deleteTenant` (recursive delete of `tenants/{t}`, its users, secrets and usernames; `main.py` then deletes every Storage object under `tenants/<t>/` and reports `removed.files`). `updateTenant` — superadmin or the firm's own `tenant_admin`. `loadTenantProfile`.

### `files.py` — reading and deleting Storage files

`users_admin` actions `loadWorkerAssets` and `deleteWorkerDoc` with `{fileId: <storage path>}`:
- manager roles (and `hr`) only; the path must be under `tenants/<caller's firm>/workers/` (no `..`, no `//`);
- an own-workers HR only for a worker whose `hrId` is its uid (`worker_hr(wid)` reads the worker in `main.py`);
- delete needs superadmin, `tenant_admin`, or staff / hr with `workers`;
- `loadWorkerAssets` returns `{ok, scanB64, scanMediaType, sigPng, extraPages}`.

`delete_tenant_files(bucket, tenantId)` deletes everything under `tenants/<tenantId>/` (refuses an empty id or one with `/`).

Uploads do not go through here: the browser writes to Storage directly (`uploadWorkerFile`), and `storage.rules` decide. Reading through a function avoids having to set CORS on the bucket.

### `portal.py` — worker link and supplier portal

See [punch.md](punch.md) and [supplier-portal.md](supplier-portal.md) for the pages.

- **`punch`:** the token is looked up by a collection-group query on `workers.token`; none or two matches → "Unknown worker link".
  - `load` → `{workers:[{id, name, colorIdx, token, clientIds}], clients:[{id, name, object, lat, lng, radius}]}` — only this worker and their sites.
  - `savePunch` — only for this worker; type `in`/`out`; the punch id may not contain `/`; an existing document of another worker is never overwritten. Stored fields: `workerName, type, time, date, site, dist, gpsAccuracy, gpsSuspicious, gpsWarnings (≤20, clipped), notes, clientId`, plus `id, workerId, ts, day, archived:false`, and `hrId` from the worker document (never from the page). `day` comes from `date` (`dd/MM/yyyy`) when sent, otherwise from `ts` in Israel time (the punch page sends no date). `set()`, so a re-sent punch is the same document. The page's `lat`/`lng`/`gpsVerified`… are not kept.
  - `savePushSubscription`, `logError` (no token needed).
- **`supplier`:** role `supplier` with `tenantId` and `supplierId` in the claims, else "Только для роли поставщика".
  - `loadSchedule` → own workers through `strip_worker` (the `SUPPLIER_WORKER_FIELDS` allow-list + `supplierRate`; never a wage, the worker's punch-link token or a file link), clients as `{id, name, object}`, `suppliers: []`;
  - `loadPunchLog` → own workers' punches of the last 13 months with `id, workerId, workerName, type, time, date, site, clientId, ts` (`workerId in` queries of 30);
  - `supplierAddWorker` / `supplierUpdateWorker` / `supplierDeleteWorker` with the `SUPPLIER_EDITABLE` list ([supplier-portal.md](supplier-portal.md)).

### `ai.py` — `ai_read`

The seven AI actions: the Anthropic request for each, the reply handling and the result shape the scan code expects ([scan.md](scan.md)).

| Action | Model | `max_tokens` | Returns |
|---|---|---|---|
| `aiReadDoc` | `ANTHROPIC_MODEL` | 8000 | passport or Israeli ID fields, `fieldBoxes`, `photoBox`, `children`, `spouse`; `latinSurname` / `latinGiven` and `mrzName` for the name cross-check; an Israeli passport comes back as `israeli_id` (Hebrew names, `idNo`, `passportNo`); system prompt cached |
| `aiReadSefach` | `ANTHROPIC_MODEL` | 3000 | an extra Israeli page: address, house number, city, marital status, sex, spouse, children, idNo and the holder's given / surname (cross-checks), `fieldBoxes` of address / house number / city |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` | 400 | `{kind, rotate (0/90/180/270), corners {tl,tr,br,bl} as fractions}` |
| `aiVerifyField` | `ANTHROPIC_MODEL` | 50 | one zoomed field (`digits9`, `date`, `passportNo`); empty when unreadable |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | 400 | several fields in one call: `{values:{field:value}}`; kinds `digits9`, `date`, `passportNo`, `hebrewText`, `latinName`, `houseNumber` (`verifyFieldsKind`; `verifyField` has the same kinds for the single re-read) |
| `aiReadHoursTable` | `ANTHROPIC_MODEL` | 4000 | `{entries:[{date, inTime, outTime}]}` from a timesheet photo |
| `aiFindField` | `ANTHROPIC_MODEL` | 300 | `{found:{value, page, box}}` for one `field`, or `{found:{key:{value, page, box}}}` for `fields` (several in one request, `findFields` prompt; `max_tokens` 300 + 150 per extra field) — searched by key and `docType` on up to 4 page photos (`images:[{image, mediaType}]`); label and hint come from `ai_prompts.json` `findFieldFields`, never from the caller; `value` is empty when not found |

- Models: env `ANTHROPIC_MODEL` (default `claude-sonnet-5`) and `ANTHROPIC_ALIGN_MODEL` (default `claude-haiku-4-5-20251001`). Errors: "AI вернул нечитаемый ответ"; "Ответ ИИ обрезан лимитом max_tokens" when `stop_reason` is `max_tokens` and nothing could be kept. A `aiReadDoc` / `aiReadSefach` answer cut at `max_tokens` is salvaged first (`_salvage_object`: the longest prefix ending after a complete value, open brackets closed) and returned as `{ok, parsed, truncated:true}` — the fields that came in full (address, spouse, the children listed so far) are kept; `readSefachPage` notes it in Admin → Errors. Both prompts ask for filled-in children only, each once (an old ספח's empty table rows had made the answer run to the limit).
- Retries: a busy reply (HTTP 429 or 5xx, an `overloaded_error` / `rate_limit_error` / `api_error` body) or a network error is sent again after 1.5 s, then 4 s (`RETRY_PAUSES`); the third answer is returned as is. Each Anthropic request times out after 90 s. The `ai_read` function timeout is 300 s.
- **Prompts** live in `functions-auth/ai_prompts.json` — edit them there. The Israeli and passport rules (page kinds A/B/C and the old laminated card's fixed field order, joined ID groups, Gregorian dates only, holder vs spouse vs child numbers, the MRZ cross-check) are in `readDoc` / `readSefach`.
- **Tests:** `tests/auth/test_ai.py` compares every request and result with `tests/auth/ai_golden.json`, recorded from the original Apps Script actions. A prompt edit therefore fails `test_same_request` until the golden file is updated for the new prompt.

## Parallel AI calls — the pattern

How a feature that sends several AI requests is built, on both ends. Follow it for any new one.

**Client (the page).** Every request that does not need another one's answer is started at once, and the code waits only where a later step really needs a result:

| Where | Sent in parallel |
|---|---|
| `processAllPendingPages` (`scan-pipeline.js`) | Phase 1: `aiDetectAlign` + `preprocess_scan` for every queued page (`Promise.all`); the early `aiReadDoc` of the first page as cropped, alongside Phase 1; the ספח `aiReadSefach` (`prefetchSefachFrom`) while the front page's digits are re-checked; the zoom batches (`aiVerifyFields`), one per page |
| `findScanFields` (`schedule-manager.html`) | one `aiFindField` batch per page |
| hours import | `aiReadHoursTable` per page of every file |
| uploads | `fileToUploadPages` / `fileForStorage` and `uploadWorkerFile` per file |

Rules:
- one request = one page or one batch of fields; requests share no state, and results are merged afterwards in page order, so the outcome is the same as the sequential order;
- parallel sending changes only the time, never the number of AI calls (an ID front + ספח read cleanly = 6 calls);
- a failed request fails alone (`aiDetectAlign` leaves the page as cropped, a failed ספח read is logged); busy replies are retried on the server (`RETRY_PAUSES`).

**Server (the function).** `ai_read` is declared so that one warm instance serves all of a scan's parallel requests:

| Setting | Value | Why |
|---|---|---|
| `cpu` | 1 | a full CPU; the default third of one makes a cold start and the image work slow |
| `concurrency` | 20 | up to 20 requests in one instance. With the default (1) every parallel call started an instance of its own, and a cold one cost 5–20 s. The requests mostly wait on Anthropic, so 20 fit; a scan sends up to ~6 at a time |
| `memory` | 512 MB | |
| `timeout_sec` | 300 | a slow reply plus the retries |
| `min_instances` | 0 | an idle function costs nothing; the first call of the day may still start cold |

Conditions for `concurrency` > 1: requests run in threads of one process, so a handler keeps no per-request state in globals, and a shared object is created once under a lock (`_db()` with `threading.Lock`). A new function that receives parallel calls copies these settings and conditions.

**Proposing it.** When new work brings a similar case (several independent AI or server calls, sent one after another, or a function that will receive parallel calls), the pattern is proposed to the user in chat first — what would run at once, which function settings — and applied once they agree.

## Cloud Functions — `functions/` (codebase `default`, us-central1)

- `fill_form_101` — builds the Form 101 PDF ([form101.md](form101.md)).
- `preprocess_scan` — contrast/sharpness enhancement and the blur check ([scan.md](scan.md)). Its classical-CV auto-crop (`_find_document_quad` / `_warp_quad`) is defined but dormant.

Both answer `{"ping":true}` at once (warm-up) and parse the body with `force=True`. `functions/venv` must exist before `firebase deploy --only functions` from a local machine (`python -m venv venv && pip install -r requirements.txt`); CI builds its own. `functions/assets/` holds the PDF template and font the function uses.

## Security rules

**`firestore.rules`** — identities come from the custom-token claims.
- `manager(t)` = superadmin, or a `tenant_admin` / `staff` of firm `t`, or an `hr` of firm `t` without `own` (`hrAll`). A supplier never reads Firestore directly (wages and GPS can't be hidden field by field) — it goes through `supplier`.
- HR (`isHr`, `hrMine` = with `own`, `hrAll` = without, `hrCan(t, section)`): workers are written by an HR with `workers` or `schedule`; `hrMine` only reads, updates and deletes workers whose `hrId` is its uid and creates them only with its own `hrId`; `hrAll` may create with no `hrId` or its own; **no HR changes a worker's `hrId`**. `hrMine` reads / writes punches whose `hrId` is its uid, reads its own pendingHours (`createdBy`). Any HR reads the firm doc, clients, suppliers and settings; clients / suppliers are written with the `clients` / `suppliers` section.
- `tenants/{t}`: read by managers; update by a superadmin, or by its `tenant_admin` touching only the profile fields; create/delete superadmin.
- workers, clients, suppliers, settings: read by managers; write by superadmin, `tenant_admin`, or staff with `schedule` — so a staff login without `schedule` gets `gsSave()` → false.
- punches: read and write by any manager of the firm.
- pendingHours: read by managers; create (managers and any HR) only as `status:'pending'` with `createdBy` = the caller; update/delete only superadmin or `tenant_admin`.
- `users/{uid}`: read by the user, a superadmin, or that firm's `tenant_admin`; never written by clients. `authSecrets`, `usernames`, `workerTokens`, `pushSubscriptions`: functions only.
- `errors`, `timings`: create by anyone signed in, read by a superadmin.

**`storage.rules`** — `tenants/{t}/**`: read by managers of the firm (`hrAll` included); create/update by superadmin, `tenant_admin`, or staff / hr with `workers`; delete by those, except an own-workers HR (it deletes through `users_admin`); files under 25 MB. An own-workers HR must put its uid in the file's `hrId` metadata and reads back only files carrying it.

## Tests

- **Rules:** `tests/rules/rules.test.mjs` on the Firestore + Storage emulators — `cd tests/rules && npm install && npm test`.
- **Functions:** `tests/auth/test_core.py`, `test_portal.py`, `test_ai.py`, `test_files.py` (in-memory bucket) on the Firestore + Auth emulators — `cd tests/rules && PYTHON=<python with firebase-admin and pytest> npm run test:auth`.

## Deploys (push to `main`)

| Workflow | Runs on | Does |
|---|---|---|
| `deploy.yml` | every push to `main` | Firebase Hosting (live channel) |
| `deploy-functions.yml` | `functions/**`, `functions-auth/**`, `tests/auth/**`, or manual | builds both venvs, runs `tests/auth` on the emulators (a failure stops the deploy), `firebase deploy --only functions --force` (`--force` also deletes deployed functions that are no longer in the code); on failure opens/updates a GitHub Issue |
| `deploy-rules.yml` | `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `tests/rules/**`, or manual | rules tests, then deploys rules, indexes and storage; on failure opens an Issue (usual causes: the service account lacks Firebase Rules Admin / Cloud Datastore Index Admin, or Storage is not enabled) |

`firebase.json`: both codebases pinned to `python312`; Hosting rewrites `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`; the Hosting `ignore` list must keep `functions/**` (otherwise the venv is uploaded as public files), `functions-auth/**`, `tests/**`, the rules files, `*.md` and `docs/**`. HTML and all `.js` files, and the routes `/`, `/punch`, `/supplier`, are served `no-cache`. When `service-worker.js` changes, bump its `CACHE` version (now `schedule-mgr-v106`).

### Known deploy failures

- **"Missing permissions required for functions deploy" / `iam.serviceAccounts.ActAs`** — the `FIREBASE_SERVICE_ACCOUNT` identity needs **Service Account User** granted on the runtime service account's own Permissions tab (it happened for both `schedule-odinson@appspot.gserviceaccount.com` and `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`; grant a new one the same way). Early deploy steps also needed Cloud Functions Admin, Service Usage Consumer, Cloud Build Editor, Artifact Registry Writer, Cloud Run Admin, Eventarc Event Receiver. Needs a human with IAM rights in the GCP Console. `--force` in the workflow accepts the Artifact Registry cleanup-policy prompt.
- Re-run after a fix: run the workflow manually, or push a change under its paths.
