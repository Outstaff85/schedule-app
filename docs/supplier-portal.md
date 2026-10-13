# Supplier portal (`supplier-portal.html`)

The page for a supplier (staffing agency) login, routed at `/supplier`. A separate file on purpose: it never loads the manager app's rate, GPS or scan code. The real boundary is on the server — the supplier gets data through allow-lists and can only write through three narrow actions. One inline `<script>`, no modules; SheetJS from cdnjs for Excel, loaded only when an Excel export or the timesheet import needs it (`loadXlsx()`).

Who creates a supplier login and how: [admin.md](admin.md) → Users pane. The supplier entity and commission: [suppliers.md](suppliers.md), [accounting.md](accounting.md).

## Session and requests

- The session is kept in its own key `localStorage.supplierPortal_session`, so a manager login on the same browser is never touched. It holds `{uid, role, tenantId, supplierId, username}`; `getSession()` drops one without `uid` or with a role other than `supplier`.
- **One login for every role** (user request 2026-10-11): the portal has no login screen. A supplier signs in on the manager app's login page, which hands the session over (`goToSupplierPortal`). A small script at the top opens the portal at once when a session is kept on this device (class `has-session`), else sends to `schedule-manager.html`; **`gateApp()`** does the same when the Firebase sign-in is gone, or loads the data. The client portal works the same way.
- **Header and tabs** (redesign stage 10): a glass header (`.pt-head`, sticky) with the logo mark (`.pt-mark`, the manager app's 11C) and "Supplier Portal"; the tabs are glass tabs with the highlight line under the open one. Lists are plates (the shared list pieces, [app-core.md](app-core.md) → Lists).
- **Account menu** (the same as in the manager app): a button with the login's initial and name opens **Sign out**; the Language button sits before it — `logout()` ends the portal's session and the Firebase sign-in (one per browser for the whole site) and opens the login page.
- A supplier who signs in on the main site is brought here signed in (`goToSupplierPortal` in the manager app, [app-core.md](app-core.md) → Login).
- **`logout()`** clears the session and signs out of Firebase.
- **Requests:** `supplierCall(body)` posts to the `supplier` function (`SUPPLIER_FN_URL`, europe-west3) with `Authorization: Bearer <Firebase ID token>` and resolves with the JSON reply. Actions: `loadSchedule`, `loadPunchLog`, `supplierAddWorker`, `supplierUpdateWorker`, `supplierDeleteWorker`.

## Data (`loadData()`)

`loadSchedule` and `loadPunchLog` in parallel → `myWorkers`, `myClients`, `punchLog`. The page draws in the language chosen on this device (`localStorage.uiLang`, English by default, loaded before `gateApp()`); the Language button (`#langBtn`) in the header opens the language sheet, whose pick calls `setLanguage()`, which also saves the choice to the user's account (`updateMyLanguage` through `handleAction`); the login page applies the account's `language` from the login reply ([translations.md](translations.md)). What the server sends a supplier (`functions-auth/portal.py` `strip_worker`):

- **workers** — only those with `supplierId` = this supplier, and only these fields (`SUPPLIER_WORKER_FIELDS`): `id, name, docGiven, docSurname, docId, docType, docDob, docSex, address, houseNumber, city, maritalStatus, healthFund, workStartDate, phone, docChildren, clientIds, supplierId, startDate, expiryEnabled, expiryMonths, expiryWarnMonths, avatarB64, colorIdx, notes, createdAt, schedule`, plus `supplierRate` = this supplier's commission ₪/h override or `null` (default 5), and `supplierDayRate` = its fixed ₪/day commission for a worker paid by the day (`supplierRates[sid].dayRate`; sent only if the worker is paid daily — `null` otherwise). With **"Sees own workers' pay"** (the login's `showPay`, claim `pay`, on unless the owner turned it off) also `SUPPLIER_PAY_FIELDS`: `payMode, hourlyRate, regRate, otRate, shabbatRate, clientRates, dayOverrides`; without it no wage at all. Never `supplierRates` (other suppliers' commissions), never the worker's punch-link `token` (a supplier must not be able to punch for its workers), never a stored-file link (`docUrl`, `docFileId`, `assetsFileId`);
- **clients** — `{id, name, object}`; with "sees pay" also the worker-pay rates `defaultHourlyRate, defaultOtRate, defaultShabbatRate` (`CLIENT_PAY_FIELDS`) — never client billing (`billRate`, `rateMode`, …), GPS or company numbers;
- **showPay** — whether this login sees pay;
- **commission** — this supplier's own rate list `[{from, mode, rate}]` (`sp.commission`, set by the firm owner);
- **suppliers** — always empty;
- **punches** — only this supplier's workers, only `id, workerId, workerName, type, time, date, site, clientId` (plus `ts`); no GPS, distance or notes. The last 13 months.

## Tabs (`switchTab`)

Drawn in the app's template (variant 3, the same CSS and `t3Line` / `t3Av` copies as the manager app): figures as text, lines with a colored mark on the left; on a phone windows open from the bottom.

The tabs a supplier login may use are ticked in Admin → Users (`users.supplierSections` → claim `ss`, read by `supplierSections()` in `firestore-backend.js`; none stored = all three): a tab without its tick is hidden and `switchTab` falls back to the first allowed one. The `supplier` function enforces it: worker add / edit / delete need **My Workers** (`workers`), sending and listing hours need **My Hours** (`hours`) — else "Not allowed for this login".

- **Dashboard** (`renderDashboard()`): figures — On site now (workers whose last punch is IN), My workers, punches today — then today's punches as lines (green IN / red OUT, the client, the time) (paged by 10 — the portal's own copy of `renderPagedList`, [app-core.md](app-core.md) → Long lists).
- **My Workers** (`renderWorkersList()`; the header has the title and one glass primary **New** — `openAddWorkerModal`): a "Workers" section with the count, Select always on above the plates (`startWorkersSelect`), then a plate per worker — name (and NEW), phone · clients, the commission (₪/h or ₪/day), a bare ⋮ (Edit, Delete) and a swipe left on a phone (Edit, Delete); green while the worker is on site; a tap, a double click or a long press on the line opens the edit form; paged by 10. **Delete never asks**: the plate collapses behind the Undo snack (`deleteWorker(id, el)` → `undoDelete`), and `deleteWorkerNow(id)` (`supplierDeleteWorker`) runs only after its 5 s; Select's bulk Delete removes the picked workers the same way.
  - **Add / edit** (`renderWorkerModal` → `saveWorkerModal`): a manual form drawn like the manager app's editors (section plates, `ogSections`): a head with the initials, name and phone, the sections Person (given name + surname, phone + ID/passport number) and Address (address + city), each closed section showing its summary, one open at a time; Save is the glass button. The name fields fall back to splitting `name` for an older record. Given name is required. No document scan here (a deliberate scope cut).
  - **Delete** (`deleteWorker`) after `confirm()`.
  - After each change the data is reloaded.
- **My Hours** (`renderHoursTab()`): a month (this one and the 11 before it) and a worker.
  - **Detail** (`runDetailExport` → `exportShiftsDetail`): the worker's shifts that month, Date / In / Out / Hours + total, Excel or a print page.
  - **Summary** (`runSummaryExport` → `exportPayableSummary`): per worker with hours that month, its commission by `myMonthCommission()` (below), the rate by `myRateLabel`, Excel or a print page.

  - The buttons of this tab are glass (stage 13): Detail / Summary exports and Add shift / Load from Excel secondaries, **Send for approval** the one primary; its selects are the same glass fields as in a window (the form-field block applies to `#appRoot .field` too).
  - **Send hours for approval**: a worker select and "Add shift" rows of date / in / out (`sendHoursRows`; each new row takes the next day; **Load from Excel** (`loadTimesheetFile` → `parseTimesheetFile`, `.xlsx/.xls/.csv`) adds rows from a timesheet: columns by header — Date, In, Out (English or Hebrew), and an optional Worker column (a name or an ID number, `timesheetRowIsFor`) so one sheet can hold several workers; only the picked worker's rows are added, to check and send like typed rows, and the toast says how many rows of other workers were left; a daily-paid worker needs only a date — one day, 08:00–16:00; a row that can't be sent is outlined red and explained, nothing is sent), "Send for approval" (`submitSendHours` → `supplierSubmitHours`); **Sent for approval** (`loadSentHours` → `supplierListHours`) lists each batch with an amber / green / red status chip (`hoursStatusChip`), paged by 10.
  - **Pay** (`renderPayTable`, only with `showPay`): for the picked month, per own worker with hours: Hours, Days, Rate (₪/h, or ₪/day for a daily-paid worker), Pay, My commission (`myMonthCommission()`), with totals; paged by 10.

- **Approvals** (the hours approval tab, `#tabBtn_review` — `openHoursReview()`, `#sectionReview`; the tab shows only with an hours or schedule tick — `hourPerms`, read from the ID token): the shared hours screen `hours-review.js` over the `hours` function — its own workers' days approved, disputed or given a proposed fix, the month approved at once ([hours-review.md](hours-review.md)).

Hours use local copies of `groupPunchesIntoShifts` / `analyzeDayPunches` (simplified: no warnings, no rounding) and `getWorkerMonthShifts`. Pay uses copies of the manager app's pay functions (`PAY_RULES`, `israeliDayPay`, `effectiveRates`, `shiftPay`, `shiftPayFor`, `dayOverride`, `wOwnRate`, `localYMD` — the global `clients` is set to `myClients`), so a worker's pay is the same figure as in the manager's Salary table. Commission is independent of pay (`myMonthCommission`): a worker with an override of his own (`hasOwnCommission`: `supplierRate`, or `supplierDayRate` for a daily-paid worker) uses `myCommission` — days × `supplierDayRate`, else hours × `supplierRate`; otherwise each shift is priced by the supplier's own rate on its date (`myRateOn` / `myShiftCommission`, copies of the manager app's `supplierRateOn` / `supplierShiftCommission`: by the hour, by the day once per day, or 5 ₪/h).

## Modals

The worker modal closes like the manager app's modals: a tap outside it, no ✕ or Cancel button ([app-core.md](app-core.md) → Layout).

## New version check

`startVersionWatch` watches the page and `firestore-backend.js` and shows the "A new version is available — Update" bar after a deploy (the same code as the manager app, [app-core.md](app-core.md) → PWA).

## What a supplier can write

Only the three actions:
- `supplierAddWorker` — a new worker with `supplierId` forced to the caller's own, `clientIds: []`, `schedule: []`, `createdAt` (now, ISO — the "NEW" badge for 3 days, `newWorkerBadgeHtml`, shown in the app and in the portal's worker list), and only the editable fields;
- `supplierUpdateWorker` / `supplierDeleteWorker` — only a worker whose `supplierId` is the caller's; otherwise "Worker not found";
- `supplierSubmitHours` `{workerId, clientId, entries:[{date dd/MM/yyyy, inTime, outTime}]}` — shifts for its own worker, at most 62 rows, invalid rows dropped, a client that isn't the worker's dropped; written as a `pending` batch (`supplierId`, `createdBy`) for the owner to approve; `supplierListHours` → its batches with `status`, `uploadedAt`, `decidedAt` and the rows;
- editable fields (`SUPPLIER_EDITABLE`): `docGiven, docSurname, phone, docId, address, houseNumber, city, docDob, docSex, maritalStatus, healthFund, startDate, notes, status`; `name` is rebuilt from given name + surname.

A supplier cannot call `saveSchedule`, the app's hours-import actions (it sends hours only through `supplierSubmitHours`) or the AI reads (refused on the server), and has no client billing data to show; wages only with "sees pay".
