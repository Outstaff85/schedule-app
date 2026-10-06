# Supplier portal (`supplier-portal.html`)

The page for a supplier (staffing agency) login, routed at `/supplier`. A separate file on purpose: it never loads the manager app's rate, GPS or scan code. The real boundary is on the server — the supplier gets data through allow-lists and can only write through three narrow actions. One inline `<script>`, no modules; SheetJS from cdnjs for Excel.

Who creates a supplier login and how: [admin.md](admin.md) → Users pane. The supplier entity and commission: [suppliers.md](suppliers.md), [accounting.md](accounting.md).

## Session and requests

- The session is kept in its own key `localStorage.supplierPortal_session`, so a manager login on the same browser is never touched. It holds `{uid, role, tenantId, supplierId, username}`; `getSession()` drops one without `uid` or with a role other than `supplier`.
- **Login** (`submitLogin()`): `firestore-backend.js` `login()` through the `login` function, which signs the device in to Firebase; a role other than `supplier` is signed out again with "This login is not a supplier account".
- **`gateApp()`** clears a session whose Firebase sign-in is gone, then shows the login screen or loads the data.
- **`logout()`** clears the session and signs out of Firebase.
- **Requests:** `supplierCall(body)` posts to the `supplier` function (`SUPPLIER_FN_URL`, europe-west3) with `Authorization: Bearer <Firebase ID token>` and resolves with the JSON reply. Actions: `loadSchedule`, `loadPunchLog`, `supplierAddWorker`, `supplierUpdateWorker`, `supplierDeleteWorker`.

## Data (`loadData()`)

`loadSchedule` and `loadPunchLog` in parallel → `myWorkers`, `myClients`, `punchLog`. What the server sends a supplier (`functions-auth/portal.py` `strip_worker`):

- **workers** — only those with `supplierId` = this supplier, and only these fields (`SUPPLIER_WORKER_FIELDS`): `id, name, docGiven, docSurname, docId, docType, docDob, docSex, address, houseNumber, city, maritalStatus, healthFund, workStartDate, phone, docChildren, clientIds, supplierId, startDate, expiryEnabled, expiryMonths, expiryWarnMonths, avatarB64, colorIdx, notes, createdAt, schedule`, plus `supplierRate` = this supplier's commission ₪/h override or `null` (default 5), and `supplierDayRate` = its fixed ₪/day commission for a worker paid by the day (`supplierRates[sid].dayRate`; sent only if the worker is paid daily — `null` otherwise). With **"Sees own workers' pay"** (the login's `showPay`, claim `pay`, on unless the owner turned it off) also `SUPPLIER_PAY_FIELDS`: `payMode, hourlyRate, regRate, otRate, shabbatRate, clientRates, dayOverrides`; without it no wage at all. Never `supplierRates` (other suppliers' commissions), never the worker's punch-link `token` (a supplier must not be able to punch for its workers), never a stored-file link (`docUrl`, `docFileId`, `assetsFileId`);
- **clients** — `{id, name, object}`; with "sees pay" also the worker-pay rates `defaultHourlyRate, defaultOtRate, defaultShabbatRate` (`CLIENT_PAY_FIELDS`) — never client billing (`billRate`, `rateMode`, …), GPS or company numbers;
- **showPay** — whether this login sees pay;
- **suppliers** — always empty;
- **punches** — only this supplier's workers, only `id, workerId, workerName, type, time, date, site, clientId` (plus `ts`); no GPS, distance or notes. The last 13 months.

## Tabs (`switchTab`)

- **Dashboard** (`renderDashboard()`): On site now (workers whose last punch is IN), My workers (count), today's punches (paged by 10 — the portal's own copy of `renderPagedList`, [app-core.md](app-core.md) → Long lists).
- **My Workers** (`renderWorkersList()`): Name, Phone, Object (client names), Commission (₪/h or —), delete; a tap on the row opens the edit form; paged by 10.
  - **Add / edit** (`renderWorkerModal` → `saveWorkerModal`): a manual form — given name, surname, phone, ID/passport number, address, city. The name fields fall back to splitting `name` for an older record. Given name is required. No document scan here (a deliberate scope cut).
  - **Delete** (`deleteWorker`) after `confirm()`.
  - After each change the data is reloaded.
- **My Hours** (`renderHoursTab()`): a month (this one and the 11 before it) and a worker.
  - **Detail** (`runDetailExport` → `exportShiftsDetail`): the worker's shifts that month, Date / In / Out / Hours + total, Excel or a print page.
  - **Summary** (`runSummaryExport` → `exportPayableSummary`): per worker with hours that month, its commission calculated by `myCommission()` — days × `supplierDayRate` when set for a daily-paid worker, else hours × `supplierRate` (or 5), Excel or a print page.

  - **Send hours for approval**: a worker select and "Add shift" rows of date / in / out (`sendHoursRows`; each new row takes the next day; a daily-paid worker needs only a date — one day, 08:00–16:00; a row that can't be sent is outlined red and explained, nothing is sent), "Send for approval" (`submitSendHours` → `supplierSubmitHours`); **Sent for approval** (`loadSentHours` → `supplierListHours`) lists each batch with an amber / green / red status chip (`hoursStatusChip`), paged by 10.
  - **Pay** (`renderPayTable`, only with `showPay`): for the picked month, per own worker with hours: Hours, Days, Rate (₪/h, or ₪/day for a daily-paid worker), Pay, My commission (calculated by `myCommission()` — days × `supplierDayRate` for a daily-paid worker when set, else hours × commission rate), with totals; paged by 10.

Hours use local copies of `groupPunchesIntoShifts` / `analyzeDayPunches` (simplified: no warnings, no rounding) and `getWorkerMonthShifts`. Pay uses copies of the manager app's pay functions (`PAY_RULES`, `israeliDayPay`, `effectiveRates`, `shiftPay`, `shiftPayFor`, `dayOverride`, `wOwnRate`, `localYMD` — the global `clients` is set to `myClients`), so a worker's pay is the same figure as in the manager's Salary table. Commission (`myCommission`) is independent: for a daily-paid worker it uses `supplierDayRate` when set, else the hourly `supplierRate`.

## Modals

The worker modal closes like the manager app's modals: a tap outside it, no ✕ or Cancel button ([app-core.md](app-core.md) → Layout).

## New version check

`startVersionWatch` watches the page and `firestore-backend.js` and shows the "A new version is available — Update" bar after a deploy (the same code as the manager app, [app-core.md](app-core.md) → PWA).

## What a supplier can write

Only the three actions:
- `supplierAddWorker` — a new worker with `supplierId` forced to the caller's own, `clientIds: []`, `schedule: []`, and only the editable fields;
- `supplierUpdateWorker` / `supplierDeleteWorker` — only a worker whose `supplierId` is the caller's; otherwise "Worker not found";
- `supplierSubmitHours` `{workerId, clientId, entries:[{date dd/MM/yyyy, inTime, outTime}]}` — shifts for its own worker, at most 62 rows, invalid rows dropped, a client that isn't the worker's dropped; written as a `pending` batch (`supplierId`, `createdBy`) for the owner to approve; `supplierListHours` → its batches with `status`, `uploadedAt`, `decidedAt` and the rows;
- editable fields (`SUPPLIER_EDITABLE`): `docGiven, docSurname, phone, docId, address, houseNumber, city, docDob, docSex, maritalStatus, healthFund, startDate, notes, status`; `name` is rebuilt from given name + surname.

A supplier cannot call `saveSchedule`, the app's hours-import actions (it sends hours only through `supplierSubmitHours`) or the AI reads (refused on the server), and has no client billing data to show; wages only with "sees pay".
