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

- **workers** — only those with `supplierId` = this supplier, and only these fields (`SUPPLIER_WORKER_FIELDS`): `id, name, docGiven, docSurname, docId, docType, docDob, docSex, address, houseNumber, city, maritalStatus, healthFund, workStartDate, phone, docChildren, clientIds, supplierId, startDate, expiryEnabled, expiryMonths, expiryWarnMonths, avatarB64, colorIdx, notes, createdAt, schedule`, plus `supplierRate` = this supplier's commission override or `null`. Never a wage (`hourlyRate`, `otRate`, `shabbatRate`, `clientRates`, `supplierRates`), never the worker's punch-link `token` (a supplier must not be able to punch for its workers), never a stored-file link (`docUrl`, `docFileId`, `assetsFileId`);
- **clients** — `{id, name, object}` only;
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
  - **Summary** (`runSummaryExport` → `exportPayableSummary`): per worker with hours that month, hours × commission (`supplierRate`, else 5), Excel or a print page.

Hours use local copies of `groupPunchesIntoShifts` / `analyzeDayPunches` (simplified: no warnings, no rounding) and `getWorkerMonthShifts`. They are never wages.

## Modals

The worker modal closes like the manager app's modals: a tap outside it, no ✕ or Cancel button ([app-core.md](app-core.md) → Layout).

## New version check

`startVersionWatch` watches the page and `firestore-backend.js` and shows the "A new version is available — Update" bar after a deploy (the same code as the manager app, [app-core.md](app-core.md) → PWA).

## What a supplier can write

Only the three actions:
- `supplierAddWorker` — a new worker with `supplierId` forced to the caller's own, `clientIds: []`, `schedule: []`, and only the editable fields;
- `supplierUpdateWorker` / `supplierDeleteWorker` — only a worker whose `supplierId` is the caller's; otherwise "Worker not found";
- editable fields (`SUPPLIER_EDITABLE`): `docGiven, docSurname, phone, docId, address, houseNumber, city, docDob, docSex, maritalStatus, healthFund, startDate, notes, status`; `name` is rebuilt from given name + surname.

A supplier cannot call `saveSchedule`, the hours-import queue or the AI reads (refused on the server), and has no client billing or wage data to show.
