# Supplier and client logins (inside the manager app)

A supplier (a staffing agency) and a client of the firm (a site where its workers work) sign in with their own logins on the one sign-in page and work **inside the manager app**, in the same frame, with their own tabs (since 2026-10-19; the plan it came from, done, is [archive/docs/permissions-plan.md](../archive/docs/permissions-plan.md) → stages 3–4). Nothing reads Firestore for them: the real boundary is on the server — a supplier gets data only through the `supplier` function's allow-lists and writes only through narrow actions; a client gets everything from the `hours` function. Who creates these logins and how: [admin.md](admin.md) → Users pane.

## What both share

- **The gate.** After the sign-in the manager page's gate runs `startPortal` (`src/manager/page/gate.ts`) instead of the app's start — no firm data is loaded. It writes the role's session key (`supplierPortal_session` / `clientPortal_session`), checks the Firebase sign-in (`loadFirestoreBackend().currentUser()`; gone or another user's → the sign-in), reads the login's flat rights from the ID token (`rights()`, claim `rt`) and gives the frame the role's tabs (`portalTabs(role, rights)`, `src/manager/portal.ts`).
- **The view.** `PortalView` (`src/manager/Portal.tsx`) draws the open tab into the page's `#sectionPortal` (`switchTab` and `render()` draw only that while a supplier or client is signed in, `nav.ts`); a session error in a reply signs out. A reload opens the first tab.
- **The frame** is the manager app's: the side menu / bottom bar with the role's tabs, the Language button (the pick kept on the device and the account) and the account menu (the person's name, the firm · supplier or client, the theme, **Sign out** → both sessions and the Firebase sign-in end, the sign-in opens).
- **`/supplier` and `/client`** (`supplier-portal.html`, `client-portal.html`, small static pages kept for bookmarks and installed apps) only send to `/schedule-manager.html`; a session key kept from the old portals is taken over by the gate (`adoptPortalSession`; `clearPortalSessions` at sign-out).
- **Hours review:** both review hours on the shared screen `HoursReview`, `src/hours-review/` ([hours-review.md](hours-review.md) — the ticks, the `hours` function, the per-day approve / dispute / fix, the owner's side).

## Supplier login (screens in `src/supplier/`)

Forms on React Hook Form + Zod, the pay table on TanStack Table (the Data Table), reads through TanStack Query; SheetJS from cdnjs, loaded only when an Excel export or the timesheet import needs it (`loadScript(XLSX_URL)`). The supplier entity and commission: [suppliers.md](suppliers.md), [accounting.md](accounting.md).

### Files

| File | What |
|---|---|
| `src/manager/portal.ts` | the frame tabs of a supplier / client (`portalTabs`), the frame tab → screen map (`SUPPLIER_VIEWS`), the session keys |
| `src/manager/Portal.tsx` | `PortalView`: the open tab drawn with the screens below (`QueryClientProvider`, `Toaster`), the `hours` function's `call` for the Hours tab |
| `src/manager/page/gate.ts` | `startPortal` (the gate for a supplier / client), `adoptPortalSession`, `clearPortalSessions` |
| `src/supplier/api.ts` | the session key, `supplierCall`, the data shapes, the TanStack Query reads (`useSupplierData`, `useSentHours`, `refreshData`), `lastEntryFor`, `clientName` |
| `src/supplier/money.ts` | the month's shifts, pay rows and the commission (`workerMonthShifts`, `payRows`, `summaryRows`, `myRateOn`, `myShiftCommission`, `myCommission`, `myMonthCommission`, `myRateLabel`, `plateRate`) |
| `src/supplier/timesheet.ts` | the timesheet file (`parseTimesheetFile`, `timesheetRowIsFor`) |
| `src/supplier/store.ts` | the screen state outside React (the month, the picked workers, the shift rows being typed) — it outlives a language change |
| `src/supplier/Dashboard.tsx`, `Workers.tsx`, `Hours.tsx` | the screens |

### Session, tabs and requests

- **One login for every role:** after the sign-in the manager page's gate runs `startPortal` instead of the app's start — no firm data is loaded. It writes the screens' session key `localStorage.supplierPortal_session` (`{uid, role, tenantId, supplierId, username, rights}`), checks the Firebase sign-in (gone or another user's → the sign-in) and reads the login's flat rights from the ID token (`rights()`, claim `rt`).
- **The tabs** (`portalTabs(role, rights)`): **Today** (the dashboard), **Workers**, **Commission** (its hours and pay), and with Hours or Schedule **Hours** (the hours review) — each by its right. Each is drawn into the page's `#sectionPortal` (`switchTab` and `render()` draw only that while a supplier is signed in, `nav.ts`).
- **Requests:** `supplierCall(body)` (`api.ts`) posts to the `supplier` function (`SUPPLIER_FN_URL`, europe-west3) with `Authorization: Bearer <Firebase ID token>` and resolves with the JSON reply; a session error in the reply signs out. Actions: `loadSchedule`, `loadPunchLog`, `supplierAddWorker` (the server also gives the new worker its punch-link `token`, which no supplier reply carries), `supplierUpdateWorker`, `supplierDeleteWorker`, `supplierSubmitHours`, `supplierListHours`.

### Data (`useSupplierData()`)

One TanStack Query read (`['supplier', 'data']`): `loadSchedule` and `loadPunchLog` in parallel → `{workers, clients, punches, showPay, commission}`. It is cached across a language change (the page is redrawn, the data is not loaded again) and refreshed (`refreshData()`) after every write. What the server sends a supplier (`functions-auth/portal.py` `strip_worker`):

- **workers** — only those with `supplierId` = this supplier, and only these fields (`SUPPLIER_WORKER_FIELDS`): `id, name, docGiven, docSurname, docId, docType, docDob, docSex, address, houseNumber, city, maritalStatus, healthFund, workStartDate, phone, docChildren, clientIds, supplierId, startDate, expiryEnabled, expiryMonths, expiryWarnMonths, avatarB64, colorIdx, notes, createdAt, schedule`, plus `supplierRate` = this supplier's commission ₪/h override or `null` (default 5), and `supplierDayRate` = its fixed ₪/day commission for a worker paid by the day (`supplierRates[sid].dayRate`; sent only if the worker is paid daily — `null` otherwise); with a `supplierDayRate`, also `dayOverrides` (the days set by hand per period — a commission input, not a wage — sent even without See workers' pay, so the portal prices that commission by the same days as the manager's Payable by supplier). With **See workers' pay** (the `seePay` right of its template) also `SUPPLIER_PAY_FIELDS`: `payMode, hourlyRate, regRate, otRate, shabbatRate, clientRates, dayOverrides`; without it no wage at all. Never `supplierRates` (other suppliers' commissions), never the worker's punch-link `token` (a supplier must not be able to punch for its workers), never a stored-file link (`docUrl`, `docFileId`, `assetsFileId`);
- **clients** — `{id, name, object}`; with "sees pay" also the worker-pay rates `defaultHourlyRate, defaultOtRate, defaultShabbatRate` (`CLIENT_PAY_FIELDS`) — never client billing (`billRate`, `rateMode`, …), GPS or company numbers;
- **showPay** — whether this login sees pay;
- **commission** — this supplier's own rate list `[{from, mode, rate}]` (`sp.commission`, set by the firm owner);
- **suppliers** — always empty;
- **punches** — only this supplier's workers, only `id, workerId, workerName, type, time, date, site, clientId` (plus `ts`); no GPS, distance or notes. The last 13 months (the query itself is bounded by `ts`).

### Tabs

The tabs a supplier login may use are its template's ticks (Today, Workers, Commission, Hours — its flat rights, claim `rt`, read by `rights()` in `firestore-backend.js`): a tab without its tick is hidden (the frame tabs above). The `supplier` function enforces it from the token's flat rights (claim `rt`, `core.caller_rights`): worker add / edit / delete need **Workers**, sending and listing hours **Commission**, the pay inputs **See workers' pay** — else "Not allowed for this login". A reload opens the first tab.

- **Today** — the dashboard (`Dashboard.tsx`): `Figures` — On site now (workers whose last punch is IN), My workers, punches today — then a "Today's log" `Section` with today's punches as small plates (green IN / red OUT, the client, the time), paged by 10 (`PagedList`).
- **Workers** (`Workers.tsx`; `PageHead` with **New** in plain glass, `og-new`): a "Workers" section with the count and the Select button (`SelectHead`), then a `Plate` per worker — name and the `NewBadge` (3 days after `createdAt`), phone · clients, the commission (₪/h or ₪/day, `plateRate`), green while the worker is on site; a tap, a double click or a long press opens the edit form; ⋮ and a swipe left: Edit, Delete; paged by 10. **Delete never asks**: the plate goes behind the Undo snack (`undoDelete`) and `supplierDeleteWorker` runs only after its 5 s (Undo brings it back, nothing is sent); a worker who signed is deleted too — a person's own delete (owner, 2026-10-25; docs/contracts.md → Signed files are kept); Select's bulk bar deletes the ticked workers the same way. After each change the data is refreshed.
  - **Add / edit** (`WorkerWindow` → `WorkerForm`): a `Window` (a bottom sheet on a phone) with a React Hook Form + Zod form drawn like the manager app's editors — Accordion section plates, one open at a time, a closed one shows its summary: Person (given name + surname, phone + ID/passport number) and Address (address + city); Save is the one primary. The given name is required (Zod, "Name required"; a save without it opens Person). The name fields fall back to splitting `name` for an older record. No document scan here (a deliberate scope cut). Saved with `supplierAddWorker` / `supplierUpdateWorker`.
- **Commission** — its hours and pay (`Hours.tsx`): a month (the one month picker, `MonthPicker` — docs/components.md → `date-picker.tsx`: this one and the 11 before it; the store keeps how many months back).
  - **Pay** (only with `showPay`): `Figures` (Hours, Pay, My commission), then a **Data Table** — per own worker with hours that month: Worker, Hours, Days, Rate (₪/h, or ₪/day for a daily-paid worker), Pay, My commission, with the totals row; a tap on a column head sorts; paged by 10; on a phone each row is a plate ("8.0h · 1 day · ₪50/h · Pay ₪400" and the commission).
  - **Export**: a worker (a Combobox) for **Detail** (`exportDetail`: the worker's shifts that month, Date / In / Out / Hours + total) and **Summary** (`exportSummary`: per worker with hours that month, its commission by `myMonthCommission()` over the days set by hand for the month when there are some, as the Pay table and the manager's figure — `commissionDayOverride` —, else the punched days; the rate by `myRateLabel`), each Excel or a print page (the print page's data through `esc()`, `src/lib/utils.ts`).
  - **Send hours for approval**: a worker (a Combobox) and "Add shift" rows of date (a Date Picker) / in / out (each new row takes the next day — `addSendRow`); **Load from Excel** (`parseTimesheetFile`, `.xlsx/.xls/.csv`) adds rows from a timesheet: columns by header — Date, In, Out (English or Hebrew), and an optional Worker column (a name or an ID number, `timesheetRowIsFor`) so one sheet can hold several workers; only the picked worker's rows are added, to check and send like typed rows, and the toast says how many rows of other workers were left; a daily-paid worker needs only a date — one day, 08:00–16:00; a row that can't be sent is outlined red and explained, nothing is sent; **Send for approval** (the one primary) → `supplierSubmitHours`.
  - **Sent for approval** (`useSentHours` → `supplierListHours`, refreshed after a send): each batch as a plate with an amber / green / red status badge and its date, paged by 10.
- **Hours** — the review (shown only with Hours or Schedule, read from the ID token): the shared React hours screen `HoursReview` ([hours-review.md](hours-review.md) → The screen in the new stack) over the `hours` function — its own workers' days approved, disputed or given a proposed fix (by its ticks), the month approved at once.

Hours use `groupPunchesIntoShifts` / `analyzeDayPunches` (the short check: no warnings, no rounding) from `src/lib/payroll.ts`. Pay uses the same pay functions as the manager app (`effectiveRates`, `shiftPayFor`, `isDailyPay`, `dailyRate`, `dayOverride`, `localYMD` — imported from `src/lib/payroll.ts` with this page's `clients`, docs/accounting.md → Payroll module), so a worker's pay is the same figure as in the manager's Salary table. Commission is independent of pay (`myMonthCommission`): a worker with an override of his own (`hasOwnCommission`: `supplierRate`, or `supplierDayRate` for a daily-paid worker) uses `myCommission` — days × `supplierDayRate`, else hours × `supplierRate`; otherwise each shift is priced by the supplier's own rate on its date (`myRateOn` / `myShiftCommission`, copies of the manager app's `supplierRateOn` / `supplierShiftCommission`: by the hour, by the day once per day, or 5 ₪/h).

### Windows

The worker window closes like every window: a tap outside it (or a swipe down on a phone), no ✕ or Cancel button ([components.md](components.md) → `Window`).

### What a supplier can write

Only these actions:
- `supplierAddWorker` — a new worker with `supplierId` forced to the caller's own, `clientIds: []`, `schedule: []`, `createdAt` (now, ISO — the "NEW" badge for 3 days, shown in the app and in the portal's worker list), and only the editable fields;
- `supplierUpdateWorker` / `supplierDeleteWorker` — only a worker whose `supplierId` is the caller's; otherwise "Worker not found";
- `supplierSubmitHours` `{workerId, clientId, entries:[{date dd/MM/yyyy, inTime, outTime}]}` — shifts for its own worker, at most 62 rows, invalid rows dropped, a client that isn't the worker's dropped; written as a `pending` batch (`supplierId`, `createdBy`) for the owner to approve; `supplierListHours` → its batches with `status`, `uploadedAt`, `decidedAt` and the rows;
- editable fields (`SUPPLIER_EDITABLE`): `docGiven, docSurname, phone, docId, address, houseNumber, city, docDob, docSex, maritalStatus, healthFund, startDate, notes, status`; `name` is rebuilt from given name + surname.

A supplier cannot call `saveSchedule`, the app's hours-import actions (it sends hours only through `supplierSubmitHours`) or the AI reads (refused on the server), and has no client billing data to show; wages only with "sees pay". The page never reads Firestore: `tests/e2e/main.test.js` checks the `supplier` function's replies for tokens, client billing and GPS.

## Client login

A client login reviews its workers' hours, with one tab, **Hours**. A client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so nothing reads Firestore for it: everything comes from the `hours` Cloud Function and is drawn by the shared hours screen, `src/hours-review/` ([hours-review.md](hours-review.md) — the ticks, the function, the per-day approve / dispute / fix, the owner's side).

### Logins

- Made in the manager app: Admin → Users → New user, a **Client** template (the template says the role and its rights — the default Client template: Hours, Approve / Dispute / Fix hours; a Client template may also tick Schedule and Export — `RIGHT_CAPS`), then the client (the user window's client picker, `src/manager/Users.tsx`). "Only own workers" is on and locked.
- Server side (`core.py`): `create_tenant_user` / `update_user` take a Client template with `clientId` (required); `claims_for` gives it `role: 'client'`, `clientId` and `rt` (its flat rights). The login reply carries `clientId` and `rights`.
- The Users list shows a client login as "(client)" with its client and its hours ticks.
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

### In the manager app

- **The gate.** One login page for every role: after the sign-in the manager page's gate runs `startPortal` (`src/manager/page/gate.ts`) instead of the app's start — no firm data is loaded. It writes the client's session key `clientPortal_session` = `{uid, role:'client', tenantId, clientId, username, rights}` (the gate clears a client or supplier session that has no `rights` array — signed in before the flat rights; `gateApp`, `gate.ts`), checks the Firebase sign-in (`loadFirestoreBackend().currentUser()`; gone or another user's → the sign-in), and gives the frame one tab, Hours (`portalTabs`, `src/manager/portal.ts`).
- **The tab.** `PortalView` (`src/manager/Portal.tsx`), drawn into the page's `#sectionPortal`: `HoursReview` with its client named on top and `sign={signer: the login's name}` — the approved month is signed with a finger and kept as a PDF with the client's documents ([hours-review.md](hours-review.md) → Signing the month); its `call` posts to the `hours` function with the ID token; a session error in the reply signs out.
- What a client receives is only the `hours` function's reply for its client (names, shifts at its site, its day entries, when and by whom the month was signed) — the page reads nothing else; `tests/e2e/main.test.js` checks the replies and the page for money, suppliers, GPS, files and tokens, and that no firm data is loaded.
