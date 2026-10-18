# Firestore migration plan

> **Done.** The migration is finished; Apps Script and the Google Sheets mode were removed on 2026-10-03 (see [history.md](../../docs/history.md)). Below is the original plan, kept as a historical document. The current design is in [backend.md](../../docs/backend.md).

Moving the database from Google Sheets + Apps Script to **Firestore (Standard, region `europe-west3`, Frankfurt)**
in the Firebase project `schedule-odinson`. The site (Hosting) and the Cloud Functions stay where they are.

## Why

- **A Google Sheet holds at most 10 million cells.** With 20 firms of ~50 workers each, punches add
  ~52k rows × 16 columns ≈ 830k cells a month, so the sheet would fill up in about a year.
- **Speed.** Every Apps Script call takes 1.5–10 s (Timings: login 10–17 s, load 2.5–5 s).
  Firestore answers in 0.1–0.5 s, with no server wake-up.
- **One JSON per firm.** All of a firm's workers are stored in one cell, and every save
  rewrites it whole; two managers saving at once get a conflict. In Firestore every
  worker, client and punch is a document of its own.
- Real-time updates: a worker's punch shows up at the manager's at once, without a reload.

## What doesn't change

- All payroll and accounting math in the browser: `groupPunchesIntoShifts`, `shiftPay`,
  the Israeli rates, supplier payouts, client billing, the Excel/PDF/CSV exports.
  Only **where** the data comes from changes.
- The UI, the roles (superadmin / tenant_admin / staff / supplier) and the per-section rights.
- Form 101 (Cloud Function `fill_form_101`) and scan preprocessing (`preprocess_scan`).
- User logins and passwords: nobody has to change a password.

## Data model

```
tenants/{tenantId}                     firm profile (name, תיק ניכויים, phone, address), active,
                                       workerCount/clientCount
tenants/{tenantId}/workers/{workerId}  one document per worker (all current fields, the photo included —
                                       ~10 KB, the document limit is 1 MB); files go to Storage, the document holds links
tenants/{tenantId}/clients/{clientId}
tenants/{tenantId}/suppliers/{supplierId}
tenants/{tenantId}/punches/{punchId}   workerId, clientId, type (in/out), ts (Timestamp),
                                       date 'yyyy-MM-dd', time, GPS fields, notes, editedAt
tenants/{tenantId}/pendingHours/{batchId}  the hours import queue (status, rows[], fileName, author)
tenants/{tenantId}/settings/schedule   weekStart and other small settings
users/{uid}                            username, tenantId, role, permissions, supplierId, active
                                       (the password hash only in a closed collection, see "Login")
authSecrets/{uid}                      algo, salt, hash, wrong-attempt counter — never readable by a client
usernames/{username}                   { uid } — a unique username and a fast lookup at login
workerTokens/{token}                   { tenantId, workerId } — for the worker's punch link
pushSubscriptions/{id}
errors/{id}, timings/{id}              logs (read by superadmin only)
```

Punches are read **by period**, not whole: opening the app loads the current and the previous month;
accounting and exports for another period load the months they need. "All Time" is limited to
the last 12 months: otherwise it is ~30k reads per firm at a time.

## Login and rights

- **Login through the Cloud Function `login`.** It checks the username and password against the current hashes
  (moved over from the Users sheet as they are) and issues a Firebase **custom token** with the rights in its claims:
  `tenantId, role, permissions, supplierId`. The browser signs in with `signInWithCustomToken`.
  - Passwords are not moved into Firebase Auth and are not reset: the hash format stays ours.
  - Firebase Auth keeps the session from then on (it renews itself). The home-made 6-hour tokens
    and `requireAuth` go away.
- **Firestore security rules** repeat the server's current checks:
  - a firm sees only its own data (`request.auth.token.tenantId == tenantId`), superadmin sees all;
  - writing workers/clients/suppliers/schedule: tenant_admin, or staff with the `schedule` right;
  - approving an hours import: tenant_admin/superadmin only; staff may upload but not approve;
  - the firm profile: the firm's tenant_admin; creating and deleting firms — superadmin only;
  - the error and timing logs: any signed-in user writes, only superadmin reads.
- **A supplier never reads Firestore directly.** Rates and GPS can't be hidden by rules
  field by field, so the supplier portal works through functions that return trimmed
  data — the same logic as `_stripWorkerForSupplier` / `_stripClientForSupplier` today.
- **The worker's punch link** (no login) goes through the function `punch`:
  token → firm/worker, the punch written on the server. The offline queue on the worker's phone
  stays as it is.

## Stages (each a separate PR, merged after the owner's OK)

1. **Model and rules.** ✅ `firestore.rules`, `storage.rules`, `firestore.indexes.json`, the settings
   in `firebase.json`, a CI deploy (`.github/workflows/deploy-rules.yml`: tests first, then the deploy).
   Tests on the emulator (`tests/rules`, `npm install && npm test`): 12 scenarios — firm isolation,
   every role × every collection, a supplier with no direct access, the hours queue, the firm profile,
   closed collections, logs, Storage. The app is not touched yet.
2. **Login.** ✅ The folder `functions-auth/` — a separate set of functions in `europe-west3` (Frankfurt, next to the database),
   so that login doesn't load the heavy OpenCV/PyMuPDF of `functions/`:
   - `login` — checks the password, issues a custom token with the rights;
   - `users_admin` — `listUsers` / `createUser` (a new firm) / `createTenantUser` / `updateUser` /
     `resetUserPassword` / `deleteUser`, with the same rules and error texts as in Apps Script.
   The old password hash is replaced by scrypt at the first login. After 5 wrong passwords in a row, login
   is closed for 5 minutes. Changing rights, resetting a password or deleting a user ends their sessions.
   Tests: `tests/auth` on the Firestore and Auth emulators (13 scenarios), run in CI before the functions deploy.
   The app is not touched yet: the users appear in Firestore at stage 3.
3. **Data transfer.** ✅ The button **Admin → Firms → Copy to Firestore** (super-admin only).
   The function `migrate_from_sheets` takes the data through the Apps Script action `exportForMigration`
   (super-admin only, doesn't change the sheet) and lays it out in Firestore: logins with their current
   passwords, firms, workers with photos, workers' punch links, clients, suppliers, punches
   (archived ones too), the hours import queue. Firestore becomes a copy of the sheet: documents are written
   under the same ids, and whatever is no longer in the sheet is deleted. The run can be repeated any number of times.
   After a run, a "sheet → Firestore" table is shown for every firm, with errors and
   warnings (for example, a phone without its leading zero). Tests: `tests/auth/test_migrate.py`.
4. **The manager app on Firestore.** ✅ The file `firestore-backend.js`, loaded only
   in Firestore mode. The per-device switch: open the app with `?backend=firestore`
   (off — `?backend=sheets`); a "Firestore" badge appears in the header.
   - Login through the function `login`; an Apps Script login runs in parallel — its token is needed by the parts
     not moved yet (AI scan, documents in Drive, the admin tabs, hours import).
   - Workers, clients, suppliers: loaded straight from Firestore; a save writes only the
     changed documents (order — the `sortIndex` field) and deletes the removed ones.
   - Punches: a live subscription to the last 13 months — a punch from another device appears
     at once, without a reload. Adding/editing/deleting a punch goes to Firestore at once.
   - Rights are checked by the Firestore rules: staff without the `schedule` right reads but can't save.
   - Not done yet: a live update of the worker list (it updates on open).
   - Important: changes made in Firestore mode don't reach the sheet, and a repeated
     "Copy to Firestore" overwrites Firestore with the sheet's data. Until stage 8 the mode is
     for testing; working data stays in the sheet.
   - Checked in the browser on the real Firebase SDK with the Firestore and Auth emulators (25 checks).
5. **Admin.** ✅ In Firestore mode these moved to Firestore and the function `users_admin`:
   firms (list, enable/disable, delete, create), users, the firm profile, the error and
   timing logs (shown together with the sheet's rows), clearing punches by month, the hours
   import queue (upload, list, approve, reject), the super-admin's summary by firm.
   Login no longer waits for Apps Script: the function `login` itself issues the Apps Script token for the parts
   not moved yet (the secret `GS_SESSION_SECRET` in Secret Manager). In Admin → Timings,
   Firestore-mode measurements are separate rows ("… · Firestore").
   Left in Apps Script in Firestore mode: AI scan, Form 101 and documents in Drive, Copy to
   Firestore, the worker link. Deleting a firm in Firestore mode doesn't touch its Drive folder.
   Checked in the browser on the emulators (56 checks) and by function tests (28).
6. **The worker link and the supplier portal.** ✅ The same per-device switch `?backend=firestore`.
   - The worker link goes through the function `punch`: by the token in the link it returns only this
     worker and their sites (Apps Script used to return, for any link, the firm's whole worker list
     with rates and phones) and accepts punches only for them. The offline queue stays as it was.
   - The supplier portal: login through `login`, data and workers through the function `supplier`,
     with the same limits as in Apps Script (no rates, client billing or GPS).
   - A worker's punch shows up at once at a manager in Firestore mode.
   - Checked in the browser: 19 checks (worker → manager live, a punch for someone else is refused,
     a supplier sees only its own), function tests — 38.
7. **AI and files.**
   - **7a ✅ AI:** in Firestore mode all six AI calls (`aiReadDoc`, `aiReadSefach`,
     `aiDetectAlign`, `aiVerifyField`, `aiVerifyFields`, `aiReadHoursTable`) go to the function
     `ai_read` (the key is the secret `ANTHROPIC_API_KEY`). It is a port of the Apps Script code: the same requests to
     Anthropic, the same reply handling. The prompt texts were not rewritten by hand but generated
     from the Apps Script source (`functions-auth/ai_prompts.json`); the test runs the real Apps Script code and
     requires byte-identical requests and results (68 scenarios). One Apps Script delay less
     on every AI call during a scan.
   - **7b ✅ files:** in Firestore mode Form 101 (PDF), the scan with the signature (JSON for
     rebuilding the form) and the workers' documents (contract, visa, permit) are uploaded straight
     from the browser to Firebase Storage: `tenants/<firm>/workers/<worker>/{form101,assets,docs}/`,
     with real upload progress. Rights are checked by `storage.rules` (write — the firm owner
     or staff with the `workers` right). Reading the scan for a rebuild and deleting a file go through
     `users_admin` (`functions-auth/files.py`, own firm only) — so the bucket needs no
     manual CORS setup. Files saved to Drive earlier still open by their
     old links and are read and deleted through Apps Script; on a rescan the old file
     in Drive goes to the trash. When a firm is deleted, its files in Storage stay (like
     its Drive folder). Checked in the browser on the emulators: 21 checks.
8. **Switch-over.** A repeated transfer run right before the switch (takes minutes), then
   `BACKEND = firestore`. Apps Script stays read-only for another 1–2 weeks as a fallback,
   then it is turned off. Daily Firestore backups are turned on (a built-in feature, kept
   up to 14 weeks).
   - **In the code:** Firestore is the default mode on all three pages (manager, worker
     link, supplier portal); `?backend=sheets` keeps a device on the old mode.
     The "Copy to Firestore" button requires typing REPLACE after the switch. The "Move files
     to Firebase" button (function `migrate_files`) copies the workers' files from Drive to Storage and
     changes the links in the cards; it doesn't touch Drive, and a repeated run moves only the rest.
   - **Punches by month:** on open the app loads only the current month (plus the week
     before it); older months are read once, when they are picked in payroll, export,
     the punch log or the log cleanup. Fewer Firestore reads and a small browser cache.
   - **Order:** 1) ask everyone not to make changes; 2) "Copy to Firestore"; 3) merge
     the switch-over PR; 4) after the deploy — "Move files to Firebase"; 5) backups and a budget in the console.

**Rollback** at any stage before 8: the `BACKEND` switch back to `sheets` — the data in the sheet
is not touched until the very end.

## What was needed from the owner along the way

- [x] Firestore (Standard, `europe-west3` — Frankfurt) and Email/Password sign-in turned on.
- [x] **Firebase Storage** turned on; the deploy account given Firebase Rules Admin, Cloud Datastore
      Index Admin and Cloud Storage for Firebase Admin.
- [x] Stage 2: the **Service Account Token Creator** role for the functions' service account.
- [x] Stage 5: the secret `GS_SESSION_SECRET` (the value of `SESSION_SECRET` from the Apps Script Script Properties)
      in Secret Manager. The deploy account `firebase-adminsdk-…` needs the **Secret Manager Admin** role.
- [ ] Stage 4: a Firebase web app in the project (Project settings → Your apps → Web), otherwise
      `/__/firebase/init.json` on the site is empty and Firestore mode doesn't start.
- [x] Stage 7: the Anthropic key in **Secret Manager** (`ANTHROPIC_API_KEY`).
- [ ] Stage 8: turn on daily Firestore backups (Firestore → Disaster recovery).
- [ ] A spending alert (Billing → Budgets), for example $20/month.

## Decisions

1. **Files go to Firebase Storage** (decided 2026-10-01): Form 101, scans with the signature and pages,
   the workers' documents (contract, visa, permit). Path `tenants/{tenantId}/workers/{workerId}/…`,
   access by the same roles as the data. Old files in Drive are left alone: their links in the cards
   keep opening, new files go to Storage.
2. **Push reminders about shifts** — turned off, not part of the migration; to come back as a separate task
   when needed (the `pushSubscriptions` collection is kept in the model for it).

## Cost (an estimate; check in Firebase Console → Usage)

Free every day: 50k reads, 20k writes, 1 GB of storage. With 20 firms × 50 workers
the paid part is mostly reads when the app and accounting are opened: expected **$5–15 a month**.
Cloud Functions within the free tier (2 million calls a month).
