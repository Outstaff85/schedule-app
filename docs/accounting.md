# Accounting and payroll

Hours and pay calculation, the Accounting tab, supplier commission, client billing, the hours-import approval queue, and the exports. Code is in `schedule-manager.html`.

**Rule:** all hours and pay go through the functions in "Canonical calculation" below. Never add a second hours or pay calculation.

## The punch (input data)

A punch is one IN or OUT:
`{id, workerId, workerName, type:'in'|'out', time:'HH:MM', date:'dd/MM/yyyy', ts:ISO, clientId, site, dist, gpsAccuracy, gpsSuspicious, gpsWarnings, notes, manual, editedAt, editedBy}`.
In Firestore it is a document `tenants/{t}/punches/{id}` with `ts` (Timestamp), `day` (`yyyy-MM-dd`) and `archived` added. Imported hours have ids `imp-<batch>-<row>-in|out`.

The client keeps the punch log in `localStorage.punchLog` (`getPunchLog()` / `savePunchLog()`). How it is loaded and kept in sync: [admin.md](admin.md) → Punch log data.

## Canonical calculation

- **`groupPunchesIntoShifts(entries)`** — one worker's punches, sorted by `ts`, split into shift buckets: each IN starts a bucket and the next OUT closes it. An overnight IN→OUT stays one shift. A bucket's `date` is the date of its first punch.
- **`analyzeDayPunches(entries, date)`** → `{hours, warnings}`.
  - Pairs IN→OUT; a negative duration wraps past midnight.
  - Warnings (Russian): double IN, OUT without IN, a 0-minute shift, a shift over 12 h, an open shift.
  - An open shift *today* counts up to now.
  - Durations go through `roundMins()` (`PAY_RULES.roundMinutes`, 0 = off).
- **`PAY_RULES`** = `{regularMax:8, ot1Span:2, roundMinutes:0, otMult:1.25, shabbatMult:1.5}`.
- **`israeliDayPay(hours, rate, isSat)`** — Israeli law tiers:

  | Hours | Weekday | Saturday |
  |---|---|---|
  | first 8 | ×1.0 | ×1.5 |
  | next 2 | ×1.25 | ×1.75 |
  | beyond | ×1.5 | ×2.0 |
- **`effectiveRates(w, clientId)`** — the most specific rate wins:
  1. `w.clientRates[clientId]` — the worker's own rate at this client (Accounting matrix);
  2. the client's `defaultHourlyRate` / `defaultOtRate` / `defaultShabbatRate`;
  3. the worker's `regRate` / `otRate` / `shabbatRate`, or `hourlyRate`.
  
  Without an explicit value, OT = regular × 1.25 and Shabbat = regular × 1.5. `hasOtOverride` / `hasShabbatOverride` say whether an explicit value was found at any tier. Shortcuts: `wRegRate`, `wOtRate`, `wShabRate`.
- **`shiftPay(hours, w, isSat, clientId)`**:
  - Saturday — a flat Shabbat override if one exists, otherwise the Saturday law tiers;
  - weekday — with an OT override, `min(h,8) × reg + rest × ot`; otherwise the weekday law tiers.
  
  **Saturday = the shift's opening date is a Saturday** (`date.getDay() === 6`).
- **Client billing** — a separate figure that never changes worker pay: `clientBillPay(hours, client, isSat)`.
  - `fixed` → `hours × fixedBillRate`;
  - `tiered` → the law tiers on `clientBillRate(client)` (`billRate`, else the old `defaultHourlyRate`), unless a flat `billOtRate` / `billShabbatRate` is set (applied like `shiftPay`).

## Accounting tab (`#sectionAccounting`)

`renderAccounting()` draws, in this order on the page:
1. **Salary Calculation** — `renderSalary()` into `#dashSalary`.
2. **Per-client rates** — `renderRateMatrix()`.
3. **Per-supplier rates** — `renderSupplierRateMatrix()`.
4. **Payable by supplier** — `renderSupplierPayable()`, called from `renderSalary()`.
5. **Billable by client** — `renderClientBillable()`, called from `renderSalary()`.
6. **Pending hours** — `renderPendingHours()`.

The tab is gated by the `accounting` permission.

### Salary (`renderSalary()`)

- **Period** (`#salaryPeriod`, filled by `fillSalaryPeriodSelect()` from `salaryExportPeriodOptions()`): This Week (from Sunday), This Month, each of the 12 previous months (`m:YYYY-MM`), All Time. `onSalaryPeriodChange()` first loads the punches that period needs (`ensurePunchesSince(periodPunchStart(period))` — see [admin.md](admin.md)), then redraws.
- **Calculation:**
  1. Punches are filtered by `ts` to the period and grouped per worker.
  2. Shifts come from `groupPunchesIntoShifts`; each shift goes through `analyzeDayPunches`.
  3. Per worker it sums hours, days worked and regular / OT / Saturday hours.
  4. **Pay** per shift = `shiftPay(h, worker, isSat, clientId of the shift's first punch)`.
  5. **Travel** = `w.travelAllowance` once per shift with hours.
  6. In parallel, `byClient[clientId]` sums hours and `clientBillPay()` for shifts that have a `clientId`.
- **Results:**
  - `__lastSalaryEntries` holds the per-worker rows (feeds Payable by supplier);
  - `__lastClientBillEntries` holds the per-client rows (feeds Billable by client).
- **Table:** Worker, Hours, Regular / OT / Shabbat ₪/h, Travel ₪, Total Pay (= wage + travel); a TOTAL row; 4 rows until "Show all" (`toggleSalary`).
  - **Editable rate inputs** — `setWorkerRate`, `setWorkerOtRate`, `setWorkerShabbatRate`. These edit the worker's **base** rates. The values shown are `wRegRate(w)` etc. *without* a client, so they don't reflect per-client rates.
  - **Warnings** — anomalies show as an amber "N to review" banner and a ⚠ icon per worker.

### Per-client rates (`renderRateMatrix()`)

One row per (worker, assigned client). Empty inputs show the resolved rate as a placeholder. `setClientRateOverride(wid, cid, field, val)` writes `w.clientRates[cid][field]` (`null` when emptied; the entry is removed when all three are empty), then saves.

### Supplier commission

- **Rate:** `SUPPLIER_DEFAULT_RATE` = 5 ₪/h. `supplierCommissionRate(w, sid)` returns `w.supplierRates[sid].rate` if set, otherwise the default.
- **Matrix:** `renderSupplierRateMatrix()` — one row per worker with a supplier and a single "Commission ₪/h" input. `setSupplierRateOverride()` writes it, then redraws the matrix and the payable table.
- **Payable by supplier:** `renderSupplierPayable(entries)`:
  - per supplier, hours × commission (never the worker's wage); stored in `__lastSupplierPayableRows` for the export buttons;
  - Excel / PDF buttons → `exportPayableSummary()`;
  - the **"No supplier assigned" row** shows those workers' hours and their **real pay total** (`e.total`), not a commission.

### Billable by client (`renderClientBillable(entries)`)

Per client: hours, mode (Fixed / Tiered) and the billable total. It never shows anything about suppliers.

### Pending hours (approval queue)

- **List:** `renderPendingHours()` sends `loadPendingHours` and lists batches with status `pending`: file, worker, uploaded by, shift count. Firestore mode answers from `tenants/{t}/pendingHours`; Apps Script from the `PendingHours_<t>` sheet.
- **Who may approve:** Approve / Reject buttons show only for `tenant_admin` and `superadmin` (the server checks the same). `staff` sees the list read-only; a `supplier` is refused everywhere.
- **Approving:** `approveHoursBatch(id)` → `approvePendingHours` creates IN and OUT punches per row, with no GPS fields and the note `Imported from <file>`. Approving again creates nothing. In Firestore mode the app then reads the batch's punches (`punchesOfBatch`) and loads back to the earliest of them, so a past month shows up.
- **Rejecting:** `rejectHoursBatch(id)` → `rejectPendingHours` marks the batch rejected and creates nothing.

Uploading the hours (worker card) is in [workers.md](workers.md).

## Exports

- **Salary export** (`openSalaryExportModal()` → `runSalaryExport(format)`):
  - it first loads the period's punches, then calls `exportSalary(format, period)`;
  - the rows come from `buildSalaryExportRows(period)`: one row per shift — Worker, Object/Client, Supplier, Date, First In, Last Out, Hours, Rate (`wRegRate` at the shift's client), Day Pay (`shiftPay`), Notes (the warnings);
  - formats:
    - Excel — SheetJS, sheet "Salary";
    - PDF — a print page in a new window;
    - CSV.
  
  `exportSalaryCSV()` = CSV without the picker.
- **Hours of one worker:** `getWorkerMonthShifts(workerId, year, month, workerLog?)` → `[{date, inTime, outTime, hours}]` for shifts that *start* in that month. `exportShiftsDetail(workerId, year, month, 'excel'|'pdf')` writes Date / In / Out / Hours plus a total. Opened from the worker card ([workers.md](workers.md)).
- **Summary rows:** `exportPayableSummary(rows, {title, filename, format})` writes rows the caller already computed (`{label, hours, rate, total}`) to Excel or PDF; it never recalculates.
- **Punch log CSV:** `exportPunchCSV()` — see [admin.md](admin.md).
- **Schedule week (Excel / PDF / JSON):** see [app-core.md](app-core.md).

## Today tab (`#sectionDashboard`)

Real-time attendance from the punch log and today's schedule; `renderDashboard()`. Never gated.

- **On site now** — workers whose last punch today is IN; shows "since" time and distance.
- **Should be here** — today's shift started more than 15 minutes ago and there is no punch, or the worker punched OUT more than 10 minutes before the shift's end.
- **Workers by supplier** — `renderDashSuppliers()`: a headcount per supplier plus "No supplier"; no pay data.
- **Expiry cards** — contract-term warnings (`workerExpiryStatus`) and expiring or expired worker documents (`workerDocExpiries`).
- **Today's punches** — 4 rows until "Show all" (`toggleLog`).

## Super-admin cross-firm summary

Admin → Firms → "Payable summary (all firms)" (`toggleSuperadminAccounting()` → `renderSuperadminAccounting()`).
- For each cached firm, `fetchForTenant('loadSchedule'|'loadPunchLog', tenantId)` sends GET requests with an explicit `asTenantId`, so the firm being viewed does not change.
- It computes this week's hours and `shiftPay` per firm with the canonical functions and shows a table with a grand total.
- **Limitation:** tier 2 of `effectiveRates()` reads the global `clients` — the firm currently loaded — not the other firm's clients.
