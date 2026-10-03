# Supplier portal (`supplier-portal.html`)

The page for a supplier (staffing agency) login, routed at `/supplier`. A separate file on purpose: it never loads the manager app's rate, GPS or scan code. The real boundary is on the server — the supplier gets data through allow-lists and can only write through three narrow actions. One inline `<script>`, no modules; SheetJS from cdnjs for Excel.

Who creates a supplier login and how: [admin.md](admin.md) → Users pane. The supplier entity and commission: [suppliers.md](suppliers.md), [accounting.md](accounting.md).

## Backend switch and session

- `BACKEND` — the same per-device switch as the other pages (`localStorage.backend`, `?backend=sheets` / `?backend=firestore`); Firestore by default.
- The session is kept in its own key `localStorage.supplierPortal_session`, so a manager login on the same browser is never touched. `getSession()` drops an expired session.
- **Login** (`submitLogin()`):
  - Firestore: `firestore-backend.js` `login()` through the `login` function; a role other than `supplier` is signed out again with "This login is not a supplier account". The session is `{backend:'firestore', token: gsToken, role, tenantId, supplierId, username, expiresAt: now + 30 days}`.
  - Sheets: Apps Script `login`; the same role check; the session keeps Apps Script's `token` and `expiresAt`.
- **`gateApp()`** clears a session made on the other backend, or a Firestore session whose Firebase sign-in is gone, then shows the login screen or loads the data.
- **`logout()`** clears the session and signs out of Firebase.

## Requests

All calls are written as Apps Script calls to `GS_URL` with `gsAuth()` (`{token}`). A `window.fetch` wrapper:
- in Firestore mode sends the five actions in `SUPPLIER_FN_ACTIONS` (`loadSchedule`, `loadPunchLog`, `supplierAddWorker`, `supplierUpdateWorker`, `supplierDeleteWorker`) to the `supplier` function (`SUPPLIER_FN_URL`, europe-west3) as JSON with `Authorization: Bearer <Firebase ID token>`, without the Apps Script token;
- in Sheets mode picks up `refreshedToken` / `refreshedExpiresAt` from replies (sliding session). There is no retry-then-logout logic on this page.

## Data (`loadData()`)

`loadSchedule` and `loadPunchLog` in parallel → `myWorkers`, `myClients`, `punchLog`. What the server sends a supplier (Apps Script `_stripWorkerForSupplier` / `_stripClientForSupplier`, `functions-auth/portal.py` `strip_worker` — the same lists):

- **workers** — only those with `supplierId` = this supplier, and only these fields: `id, name, docGiven, docSurname, docId, docType, docDob, docSex, address, houseNumber, city, maritalStatus, healthFund, workStartDate, phone, docChildren, clientIds, supplierId, token, startDate, expiryEnabled, expiryMonths, expiryWarnMonths, docUrl, docFileId, assetsFileId, avatarB64, colorIdx, notes, createdAt, schedule`, plus `supplierRate` = this supplier's commission override or `null`. Never `hourlyRate`, `otRate`, `shabbatRate`, `clientRates`, `supplierRates`. Note that `token` (the worker's punch link) and `docUrl` (the Form 101 PDF) are in the list;
- **clients** — `{id, name, object}` only;
- **suppliers** — always empty;
- **punches** — only this supplier's workers, only `id, workerId, workerName, type, time, date, site, clientId` (plus `ts`); no GPS, distance or notes. Firestore returns the last 13 months.

## Tabs (`switchTab`)

- **Dashboard** (`renderDashboard()`): On site now (workers whose last punch is IN), My workers (count), today's punches.
- **My Workers** (`renderWorkersList()`): Name, Phone, Object (client names), Commission (₪/h or —), edit and delete.
  - **Add / edit** (`renderWorkerModal` → `saveWorkerModal`): a manual form — given name, surname, phone, ID/passport number, address, city. The name fields fall back to splitting `name` for an older record. Given name is required. No document scan here (a deliberate scope cut).
  - **Delete** (`deleteWorker`) after `confirm()`.
  - After each change the data is reloaded.
- **My Hours** (`renderHoursTab()`): a month (this one and the 11 before it) and a worker.
  - **Detail** (`runDetailExport` → `exportShiftsDetail`): the worker's shifts that month, Date / In / Out / Hours + total, Excel or a print page.
  - **Summary** (`runSummaryExport` → `exportPayableSummary`): per worker with hours that month, hours × commission (`supplierRate`, else 5), Excel or a print page.

Hours use local copies of `groupPunchesIntoShifts` / `analyzeDayPunches` (simplified: no warnings, no rounding) and `getWorkerMonthShifts`. They are never wages.

## What a supplier can write

Only the three actions. On both backends:
- `supplierAddWorker` — a new worker with `supplierId` forced to the caller's own, `clientIds: []`, `schedule: []`, and only the editable fields;
- `supplierUpdateWorker` / `supplierDeleteWorker` — only a worker whose `supplierId` is the caller's; otherwise "Работник не найден";
- editable fields (`_supplierWorkerAllowedFields` / `SUPPLIER_EDITABLE`): `docGiven, docSurname, phone, docId, address, houseNumber, city, docDob, docSex, maritalStatus, healthFund, startDate, notes, status`; `name` is rebuilt from given name + surname.

A supplier cannot call `saveSchedule`, the hours-import queue or the AI reads (refused on the server), and has no client billing or wage data to show.
