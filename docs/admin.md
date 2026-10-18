# Admin tab

The Admin tab (`#sectionAdmin`) and the punch-log data behind it: the punch log, firms (every firm for the super-admin, the own firm for an owner), users, errors and timings. The whole tab is React, inside the old page: the section tabs, the tiles and the Punch Log (stage 6f-1: `src/manager/Admin.tsx` with its figures in `src/manager/punchlog.ts`), Firms (`src/manager/Firms.tsx`), Users (`src/manager/Users.tsx` with its rules in `src/manager/users.ts`), Errors and Timings (`src/manager/Logs.tsx` with its figures in `src/manager/adminlogs.ts`) (stage 6f-2), all drawn into the root `#adminRoot` through `ManagerIsland.renderAdmin()`; the super-admin's landing screen's firms into `#firmsScreenRoot` (`renderFirmsScreen()`); the firm, user and Add workers windows into the page's overlays `#editFirmOverlay` / `#userFormOverlay` / `#hrAssignOverlay` (`openFirm()`, `openUser()`, `openAssign()`). The data, its caches, the saves of workers and the server calls stay on the page and go through `ManagerBridge.admin()` and its actions ([build.md](build.md) → The manager's React pieces).

## Panes and who sees them

`switchTab('admin')` → `setupAdminPaneBar()` (the users prefetch for an owner / super-admin) → `switchAdminPane(__adminPane)`. The tab opens with **no section**: under the tabs "Choose a section" and **three large tiles** — Punch Log, Firms, Users (those the login sees; a plate each with its icon and what the section is for; the Firms tile amber while the firm's Form 101 profile is incomplete) — and nothing is loaded until a tab or a tile is tapped (`ManagerBridge.setAdminPane` → `switchAdminPane(pane)`, kept in `__adminPane` while the app stays open; a section the login doesn't see is no section). `switchAdminPane` keeps the section, starts the load of Errors / Timings and draws the tab (`renderAdmin()`, which `render()` and `switchTab` call too; Firms and Users load their own data when they are drawn); the breadcrumb reads "Admin › <section>" from the lit tab.

| Pane | Who |
|---|---|
| Punch Log | everyone who can open the tab — the tab needs the `workers` permission |
| Firms, Users | `superadmin`, `tenant_admin` |
| Errors, Timings | `superadmin` |

The list is `adminPanes()` on the page (the React tabs draw only these). An `hr` login never sees the Admin tab ([hr.md](hr.md)).

Layout: the app's template (variant 3, [app-core.md](app-core.md) → Layout) in every section — figures on top, sections with a count, a `Plate` per item with a coloured bar on the left. The section tabs are the glass tabs (`.og-tabs`, icon + name; they scroll sideways on a narrow phone), the open one lit, and under them the open section's line (what it is for). Admin has no list / cards toggle (no tables left).

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
  - display helpers: `punchSite(e)` (the client from `clientId`, else the stored site, else the worker's first client), `latestOf(entries)`.

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

Drawn by `FirmsPane` in `src/manager/Firms.tsx` from `ManagerBridge.admin()`: `isSuper`, `firms` (a super-admin's list — the cached one, `localStorage.firmsCache_v1`, until `listTenants` answers — each row with `missing`, what Form 101 would leave empty, `firmProfileMissing(t)`; null until something is there, with `firmsError`), `own` (an owner's own profile with its `missing`) and `locale`. Drawing the section (and the landing screen) calls `ManagerBridge.loadFirms()` → the page's `loadFirms()`: for a super-admin `listTenants` (saved in the cache and `__firmsCache`), for an owner `refreshTenantProfile(0)`; then both views draw again (`renderFirmsViews`). Skeleton plates while nothing is loaded.

**Firm owner** (`tenant_admin`): the own firm only (`OwnFirm`): one large plate (green when Form 101 has everything, amber when not) with the Form 101 fields (name, deductions file, phone, address) and which of them are missing; a tap, a double click or a long press opens the firm window for the firm being worked in (`openFirmWindow('mine')` → the page's `openMyFirmForm`). There is no super-admin bar and no separate Profile pane.

**Super-admin:**

- **List** (`FirmsList`, the same component on the landing screen `#firmsScreen` — its header, Create firm, the Language button (`placeLangButton` → `#firmsActions`) and Sign out stay the page's HTML — and in Admin → Firms):
  - a plate per firm (`PagedList columns`): green while active, amber when disabled or its profile is incomplete; the name, then worker and client counts and the last save (left out when the date can't be read), then "disabled" / "profile incomplete" (its title lists the missing fields);
  - a tap → `openFirm(id)` → `switchToTenant()` (with a mouse a single click waits 250 ms for a double one, `useTapOpen`); a double click, a long press or the ✎ at its right → the firm window (`openFirmWindow('edit', id)` → `openEditFirmForm`); ⋮: Edit, Disable / Enable (`setFirmsActive` → the page's `setTenantsActive`: `setTenantActive` each, its toast, the list again), Delete; a swipe left on a phone (Edit, Delete);
  - **Delete never asks**: the plate goes behind the React Undo snack (`hiddenFirms` keeps it out of a redraw) and `deleteFirms(ids)` (the page's `deleteTenantsNow`: `deleteTenant` each — the firm's data, its logins and every worker file in Storage — then the toast and the list) runs when the 5 s are up;
  - **Select** (a button above the list): Disable / Enable / Delete the ticked firms.
- **Admin → Firms only:** above the list **Payable summary (all firms)** (a toggle, kept open while the app is) and **New firm**. The summary (`firmsPayable()` → the page's `firmsPayableRows()`, [accounting.md](accounting.md) → Super-admin summary) shows a plate per firm with this week's hours and pay, "(load failed)" in red for a firm that could not be read, and the TOTAL on the section's line.
- **Firm window** (`FirmWindow`, drawn into `#firmModal` of `#editFirmOverlay`; what it edits is the page's `__firmWin` from `showFirmWindow(mode, tenantId, profile)`, read with `firmInfo()`):
  - fields: company name, deductions file number, phone, street, street number, city — their labels Hebrew, as Form 101 prints them; the note under the title Hebrew too;
  - **Create** (`openCreateFirmForm`) also asks for the owner's name, username and password → `createUser` (`adminCall`); a missing username or password is an error in the window;
  - **Edit** (`openEditFirmForm`, a firm of the list's cache) or the firm's own profile (`openMyFirmForm`, the session's copy at once, then `loadProfile()` — `loadTenantProfile` — fills the form unless something was already typed) → `updateTenant`;
  - after saving (`firmSaved` on the page): the window closes, the toast, `cacheTenantProfile`, the list again (super-admin), and `regenerateAllWorkerDocs()` when the edited firm is the one loaded (every worker's Form 101 employer block changes). For another firm, the rebuild waits until that firm is opened here (`form101Regen:<tenantId>`, `maybeRegenAfterFirmEdit`);
  - **WhatsApp reminder** (redesign stage 11a; shown only when the window edits the firm being worked in): the message for a worker who has not punched in, a textarea filled from `firmMessage()` (`loadFirmMessages(true)`, then `waTemplate()`) and saved on its own when it changes (on leaving the field: `saveFirmMessage` → the page's `saveFirmMessage` → `saveFirmMessages`; not part of `updateTenant`, so it never rebuilds Form 101s) into `tenants/{t}/settings/messages.waTemplate` (≤ 1000 chars; read by every manager-side login, written by a schedule writer — `firestore.rules` → settings). Empty, or the default text, = the default `waDefaultTemplate()` in the UI language: "Hi {full name}, you have not punched in today (shift {start} · {site})." Placeholders: `{full name}`, `{first name}`, `{start}` (today's planned start), `{site}` (the worker's first client, `workerSiteName`).
  - The button: a no-punch notice (notices sheet and bell panel) of a worker with a phone gets **WhatsApp** next to **Call** (`noPunchActs`). It opens `https://wa.me/<number>?text=<message>` in a new tab (`waLink` / `openWhatsApp`): the number is `waPhone(w.phone)` — digits only, `00` dropped, an Israeli `0XXXXXXXXX` → `972XXXXXXXXX`, at least 9 digits — and the message is the template filled in (`waMessage`). No API and no key; the owner taps Send in WhatsApp. The template is read with `loadFirmMessages` (cached 5 minutes) when the bell or a notices sheet opens.

## Users pane (owner, super-admin)

- **List** (`UsersPane` in `src/manager/Users.tsx`): drawing it calls `loadUsers()` → the page's `prefetchAdminUsers()` (`listUsers` through `fetchAdminUsers`, which a load in flight shares; the logins of the active firm only, `activeTenantIdForAdmin()` — `listUsers` returns more for a super-admin; cached as `adminCache_users_<tenantId>`; the HR names on the worker plates, Payable by HR and an open worker window draw again). The snapshot's `users` is that cache (null until it exists, with `usersError`), `team` the workers with their `hrId` / `supplierId`, `suppliers` and `clients` their names.
  - the firm's owner (`tenant_admin`, a pin) is always first, then a super-admin, then everyone by name (`sortUsers`);
  - a "Logins" section with the count and **New user**, then a plate per login (`PagedList columns`), its role as the coloured bar (`ROLE_COLOR` in `users.ts`: owner amber, super-admin accent, HR violet `--uline-1`, supplier cyan `--uline-2`, client green, staff grey): the person's name (`fullName`, the login when it has none) with the role and an inactive flag; then `login: <username> · <phone>`; then the supplier (supplier role), the client (client role) or the permissions (staff, hr), with an HR's worker count or a supplier's count of its workers ("sees all workers" for an HR with Only own workers off); then the hours ticks;
  - a tap, a double click or a long press edits (`openUserWindow(id)`); ⋮ (Edit, Delete) and a swipe left on a phone (Edit, Delete). **Delete never asks**: the plate goes behind the Undo snack and `deleteUsers(ids)` (the page's `deleteUsersNow`: `deleteUser` each, the toast, the list again) runs only when its 5 s are up. **Select** (a button above the list): every login but the owner's and a super-admin's (`UNSELECTABLE`) gets a tick box; the glass bar's Delete removes the picked logins the same way (one Undo for all).
- **User window** (`UserWindow`, drawn into `#userFormModal` of `#userFormOverlay`; `openCreateUserForm(preset)` / `openEditUserForm(id)` on the page — a saved login from the list's cache, the server only when the row isn't there): a head (`EditorHead`: the initials in the role's colour, the full name live, "HR · 14 own workers" / the role and its supplier or client, and for a saved login that is not the owner's a ⋮ with Delete — the window closes and the plate goes behind the Undo snack), then section plates (`Accordion`; Person & login open each time) in the owner's fixed order, and one Save:
  - **Person & login**: Full name ("Full name *" for HR, where it is required), Phone, Username (locked for a saved login), Password ("Password (min. 8)" for a new login; "New password (empty = keep)" when editing — filled in, it is sent first as `resetUserPassword`, which also ends the user's sessions), and the **Role** as a switch (`ToggleGroup`: Staff / HR / Supplier / Client);
  - **Sections**: for a supplier the supplier select and its portal tabs (Dashboard, My Workers, My Hours → `supplierSections`); for a client the client select; for staff and HR the section tiles — each with the icon and name of the header tab or button it opens (Schedule, Workers, Clients, Suppliers, Accounting tabs, the Export button) — and for HR the "Edit own workers' pay" tile (permission `payEdit`); an HR's Accounting tile reads "Own workers' pay and commission only";
  - **Hours** (HR, supplier, client): the hours ticks (`hourPerms`: hours, approve, dispute, fix, schedule, export — [hours-review.md](hours-review.md)), for a client the note that it never sees pay, rates, suppliers, GPS or documents; **Only own workers** (an HR may untick it; locked on for a supplier and a client); for a supplier **Sees own workers' pay** (`showPay`, on by default);
  - **HR commission** (HR): "HR commission ₪/h" (`commissionRate`) and "₪/day (daily workers)" (`commissionDayRate`, empty = by the hour); its summary is the rate and this month's commission on its workers (`hrMonthCommission` → the Salary rows and `commissionFor`, as in Payable by HR);
  - **Own workers** (an HR's saved login, and a supplier's): the team's workers (paged, each with Unassign) and **Add workers**. The team is an HR's workers (`hrId` = its uid; `assignWorkers('hr', …)` → `assignWorkersToHr`, which also moves their punches) or the workers of the supplier picked in the form (`supplierId`; `assignWorkers('supplier', …)` → `assignWorkersToSupplier`: sets `supplierId`, saves — punches carry no supplier), so every login of that supplier shares them; the section shows for a supplier also while creating, and follows the supplier select.
  - **Add workers** (`AssignWindow`, `#hrAssignModal` of `#hrAssignOverlay`, opened over the user window): the firm's other workers with a search (name or document) and a tick tile each, a worker of another HR or supplier marked "now: <name>"; **Assign** saves them, the toast gives the count.
  - A role change (`withRole` in `users.ts`): a supplier gets the first supplier and all its portal tabs when none is ticked, a client the first client, an HR / supplier / client the default hours ticks when none is ticked (`HOUR_DEFAULT`: hours, approve, dispute, fix); only an HR keeps Only own workers off and `payEdit`; a new HR (or one with no section ticked) starts with Workers only.
  - An owner's (or a super-admin's) row shows only Person & login without the Role; it saves only Full name and Phone (and the password).
  - **Save** (`createBody` / `updateBody`, sent with `adminCall`): first `formProblem` (a client needs its client; an HR its full name; a new login its username and password); a new login → `createTenantUser` (`username`, `password`, `role`, `fullName`, `phone`; for HR `ownOnly`, `commissionRate`, `commissionDayRate`; for a supplier `showPay`; the access: a supplier's `supplierId` and `supplierSections`, a client's `clientId`, or staff / HR `permissions`; for HR, supplier and client `hourPerms`); a saved login → `updateUser` with the same fields and `role` (the role can change between Staff, HR, Supplier and Client; the user signs in again when its rights really changed). Then `userSaved` on the page: a former HR's workers are unassigned (`assignWorkersToHr(ids, null)`), editing one's own row updates the header name, the window closes, the toast, the list is read again. A server error stays in the window's error line.

The server rules (only staff/hr/supplier/client users are created here, own firm only, and so on): [backend.md](backend.md).

## HR logins

HR logins are created and edited here (form above); what they can do and how it is enforced: [hr.md](hr.md).

## Errors and Timings: the period picker

Both sections (`LogsPane` in `src/manager/Logs.tsx`) load one period at a time, picked in a select at the left of the toolbar:
- the options are "Last 30 days" (default), "Last 7 days", and each calendar month (this one and the 11 before it) — the page's `logPeriodOptions`;
- `logPeriodRange(value)` gives `{key, from, to, label}` (ISO times), sent to `loadErrors` / `loadTimings` as `from` / `to` (`logPeriodQuery`) by `loadLogPane(kind)`, which `switchAdminPane`, `setLogPeriod(kind, value)` and Refresh (`reloadLog`) call; the picked period is kept on the page (`__logPeriod`) while the app stays open;
- each period has its own cache (`adminCache_errors:<key>`, `adminCache_timings:<key>`): the snapshot's `logs` is the cached rows (null until loaded, with the load error), drawn at once and again when the fresh rows arrive;
- **Copy all** and **Print** take only the loaded period. Print opens a plain page with a table (for timings, the summary first) and prints it.

The toolbar is the select and icon buttons in one line: Copy all, Print, Refresh and **Reset** (red; labelled in Timings). Times are shown as `04.10 10:18` (`shortWhen`). The lists page by 10. Copying goes through the page's `copyTextToClipboard` (`copyText`, with its toast).

**Reset** (in both sections), **behind the Alert Dialog**: Delete → `resetLogs()` on the page deletes every error and every measurement — all firms, all periods ([backend.md](backend.md)) — drops the cached periods (`adminCache_errors…`, `adminCache_timings…`) and reloads the section; a toast gives the counts.

## Errors pane (super-admin)

The count and the period on the section's line, then a red plate per error: the message (wrapped in full), under it time · page · source · user; a copy button at the right (`errorText`). "Copy all" copies "Errors — <period> (N)" and every error as text.

## Timings pane (super-admin)

The figures and the text forms are `src/manager/adminlogs.ts`:
- **figures** on top: measurements, kinds, runs above their kind's 90%, aborted runs;
- **by kind** (`timingsSummary`) — a plate per kind over the period, without aborted runs: the name with the count, the median of each step under it (the steps per kind; a slow AI call `gs:ai…` has: time at Anthropic, retry pauses), the median and 90th percentile of the total at the right. Every slow data call adds a kind (`gs:<action>`), so these page by 10 as well (in columns on a computer);
- **all measurements**, newest first, paged by 10: a plate each — the kind, the steps under it (a slow AI call also `aiNote`: the `part`, tries, output / input / cache tokens and a stop reason other than `end_turn`), then time, firm (`firmNames` from the firms cache), user, device, pages and page kinds; the total at the right (amber, and an amber bar, when above its kind's 90%) and a copy button (`timingText`).

"Copy all" copies the summary (`summaryText`) and every measurement of the period as text. Kinds and how they are measured: [app-core.md](app-core.md) → Telemetry.
