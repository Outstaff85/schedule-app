# Multi-tenant + login architecture

> **Historical.** This design was built on Apps Script / Google Sheets; the app now runs on Firestore and Cloud Functions, and Apps Script was removed 2026-10-03. The tenant model (firms, roles, per-firm isolation) carried over; the current implementation is in [backend.md](backend.md).

Design doc for the multi-tenant version of this app: a super-admin creates
"firms" (tenants), each firm logs in and only ever sees its own data.

**Merged to `main` 2026-09-18** (PR #34, `feature/multi-tenant` → `main`); both halves are live together.

## Status

- [x] **Step 1 — backend**: `Users`/`Tenants` sheets, password hashing,
      stateless signed session tokens, tenant-scoped `Schedule`/`PunchLog`/
      `PushSubscriptions`, `login`/`createUser`/`listTenants` actions,
      `migrateToMultiTenant()` one-time migration function.
      (`apps-script/Код.js` / `google-apps-script.js`)
- [x] **Step 2 — frontend**: login screen (`#loginScreen`) + 6h session
      (`schedMgr_session` in localStorage) in `schedule-manager.html`;
      super-admin "Firms" screen (`#firmsScreen`) + create-firm modal
      (`#createFirmOverlay`) + switcher (`switchToTenant()`/
      `backToFirmsList()`); every `fetch(GS_URL...)` call site now sends
      `gsAuth()` (POST body) / `gsAuthQuery()` (GET query string);
      `worker-punch.html` sends its own worker token (`_wpToken()` —
      `URL_TOKEN` on a personal link, or the picked worker's own `.token` in
      the picker-grid flow) as `workerToken` with every read/write. A single
      `window.fetch` wrapper (near `gsAuth()`) watches every `GS_URL`
      response for the backend's exact session-expired error and, when seen,
      clears the stale session, toasts, and reloads to the login screen —
      rather than threading that check through every individual call site.
      Verified live: corrupted an active token mid-session, triggered
      `gsSave()`, watched it toast and land back on the login screen with
      `schedMgr_session` cleared. **Known regression**: the legacy no-token
      picker-grid flow in
      `worker-punch.html` (`!URL_TOKEN`) has no per-request way to name a
      firm and will fail against this backend — every real worker link is a
      personal token link per `CLAUDE.md`, so this may not matter in
      practice, but it hasn't been redesigned for multi-tenant.
- [x] **Step 3**: Form 101 section א filled from the tenant's profile —
      verified this template's section א also has zero real AcroForm fields
      (same technique as `form101-field-map.md`'s other hand-drawn boxes),
      hand-drawn via a small IIFE in `aiFillForm101()` right after
      `TAX_YEAR_RECT`. Row native y=659.89–673.89 (height 14), columns
      right-to-left: `NAME_RECT` (x 414.9–540.4, שם), `ADDRESS_RECT` (x
      209.0–414.9, כתובת — `street + streetNumber + ', ' + city`), `PHONE_RECT`
      (x 130.3–209.0, מספר טלפון), `DEDUCTIONS_RECT` (x 39.9–130.3, מספר תיק
      ניכויים — 8-digit comb; the template already prints a fixed leading
      "9", so the 8 comb cells are the user-entered digits after it). Reads
      `getSession().viewingTenantProfile || tenantProfile` — the former is
      cached by `switchToTenant()` from the already-fetched Firms list (a
      super-admin's own login never carries a `tenantProfile`, since they
      have no fixed tenant of their own); the latter comes from `login()` for
      a normal tenant user. Drive storage: `saveWorkerDoc`/`deleteWorkerDoc`
      now resolve a per-tenant `Schedule manager APP/<CompanyName>/Workers`
      folder server-side via `_companyFolder(tenantId)` (company name read
      from `Tenants`, never trusted from the client); the PDF filename also
      gains a `_<CompanyName>` suffix for human browsing in Drive.
- [x] **Step 4 — firm lifecycle management** (added 2026-09-18, right after
      the merge): super-admin Firms screen (`renderFirmsList()`) gained a
      play/pause button and a trash button per firm row.
      `toggleTenantActive(tenantId, nextActive)` calls `setTenantActive` —
      reversible, flips the `active` column on every `Users` row for that
      tenant; a deactivated login is rejected at `login()` with "Аккаунт
      отключён" but the firm's schedule/punches/Drive docs are untouched
      (an already-issued session token still works until its normal 6h
      expiry, since sessions are stateless with no revocation list).
      `confirmDeleteTenant(tenantId, companyName)` calls `deleteTenant` —
      irreversible, gated by a `confirm()` plus typing the exact company
      name; deletes the `Tenants` row, every `Users` login, the tenant's
      `Schedule` row, every `PunchLog`/`PushSubscriptions` row carrying its
      `TenantId`, and trashes its `Schedule manager APP/<CompanyName>` Drive
      folder. `Backups` rows are deliberately left alone (dated snapshots,
      not live data). `listTenants()` now also returns `t.active` per firm
      (true if any of its logins are active, or if it has no `Users` rows
      yet at all).
- [x] **Step 5 — firm profile editing + Drive folder rename fix** (added
      2026-09-18): super-admin Firms screen gained an edit (pencil) button
      per row (`openEditFirmForm(tenantId)` / `submitEditFirm()`), calling a
      new `updateTenant` action — updates the `Tenants` row's `companyName`,
      `deductionsFileNumber`, `phone`, `street`, `streetNumber`, `city` (not
      the login itself). This surfaced a real bug: `_companyFolder(tenantId)`
      resolved the per-tenant Drive folder **by name** on every call, so
      renaming a firm made the old folder (and every worker doc in it)
      unreachable — the next save silently created a fresh, empty folder
      under the new name instead of reusing the old one. Fixed by resolving
      the company folder by a **stable Drive folder ID** cached on the
      `Tenants` row (new `driveFolderId` column, backfilled lazily on first
      use via `_setTenantDriveFolderId()` since `ensureHeaders()` only writes
      headers to a fully empty sheet). `updateTenant()` also eagerly renames
      the Drive folder in place via `_syncTenantDriveFolderName()` right
      after a `companyName` edit (a no-op if the tenant has no folder yet);
      `_companyFolder()` additionally self-heals the on-disk name on every
      call as a safety net. `deleteTenant()` now prefers the cached
      `driveFolderId` too (falling back to a name lookup only for tenants
      that predate this column). Net effect: renaming a firm renames its
      existing Drive folder and keeps every previously-uploaded document (and
      future Form 101 saves) in place — no new folder, no data loss, and the
      only added cost is one extra cheap Drive lookup per doc save/edit.
- [x] **Step 6 — cross-tenant Drive folder collision fix** (added
      2026-09-19, full-project bug-fix pass): `companyName` uniqueness was
      never enforced anywhere, so `_companyFolder()`'s by-name fallback (hit
      whenever a tenant has no cached `driveFolderId` yet) could silently
      adopt a *different* tenant's folder if two firms happened to share a
      name — every worker doc either firm uploaded afterward would land in
      one shared folder. Fixed by tagging each company folder with its
      owning `tenantId` (Drive folder `description`, set/kept in sync by
      `_companyFolder()` itself) — a by-name match is only adopted if it's
      untagged (a legacy folder predating this tag) or already tagged as
      the caller's own tenantId; a match tagged with someone else's
      tenantId is left alone and a fresh folder is created instead.
      `deleteTenant()`'s by-name trash fallback (for tenants with no cached
      `driveFolderId`) got the same guard — a destructive trash must never
      guess at a same-named folder that's actually tagged as another
      tenant's.

## Testing status

**Steps 1-3 verified** — no access to the real Google Sheet/Drive from this
environment, so instead: (1) a GAS environment shim (`SpreadsheetApp`/
`Utilities`/`PropertiesService`/`ContentService`/`DriveApp` stubbed over
in-memory state) runs the **actual** `apps-script/Код.js` unmodified under
Node; 64 automated checks cover login, session tokens (tampered/expired
rejected),
superadmin vs tenant authorization, migration idempotency, that one firm can
never read or edit another firm's schedule/punches (including a direct
attempt to delete another tenant's punch by ID, correctly denied), and that
`saveWorkerDoc`/`deleteWorkerDoc` route two firms' uploads into two distinct
`<CompanyName>/Workers` folders and never cross-trash each other's files. (2)
that same backend served over local HTTP, with a local copy of
`schedule-manager.html` pointed at it, driven through an actual browser:
login → Firms screen → create firm (all Form-101 profile fields) → switch
into a firm → back to Firms. (3) the section א coordinates were verified the
same way as every other hand-drawn box in `form101-field-map.md` — filled
with real-looking data via a standalone pdf-lib script (the exact same rect
constants now in `aiFillForm101()`), rendered, and visually confirmed each
field lands in its own cell under the right label, "9" + the 8-digit
deductions number combed correctly after the template's fixed prefix.

Three real bugs were caught and fixed this way (all in `schedule-manager.html`):
1. `loginScreen`/`firmsScreen` used `var(--bg1)`, a CSS variable that doesn't
   exist in this app (it's `--bg`) — their background was fully transparent,
   so the real app underneath (titlebar, dashboard) showed through around
   their content instead of being hidden.
2. `#createFirmOverlay` (class `.overlay`, z-index 100) opened *behind*
   `#firmsScreen` (z-index 900) and was invisible — needed an explicit
   higher z-index (950).
3. `openCreateFirmForm()` showed the modal via `style.display='flex'`, but
   `closeModal()` (used everywhere else in the app) only ever removes the
   `.open` class — so the modal, once opened, could never close. Fixed to
   use `classList.add('open')` like every other overlay in the app.

## Data model

- **`Tenants`** — one row per firm, also the source for Form 101 section א:
  `tenantId, companyName (שם), deductionsFileNumber (מספר תיק ניכויים, 8
  digits), phone, street, streetNumber, city, createdAt`.
- **`Users`** — logins: `id, username, passwordHash, passwordSalt, role
  (superadmin|tenant), tenantId, active, createdAt`. `role='superadmin'` has
  no fixed `tenantId` — it's supplied per-request via `asTenantId` to drill
  into a specific firm.
- **`Schedule`** — was a single global `{key,value}` sheet; now one row per
  tenant: `TenantId, workers (JSON), clients (JSON), weekStart, savedAt`.
- **`PunchLog`**, **`PushSubscriptions`** — gained a `TenantId` column,
  filtered on every read/write.
- **`Backups`** — gained a `TenantId` column; `backupNow()` now snapshots
  every tenant's `Schedule` row once a day instead of one global row.
- The old **`Clients`** human-readable tab (a write-only convenience mirror
  of `clients` JSON, never read by the app) and its writer `writeClientsTable`
  were dropped rather than made multi-tenant — it would need per-firm
  sub-tabs to stay meaningful, which is out of scope here. Same for
  `writeWorkersTable`. If this convenience view is wanted back later, it
  should be redesigned as a per-tenant sheet/tab, not resurrected as-is.

## Auth

- Passwords: `SHA-256(password + ':' + per-user salt)` via
  `Utilities.computeDigest` — never stored in plaintext.
- Sessions: **stateless**, no `Sessions` sheet. A token is
  `base64url(JSON payload).base64url(HMAC-SHA256 signature)`, payload
  `{userId, username, role, tenantId, exp}`. Verified by recomputing the HMAC
  with a secret in Script Properties (`SESSION_SECRET` — generate once,
  e.g. two concatenated `Utilities.getUuid()` calls, and set it in the Apps
  Script project's Script Properties before the first login; `login()`
  throws a clear error if it's missing). `exp` is `now + 6h` (shortened from
  the original 24h) — checked fresh on every request, no server-side expiry
  sweep needed.
- `requireAuth(body)` resolves `{userId, role, tenantId, isSuperadmin}` from
  `body.token` (works for both POST bodies and GET `e.parameter`, both plain
  objects) and honors `body.asTenantId` for super-admin drill-down. Throws
  `{error: '...'}` on missing/invalid/expired token, caught by `doPost`/
  `doGet`.
- **Worker punch links stay login-free**, as decided: `worker-punch.html`
  never shows a login screen. Its own per-worker token (the `t=` URL param,
  already unique per worker) is sent as `workerToken` alongside the existing
  `secret: API_SECRET` on every write; `findTenantIdByWorkerToken()` scans
  every tenant's `Schedule` row for a worker whose `token` matches, and that
  resolves the tenant. `API_SECRET` remains a legacy write-gate for exactly
  this unauthenticated path (`savePunch`/`updatePunch`/`deletePunch`/
  `savePushSubscription`) — everything else now goes through session tokens
  instead.
- GET requests (`loadSchedule`, `loadPunchLog`, `calcSalary`) now require
  either `token` (manager session) or `workerToken` (worker link) as a query
  param — previously unauthenticated entirely.

## Migration (run once, manually, from the Apps Script editor)

`migrateToMultiTenant(superadminUsername, superadminPassword, odinsonUsername, odinsonPassword)`
— never call this with real credentials from committed code; run it directly
in the Apps Script editor's function picker, typing the arguments into the
"Run" dialog (or a throwaway `function _run(){ migrateToMultiTenant(...); }`
you delete afterward). It:
1. Creates a `Tenants` row named "Odinson" from the pre-multi-tenant
   `Schedule` sheet (detected by its old `key,value` header shape) and
   rewrites `Schedule` into the new per-tenant-row format.
2. Backfills `TenantId` onto every existing `PunchLog` / `PushSubscriptions`
   row that doesn't have one yet.
3. Creates your super-admin login and the Odinson firm's own login.

Idempotent — safe to re-run; each step skips work that's already done
(existing Odinson tenant reused, already-migrated `Schedule` left alone,
already-backfilled rows skipped, existing usernames not duplicated).

**Before running it or shipping this branch**, `SESSION_SECRET` must be set
in Script Properties (Apps Script editor → Project Settings → Script
Properties) — `login()`/`requireAuth()` throw a clear error otherwise.
**Done** (2026-09-18): `SESSION_SECRET` set on the real project
(scriptId `1um51tx-6A5Ljyz2AqsuOQcJ1eaMVgAiSL3Bbt_pKzCEdvHY1ngG5vvdj`,
confirmed matching `apps-script/.clasp.json`), via the `stas@odinson.ltd`
account. This branch has since been merged to `main` (2026-09-18, PR #34).

Drive/Form 101 details (per-tenant folder, filename format, hand-drawn
section א coordinates) are covered in Step 3 under Status above.
