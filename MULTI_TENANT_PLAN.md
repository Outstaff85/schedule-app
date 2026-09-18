# Multi-tenant + login architecture

Working design doc for turning this single-client app into a multi-tenant
one: a super-admin creates "firms" (tenants), each firm logs in and only ever
sees its own data. Built incrementally on the `feature/multi-tenant` branch —
**never push straight to `main`** while this is in progress: a push to `main`
auto-deploys both the Apps Script backend and Firebase Hosting immediately
(see `CLAUDE.md`/`deploy.yml`/`deploy-apps-script.yml`), and the backend and
frontend halves of this feature are not independently deployable — shipping
one without the other breaks the live app for the real "Odinson" tenant.

## Status

- [x] **Step 1 — backend**: `Users`/`Tenants` sheets, password hashing,
      stateless signed session tokens, tenant-scoped `Schedule`/`PunchLog`/
      `PushSubscriptions`, `login`/`createUser`/`listTenants` actions,
      `migrateToMultiTenant()` one-time migration function.
      (`apps-script/Код.js` / `google-apps-script.js`)
- [x] **Step 2 — frontend**: login screen (`#loginScreen`) + 24h session
      (`schedMgr_session` in localStorage) in `schedule-manager.html`;
      super-admin "Firms" screen (`#firmsScreen`) + create-firm modal
      (`#createFirmOverlay`) + switcher (`switchToTenant()`/
      `backToFirmsList()`); every `fetch(GS_URL...)` call site now sends
      `gsAuth()` (POST body) / `gsAuthQuery()` (GET query string);
      `worker-punch.html` sends its own worker token (`_wpToken()` —
      `URL_TOKEN` on a personal link, or the picked worker's own `.token` in
      the picker-grid flow) as `workerToken` with every read/write. **Known
      gap**: no proactive redirect-to-login if a session expires mid-use —
      an expired-session API error currently just fails that one call
      silently rather than showing the login screen again; a full page
      reload picks up the expired session correctly via `getSession()`.
      **Known regression**: the legacy no-token picker-grid flow in
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

Before merging to `main`: deploy this branch's
`apps-script/Код.js` to a **test** Apps Script project (or a temporary extra
deployment of the real one) first, set `SESSION_SECRET`, run
`migrateToMultiTenant(...)` there, and walk through login → Firms → create a
firm → switch into it → save a schedule → open a worker's punch link →
clock in/out, before pointing production `GS_URL` at it.

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
  throws a clear error if it's missing). `exp` is `now + 24h`, matching the
  "stay logged in for a day" requirement — checked fresh on every request, no
  server-side expiry sweep needed.
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

## Drive / Form 101 (Step 3, not yet built)

- PDF storage moves from the single shared `Schedule manager APP/Workers`
  folder to `Schedule manager APP/<CompanyName>/Workers`, company name
  resolved server-side from the tenant's own `Tenants` row (never trusted
  from the client, so a tenant can't spoof another firm's folder).
- Filename gains the company name: `<docNumber>_<given>_<surname>.pdf` →
  `<docNumber>_<given>_<surname>_<companyName>.pdf`.
- Form 101 section א ("פרטי המעסיק") has **no real AcroForm fields** on the
  template (confirmed via `page.widgets()` — same situation as the page-1 ID
  box and tax-year box documented in `form101-field-map.md`) — `companyName`/
  `deductionsFileNumber`/`phone`/address will need hand-drawn coordinates
  found the same verified way (render + `page.get_drawings()` + crop) before
  wiring into `aiFillForm101()`.
