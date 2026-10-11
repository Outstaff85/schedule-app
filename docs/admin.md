# Admin tab

The Admin tab (`#sectionAdmin`) and the punch-log data behind it: the punch log, firms (every firm for the super-admin, the own firm for an owner), users, errors and timings. Code is in `schedule-manager.html`.

## Panes and who sees them

`switchTab('admin')` → `setupAdminPaneBar()`. The tab opens with **no section** (`#adminPane_none`, "Choose a section"): nothing is drawn or loaded until a section button is tapped (`switchAdminPane(pane)`, kept in `__adminPane` while the app stays open). `renderAdmin()` draws only while Punch Log is the open section.

| Pane | Who |
|---|---|
| Punch Log | everyone who can open the tab — the tab needs the `workers` permission |
| Firms, Users | `superadmin`, `tenant_admin` |

An `hr` login never sees the Admin tab ([hr.md](hr.md)).
| Errors, Timings | `superadmin` |

Layout (`.admin-pane-bar`): the section buttons in a row on a computer, a 3-column grid on a phone. The header buttons (`.head-actions`) are two equal buttons across the width on a phone.

The header buttons **Export CSV** and **Clear Log** show only on the Punch Log pane; Clear Log is only for `tenant_admin` and `superadmin`. Opening the tab as an owner also preloads the user list (`prefetchAdminUsers()`). The pane subtitles are in `ADMIN_PANE_SUBTITLES`.

## Punch log data

- **Storage:** punches live in `localStorage.punchLog` — `getPunchLog()` parses it on every call, `savePunchLog(log)` writes it.
- **Loading:** `syncPunchesFromGS()` → `gsLoadPunchLog()` → `mergeRemotePunches(remote)`:
  - `time` is rebuilt from `ts` in local time;
  - remote rows win by id;
  - local rows the server doesn't have are kept if they are newer than `__punchLoadedFrom`.
- **Loading by month:**
  - `gsLoadPunchLog()` starts a live listener (`listenPunches`) from `punchWindowStart()` = the 1st of this month minus 7 days; every later snapshot is merged and refreshes Today;
  - `__punchLoadedFrom` is the earliest time loaded in this app open;
  - `ensurePunchesSince(from)` reads older punches once (`punchesBetween(t, from, loadedFrom)`), merges them and lowers `__punchLoadedFrom`. Calls run one after another (`__punchEnsureChain`). `ensureAllPunches()` = from 2000-01-01;
  - `periodPunchStart(period)` gives the start a salary period needs (a past month starts one day early);
  - callers: the Accounting period, salary and hours exports, Export CSV, Clear Log, an approved hours batch, and "Load earlier month" / "Load all history" under the log;
  - cached rows older than what this app open loaded are dropped on merge, so the cache doesn't grow;
  - another firm's punches (super-admin summary) use the same window (`punchesOnce`).
- **Writing:**
  - `gsSavePunch(entry)` / `gsUpdatePunch(data)` / `gsDeletePunch(id)` write to Firestore directly;
  - `updatePunch` writes only `type`, `time`, `site`, `notes`, `clientId` and `editedAt`;
  - display helpers: `punchSite(e)` (the client from `clientId`, else the stored site, else the worker's first client), `punchClientObject(e)`, `latestOf(entries)`.

## Punch Log pane

- **Stats:** Total IN, Total OUT, Today and Total (over what is loaded) — four in a row, smaller on a phone.
- **Views:** Log (`setAdminView('log')`) or By Client (`setAdminView('clients')`), with the record count on the same line (`.admin-log-bar`).
- **Filters** (`.filters-grid`, `--cols:4` — one row on a computer, two columns without captions on a phone; see [workers.md](workers.md)):
  - Worker — the workers that appear in the log;
  - Client — the punch's own `clientId` (where it was recorded); a punch saved without one falls back to the worker's current clients;
  - Date — the days that have punches, as `en-GB` strings, newest day first (sorted by the real date);
  - Type.
  
  The list is sorted newest first by `ts`.
- **Table** (`renderAdmin()`): worker, client badges, IN/OUT, time, date, site, GPS (distance, ±accuracy, ⚠ when suspicious, or "Manual"), edit / delete.
  - **Drawing:** in pages of `LIST_PAGE` = 10 via `renderPagedList(el, 'punchLog', filters, rows, rowHtml, {table:true, colspan:8})`. The next 10 rows come when the user scrolls the "Show more" row into view, or taps it ([app-core.md](app-core.md) → Long lists). A redraw keeps the opened count; a new filter starts again at 10. Firms, Users, Errors, Timings and the client logs page the same way.
  - **Older punches:** under the table, `renderAdminOlder()` shows "Showing punches from <date>" with **Load earlier month** (`loadEarlierPunchMonth()` loads back to the 1st of the month already partly loaded, or the month before) and **Load all history**.
- **Edit:** a double click (computer) or a long press (phone) on a log row (or on a punch in By Client), anywhere but its delete button, opens `editPunchEntry(id)` → type, time, site (a client, or a kept custom site) and notes. `savePunchEntry(id)` sets `editedBy:'admin'` and `editedAt`, then calls `gsUpdatePunch`. `deletePunchEntry(id)` removes it locally and calls `gsDeletePunch`.
- **By Client** (`renderClientLogs()`): per client, its assigned workers with on-site-now status and their last 5 punches.
- **Export CSV** (`exportPunchCSV()`, after `ensureAllPunches()`): Worker, Supplier, Type, Time, Date, Site, Distance(m), GPS Accuracy (rounded), Notes, Edited.
- **Clear Log** (`clearPunchLog()`, after `ensureAllPunches()`):
  1. A month checklist with counts per month (`punchMonthKey(e)` from `date`, else `ts`); the user must type `DELETE`.
  2. `submitClearPunchLog()` downloads a CSV of exactly those rows first.
  3. Then `deletePunchesByMonths` runs (by `day`, or `ts` for a punch without `day`), and the rows are dropped from the local cache.

## Firms pane

**Firm owner** (`tenant_admin`): the own firm only (`renderOwnFirmCard`). The card shows the Form 101 fields (name, deductions file, phone, address), and which of them are missing; a double click (computer) or a long press (phone) on the card opens the edit form (`openMyFirmForm`). It is drawn from the session's profile, then from `refreshTenantProfile(0)`. The super-admin buttons (`#adminFirmsSuperBar`) are hidden. There is no separate Profile pane.

**Super-admin:**

- **List:** `renderFirmsList('adminFirmsList')` — the same function draws the super-admin's landing screen (`#firmsList`).
  - It draws the cached list first (`localStorage.firmsCache_v1`), then `listTenants`.
  - A row shows the name, "disabled", "profile incomplete" (`firmProfileMissing(t)`), worker and client counts, and the last save. Clicking a row → `switchToTenant()`.
  - Row actions:
    - edit (`openEditFirmForm`);
    - enable / disable (`toggleTenantActive` → `setTenantActive`);
    - delete (`confirmDeleteTenant` — confirm, then type the exact firm name → `deleteTenant`: the firm's data, its logins and every worker file in Storage).
- **Firm form** (`#editFirmOverlay`, one modal, `__firmFormMode`):
  - fields: company name, deductions file number, phone, street, street number, city;
  - Create (`openCreateFirmForm`) also asks for the owner's username and password → `createUser`;
  - Edit (`openEditFirmForm`, or `openMyFirmForm` for the firm's own profile) → `updateTenant`;
  - after saving: `cacheTenantProfile`, `refreshFirmProfileWarnings`, and `regenerateAllWorkerDocs()` when the edited firm is the one loaded (every worker's Form 101 employer block changes). For another firm, the rebuild waits until that firm is opened here (`form101Regen:<tenantId>`, `maybeRegenAfterFirmEdit`);
  - `openMyFirmForm()` prefills from the session and refreshes with `loadTenantProfile`, without overwriting what the user already typed (`__firmEditDirty`).
- **Buttons:**
  - **Payable summary (all firms)** — [accounting.md](accounting.md);
  - **New firm**.

## Users pane (owner, super-admin)

- **List** (`renderAdminUsers()`):
  - logins of the active firm only (`activeTenantIdForAdmin()`); `listUsers` returns more for a super-admin and is filtered here;
  - cached as `adminCache_users_<tenantId>`;
  - each row: the person's name (`fullName`, the login when it has none) with the role and an inactive flag; then `login: <username> · <phone>`; then the supplier (supplier role) or the permissions (staff, hr); an HR row also shows its worker count (`hrWorkerCount`), a supplier row the count of its supplier's workers.
- **Form** (`#userFormOverlay`), top to bottom:
  - Role;
  - Person: Full name, Phone;
  - Login: Username, Password;
  - Access: the supplier select (supplier), or the Sections tiles — each with the icon and name of the header tab or button it opens (Schedule, Workers, Clients, Suppliers, Accounting tabs, the Export button) — and, for HR, the "Edit own workers' pay" tile (permission `payEdit`, off by default) and the "Only own workers" tile (the checkbox-tile template, [app-core.md](app-core.md) → Layout); for a supplier the "Sees own workers' pay" tile (`showPay`, on by default); for HR "HR commission ₪/h" (`commissionRate`) and "₪/day (daily workers)" (`commissionDayRate`, empty = by the hour), side by side (`#userFormPayFields`) — an HR's pay view is its Accounting tile, whose hint then reads "Own workers' pay and commission only";
  - Workers — an HR's edit form only.
- **Create** (`openCreateUserForm`):
  - username, password, role (`staff` / `hr` / `supplier`, `onUserFormRoleChange`);
  - Full name and Phone for every role (the name is what the header and this list show; required only for HR);
  - `staff` and `hr`: section tiles from `PERMISSION_SECTIONS` (`schedule, workers, clients, suppliers, accounting, exports`), plus `payEdit` for HR only (cleared for any other role); picking HR checks only Workers; `hr` also gets "Only own workers" (`ownOnly`, on by default);
  - `supplier`: a supplier select;
  - saved with `createTenantUser`.
- **Edit** (`openEditUserForm`, a double click (computer) or a long press (phone) on the row anywhere but its delete button):
  - filled from the list the pane drew (its cache); the server is asked only when the row isn't there;
  - the username is locked;
  - the role can change between Staff, HR and Supplier (`updateUser` with `role`; the user signs in again; a former HR's workers are unassigned);
  - an owner's row shows only Full name, Phone and the password (`__editingAdminRow`); editing one's own row also updates the header name;
  - the password field reads "New password (empty = keep)"; filled in, it is sent first as `resetUserPassword`, which also ends the user's sessions;
  - then `updateUser` (`fullName`, `phone`; for HR also `ownOnly`, `commissionRate` and `commissionDayRate`; for a supplier `showPay` — these are rights: a change makes the user sign in again);
  - an HR's form, and a supplier's form, list their workers (`renderUserFormHrWorkers`, paged, each with Unassign) and have **Add workers** (`#hrAssignOverlay`: the firm's other workers with a search and checkboxes, a worker of another HR or supplier marked "now: <name>"; `submitHrAssign`). `userFormTeam()` picks what the section works on: an HR's workers are those whose `hrId` is its uid (`assignWorkersToHr`, which also moves their punches); a supplier's are those whose `supplierId` is the supplier picked in the form (`assignWorkersToSupplier`: sets `supplierId`, saves — punches carry no supplier), so every login of that supplier shares them; the section shows for a supplier also while creating, and redraws when the supplier select changes.
- Errors show in `#userFormError`.
- **Delete:** the row's trash button, `deleteUserConfirm` → `deleteUser`. A password is changed in the edit form (above).

The server rules (only staff/hr/supplier users are created here, own firm only, and so on): [backend.md](backend.md).

## HR logins

HR logins are created and edited here (form above); what they can do and how it is enforced: [hr.md](hr.md).

## Errors and Timings: the period picker

Both panes load one period at a time, picked in a select at the top:
- the options are "Last 30 days" (default), "Last 7 days", and each calendar month (this one and the 11 before it) — `logPeriodOptions` / `fillLogPeriodSelect`;
- `logPeriodRange(value)` gives `{key, from, to, label}` (ISO times), sent to `loadErrors` / `loadTimings` as `from` / `to` (`logPeriodQuery`);
- each period has its own cache (`adminCache_errors:<key>`, `adminCache_timings:<key>`);
- **Copy all** and **Print** take only the loaded period. Print (`printLogPane('errors' | 'timings')`) opens a plain page with a table (for timings, the summary first) and prints it.

Rows are compact: one bordered box (`.log-box`), one row per entry (`.log-row`), and a small copy button per row. Times are shown as `04.10 10:18` (`_shortWhen`). The rows are paged by 10.

## Errors pane (super-admin)

`loadErrorsList('adminErrorsList')` draws the period's cached list, then loads `loadErrors` for the period. The list shows the count and the period, then one row per error: time, page, source, user on the first line, the message under it. Each row has a copy button (`copyErrorRow` → `copyTextToClipboard`); "Copy all" is `copyAllErrors`. The old standalone `#errorsScreen` (`openErrorsScreen`) has no UI caller and loads without a period (the newest 100).

## Timings pane (super-admin)

`loadTimingsPane()` → `loadTimings` for the picked period.

`renderTimingsPane()` shows:
- **summary cards** (`_timingsSummary`, `.tm-card`) — one per kind over the period, without aborted runs. Each shows the count, the median and 90th percentile of the total, and the median of each step (`TIMING_PHASES`; a slow AI call `gs:ai…` uses `TIMING_AI_PHASES`: time at Anthropic, retry pauses) as small pills. A slow AI call's row also shows `_timingAiNote`: the `part`, tries, output / input / cache tokens and a stop reason other than `end_turn`. Every slow data call adds a kind (`gs:<action>`), so the cards are paged by 10 as well (`renderPagedList`, grid);
- **all measurements**, newest first, paged by 10. Each row shows time, kind and total on the first line (a total above its kind's 90% is amber), the steps under it, then firm, user, device, pages and page kinds. Each row has a copy button (`copyTimingRow`).

"Copy all" (`copyAllTimings`) copies the summary and every measurement of the period as text. Kinds and how they are measured: [app-core.md](app-core.md) → Telemetry.
