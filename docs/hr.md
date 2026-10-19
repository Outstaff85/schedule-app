# HR logins (role `hr`)

An HR manager's login inside one firm: it works with the workers assigned to it. This file is the architecture end to end — who creates it, what it sees, how ownership is stored and enforced at each layer. The Users pane UI itself is in [admin.md](admin.md), the worker record in [workers.md](workers.md), the rules and functions in full in [backend.md](backend.md).

## The model

- **Ownership = `workers/{id}.hrId`** — the uid of the HR login the worker belongs to, or absent (no HR). One worker has at most one HR. Workers created before HR existed have none until the owner assigns them.
- **Punches carry a copy: `punches/{id}.hrId`** — the worker's HR when the punch was written. Firestore rules can't look up the worker for every punch in a query, so the punch holds the field the rules (and the HR's query) filter on. A reassignment rewrites it (below).
- **Pending hours batches** are owned by `createdBy` (the uploader's uid), as for every role.
- **The login:** `users/{uid}` with `role:'hr'`, `permissions` (sections), `fullName` (required), `phone`, `ownOnly` — the sections, `ownOnly`, `showPay` and the hours ticks copied from its permission template (`templateId`; the default HR template: Schedule, Workers, own-only on — [admin.md](admin.md) → Users pane). Login puts into the custom token the claims `role`, `tenantId`, `perms` and `own` (= `ownOnly`); the reply also gives `ownOnly`, `fullName`, kept in the app session.

## Two kinds of HR

| | "Only own workers" on (`own:true`, default) | off (`own:false`) |
|---|---|---|
| Workers | only `hrId == uid`: read, add (always with its own `hrId`), edit, delete | the whole firm, like staff; may add with no `hrId` or its own |
| Punches | only `hrId == uid` | the whole firm |
| Pending hours | uploads (pending, the owner approves); sees only its own batches | uploads; sees all |
| Clients, suppliers, settings, firm doc | read; clients / suppliers written only with that section | same |
| Worker files (Storage) | uploads stamped with `hrId` metadata; reads back only those; other reads / deletes through `users_admin` with an ownership check | like staff |
| Tabs | its sections; never Today or Admin | same |
| Pay | never the full Accounting tab; with the Accounting section (its template's **Commission** tick, off by default) a reduced one (`hrPayOnly()`) — Salary for the workers whose `hrId` is its uid, read-only, with a "My commission" column (hours × its `commissionRate`; a worker paid by the day: days × its `commissionDayRate` when set, `commissionFor`), the Bank column and the pay window of the same workers, read-only — with **Edit pay** (`payEdit`, which also needs Workers or Schedule, the sections the rules let it write workers with) it edits those workers' pay and bank in the pay modal (`canEditPay(w)`: `w.hrId` is its uid). The rules enforce it too (Enforcement below); no other Accounting section, no export | same (still only the workers with its `hrId`) |

No HR, of either kind, and no staff login can change a worker's `hrId` — only the owner (`tenant_admin`) or a super-admin assigns (`firestore.rules`: a staff write keeps the stored `hrId`, and creates a worker without one).

## Who does what

- **Create / edit the HR:** Admin → Users (owner, super-admin) → `createTenantUser` / `updateUser` (`functions-auth/core.py`). The rights come from the template (a super-admin's change of the template reaches every HR on it); only a real change of sections or of `ownOnly` ends the HR's sessions (new claims on the next login) — the server compares them with what is stored; name and phone never do.
- **The owner's order is kept:** an own-workers HR sees only part of the list, so its saves keep each worker's stored `sortIndex` (`storedPos` in `firestore-backend.js`); a worker it adds goes to the end.
- **Duplicate check on edit too:** changing an existing worker's document number is checked across the firm the same way (`checkWorkerDoc` with `workerId`).
- **Assign workers:** the HR's card in Users (its worker list with Unassign, "Add workers" bulk picker) or the worker modal's HR field. Both go through `assignWorkersToHr(ids, hrId)` in `schedule-manager.html`: sets `hrId` on the workers, `autoSave()`, then `setPunchesHr` (`firestore-backend.js`, owner / super-admin only) rewrites `hrId` on every punch and every day-off / shift-offer request (`shiftRequests`) of those workers, 8 workers at a time — so the new HR sees the history and the old one loses it.
- **Hours approval:** an HR with an hours tick (`hourPerms`) reviews its workers' days in Accounting → `#accSecReview` (the shared React `HoursReview`, [hours-review.md](hours-review.md)) — and gets the Accounting tab for it even without the Accounting section; with "Only own workers" off it reviews every worker.
- **A worker added by an HR** gets `hrId` = its uid in `saveWorker()`.
- **Live list:** an HR session watches its workers (`watchHrWorkers` → `listenWorkers`): a worker the owner assigns appears, one taken away disappears, and a field the owner edits (a rate, a phone…) changes, without a reload (`applyHrWorkerChanges`, applied while no worker form, card or pay modal is open; a worker with edits of its own not yet saved keeps them). Its punches follow through the punch listener (`setPunchesHr` rewrites their `hrId`).

## Enforcement, layer by layer

1. **Firestore rules** (`firestore.rules`): helpers `isHr`, `hrMine` (own), `hrAll` (not own), `hrCan(t, section)`, `oldHr()` / `newHr()`. `manager(t)` includes `hrAll`. Workers: `hrMine` only where `oldHr()`/`newHr()` equal its uid; no HR write may change `hrId`; without `payEdit` an HR write leaves a worker's money as it was (`hrPayOk` / `samePay`: `hourlyRate`, `regRate`, `otRate`, `shabbatRate`, `payMode`, `travelAllowance`, `travelMonthly`, `bank`, `bankBranch`, `bankAccountNumber`, `clientRates`, `dayOverrides`; missing = null), and a worker it creates carries none of them (`hrNewPayOk` / `noPay`: each null, 0, '' or {}). In the app the same HR skips `saveWorker`'s client-rate rule (adding a rated client clears the own rate), which would be refused. Punches: `hrMine` only with `hrId == uid`. Pending hours: `hrMine` reads only `createdBy == uid`.
2. **Queries** (`firestore-backend.js`): the rules check the query itself, so for an own-workers HR (`hrOnly()` from the token claims, `myClaims()`) every read of workers / punches adds `where('hrId','==',uid)` and pending hours `where('createdBy','==',uid)`. Index: punches `hrId + ts`. `saveSchedule` diffs only what it loaded, so it never touches other HRs' workers, and skips clients / suppliers without that section (`mayWrite`).
3. **Stamping punches:** the punch link (`portal._save_punch`, from the worker document — never from the page), the app (`punchDoc`, from the worker's current `hrId` kept in `workerHr` after each load / save), approved hours (`approvePendingHours`, from the workers it reads).
4. **Storage** (`storage.rules`): uploads by staff / hr with `workers`; an own-workers HR must set `customMetadata.hrId` = its uid (done by `uploadWorkerFile`) and may read only files carrying it (the download link after an upload). Reads of the scan sidecar and deletes go through `users_admin` → `files.py`, which for an own-workers HR checks the worker's `hrId` (`worker_hr(wid)` in `main.py`). The rules avoid a cross-service Firestore lookup on purpose.
5. **Functions:** `checkWorkerDoc` (`core.py`) — a new worker's document number is checked across the whole firm (one query on `docKeys`, [backend.md](backend.md)) and the answer is only `{exists}`, so an HR learns nothing about workers it can't see. `ai_read` accepts `hr`.
6. **App UI** (visibility only): `hasPermission` limits `hr` like staff; `tabAllowed` / `HR_HIDDEN_TABS` hide Today and Admin; `homeTab()` lands it on its first tab; the HR field and HR names show only to the owner / super-admin; cached punches of a worker it no longer has are dropped (`mergeRemotePunches`).

## Tests

- Rules: `tests/rules/rules.test.mjs` — identities `hrOwn`, `hrOwnClients`, `hrAll`, `hrOwnB`; the HR block covers workers, punches, pending hours, shared data, owner assignment and Storage.
- Functions: `tests/auth/test_core.py` (`test_hr_user_create_login_update`, `test_check_worker_doc_answers_only_yes_or_no`), `test_files.py` (`test_hr_own_only_reaches_its_own_workers_files`), `test_portal.py` (`test_save_punch_stamps_the_workers_hr_never_the_pages`).

## Known limits

- A worker's past punches move with `setPunchesHr` only when the assignment is made in the app; an `hrId` written any other way leaves the punches as they were.
- Files uploaded before a reassignment keep the old HR in their metadata; the new HR still opens them through their stored links and `users_admin`.
