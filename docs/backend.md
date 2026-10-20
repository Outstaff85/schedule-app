# Backend: Firestore, Storage and Cloud Functions

The whole backend: the browser data layer, the Cloud Functions, the data model, the security rules, tests and deploys. There is no other backend — the old Google Apps Script / Google Sheets one was removed (2026-10-03; its code is in git history before that date, and the spreadsheet itself is left untouched as an archive). The plan the move followed: [archive/docs/firestore-plan.md](../archive/docs/firestore-plan.md).

Project `schedule-odinson`; Firestore and the `functions-auth` functions in **europe-west3** (Frankfurt); the `functions/` functions in us-central1.

## Data model (Firestore)

| Path | Content | Written by |
|---|---|---|
| `tenants/{t}` | firm profile: `companyName, deductionsFileNumber, phone, street, streetNumber, city`, `createdAt`, `active`, `workerCount`, `clientCount` | `users_admin`; a `tenant_admin` may update only the profile fields |
| `tenants/{t}/workers/{id}` | the worker object exactly as the app keeps it, plus `sortIndex` (list position) and `docKeys` (its document numbers in standard form — `docKeysOf` / `doc_keys`, for `checkWorkerDoc`; not kept in the app's copy); `hrId` = the HR login it belongs to | the app (`saveSchedule`), the `supplier` function |
| `tenants/{t}/clients/{id}`, `…/suppliers/{id}` | same, with `sortIndex`; a supplier may carry `commission` `[{from, mode, rate}]` (its own rate by date) | the app; rules: `commission` changed only by the owner or a superadmin |
| `tenants/{t}/settings/schedule` | `weekStart`, `savedAt` — copied from the sheets by the old migration; nothing writes it now | — |
| `tenants/{t}/punches/{id}` | a punch ([accounting.md](accounting.md) → the punch) with `ts` as a Timestamp, `day` (`yyyy-MM-dd`), `archived`, `hrId` (the worker's HR, when it has one); `tsRaw` when a migrated sheet timestamp was unreadable | the app, the `punch` function, an approved hours batch |
| `tenants/{t}/hourApprovals/{kind}_{ownerId}_{YYYY-MM}` | a client, supplier or HR login's month of hours review: `kind, ownerId, ownerName, month, days` ([hours-review.md](hours-review.md)) | the `hours` function |
| `tenants/{t}/shiftRequests/{id}` | a worker's day they can't work (`u_<worker>_<date>`: `kind:'unavailable', status:'active'`) or their shift of a date offered to a colleague (`s_<worker>_<date>`: `kind:'swap', start, end, toWorkerId, toWorkerName, status:'pending'|'confirmed'|'declined'`, then `decidedAt, decidedBy` (the username), `decidedByUid` (the decider's uid)); always `workerId, workerName, date` (`YYYY-MM-DD`), `createdAt`, `hrId` (the worker's HR), optional `note` (stage 5b, [punch.md](punch.md) → My schedule) | the `punch` function; a manager decides an offer (`decideShiftRequest`) |
| `tenants/{t}/pendingHours/{batchId}` | `{status, fileName, uploadedBy, createdBy, uploadedAt, createdAt, rows:[{rowId, workerId, clientId, date, inTime, outTime}]}` | the app |
| `users/{uid}` | `username, tenantId, role, supplierId, clientId (a client login), active, createdAt, fullName` (the person's name the app shows), `phone`, `language` (the UI language the person last picked: `en` / `he` / `ru`, returned by `login`), `theme` (the look last picked in the account menu: `dark` / `light` / `system`, returned by `login`); for `hr` also `ownOnly`, `commissionRate`, `commissionDayRate` (₪/day for a worker paid by the day); `templateId` (the permission template its role and rights are copied from; none: a login made before templates); `rights` (staff / hr / supplier / client: the flat rights copied from the template, docs/permissions-plan.md) | functions only |
| `permTemplates/{id}` | `name, role` (staff / hr / supplier / client), `rights` (the flat list, only the role's ticks — `RIGHT_CAPS`), `ownOnly` (HR) and `updatedAt`; one set for every firm ([admin.md](admin.md) → Users pane) | functions only |
| `notifReads/{uid}` | `{ids, at}` — the notification ids a manager-side login has read (at most 500; the bell's "Mark all read", [accounting.md](accounting.md) → Today) | the app (`loadNotifReads` / `saveNotifReads` in `firestore-backend.js`); rules: only the login itself, roles superadmin / tenant_admin / staff / hr, keys `ids` + `at` only |
| `tenants/{t}/settings/messages` | `{waTemplate, at}` — the firm's WhatsApp "no punch" template (stage 11a, [admin.md](admin.md) → Firm form) | the app (`loadFirmMessages` / `saveFirmMessages` in `firestore-backend.js`); rules: the `settings` match — read by managers and HR, written by a schedule writer |
| `authSecrets/{uid}` | `algo ('scrypt', or 'sha256' until the user's next login), salt, hash, failCount, lastFailAt` | functions only |
| `usernames/{name}` | `{uid}` — keeps usernames unique | functions only |
| `workerTokens/{token}` | left over from the migration; nothing reads or writes it (the `punch` function finds a token by a collection-group query on `workers.token`) | — |
| `pushSubscriptions/{sha256(endpoint)}` | a worker's push subscription | `punch` |
| `weatherCache/{lat_lng}` | `kind, temp, at` — the weather of an area (lat / lng rounded to 0.1°), kept 30 minutes | `weather` |
| `tenants/{t}/contractTemplates/{id}` | a contract template: `name, category, isDefault, fileId` (its light PDF in Storage), `size, origSize, pages, version, marks, unknown, placed, pictures, workerId` (a worker's own), `signedCount, createdAt, updatedAt, createdBy` ([contracts.md](contracts.md)) | the `contract_templates` function only |
| `tenants/{t}/signRequests/{id}` | a send of Form 101 and the contract to sign: `workerId, hrId, status` (sent → signing → signed; replaced, withdrawn), `way, templateId, templateName, templateVersion, templatePath` (the frozen copy), `placed, values, form101, signDate, dateFixed, sentAt, sentBy, signedAt` (server time), `sigPath, parts {form101, contract}, appliedAt`, `printHash, printPay, printMarks` (what the documents print about the worker — D4) ([contracts.md](contracts.md) → Signing) | the `sign_documents` function only |
| `transferRequests/{id}`, `transferLog/{requestId}` | a firm's request for a worker of another firm (`fromTenant, fromWorker, toTenant, toName, status` asked → signing → done; declined, expired, replaced, `askedAt, askedBy, expiresAt, newWorkerId, signDate, signedAt, sigPath, parts`) and each copy made — created once, the copy's lock ([contracts.md](contracts.md) → Moving to another firm) | the `sign_documents` function only |
| `appConfig/docx2pdf` | `{url}` — the docx2pdf Cloud Run service's address, written by its deploy | the deploy workflow only |
| `errors/{auto}`, `timings/{auto}` | telemetry rows (`when, page, role, worker, message, source, stack` / `when, kind, totalMs, tenantId, user, role, details`) | any signed-in caller; login refusals by `login` |

Indexes (`firestore.indexes.json`): punches `workerId + ts`, `hrId + ts` (an own-workers HR's punch queries) and `clientId + ts` (the client portal's month); pendingHours `status + createdAt desc`; a single-field override on `workers.token` with collection-group scope (needed by `punch`).

**Storage:** `tenants/<t>/workers/<workerId>/{form101|pages|signature|assets|docs}/<ms>-<name>` (`pages/` one JPEG per scanned page, `signature/` the signature's PNG, `assets/` the old scan sidecar until it is split — [contracts.md](contracts.md) → Scanned pages); a client's signed months at `tenants/<t>/clients/<clientId>/documents/hours-<YYYY-MM>-signed.pdf` (written only by the `hours` function's `sign`, read by the managers — `storageUrl(path)`). The object path is the file id kept on the worker (`docFileId`, `assetsFileId`, `docs[].fileId`); the PDF and documents also get a download URL (`docUrl`, `docs[].url`), the sidecar does not.

## Browser data layer (`firestore-backend.js`)

The code is `src/lib/firestore-backend.ts` (TypeScript, the one copy); `firestore-backend.js` at the root is generated from it by `scripts/build-globals.mjs` and committed — change the TypeScript, then `npm run build:globals` (`npm run build` fails while the file is stale; [build.md](build.md) → Generated scripts). `src/lib/backend.ts` types the new pages' `loadBackend()` with its `FirestoreBackend`.

Loaded by `loadFirestoreBackend()` in the manager app and by `loadBackend()` (`src/lib/backend.ts`) in the new pages — the portals use only the sign-in, the ID token, the claims, `updateMyLanguage` and `updateMyTheme` (the punch page talks only to the `punch` function). One global, `initFirestoreBackend()`:

- imports the Firebase SDK `FB_VERSION` 12.19.0 (app, auth, firestore) from gstatic; Storage only on the first upload, or 4 s after a signed-in start (`loadStorage()`);
- web config from Hosting's `/__/firebase/init.json`, or `window.FIREBASE_WEB_CONFIG`;
- `localStorage.fsEmulator` = a host → Firestore 8080, Auth 9099, Storage 9199 (tests);
- waits for `auth.authStateReady()`.

An own-workers HR's reads are filtered by `hrOnly()` (from `myClaims()`), and `saveSchedule` skips what its sections don't allow (`mayWrite`) — the HR model end to end is in [hr.md](hr.md).

It returns:

| Function | What it does |
|---|---|
| `login(username, password)` | `login` function → `signInWithCustomToken`; returns the function's reply |
| `currentUser()`, `idToken()`, `signOut()` | `signOut` also stops the punch listener |
| `loadSchedule(t, track=true)` | workers (an own-workers HR: only its own), clients, suppliers (sorted by `sortIndex`, then id) and settings. Remembers each document's signature (`sig()`, key-order independent, plus the position) as the reference for the next save; `track=false` (another firm) does not |
| `saveSchedule(t, data, first?)` | writes only documents whose signature or position changed, deletes the ones that are gone, in batches of 450. Reloads first if the reference belongs to another firm. `first` (`{ops, ids}`): extra writes (`['update', ref, fields]`) put at the front with the writes of those worker ids, so they share the first batch and commit together (a confirmed shift offer, `decideShiftRequest`) |
| `listenPendingHours(t, onChange)` | `onSnapshot` on the hours batches this login may read (an own-workers HR: `createdBy` = its uid); every change calls `onChange` with the whole list, shaped like `loadPendingHours` (`batchFromDoc`). Started for every manager-side session (`watchHoursBatches`) |
| `listenWorkers(t, onChange)` | `onSnapshot` on the workers an HR may read (own-only: its own); reports `{added, removed, changed}` against the reference copy (`known`, `storedPos`, `workerHr` follow); a changed worker (an edit made elsewhere; this device's pending writes skipped) comes as `{data, unsaved(item)}`, where `unsaved` says whether the app's copy has edits not yet saved (its signature differs from the last server copy). Started for an HR session only |
| `listenPunches(t, onChange, since)` | `onSnapshot` on punches with `ts ≥ since`; resolves with the first snapshot, every later snapshot (this device's own writes included) goes to `onChange`. Without `since`: 13 months back |
| `punchesBetween(t, from, to)` | one read of `[from, to)` |
| `punchesOfBatch(t, batchId)` | punches with ids starting `imp-<batchId>-` |
| `savePunch` / `updatePunch` / `deletePunch` | `savePunch` stamps the worker's current `hrId` (`punchDoc`, from the last load/save — `workerHr`); `updatePunch` writes only `type, time, site, notes, clientId`, `ts` (the punch window moves it with an edited time — the live sync rebuilds `time` from `ts`) and `editedAt` |
| `uploadWorkerFile(t, body, onProgress)` | `saveWorkerDoc` → `form101/`, `saveWorkerPage` `{fileBase64, kind, index}` → `pages/<ms>-<index>-<kind>.jpg` (one scanned page, a JPEG), `saveWorkerSignature` `{fileBase64}` → `signature/<ms>-signature.png`, `saveWorkerFile` → `docs/`; `saveWorkerAssets` → `assets/` (the old sidecar, a JSON `{scanB64, scanMediaType, sigPng, extraPages}`) is kept only for the browser tests of the old read — the app no longer writes it; `uploadBytesResumable` with real byte progress; returns `{ok, id: path, url}` (no url for a page, the signature or the sidecar); an own-workers HR's files carry `hrId` in their metadata |
| `storageUrl(path)` | a download URL for a file in the firm's Storage (`storage.rules`: the firm's managers read); used for a client's signed month (`openSignedHours`, the `hours` function's `sign`) |
| `handleAction(action, params, ctx)` | answers one named data action (below) with a JSON reply, or `null` when there is no such action |

**`handleAction`** — the manager app's `fetch(API_URL, …)` dispatcher calls it ([app-core.md](app-core.md) → Data calls). `ctx` is `{role, username, tenantId}`; the firm is `params.asTenantId || ctx.tenantId`.

- `logBatch` / `logError` / `logTiming` → `errors` / `timings` documents (max 60 per batch, fields clipped); before the Firebase sign-in → `{ok:false, skipped:true}`.
- Any other action before the sign-in → the session-expired error.
- Users and firms (`listTenants, setTenantActive, deleteTenant, createUser, updateTenant, loadTenantProfile, listUsers, createTenantUser, updateUser, resetUserPassword, deleteUser, checkWorkerDoc, updateMyName, updateMyLanguage, updateMyTheme, listTemplates, saveTemplate, deleteTemplate`) → `users_admin` with the ID token.
- The AI actions (`aiReadDoc, aiReadSefach, aiDetectAlign, aiVerifyField, aiVerifyFields, aiReadHoursTable, aiFindField`) → `ai_read`.
- `loadWorkerPages` / `loadWorkerAssets` / `deleteWorkerDoc` → `users_admin` for `tenants/…` ids. Any other id: delete answers `{ok:true}` (nothing of ours to delete), a load answers "File not found".
- `resetLogs` — super-admin only: deletes every `errors` and `timings` document (all firms, all periods; batches of 400) → `{ok, errors, timings}` (the counts).
- `loadErrors` / `loadTimings` — super-admin only, newest first. With `from` / `to` (ISO times; the panes' period picker) only that period, up to 2000 errors / 5000 timings; without them the newest 100 / 500.
- `loadSchedule` / `loadPunchLog` for another firm (super-admin summary): `loadSchedule(t, false)`; punches from the 1st of this month minus 7 days (`punchesOnce`).
- `deletePunchesByMonths` — `tenant_admin` / `superadmin` only; per month, punches with `day` in the month plus punches without `day` whose `ts` is in it.
- `setPunchesHr` (`{workerIds, hrId}`) — owner / super-admin only: sets (or clears) `hrId` on every punch and every `shiftRequests` doc of those workers.
- Workers' requests (stage 5b): `loadShiftRequests` — refused for a supplier or client login; the firm's `shiftRequests` with `date` from today on (an own-workers HR only those with its `hrId`) → `{ok, requests:[{id, …}]}`. `decideShiftRequest` (`{id, status, schedule?, workerIds?}`) — sets `status` to `confirmed` (anything else → `declined`) with `decidedAt`, `decidedBy` (the username) and `decidedByUid`; the rules allow it only on a pending offer and only to a schedule writer. A confirm carries the app's schedule with both workers' dates changed: it goes through `saveSchedule(t, data, first)`, which puts the request update and those two workers' writes first, in one batch, so they commit together ([app-core.md](app-core.md) → Schedule tab).
- Hours queue: `savePendingHoursBatch` (refused for a supplier), `loadPendingHours` (all batches; an own-workers HR only its own), `approvePendingHours` (approver only; for every row an IN and an OUT punch, with the worker's `hrId` — an OUT at or before the IN is a night shift and lands on the next day — `imp-<batch>-<row>-in|out` with `notes: 'Imported from <file>'` and the batch status in **one** batch write, so approving twice creates nothing new), `rejectPendingHours`.

## Cloud Functions — `functions-auth/` (codebase `auth`, europe-west3)

A separate codebase so a login never loads OpenCV/PyMuPDF. `main.py` holds the HTTP wrappers (CORS `*`, POST only, the body parsed with `force=True`); the logic is in `core.py`, `files.py`, `portal.py` and `ai.py`. Each function returns JSON, errors as `{error}` (Russian texts where the app shows them).

| Function | Auth | Module | Notes |
|---|---|---|---|
| `login` | none | `core.login` | 30 s; `min_instances=0` (no standing cost; the login screen's `{ping:true}` wakes it while the user types, but after a long idle the first login can still wait for a cold start) |
| `users_admin` | `Bearer <ID token>`, checked with `check_revoked`; `{ping:true}` needs no token | `core.run_action`, `files.run` | a superadmin's firm = `asTenantId`; after `deleteTenant` also `files.delete_tenant_files`; `{ping:true}` answers `{ok: True, warm: True}` at once (the app sends it on open to skip a cold start on the first real call) |
| `punch` | the worker link token | `portal.punch_action` | 30 s; `{ping:true}` |
| `supplier` | `Bearer <ID token>` of a supplier | `portal.supplier_action` | |
| `hours` | `Bearer <ID token>` of a client, supplier or HR login (review), or a manager (`list` / `resolve`) | `hours.hours_action` ([hours-review.md](hours-review.md)) | |
| `ai_read` | `Bearer <ID token>`, role superadmin/tenant_admin/staff/hr | `ai.run` | 300 s, 512 MB, 1 CPU, up to 20 requests at once per instance (a scan's parallel calls share one warm instance); secret `ANTHROPIC_API_KEY`; `{ping:true}` |
| `weather` | `{token[, clientId]}` (worker punch link) or `Bearer <ID token>`, role superadmin (`asTenantId`)/tenant_admin/staff/hr | `weather.weather_action` | 20 s, 1 CPU, up to 20 requests at once; secret `OPENWEATHER_API_KEY`. The place comes from the server's data (the worker's site — the picked `clientId` first when it is theirs — or the firm's first client by `sortIndex` with a map point); OpenWeatherMap current weather, one read per area every 30 minutes (`weatherCache`); returns only `{kind: clear\|clouds\|rain\|thunder\|snow\|fog, temp}`, `{}` when nothing can be read |

Minting custom tokens needs the runtime service account to hold "Service Account Token Creator".

### `core.py` — login, users, firms

- **Login:** username lower-cased → `usernames/{name}` → `users/{uid}` + `authSecrets/{uid}`.
  - An inactive user gets "Account disabled".
  - 5 wrong passwords in a row lock the account for 5 minutes ("Too many wrong attempts — wait N min."); the counter restarts after the window.
  - A user who has not logged in since the move still has the old `sha256` hash (SHA-256 of `password + ':' + salt`); it is replaced by scrypt (N=2¹⁴, r=8, p=1) on the first good login.
  - Every refusal is written to `errors` with its reason (`on_refused`) — never the password or hash; the user only sees "Wrong username or password".
  - The reply: `{ok, token (custom token), uid, username, role, tenantId, supplierId, clientId, rights (the flat rights; null for an owner or a superadmin), ownOnly, commissionRate, commissionDayRate, fullName, language, theme, tenantProfile}`.
  - Custom-token claims (`claims_for`): `role` (`'tenant'` normalized to `tenant_admin`), `tenantId`, `supplierId`; for a client its `clientId`; `rt` — the flat rights of a staff / HR / supplier / client login (its `users.rights`, only its role's), the one thing the rules and the functions check (`caller_rights(decoded)`: the `rt` list, empty for a token without it; `files.py` needs Workers + Edit workers, `hours.py` maps the rights to its ticks with `hour_ticks` and calls a staff login with Accounting a manager, `portal.py` changes a supplier's workers with Workers, sends and lists hours with Commission and hands out pay with See workers' pay); for `hr` also `own` ("only own workers", true unless `ownOnly` is false) and `hrc` / `hrcd` (its commission ₪/h and ₪/day, `commissionRate` / `commissionDayRate`).
  - **The old rights fields, converted once** (`convert_old_rights`, run by the first `login` or `users_admin` action after the deploy; `appMeta/rights` remembers it is done): every `users` and `permTemplates` doc that still had `permissions`, `editPerms`, `hourPerms`, `supplierSections` or `showPay` got its `rights` worked out one to one (`_old_flat_of`: a staff login always had Today, the Punch log with Workers and Edit pay with Accounting; an HR's Accounting is Commission; a supplier's Dashboard is Today and its hours tab Commission; a client's old `permissions` were its hours ticks) and those fields deleted.
- **Users** (superadmin: any firm; `tenant_admin`: own firm only):
  - `listUsers` — never returns hashes;
  - `createTenantUser` — a `templateId` is required ("Pick a template"): the template says the role and its `rights` (and an HR's `ownOnly`) are copied in; password ≥ 8, a supplier needs `supplierId`, a client `clientId`, an HR `fullName` (and its own `commissionRate` / `commissionDayRate`); stores `fullName` and `phone` for every role; the `usernames` doc is created in the same batch, so a taken name fails the whole batch ("This username is already taken");
  - `updateUser` (the role and rights only from a `templateId` — a new one copies its role, `rights` and `ownOnly` in, with the same requirements as on create: a supplier needs `supplierId`, a client `clientId`, an HR a name; a `role` sent without a template → "Pick a template"; `supplierId`, `clientId`, `active`, an HR's commission — compared with the stored values, and only a real change revokes the user's sessions; `fullName` / `phone` for every role, never revoking — an HR's name can't be emptied). A `tenant_admin` / `superadmin` target takes only `fullName` / `phone` (any rights field → `E_ADMIN_TARGET`).
  - **A login on a template:** `createTenantUser` / `updateUser` with `templateId` load it (`_load_template`: "Template not found") and take its role and copy its rights (with `rights`) over whatever the body sends, storing `templateId`; for a login already on a template the rights the body sends are dropped, and a role change needs a template of the new role ("Pick a template"). A login without a template (made before them) still takes the rights fields above.
  - `resetUserPassword` (any user of the firm, the owner included; revokes), `deleteUser` (refuses a `tenant_admin` / `superadmin` target; deletes the Auth user). Another firm's user is always refused.
- **Permission templates** (one set for every firm): `listTemplates` (an owner or a superadmin; the first read writes `DEFAULT_TEMPLATES`; each with `count` — its logins in every firm for a superadmin, in its own firm for an owner); `saveTemplate` (superadmin only; `id` absent = new; a unique name, "Give the template a name"; `rights` — the flat list, kept only for its role, `_template_rights`; its role can't change while logins use it) copies the rights into every login on it in every firm, in batches of 400, and revokes the sessions of those whose rights changed — the reply's `updated`; `deleteTemplate` (superadmin only) removes it and the `templateId` of its logins, whose rights stay. `linkToTemplates` (superadmin only) puts every login without a template, in every firm, on the closest template of its role (`_closest_template`: the exact rights, else the most shared flat rights) and revokes the sessions whose rights changed — the reply's `linked`, `changed`, `skipped`; `listTemplates` also returns `unlinked`, the count of such logins.
- **`updateMyName`** (`{fullName}`, any signed-in user, owner and super-admin included): sets the caller's own `fullName`; an HR's can't be empty.
- **`updateMyLanguage`** (`{language}`, any signed-in user, a supplier included): keeps the UI language the caller picked (`en` / `he` / `ru`, else "Unknown language") in `users/{uid}.language`; `login` returns it as `language` (`null` when never picked) ([translations.md](translations.md)).
- **`updateMyTheme`** (`{theme}`, any signed-in user): keeps the theme the caller picked in the account menu (`dark` / `light` / `system`, else "Unknown theme") in `users/{uid}.theme`; `login` returns it as `theme` (`null` when never picked: the device's own choice, Dark by default) ([redesign.md](redesign.md) → Light theme).
- **`checkWorkerDoc`** (superadmin, tenant_admin, staff, hr; `{docId, workerId?}`): is a worker with this document number (`docId`, `passportNo` or `israeliId`, compared on letters and digits only) already in the caller's firm, other than `workerId` — `{ok, exists}`, nothing else, so an own-workers HR learns no other worker's data. It is one `array_contains` query on `docKeys` once the firm doc has `docKeysReady`; the firm's first check reads every worker instead, writes the missing `docKeys` and sets that flag. The app's `saveSchedule` and the supplier portal write `docKeys` on every worker save.
- **Firms** (superadmin): `createUser` (a new firm + its `tenant_admin`, whose `fullName` is `ownerName`; profile strings stay strings, so no leading-zero loss), `listTenants` (profile, active, worker/client counts by aggregation, `savedAt`), `setTenantActive` (the firm and its users; deactivation disables only the logins that were on, marking them `disabledWithFirm`, and revokes the firm's sessions; reactivation re-enables only the marked ones — a login the owner disabled on its own stays off), `deleteTenant` (recursive delete of `tenants/{t}`, its users, secrets and usernames; `main.py` then deletes every Storage object under `tenants/<t>/` and reports `removed.files`). `updateTenant` — superadmin or the firm's own `tenant_admin`. `loadTenantProfile`.

### `files.py` — reading and deleting Storage files

`users_admin` actions `loadWorkerPages` with `{fileIds: [<storage path>, …]}`, `loadWorkerAssets` and `deleteWorkerDoc` with `{fileId: <storage path>}`:
- manager roles (and `hr`) only; the path must be under `tenants/<caller's firm>/workers/` (no `..`, no `//`);
- an own-workers HR only for a worker whose `hrId` is its uid (`worker_hr(wid)` reads the worker in `main.py`);
- delete needs superadmin, `tenant_admin`, or staff / hr with `workers`;
- `loadWorkerPages` returns `{ok, pages: [{fileId, b64, mediaType}], missing: [<path>]}`: a worker's scanned pages and signature in one call, at most 20 (`MAX_PAGES`), each path only under `pages/` or `signature/` of a worker of the firm — one path that is not refuses the whole call ([contracts.md](contracts.md) → Scanned pages);
- `loadWorkerAssets` returns `{ok, scanB64, scanMediaType, sigPng, extraPages}` — the old sidecar, read until the worker's is split into pages.

`delete_tenant_files(bucket, tenantId)` deletes everything under `tenants/<tenantId>/` (refuses an empty id or one with `/`).

Uploads do not go through here: the browser writes to Storage directly (`uploadWorkerFile`), and `storage.rules` decide. Reading through a function avoids having to set CORS on the bucket.

### `portal.py` — worker link and supplier portal

See [punch.md](punch.md) and [supplier-portal.md](supplier-portal.md) for the pages.

- **`punch`:** the token is looked up by a collection-group query on `workers.token`; none or two matches → "Unknown worker link".
  - `load` → `{workers:[{id, name, colorIdx, token, clientIds, schedule, dates}], clients:[{id, name, object, lat, lng, radius}]}` — only this worker, their own weekly roster (`schedule`: seven days, Sunday first, each `{type:'work'|'off', start, end}`, `_week()`), their one-date changes from 31 days back to 120 days ahead (`dates`: `{'YYYY-MM-DD': {type, start, end}}`, `_dates()`, from the worker's `dateShifts`) and their sites.
  - `savePunch` — only for this worker; type `in`/`out`; the punch id may not contain `/`; an existing document of another worker is never overwritten. Stored fields: `workerName, type, time, date, site, dist, gpsAccuracy, gpsSuspicious, gpsWarnings (≤20, clipped), notes, clientId` (a `clientId` that isn't one of the worker's `clientIds` is dropped, with `site`), plus `id, workerId, ts, day, archived:false`, and `hrId` from the worker document (never from the page). `day` comes from `date` (`dd/MM/yyyy`) when sent, otherwise from `ts` in Israel time (the punch page sends no date). `set()`, so a re-sent punch is the same document. The page's `lat`/`lng`/`gpsVerified`… are not kept.
  - `myMonth` `{month:'YYYY-MM'}` → `{punches, pay, clients}` (`_my_month()`): this worker's own punches with `ts` from a day before the month to a day after it (`workerId` + `ts` index), each `{id, workerId, type, time, date, clientId, ts}` (ISO, `Z`); `pay` = `id` + the worker's `WORKER_PAY_FIELDS` (`payMode, hourlyRate, regRate, otRate, shabbatRate, clientRates, dayOverrides, travelAllowance, travelMonthly`); `clients` = the worker's sites as `{id}` + `CLIENT_PAY_FIELDS`. Never GPS, billing, other workers or tokens. A month that is not `YYYY-MM` → "Bad month".
  - `myRequests` → `{requests, colleagues}`: this worker's `shiftRequests` from today (Israel) on, each `{id, kind, date, start, end, toWorkerId, toWorkerName, note, status}`, and the colleagues they may offer a shift to — the active workers (not `fired`) sharing one of their sites, `{id, name}` only (a projection of `name, clientIds, status`).
  - `setUnavailable` `{date, on, note}` — marks (`on` not `false`) or unmarks the worker's day `u_<worker>_<date>`; the date from today to 120 days ahead (`REQ_DAYS_AHEAD`), else "Bad date".
  - `offerShift` `{date, toWorkerId, note}` — the worker's shift of that date (`_shift_on`: a date change wins over the weekly roster) offered to one of `colleagues`: `s_<worker>_<date>`, `pending`. Refused: no shift that day ("No shift on this date"), not a colleague ("Pick a colleague from your site"), already `confirmed`. Declined ones may be offered again. Nothing in the schedule changes here.
  - `cancelRequest` `{id}` — deletes the worker's own offer while it is `pending`; another worker's id → "Not your request"; a decided one → "The manager has already decided".
  - `savePushSubscription`, `logError` (no token needed).
- **`supplier`:** role `supplier` with `tenantId` and `supplierId` in the claims, else "Supplier role only".
  - `loadSchedule` → own workers through `strip_worker` (the `SUPPLIER_WORKER_FIELDS` allow-list + `supplierRate` and `supplierDayRate`; never a wage, the worker's punch-link token or a file link), clients as `{id, name, object}`, `commission` (this supplier's own rate list from its document, `[{from, mode, rate}]`), `suppliers: []`;
  - `loadPunchLog` → own workers' punches of the last 13 months with `id, workerId, workerName, type, time, date, site, clientId, ts` (`workerId in` queries of 30);
  - `supplierAddWorker` / `supplierUpdateWorker` / `supplierDeleteWorker` with the `SUPPLIER_EDITABLE` list (a new worker also gets `createdAt`);
  - `supplierSubmitHours` (a pending hours batch for an own worker) and `supplierListHours` (its batches with their status) ([supplier-portal.md](supplier-portal.md)).

### `ai.py` — `ai_read`

The seven AI actions: the Anthropic request for each, the reply handling and the result shape the scan code expects ([scan.md](scan.md)).

| Action | Model | `max_tokens` | Returns |
|---|---|---|---|
| `aiReadDoc` | `ANTHROPIC_MODEL` | 8000 | passport or Israeli ID fields, `fieldBoxes`, `children`, `spouse`; `latinSurname` / `latinGiven` and `mrzName` for the name cross-check; `mrzLine2` (passports only — an Israeli ID card has no MRZ): `_expiry_from_mrz` takes the passport number, the birth date and the expiry from it, each only when its own ICAO check digit is right (`passportNoFromMrz`, `dobFromMrz`, `expiryFromMrz`), and drops that field's box (no zoomed re-read), so a misread printed number or the issue date printed next to the expiry can't be taken; `issueDate` (any document): without an MRZ expiry, `_check_dates` swaps an expiry on or before the issue date back (`datesSwapped`, the expiry box dropped) and marks an expiry less than a year after the issue date for checking (`__uncertain`); an Israeli passport comes back as `israeli_id` (Hebrew names, `idNo`, `passportNo`); system prompt cached |
| `aiReadSefach` | `ANTHROPIC_MODEL` | 3000 | an extra Israeli page: address, house number, city, marital status, sex, spouse, children, idNo and the holder's given / surname (cross-checks), `fieldBoxes` of address / house number / city; `part` `holder` / `family` (prompt `readSefachPart`) asks for only the holder's fields or only spouse + children — the same cached prompt, a different closing line |
| `aiDetectAlign` | `ANTHROPIC_ALIGN_MODEL` | 400 | `{kind, rotate (0/90/180/270)}` — no corners since S1 (the corner model gives them, docs/scan-plan.md) |
| `aiVerifyField` | `ANTHROPIC_MODEL` | 50 | one zoomed field (`digits9`, `date`, `passportNo`); empty when unreadable |
| `aiVerifyFields` | `ANTHROPIC_MODEL` | 400 | several fields in one call: `{values:{field:value}}`; kinds `digits9`, `date`, `passportNo`, `hebrewText`, `latinName`, `houseNumber` (`verifyFieldsKind`; `verifyField` has the same kinds for the single re-read) |
| `aiReadHoursTable` | `ANTHROPIC_MODEL` | 4000 | `{entries:[{date, inTime, outTime}]}` from a timesheet photo |
| `aiFindField` | `ANTHROPIC_MODEL` | 300 | `{found:{value, page, box}}` for one `field`, or `{found:{key:{value, page, box}}}` for `fields` (several in one request, `findFields` prompt; `max_tokens` 300 + 150 per extra field) — searched by key and `docType` on up to 4 page photos (`images:[{image, mediaType}]`); label and hint come from `ai_prompts.json` `findFieldFields`, never from the caller; `value` is empty when not found |

- Every `ai_read` reply carries `_meta` (`ai.run(…, meta=)`): `apiMs` (time waiting for Anthropic), `tries`, `waitMs` (retry pauses), and the last reply's `stop`, `inTok`, `outTok`, `cacheReadTok`, `cacheWriteTok`. The app keeps it with a slow call's Timings row (docs/admin.md).
- Models: env `ANTHROPIC_MODEL` (default `claude-sonnet-5`) and `ANTHROPIC_ALIGN_MODEL` (default `claude-haiku-4-5-20251001`). Errors: "The AI returned an unreadable answer"; "The AI answer was cut at max_tokens" when `stop_reason` is `max_tokens` and nothing could be kept. A `aiReadDoc` / `aiReadSefach` answer cut at `max_tokens` is salvaged first (`_salvage_object`: the longest prefix ending after a complete value, open brackets closed) and returned as `{ok, parsed, truncated:true}` — the fields that came in full (address, spouse, the children listed so far) are kept; `readSefachPage` notes it in Admin → Errors. Both prompts ask for filled-in children only, each once (an old ספח's empty table rows had made the answer run to the limit).
- Retries: a busy reply (HTTP 429 or 5xx, an `overloaded_error` / `rate_limit_error` / `api_error` body) or a network error is sent again after 1.5 s, then 4 s (`RETRY_PAUSES`); the third answer is returned as is. Each Anthropic request times out after 90 s. The `ai_read` function timeout is 300 s.
- **Prompts** live in `functions-auth/ai_prompts.json` — edit them there. The Israeli and passport rules (page kinds A/B/C and the old laminated card's fixed field order, joined ID groups, Gregorian dates only, holder vs spouse vs child numbers, the MRZ cross-check) are in `readDoc` / `readSefach`.
- **Tests:** `tests/auth/test_ai.py` compares every request and result with `tests/auth/ai_golden.json`, recorded from the original Apps Script actions. A prompt edit therefore fails `test_same_request` until the golden file is updated for the new prompt.

## Parallel AI calls — the pattern

How a feature that sends several AI requests is built, on both ends. Follow it for any new one.

**Client (the page).** Every request that does not need another one's answer is started at once, and the code waits only where a later step really needs a result:

| Where | Sent in parallel |
|---|---|
| the scan window (`src/scan/`) | `aiDetectAlign` for every page the lab's page posts |
| the scan process (`readPages`, `src/scan-process/read.ts`) | `aiDetectAlign` for every page with no face and no kind; page 1's `aiReadDoc` as soon as it is upright; the following pages' `aiReadSefach` (two halves each, `prefetchFrom`) while page 1's digits are re-checked; the zoom batches (`aiVerifyFields`), one per page |
| `findScanFields` (`src/manager/page/worker-window.ts`) | one `aiVerifyFields` zoom batch per page after the one `aiFindField` |
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
- `scan_feedback` — the scanner's training examples and their counts (512 MiB, `cpu=1`, `concurrency=20`, 60 s; [scan-training.md](scan-training.md)): `add` (the edges / document type copies), `document` (a full document after the save of the worker window, when the firm collects them — H8a), `attempt` / `attemptOutcome` (every scan attempt from the site and the lab, S8), `mode` (any manager login: the document type model's mode for the scan window), `stats`, and for a super-admin `settings` / `setSettings` (Admin → Scanner: `scanSettings/current.doctypeMode`, `tenants/<id>/settings/scan.collectDocuments`). The files go through `functions/datastore.py`: the private Hugging Face bucket `OutStaff/scanner-data` (the secret `HF_DATA_TOKEN`, write-only, declared on the function), and when the bucket refuses, Firestore `scanTraining` and Storage `training/`; the counts in `scanTrainingStats/current`. No client rule opens any of it.
- `contract_templates` — the firm's contract templates (1 GiB, `cpu=1`, `concurrency=20`, 120 s; no shared state per request): `list`, `file` (the template, or its `sample`), and for a `tenant_admin` / super-admin `prepare` (made light and checked), `sample`, `save`, `update`, `delete` — `functions/contracts.py`, [contracts.md](contracts.md) → Contract templates. Its data: `tenants/{t}/contractTemplates/{id}` and Storage `tenants/<t>/contracts/<id>/<ms>.pdf`; no client rule opens either.
- `sign_documents` — one signature for Form 101 and the contract (1 GiB, `cpu=1`, `concurrency=20`, 120 s; no shared state per request): a manager login's `send`, `list`, `view`, `sign`, `build`, `applied`, `withdraw`, `bundle` (Download data: one PDF, not kept; the Workers right; docs/contracts.md → Download data), and the worker's own page by the punch link's token (`mine`, `view`, `sign`, `build`); `transferAsk` (a firm's admin) and, with `transfer: true` on the worker's page, `mine` / `view` / `sign` / `build` / `decline` for a move to another firm (`functions/transfer.py`, D6) — `functions/signing.py` over `contracts.fill` and Form 101's `build_form101_pdf`, [contracts.md](contracts.md) → Signing. Its data: `tenants/{t}/signRequests/{id}`; the frozen template copy `tenants/<t>/workers/<w>/sign/<id>/contract-template.pdf`, the signature in `…/signature/`, the signed PDFs in `…/form101/` and `…/docs/`.
- `preprocess_scan` — removed on 2026-10-19 (the site's scanner is the lab's page; [scan.md](scan.md) → Server-side finding — removed).

All answer `{"ping":true}` at once (warm-up, no sign-in needed) and parse the body with `force=True`. Every other call must carry `Authorization: Bearer <Firebase ID token>` of a manager-side login (`superadmin`, `tenant_admin`, `staff`, `hr`): `functions/gate.py` (`check()`, the token verified with `verify_id_token(check_revoked=True)`) answers 401 for a missing, invalid or revoked token and 403 for any other role (supplier, client); `tests/auth/test_scan_gate.py` checks it. The callers send the token from `idToken()` of `firestore-backend.js` (`scan_feedback` in `src/scan/server.ts`, the Form 101 build in `src/manager/page/scan.ts`). `functions/venv` must exist before `firebase deploy --only functions` from a local machine (`python -m venv venv && pip install -r requirements.txt`); CI builds its own. `functions/assets/` holds the PDF template and font the function uses.

## Cloud Run — `services/docx2pdf` (europe-west3)

LibreOffice (headless) for Word contract templates: `POST {docxBase64}` with a firm admin's or the super-admin's ID token → `{pdfBase64}`; concurrency 1, cpu 1, max 5 instances; deployed by `deploy-docx2pdf.yml`, its address in Firestore `appConfig/docx2pdf.url` for `contract_templates` ([contracts.md](contracts.md) → Word templates). `services/` is never served by Hosting.

## Security rules

**`firestore.rules`** — identities come from the custom-token claims.
- `manager(t)` = superadmin, or a `tenant_admin` / `staff` of firm `t`, or an `hr` of firm `t` without `own` (`hrAll`). A supplier never reads Firestore directly (wages and GPS can't be hidden field by field) — it goes through `supplier`.
- HR (`isHr`, `hrMine` = with `own`, `hrAll` = without, `hrCan(t, section)`): an own-workers HR reaches only workers and punches whose `hrId` is its uid, and **no HR changes a worker's `hrId`**, nor its pay and bank fields without `payEdit` — the full HR rules are in [hr.md](hr.md) → Enforcement.
- `tenants/{t}`: read by managers; update by a superadmin, or by its `tenant_admin` touching only the profile fields; create/delete superadmin.
- **The flat rights in the rules:** a staff / HR login's every check is one right of its token's `rt` list (`can(k)`: a tab `schedule` / `workers` / `clients` / `suppliers`, an edit `editSchedule` / `editWorkers` / `editPunches`, `editPay`); `mayEd(k)` lets the owner and a superadmin change everything. A token without `rt` has no right. Staff writes workers with the Workers or the Schedule tab (what it may change: its edit rights), clients with the Clients tab, suppliers with the Suppliers tab, the shift settings and offers with the Schedule tab.
- workers, clients, suppliers, settings: read by managers. Workers are written by superadmin, `tenant_admin`, staff or an HR with the Workers or the Schedule tab (`workerWriter`, `hrWorkers`; an old staff token: the `schedule` section), what it may change by its edit rights (`workerEdOk`); clients by the Clients tab and suppliers by the Suppliers tab (`staffTab`; an old staff token: the `schedule` section); settings and shift offers by the Schedule tab (`scheduleWriter`). A worker's money (`hourlyRate`, `regRate`, `otRate`, `shabbatRate`, `payMode`, `travelAllowance`, `travelMonthly`, `bank`, `bankBranch`, `bankAccountNumber`, `clientRates`, `dayOverrides`) changes only for the owner, a superadmin, or staff / an HR with **Edit pay** (`editPay`; `staffPayOk` / `staffNewPayOk` / `hrPayOk` / `hrNewPayOk`, on top of `samePay` / `noPay`).
- punches: read and write by any manager of the firm.
- hourApprovals: read by managers; never written directly (the `hours` function). A `client` role reads and writes nothing.
- shiftRequests: read by managers (an own-workers HR only those with its `hrId`); never created or deleted directly (the `punch` function); a schedule writer (`scheduleWriter`, an all-workers HR with `schedule`, an own-workers HR with `schedule` on its own workers) only decides a `pending` `swap`: `status` to `confirmed` / `declined` plus `decidedAt`, `decidedBy` and `decidedByUid` (must be the caller's uid), nothing else; the owner / super-admin may change only `hrId` (reassigning the worker's HR).
- pendingHours: read by managers; create (managers and any HR) only as `status:'pending'` with `createdBy` = the caller; update/delete only superadmin or `tenant_admin`.
- `users/{uid}`: read by the user, a superadmin, or that firm's `tenant_admin`; never written by clients. `authSecrets`, `usernames`, `workerTokens`, `pushSubscriptions`, `weatherCache`, `permTemplates`: functions only.
- **The edit ticks** (the edit rights in claim `rt`, staff / HR; `mayEd(k)`): a worker is created or deleted only with `editWorkers`; a worker update (`workerEdOk`) with `editWorkers` may change anything but `schedule` / `dateShifts` (those too with `editSchedule`), with only `editSchedule` nothing but `schedule`, `dateShifts` and `sortIndex`; punches are created, updated and deleted only with `editPunches` (an own-workers HR's too). The owner and a superadmin may always.
- `errors`, `timings`: create by anyone signed in, read and delete (Reset) by a superadmin.

**`storage.rules`** — `tenants/{t}/**`: read by managers of the firm (`hrAll` included). Browsers write only under `tenants/{t}/workers/**`: create/update by superadmin, `tenant_admin`, or staff / hr with `workers`; delete by those, except an own-workers HR (it deletes through `users_admin`); files under 25 MB. An own-workers HR stamps and reads back only files with its uid in `hrId` metadata, and can't replace a file stamped by another uid ([hr.md](hr.md)). Everything else under a firm (a client's signed month PDF, `clients/{c}/documents/…`) is written only by the functions.

## Tests

- **Rules:** `tests/rules/rules.test.mjs` on the Firestore + Storage emulators — `cd tests/rules && npm install && npm test`.
- **Functions:** `tests/auth/test_core.py`, `test_portal.py`, `test_ai.py`, `test_files.py` (in-memory bucket) on the Firestore + Auth emulators — `cd tests/rules && PYTHON=<python with firebase-admin and pytest> npm run test:auth`.
- **Browser:** `tests/e2e/` — see [tests.md](tests.md), which also lists every suite and how CI runs them on each pull request (`tests.yml`).

## Deploys (push to `main`)

| Workflow | Runs on | Does |
|---|---|---|
| `tests.yml` | every pull request into `main`, or manual | all tests: dictionaries, icons, tokens, the build ([build.md](build.md)), rules, functions, browser on `dist/` ([tests.md](tests.md)); deploys nothing |
| `deploy.yml` | every push to `main` | `npm ci`, `npm run build`, `tests/build/check.js`, then the scanner lab's models into `dist/scan-lab/` (`scripts/scan-lab/fetch-models.sh`) and the site scanner's own into `dist/scan/` (`scripts/scan/fetch-models.sh`), both from the firm's Storage, then Firebase Hosting (live channel) serves `dist/` ([build.md](build.md)); a failed build deploys nothing |
| `deploy-functions.yml` | `functions/**`, `functions-auth/**`, `tests/auth/**`, `.github/workflows/deploy-functions.yml`, or manual | builds both venvs, runs `tests/auth` on the emulators (a failure stops the deploy), `firebase deploy --only functions --force` (`--force` also deletes deployed functions that are no longer in the code), up to 3 tries a minute apart (a passing hiccup such as "Failed to list functions" is retried); on failure opens/updates the GitHub Issue "Cloud Functions deploy failing", and a good deploy closes it |
| `deploy-rules.yml` | `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `tests/rules/**`, or manual | rules tests, then deploys rules, indexes and storage; on failure opens an Issue (usual causes: the service account lacks Firebase Rules Admin / Cloud Datastore Index Admin, or Storage is not enabled) |

`firebase.json`: both codebases pinned to `python312`; Hosting serves `dist/` (`hosting.public`, built by `npm run build` — [build.md](build.md)) and rewrites `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`, `/client` → `client-portal.html`, `/next` → `/next/index.html`; the Hosting `ignore` list must keep `functions/**` (otherwise the venv is uploaded as public files), `functions-auth/**`, `tests/**`, the rules files, `*.md` and `docs/**`. HTML and all `.js` files, and the routes `/`, `/punch`, `/supplier`, are served `no-cache`. When `service-worker.js` changes, bump its `CACHE` version (now `schedule-mgr-v136`).

### Known deploy failures

- **"Missing permissions required for functions deploy" / `iam.serviceAccounts.ActAs`** — the `FIREBASE_SERVICE_ACCOUNT` identity needs **Service Account User** granted on the runtime service account's own Permissions tab (it happened for both `schedule-odinson@appspot.gserviceaccount.com` and `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`; grant a new one the same way). Early deploy steps also needed Cloud Functions Admin, Service Usage Consumer, Cloud Build Editor, Artifact Registry Writer, Cloud Run Admin, Eventarc Event Receiver. Needs a human with IAM rights in the GCP Console. `--force` in the workflow accepts the Artifact Registry cleanup-policy prompt.
- Re-run after a fix: run the workflow manually, or push a change under its paths.
