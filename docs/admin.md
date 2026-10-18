# Admin tab

The Admin tab (`#sectionAdmin`) and the punch-log data behind it: the punch log, firms (every firm for the super-admin, the own firm for an owner), users, errors and timings. The section tabs, the tiles and the Punch Log section are React (stage 6f-1: `src/manager/Admin.tsx` with its figures in `src/manager/punchlog.ts`, the root `#adminRoot`, drawn through `ManagerIsland.renderAdmin()`; the data and the saves through `ManagerBridge.admin()` and its actions — [build.md](build.md) → The manager's React pieces); the Firms, Users, Errors and Timings panes are still the page's code in `schedule-manager.html` (6f-2), shown under the React tabs.

## Panes and who sees them

`switchTab('admin')` → `setupAdminPaneBar()` (the super-admin bar of Firms, the users prefetch) → `switchAdminPane(__adminPane)`. The tab opens with **no section**: under the tabs "Choose a section" and **three large tiles** — Punch Log, Firms, Users (those the login sees; a plate each with its icon and what the section is for; the Firms tile amber while the firm's Form 101 profile is incomplete) — and nothing is loaded until a tab or a tile is tapped (`ManagerBridge.setAdminPane` → `switchAdminPane(pane)`, kept in `__adminPane` while the app stays open; a section the login doesn't see is no section). `switchAdminPane` shows the page's pane of a section not moved yet, loads it, and draws the React part (`renderAdmin()`, which `render()` and `switchTab` call too); the breadcrumb reads "Admin › <section>" from the lit tab.

| Pane | Who |
|---|---|
| Punch Log | everyone who can open the tab — the tab needs the `workers` permission |

The list is `adminPanes()` on the page (the React tabs draw only these).
| Firms, Users | `superadmin`, `tenant_admin` |

An `hr` login never sees the Admin tab ([hr.md](hr.md)).
| Errors, Timings | `superadmin` |

Layout: the app's template (variant 3, [app-core.md](app-core.md) → Layout) in every pane — figures on top, sections with a count, a line per item with a colored mark on the left (`t3Line` on the page's panes, `Plate` in the React Punch Log). The section tabs are the glass tabs (`.og-tabs`, icon + name; they scroll sideways on a narrow phone), the open one lit, and under them the open section's line (what it is for). Admin has no list / cards toggle (no tables left).

The punch log's Log / By Client switch is a segmented switch (`ToggleGroup`); every list is plates. A punch plate has a bare ⋮ (Edit, Delete) and a swipe on a phone; Delete never asks: the plate goes behind the React Undo snack and `ManagerBridge.deletePunches(ids)` (the page's `deletePunchesNow`: the cache, then `gsDeletePunch` each) runs when the 5 s are up; Select (a button above the log, the boxes after it) deletes the ticked punches the same way; until then the ids are kept in the tab (`hidden` in `Admin.tsx`) and the Log and By Client views leave them out, so a redraw during the Undo time doesn't bring them back. **Export CSV** and **Clear Log** are icon buttons at the right of the Log / By Client line; Clear Log is only for `tenant_admin` and `superadmin` (`canClear`). Opening the tab as an owner also preloads the user list (`prefetchAdminUsers()`). The section lines are `SUBTITLES` in `Admin.tsx`.

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
  - callers: the Accounting period, salary and hours exports, Export CSV, Clear Log, an approved hours batch, and "Load earlier month" / "Load all history" under the log (`ManagerBridge.loadEarlierPunches` / `loadAllPunches`);
  - cached rows older than what this app open loaded are dropped on merge, so the cache doesn't grow;
  - another firm's punches (super-admin summary) use the same window (`punchesOnce`).
- **Writing:**
  - `gsSavePunch(entry)` / `gsUpdatePunch(data)` / `gsDeletePunch(id)` write to Firestore directly;
  - `updatePunch` writes only `type`, `time`, `site`, `notes`, `clientId` and `editedAt`;
  - display helpers: `punchSite(e)` (the client from `clientId`, else the stored site, else the worker's first client), `punchClientObject(e)`, `latestOf(entries)`.

## Punch Log pane

Drawn by `PunchLog` in `src/manager/Admin.tsx` from `ManagerBridge.admin()`: `log` (the cached punches as stored, each with its site worked out by `punchSite` and its stored site text as `rawSite`; only while the section is open), the workers (id, name, clients), the clients (id, name, colour, address), `loadedFrom` and `canClear`. The figures are `src/manager/punchlog.ts`.

- **Stats:** Total IN, Total OUT, Today and Total (over what is loaded) — glass tiles (`Figures`, `logFigures`).
- **Views:** Log or By Client (a `ToggleGroup`), with the record count (Log) and the Export CSV / Clear Log icons on the same line; the view and the filters stay while the app stays open.
- **Filters** (four selects — one row on a computer, two columns on a phone; the caption is the select's label):
  - Worker — the workers that appear in the log;
  - Client — the punch's own `clientId` (where it was recorded); a punch saved without one falls back to the worker's current clients;
  - Date — the days that have punches, as `en-GB` strings, newest day first (sorted by the real date);
  - Type.

  `filterChoices` / `filterLog`; the list is sorted newest first by `ts`.
- **Plates** (a `Plate` per punch, `PagedList` in up to three columns): green for IN and red for OUT on the left; the worker's name, under it IN/OUT · date · site · GPS (distance, ±accuracy, ⚠ with the warnings as its title when suspicious, or "Manual"); the time at the right; ⋮ and a swipe.
  - **Drawing:** 10 at first, the next 10 when the user scrolls the "Show more" row into view, or taps it ([app-core.md](app-core.md) → Long lists). A redraw keeps the opened count; a new filter starts again at 10 (the list is keyed by the filters).
  - **Older punches:** under the list, while not everything is loaded, "Showing punches from <date>" with **Load earlier month** (`loadEarlierPunchMonth()` loads back to the 1st of the month already partly loaded, or the month before) and **Load all history** (`ensureAllPunches()`).
- **Edit:** a tap, a double click or a long press on a punch plate (in the log or By Client; with a mouse a single click waits 250 ms for a double one, `useTapOpen`), or ⋮ → Edit, opens the punch window (`Window`): type, time, site (a client, "— No site —", or a kept custom site) and notes; **Save Changes** → `ManagerBridge.savePunch(id, edit)` → the page's `savePunchEdit`: a client sets `clientId` and its name as `site`, no site clears `clientId` and puts the worker's client name, the custom site is kept as it was; `editedBy:'admin'` and `editedAt`; then `gsUpdatePunch`, `render()` and the toast.
- **By Client** (`byClient`): per client a panel (its colour dot, name, address; "N on site now · N workers · N total punches"), a plate per assigned worker (green while on site — today's latest punch is IN; "In since …" / "Last: … (IN/OUT)" / "No records today"; "N records" at the right; a tap opens its card) and its last 5 punches, newest first, as small plates under it (the time as the name; a tap edits).
- **Export CSV** (`ManagerBridge.exportPunches()` → `ensureAllPunches()` then the page's `exportPunchCSV()`): Worker, Supplier, Type, Time, Date, Site, Distance(m), GPS Accuracy (rounded), Notes, Edited.
- **Clear Log** (owner / super-admin; after `ensureAllPunches()`), **behind the Alert Dialog** (it asks, as an irreversible action; it does not close on the backdrop):
  1. A month checklist with counts per month (`monthCounts` / `punchMonthKey`: from `date`, else `ts`) and Select all; the user must type `DELETE`; Delete (with the count) is off until a month is ticked and the word typed; Cancel keeps everything.
  2. `ManagerBridge.clearPunchMonths(months)` → the page's `clearPunchMonths`: downloads a CSV of exactly those rows first,
  3. then `deletePunchesByMonths` runs (by `day`, or `ts` for a punch without `day`), the rows are dropped from the local cache, `render()`, and the toast gives the count. A failure keeps the dialog open with its toast.

## Firms pane

**Firm owner** (`tenant_admin`): the own firm only (`renderOwnFirmCard`), one template-3 line (green when Form 101 has everything, amber when not). It shows the Form 101 fields (name, deductions file, phone, address), and which of them are missing; a tap, a double click or a long press on the line opens the edit form (`openMyFirmForm`). It is drawn from the session's profile, then from `refreshTenantProfile(0)`. The super-admin buttons (`#adminFirmsSuperBar`) are hidden. There is no separate Profile pane.

**Super-admin:**

- **List:** `renderFirmsList('adminFirmsList')` — the same function draws the super-admin's landing screen (`#firmsList`).
  - It draws the cached list first (`localStorage.firmsCache_v1`), then `listTenants`.
  - A line per firm (template 3): green while active, amber when disabled or its profile is incomplete (`firmProfileMissing(t)`); the name, then worker and client counts and the last save (left out when the date can't be read), then "disabled" / "profile incomplete". A tap → `switchToTenant()`; a double click (computer), a long press (phone) or the ✎ at its right → `openEditFirmForm`; a bare ⋮ (Disable / Enable, Delete last in red) next to it; Select (a button, the boxes after a tap; `startFirmsSelect`: Disable / Enable / Delete the ticked firms, `setTenantsActive`).
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
  - a "Logins" section with the count and **New user**, then a line per login (template 3), its role as the colored mark (`USER_ROLE_COLOR`: owner amber with a pin, HR purple, supplier blue, client green, staff grey): the person's name (`fullName`, the login when it has none) with the role and an inactive flag; then `login: <username> · <phone>`; then the supplier (supplier role), the client (client role) or the permissions (staff, hr), with an HR's worker count (`hrWorkerCount`) or a supplier's count of its workers; then the hours ticks; a bare ⋮ at the right (Edit, Delete) and a swipe left on a phone (Edit, Delete). **Delete never asks**: the line collapses behind the Undo snack (`deleteUserConfirm(id, username, el)` → `undoDelete`) and `deleteUserNow(id)` (`deleteUser`) runs only when its 5 s are up. Select (a button, the boxes after a tap; `startUsersSelect`): every line but the owner's (and a super-admin's, `USER_UNSELECTABLE`) gets a tick box; the glass bar's Delete removes the picked logins the same way (one Undo for all).
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
