# Admin tab

The Admin tab (`#sectionAdmin`) and the punch-log data behind it: the punch log, firms (super-admin), users, errors, timings, firm profile, and the Firestore migration tools. Code is in `schedule-manager.html`.

## Panes and who sees them

`switchTab('admin')` → `renderAdmin()` + `setupAdminPaneBar()`. The pane bar (`switchAdminPane(pane)`):

| Pane | Who |
|---|---|
| Punch Log (default) | everyone who can open the tab — the tab needs the `workers` permission |
| Firms, Errors, Timings | `superadmin` |
| Users, Profile | `superadmin`, `tenant_admin` |

The header buttons **Export CSV** and **Clear Log** show only on the Punch Log pane; Clear Log is only for `tenant_admin` and `superadmin`. Opening the tab as an owner also preloads the user list (`prefetchAdminUsers()`). The pane subtitles are in `ADMIN_PANE_SUBTITLES`.

## Punch log data

- **Storage:** punches live in `localStorage.punchLog` — `getPunchLog()` parses it on every call, `savePunchLog(log)` writes it.
- **Loading:** `syncPunchesFromGS()` → `gsLoadPunchLog()` → `mergeRemotePunches(remote)`:
  - `time` is rebuilt from `ts` in local time;
  - remote rows win by id;
  - local rows the server doesn't have are kept (in Firestore mode only if they are newer than `__punchLoadedFrom`).
- **Firestore mode — loading by month:**
  - `gsLoadPunchLog()` starts a live listener (`listenPunches`) from `punchWindowStart()` = the 1st of this month minus 7 days; every later snapshot is merged and refreshes Today;
  - `__punchLoadedFrom` is the earliest time loaded in this app open;
  - `ensurePunchesSince(from)` reads older punches once (`punchesBetween(t, from, loadedFrom)`), merges them and lowers `__punchLoadedFrom`. Calls run one after another (`__punchEnsureChain`). `ensureAllPunches()` = from 2000-01-01;
  - `periodPunchStart(period)` gives the start a salary period needs (a past month starts one day early);
  - callers: the Accounting period, salary and hours exports, Export CSV, Clear Log, an approved hours batch, and "Load earlier month" / "Load all history" under the log;
  - cached rows older than what this app open loaded are dropped on merge, so the cache doesn't grow;
  - another firm's punches (super-admin summary) use the same window (`punchesOnce`).
- **Sheets mode:** `GET loadPunchLog` with two retries; the reply is the last ~12 months (live sheet).
- **Writing:**
  - `gsSavePunch(entry)` / `gsUpdatePunch(data)` / `gsDeletePunch(id)` go to Firestore directly or to Apps Script;
  - Firestore `updatePunch` writes only `type`, `time`, `site`, `notes`, `clientId` and `editedAt`;
  - display helpers: `punchSite(e)` (the client from `clientId`, else the stored site, else the worker's first client), `punchClientObject(e)`, `latestOf(entries)`.

## Punch Log pane

- **Stats:** Total IN, Total OUT, Today and Total (over what is loaded).
- **Views:** Punch Log (`setAdminView('log')`) or By Client (`setAdminView('clients')`).
- **Filters** (each with a caption, see [workers.md](workers.md)):
  - Worker — the workers that appear in the log;
  - Client — workers *currently* assigned to it, not the punch's `clientId`;
  - Date — `en-GB` date strings, sorted as text;
  - Type.
  
  The list is the log array reversed.
- **Table** (`renderAdmin()`): worker, client badges, IN/OUT, time, date, site, GPS (distance, ±accuracy, ⚠ when suspicious, or "Manual"), edit / delete.
  - **Drawing:** in pages of `LIST_PAGE` = 10 via `renderPagedList(el, 'punchLog', filters, rows, rowHtml, {table:true, colspan:8})`. The next 10 rows are added when the "Show more" row scrolls into view (IntersectionObserver) or is clicked. A redraw keeps the opened count; a new filter starts again at 10. `pagedMoreHtml` / `wirePagedMore` are the helpers; Errors and Timings use the same.
  - **Older punches:** under the table, `renderAdminOlder()` (Firestore mode only) shows "Showing punches from <date>" with **Load earlier month** (`loadEarlierPunchMonth()` loads back to the 1st of the month already partly loaded, or the month before) and **Load all history**.
- **Edit:** `editPunchEntry(id)` → type, time, site (a client, or a kept custom site) and notes. `savePunchEntry(id)` sets `editedBy:'admin'` and `editedAt`, then calls `gsUpdatePunch`. `deletePunchEntry(id)` removes it locally and calls `gsDeletePunch`.
- **By Client** (`renderClientLogs()`): per client, its assigned workers with on-site-now status and their last 5 punches.
- **Export CSV** (`exportPunchCSV()`, after `ensureAllPunches()`): Worker, Supplier, Type, Time, Date, Site, Distance, then Notes and Edited.
  - **Known bug:** the header also lists "GPS Accuracy", but the rows don't fill it, so Notes and Edited sit one column to the left of their headings.
- **Clear Log** (`clearPunchLog()`, after `ensureAllPunches()`):
  1. A month checklist with counts per month (`punchMonthKey(e)` from `date`, else `ts`); the user must type `DELETE`.
  2. `submitClearPunchLog()` downloads a CSV of exactly those rows first.
  3. Then `deletePunchesByMonths` runs (Firestore: by `day`/`ts`; Apps Script: live and archive sheets), and the rows are dropped from the local cache.

## Firms pane (super-admin)

- **List:** `renderFirmsList('adminFirmsList')` — the same function draws the super-admin's landing screen (`#firmsList`).
  - It draws the cached list first (`localStorage.firmsCache_v1`, also filled from the login reply), then `listTenants`.
  - A row shows the name, "disabled", "profile incomplete" (`firmProfileMissing(t)`), worker and client counts, and the last save. Clicking a row → `switchToTenant()`.
  - Row actions:
    - edit (`openEditFirmForm`);
    - enable / disable (`toggleTenantActive` → `setTenantActive`);
    - delete (`confirmDeleteTenant` — confirm, then type the exact firm name → `deleteTenant`).
- **Firm form** (`#editFirmOverlay`, one modal, `__firmFormMode`):
  - fields: company name, deductions file number, phone, street, street number, city;
  - Create (`openCreateFirmForm`) also asks for the owner's username and password → `createUser`;
  - Edit (`openEditFirmForm`, or `openMyFirmForm` for the firm's own profile) → `updateTenant`;
  - after saving: `cacheTenantProfile`, `refreshFirmProfileWarnings`, and `regenerateAllWorkerDocs()` when the edited firm is the one loaded (every worker's Form 101 employer block changes);
  - `openMyFirmForm()` prefills from the session and refreshes with `loadTenantProfile`, without overwriting what the user already typed (`__firmEditDirty`).
- **Buttons:**
  - **Payable summary (all firms)** — [accounting.md](accounting.md);
  - **New firm**;
  - **Copy to Firestore** — `runFirestoreMigration()` → `migrate_from_sheets` with the Apps Script token; shows per-firm sheet → Firestore counts (`migrationReportHtml`). Since the switch to Firestore it asks to type `REPLACE`, because a copy overwrites newer Firestore data with the sheets;
  - **Move files to Firebase** — `runFileMove()` → `migrate_files`; a report with Workers / Moved / Not in Drive / Left per firm (`fileMoveReportHtml`); "Not finished" means run it again. See [backend.md](backend.md).

## Users pane (owner, super-admin)

- **List** (`renderAdminUsers()`): logins of the active firm only (`activeTenantIdForAdmin()`); `listUsers` returns more for a super-admin and is filtered here. Cached as `adminCache_users_<tenantId>`. Each row shows the name, role, inactive flag, and the supplier (supplier role) or the permissions (staff).
- **Form** (`#userFormOverlay`):
  - **Create** (`openCreateUserForm`): username, password, role (`staff` / `supplier`, `onUserFormRoleChange`). `staff` gets permission checkboxes from `PERMISSION_SECTIONS` (`schedule, workers, clients, suppliers, accounting, exports`); `supplier` gets a supplier select. Saved with `createTenantUser`.
  - **Edit** (`openEditUserForm`): the username is locked and there is no password field; `updateUser`.
  - Errors show in `#userFormError`.
- **Password and delete:** `resetUserPasswordPrompt(id)` → `resetUserPassword`; `deleteUserConfirm` → `deleteUser`.

The server rules (only staff/supplier users are created here, own firm only, and so on): [backend.md](backend.md).

## Errors pane (super-admin)

`loadErrorsList('adminErrorsList')` draws the cached list (`adminCache_errors`), then `loadErrors`. In Firestore mode the Firestore `errors` merge with the Apps Script sheet rows (newest first, max 100). The list is paged by 10. Each row has a copy button (`copyErrorRow` → `copyTextToClipboard`). The old standalone `#errorsScreen` (`openErrorsScreen`) has no UI caller.

## Timings pane (super-admin)

`loadTimingsPane()` → `loadTimings` (cached as `adminCache_timings`; in Firestore mode merged with the sheet, max 500).

`renderTimingsPane()` shows:
- **summary** — median and 90th percentile per kind over the last 7 days, without aborted runs. Firestore-mode measurements get their own row (`_timingKey` adds `|fs`; the label ends with "· Firestore"). It also shows the median per step (`TIMING_PHASES`);
- **latest rows** — paged by 10, each with a copy button (`copyTimingRow`).

"Copy all" (`copyAllTimings`) copies the summary and the latest 50 rows as text. Kinds and how they are measured: [app-core.md](app-core.md) → Telemetry.

## Profile pane (owner, super-admin)

One button, "Edit company profile" → `openMyFirmForm()`. The profile fills the Form 101 employer block ([form101.md](form101.md)). An incomplete profile colors the Admin tab icon amber.
