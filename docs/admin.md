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

Layout: the app's template (variant 3, [app-core.md](app-core.md) → Layout) in every pane — figures on top, sections with a count, a line per item with a colored mark on the left (`t3Line`). The section buttons (`.admin-pane-bar`) are text tabs in one line (it scrolls sideways on a narrow phone), the open one highlighted. Admin has no list / cards toggle (no tables left).

The pane bar and the punch log's Log / By Client switch are glass tabs (the open one with the highlight line, redesign stage 8); every list is plates. A punch line's ✕ deletes **without asking**: the line collapses behind the Undo snack and `deletePunchEntry(id, el)` deletes the punch when the 5 s are up; until then its id is in `__punchDelPending` and the Log and By Client views leave it out, so a redraw during the Undo time doesn't bring the line back. **Export CSV** and **Clear Log** are icon buttons at the right of the punch log's Log / By Client line (`#adminHeaderActions`), shown only on the Punch Log pane; Clear Log is only for `tenant_admin` and `superadmin`. Opening the tab as an owner also preloads the user list (`prefetchAdminUsers()`). The pane subtitles are in `ADMIN_PANE_SUBTITLES`.

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

- **Stats:** Total IN, Total OUT, Today and Total (over what is loaded) — figures as text (`.t3-stats`).
- **Views:** Log (`setAdminView('log')`) or By Client (`setAdminView('clients')`) as text tabs, with the record count and the Export CSV / Clear Log icons on the same line (`.admin-log-bar`).
- **Filters** (`.filters-grid`, `--cols:4` — one row on a computer, two columns without captions on a phone; see [workers.md](workers.md)):
  - Worker — the workers that appear in the log;
  - Client — the punch's own `clientId` (where it was recorded); a punch saved without one falls back to the worker's current clients;
  - Date — the days that have punches, as `en-GB` strings, newest day first (sorted by the real date);
  - Type.
  
  The list is sorted newest first by `ts`.
- **Lines** (`renderAdmin()` → `punchLogLine(e)`, into `#adminTableBody`): a line per punch, green for IN and red for OUT on the left; the worker's avatar and name, under it IN/OUT · date · site · GPS (distance, ±accuracy, ⚠ when suspicious, or "Manual"); the time and a ✕ (delete) at the right. A tap opens the worker's card.
  - **Drawing:** in pages of `LIST_PAGE` = 10 via `renderPagedList(el, 'punchLog', filters, rows, punchLogLine)`. The next 10 rows come when the user scrolls the "Show more" row into view, or taps it ([app-core.md](app-core.md) → Long lists). A redraw keeps the opened count; a new filter starts again at 10. Firms, Users, Errors, Timings and the client logs page the same way.
  - **Older punches:** under the table, `renderAdminOlder()` shows "Showing punches from <date>" with **Load earlier month** (`loadEarlierPunchMonth()` loads back to the 1st of the month already partly loaded, or the month before) and **Load all history**.
- **Edit:** a tap, a double click or a long press on a punch line (in the log or By Client), anywhere but its ✕, opens `editPunchEntry(id)` → type, time, site (a client, or a kept custom site) and notes. `savePunchEntry(id)` sets `editedBy:'admin'` and `editedAt`, then calls `gsUpdatePunch`. `deletePunchEntry(id)` removes it locally and calls `gsDeletePunch`.
- **By Client** (`renderClientLogs()`): per client a section (its color dot, name, address; "N on site now · workers · total punches"), a line per assigned worker (green while on site; a tap opens its card) and its last 5 punches as small lines under it (`punchLogLine(e, 'sub')`: the time first).
- **Export CSV** (`exportPunchCSV()`, after `ensureAllPunches()`): Worker, Supplier, Type, Time, Date, Site, Distance(m), GPS Accuracy (rounded), Notes, Edited.
- **Clear Log** (`clearPunchLog()`, after `ensureAllPunches()`):
  1. A month checklist with counts per month (`punchMonthKey(e)` from `date`, else `ts`); the user must type `DELETE`.
  2. `submitClearPunchLog()` downloads a CSV of exactly those rows first.
  3. Then `deletePunchesByMonths` runs (by `day`, or `ts` for a punch without `day`), and the rows are dropped from the local cache.

## Firms pane

**Firm owner** (`tenant_admin`): the own firm only (`renderOwnFirmCard`), one template-3 line (green when Form 101 has everything, amber when not). It shows the Form 101 fields (name, deductions file, phone, address), and which of them are missing; a tap, a double click or a long press on the line opens the edit form (`openMyFirmForm`). It is drawn from the session's profile, then from `refreshTenantProfile(0)`. The super-admin buttons (`#adminFirmsSuperBar`) are hidden. There is no separate Profile pane.

**Super-admin:**

- **List:** `renderFirmsList('adminFirmsList')` — the same function draws the super-admin's landing screen (`#firmsList`).
  - It draws the cached list first (`localStorage.firmsCache_v1`), then `listTenants`.
  - A line per firm (template 3): green while active, amber when disabled or its profile is incomplete (`firmProfileMissing(t)`); the name, then worker and client counts and the last save (left out when the date can't be read), then "disabled" / "profile incomplete". A tap → `switchToTenant()`; a double click (computer), a long press (phone) or the ✎ at its right → `openEditFirmForm`; a bare ⋮ (Disable / Enable, Delete last in red) next to it; Select is always on (`startFirmsSelect`: Disable / Enable / Delete the ticked firms, `setTenantsActive`).
  - The landing screen's header row holds Create firm, the Language button (`placeLangButton` puts it in `#firmsActions`) and a Sign out icon.
  - Row actions:
    - edit (`openEditFirmForm`: the line's ✎, a double click or a long press);
    - enable / disable (`toggleTenantActive` → `setTenantActive`, in the ⋮);
    - delete (the ⋮'s Delete or the Select bar, `deleteTenantUndo`): never asks — the line collapses behind the Undo snack (`__firmDelPending` keeps it out of a redraw) and `deleteTenant` runs when the 5 s are up: the firm's data, its logins and every worker file in Storage.
- **Firm form** (`#editFirmOverlay`, one modal, `__firmFormMode`):
  - fields: company name, deductions file number, phone, street, street number, city;
  - Create (`openCreateFirmForm`) also asks for the owner's username and password → `createUser`;
  - Edit (`openEditFirmForm`, or `openMyFirmForm` for the firm's own profile) → `updateTenant`;
  - after saving: `cacheTenantProfile`, `refreshFirmProfileWarnings`, and `regenerateAllWorkerDocs()` when the edited firm is the one loaded (every worker's Form 101 employer block changes). For another firm, the rebuild waits until that firm is opened here (`form101Regen:<tenantId>`, `maybeRegenAfterFirmEdit`);
  - `openMyFirmForm()` prefills from the session and refreshes with `loadTenantProfile`, without overwriting what the user already typed (`__firmEditDirty`).
  - **WhatsApp reminder** (redesign stage 11a; shown only when the form edits the firm being worked in, `fillFirmWaField`): the message for a worker who has not punched in, a textarea saved on its own when it changes (`saveFirmWaTemplate` → `saveFirmMessages`; not part of `updateTenant`, so it never rebuilds Form 101s) into `tenants/{t}/settings/messages.waTemplate` (≤ 1000 chars; read by every manager-side login, written by a schedule writer — `firestore.rules` → settings). Empty, or the default text, = the default `waDefaultTemplate()` in the UI language: "Hi {full name}, you have not punched in today (shift {start} · {site})." Placeholders: `{full name}`, `{first name}`, `{start}` (today's planned start), `{site}` (the worker's first client, `workerSiteName`).
  - The button: a no-punch notice (notices sheet and bell panel) of a worker with a phone gets **WhatsApp** next to **Call** (`noPunchActs`). It opens `https://wa.me/<number>?text=<message>` in a new tab (`waLink` / `openWhatsApp`): the number is `waPhone(w.phone)` — digits only, `00` dropped, an Israeli `0XXXXXXXXX` → `972XXXXXXXXX`, at least 9 digits — and the message is the template filled in (`waMessage`). No API and no key; the owner taps Send in WhatsApp. The template is read with `loadFirmMessages` (cached 5 minutes) when the bell or a notices sheet opens.
- **Buttons:**
  - **Payable summary (all firms)** — [accounting.md](accounting.md);
  - **New firm**.

## Users pane (owner, super-admin)

- **List** (`renderAdminUsers()`):
  - logins of the active firm only (`activeTenantIdForAdmin()`); `listUsers` returns more for a super-admin and is filtered here;
  - cached as `adminCache_users_<tenantId>`;
  - the firm's owner (`tenant_admin`, with a pin) is always first, then a super-admin, then everyone by name;
  - a "Logins" section with the count and **New user**, then a line per login (template 3), its role as the colored mark (`USER_ROLE_COLOR`: owner amber with a pin, HR purple, supplier blue, client green, staff grey): the person's name (`fullName`, the login when it has none) with the role and an inactive flag; then `login: <username> · <phone>`; then the supplier (supplier role), the client (client role) or the permissions (staff, hr), with an HR's worker count (`hrWorkerCount`) or a supplier's count of its workers; then the hours ticks; a bare ⋮ at the right (Edit, Delete) and a swipe left on a phone (Edit, Delete). **Delete never asks**: the line collapses behind the Undo snack (`deleteUserConfirm(id, username, el)` → `undoDelete`) and `deleteUserNow(id)` (`deleteUser`) runs only when its 5 s are up. Select is always on (`startUsersSelect`): every line but the owner's (and a super-admin's, `USER_UNSELECTABLE`) gets a tick box; the glass bar's Delete removes the picked logins the same way (one Undo for all).
- **Form** (`#userFormOverlay`), an editor of section plates ([app-core.md](app-core.md) → Editors; a head, `drawUserFormHead`: the avatar in the role's colour with the initials, the full name (live), "HR · 14 own workers" / the role and its supplier or client, a role pill under it, and for a saved login a ⋮ with Delete, `openUserFormMenu`; Person & login has the Role switch at its end, after the username and password; the HR commission section's summary is the rate and this month's commission on its workers; in the owner's fixed order: **Person & login** (the Role as a switch Staff / HR / Supplier / Client, full name, phone, username, password), **Sections** (`#userFormAccessHead`: supplier / client select, the portal or app section tiles), **Hours** (hours ticks, Only own workers, Sees own workers' pay), **HR commission**, **Own workers** (`#userFormHrWorkersField`); `userFormSections()` opens Person each time, and a section marked `data-auto` shows only while one of its fields does (`ogAutoSections`, run after every role change). One Save at the end. Field by field:
  - Role;
  - Person: Full name, Phone;
  - Login: Username, Password;
  - Access: the supplier select (supplier); for a client the client select and its portal ticks (Hours, Approve, Dispute, Schedule, Export — [client-portal.md](client-portal.md)); or the Sections tiles — each with the icon and name of the header tab or button it opens (Schedule, Workers, Clients, Suppliers, Accounting tabs, the Export button) — and, for HR, the "Edit own workers' pay" tile (permission `payEdit`, off by default) and the "Only own workers" tile (the checkbox-tile template, [app-core.md](app-core.md) → Layout); for a supplier the "Sees own workers' pay" tile (`showPay`, on by default); for HR "HR commission ₪/h" (`commissionRate`) and "₪/day (daily workers)" (`commissionDayRate`, empty = by the hour), side by side (`#userFormPayFields`) — an HR's pay view is its Accounting tile, whose hint then reads "Own workers' pay and commission only";
  - Workers — an HR's edit form only.
- **Create** (`openCreateUserForm`):
  - username, password, role (`staff` / `hr` / `supplier` / `client`, `onUserFormRoleChange`);
  - for a supplier its portal tabs (`.userFormSupSecCb` → `supplierSections`: Dashboard, My Workers, My Hours; all ticked for a new one);
  - for HR, supplier and client one **Hours** block (`.userFormHourPermCb` → `hourPerms`: hours, approve, dispute, fix, schedule, export — [hours-review.md](hours-review.md)), and **Only own workers** at the bottom (an HR may untick it; locked on for a supplier and a client);
  - Full name and Phone for every role (the name is what the header and this list show; required only for HR);
  - `staff` and `hr`: section tiles from `PERMISSION_SECTIONS` (`schedule, workers, clients, suppliers, accounting, exports`), plus `payEdit` for HR only (cleared for any other role); picking HR checks only Workers; `hr` also gets "Only own workers" (`ownOnly`, on by default);
  - `supplier`: a supplier select;
  - saved with `createTenantUser`.
- **Edit** (`openEditUserForm`, a tap, a double click or a long press on the line anywhere but its ✕):
  - filled from the list the pane drew (its cache); the server is asked only when the row isn't there;
  - the username is locked;
  - the role can change between Staff, HR and Supplier (`updateUser` with `role`; the user signs in again; a former HR's workers are unassigned);
  - an owner's row shows only Full name, Phone and the password (`__editingAdminRow`); editing one's own row also updates the header name;
  - the password field reads "New password (empty = keep)"; filled in, it is sent first as `resetUserPassword`, which also ends the user's sessions;
  - then `updateUser` (`fullName`, `phone`; for HR also `ownOnly`, `commissionRate` and `commissionDayRate`; for a supplier `showPay` — these are rights: a change makes the user sign in again);
  - an HR's form, and a supplier's form, list their workers (`renderUserFormHrWorkers`, paged, each with Unassign) and have **Add workers** (`#hrAssignOverlay`: the firm's other workers with a search and checkboxes, a worker of another HR or supplier marked "now: <name>"; `submitHrAssign`). `userFormTeam()` picks what the section works on: an HR's workers are those whose `hrId` is its uid (`assignWorkersToHr`, which also moves their punches); a supplier's are those whose `supplierId` is the supplier picked in the form (`assignWorkersToSupplier`: sets `supplierId`, saves — punches carry no supplier), so every login of that supplier shares them; the section shows for a supplier also while creating, and redraws when the supplier select changes.
- Errors show in `#userFormError`.
- **Delete:** the line's ✕, `deleteUserConfirm` → `deleteUser`. A password is changed in the edit form (above).

The server rules (only staff/hr/supplier users are created here, own firm only, and so on): [backend.md](backend.md).

## HR logins

HR logins are created and edited here (form above); what they can do and how it is enforced: [hr.md](hr.md).

## Errors and Timings: the period picker

Both panes load one period at a time, picked in a select at the top:
- the options are "Last 30 days" (default), "Last 7 days", and each calendar month (this one and the 11 before it) — `logPeriodOptions` / `fillLogPeriodSelect`;
- `logPeriodRange(value)` gives `{key, from, to, label}` (ISO times), sent to `loadErrors` / `loadTimings` as `from` / `to` (`logPeriodQuery`);
- each period has its own cache (`adminCache_errors:<key>`, `adminCache_timings:<key>`);
- **Copy all** and **Print** take only the loaded period. Print (`printLogPane('errors' | 'timings')`) opens a plain page with a table (for timings, the summary first) and prints it.

The top row (`.pane-toolbar`) is the select and icon buttons in one line: Copy all, Print, Refresh and **Reset** (red). Each entry is a template-3 line with a copy button at the right (`.t3-ib`). Times are shown as `04.10 10:18` (`_shortWhen`). The lines are paged by 10.

**Reset** (`resetLogs()`, in both panes; labelled in Timings): after a confirm, `resetLogs` deletes every error and every measurement — all firms, all periods ([backend.md](backend.md)) — drops the cached periods (`adminCache_errors…`, `adminCache_timings…`) and reloads the pane; a toast gives the counts.

## Errors pane (super-admin)

`loadErrorsList('adminErrorsList')` draws the period's cached list, then loads `loadErrors` for the period. The list shows the count and the period, then a red-marked line per error: the message (wrapped in full), under it time · page · source · user. Each row has a copy button (`copyErrorRow` → `copyTextToClipboard`); "Copy all" is `copyAllErrors`. The old standalone `#errorsScreen` (`openErrorsScreen`) has no UI caller and loads without a period (the newest 100).

## Timings pane (super-admin)

`loadTimingsPane()` → `loadTimings` for the picked period.

`renderTimingsPane()` shows:
- **figures** on top: measurements, kinds, runs above their kind's 90%, aborted runs;
- **by kind** (`_timingsSummary`, `#timingsCards`) — a line per kind over the period, without aborted runs: the name with the count, the median of each step under it (`TIMING_PHASES`; a slow AI call `gs:ai…` uses `TIMING_AI_PHASES`: time at Anthropic, retry pauses), the median and 90th percentile of the total at the right. A slow AI call's row also shows `_timingAiNote`: the `part`, tries, output / input / cache tokens and a stop reason other than `end_turn`. Every slow data call adds a kind (`gs:<action>`), so the cards are paged by 10 as well (`renderPagedList`, grid);
- **all measurements**, newest first, paged by 10: a line each — the kind, the steps under it, then time, firm, user, device, pages and page kinds; the total at the right (amber, and an amber mark, when above its kind's 90%) and a copy button (`copyTimingRow`).

"Copy all" (`copyAllTimings`) copies the summary and every measurement of the period as text. Kinds and how they are measured: [app-core.md](app-core.md) → Telemetry.
