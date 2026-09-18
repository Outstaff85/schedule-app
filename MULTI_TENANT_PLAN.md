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
- [ ] **Step 2 — frontend**: login screen + 24h session in
      `schedule-manager.html`, super-admin "Firms" screen + switcher,
      `worker-punch.html` sends its own worker token with every write so the
      backend can resolve the tenant without a login.
- [ ] **Step 3**: Form 101 section א (employer details) filled from the
      tenant's profile; Drive storage split into one folder per firm.

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
