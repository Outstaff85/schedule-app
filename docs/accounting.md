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
  2. the worker's own rate — `hourlyRate` (or the older `regRate`), `otRate`, `shabbatRate` — from the worker modal or Accounting → Salary; it changes this worker only;
  3. the client's `defaultHourlyRate` / `defaultOtRate` / `defaultShabbatRate` — shared by every worker there without a rate of their own.
  
  Each of the three rates resolves on its own. Without an explicit value, OT = regular × 1.25 and Shabbat = regular × 1.5. `hasOtOverride` / `hasShabbatOverride` say whether an explicit value was found at any tier; `src` / `otSrc` / `shabbatSrc` say which tier (`override`, `worker`, `client`, or empty). Shortcuts: `wRegRate`, `wOtRate`, `wShabRate`.
- **`shiftPay(hours, w, isSat, clientId)`**:
  - Saturday — a flat Shabbat override if one exists, otherwise the Saturday law tiers;
  - weekday — with an OT override, `min(h,8) × reg + rest × ot`; otherwise the weekday law tiers.
  
  **Saturday = the shift's opening date is a Saturday** (`date.getDay() === 6`).
- **Daily pay** — `w.payMode === 'daily'` (picked per worker in Accounting → Worker pay, `savePayModal`, or in Salary, `setWorkerPayMode`): the worker is paid `dailyRate(w)` — their own rate (`wOwnRate`), read as ₪/day — once for every day worked, whatever the hours; no OT / Shabbat, and a client's (hourly) rate never applies. Every payroll figure prices a shift with **`shiftPayFor(hours, w, isSat, clientId, date, seenDays)`**: for a daily-paid worker the first shift of a day pays the day rate and later shifts that day pay 0 (`seenDays`, one Set per worker over the period); otherwise `shiftPay`. Days set by hand for a period (`w.dayOverrides[salaryPeriodKey(period)]`, `dayOverride`; keys `w:<Sunday>`, `m:<yyyy-mm>`, `all`) replace the counted days: pay = days × daily rate.
- **Client billing** — a separate figure that never changes worker pay: `clientBillPay(hours, client, isSat)`.
  - `fixed` → `hours × fixedBillRate`;
  - `tiered` → the law tiers on `clientBillRate(client)` (`billRate`, else the old `defaultHourlyRate`), unless a flat `billOtRate` / `billShabbatRate` is set (applied like `shiftPay`).

## Accounting tab (`#sectionAccounting`)

`renderAccounting()` draws, in this order on the page:
1. **Salary Calculation** — `renderSalary()` into `#dashSalary`.
1a. **Worker pay** — `renderWorkerPay()` into `#workerPayWrap` (below).
2. **Per-client rates** — `renderRateMatrix()`.
3. **Per-supplier rates** — `renderSupplierRateMatrix()`.
4. **Payable by supplier** — `renderSupplierPayable()`, called from `renderSalary()`.
   **Payable by HR** — `renderHrPayable()` (owner / super-admin, shown when the firm has HR logins): per HR, the hours of the workers whose `hrId` is that HR × its `commissionRate`; never a wage.
5. **Billable by client** — `renderClientBillable()`, called from `renderSalary()`.
6. **Pending hours** — `renderPendingHours()`.

Each section title has an (i) button (`.acc-help`) that opens the section's explanation in a modal (`openAccountingHelp(key)` → `#accHelpOverlay`, texts in `ACCOUNTING_HELP`); the page itself carries no explanatory text. A change to how a section works updates its text there.

The tab is gated by the `accounting` permission. For an HR that permission gives only the reduced tab of `hrPayOnly()` (never the full one) ([hr.md](hr.md) → Pay): `renderAccounting` hides every section but Salary and Worker pay, `renderSalary` keeps only its workers, makes the table read-only (`.salary-ro`, the setters refuse) and adds "My commission".

### Salary (`renderSalary()`)

- **Period** (`#salaryPeriod`, filled by `fillSalaryPeriodSelect()` from `salaryExportPeriodOptions()`): This Week (from Sunday), This Month, each of the 12 previous months (`m:YYYY-MM`), All Time. `onSalaryPeriodChange()` first loads the punches that period needs (`ensurePunchesSince(periodPunchStart(period))` — see [admin.md](admin.md)), then redraws.
- **Calculation:**
  1. Punches are filtered by `ts` to the period and grouped per worker.
  2. Shifts come from `groupPunchesIntoShifts`; each shift goes through `analyzeDayPunches`.
  3. Per worker it sums hours, days worked and regular / OT / Saturday hours.
  4. **Pay** per shift = `shiftPay(h, worker, isSat, clientId of the shift's first punch)`.
  5. **Travel** = `travelPay(w, days, months)`: `w.travelAllowance` ₪ × days worked (`daysUsed`, so a daily worker's days set by hand count) + `w.travelMonthly` ₪ once for each calendar month with a day worked. Travel is never part of the wage (`shiftPayFor`).
  6. In parallel, `byClient[clientId]` sums hours and `clientBillPay()` for shifts that have a `clientId`.
- **Results:**
  - `__lastSalaryEntries` holds the per-worker rows (feeds Payable by supplier);
  - `__lastClientBillEntries` holds the per-client rows (feeds Billable by client).
- **Table:** Worker, Hours, Regular / OT / Shabbat ₪/h, Travel ₪, Total Pay (= wage + travel); a TOTAL row covering every worker; the rows are paged by 10 ([app-core.md](app-core.md) → Long lists). Supplier payable, client billable and both rate matrices are paged the same way.
  - **Editable rate inputs** — `setWorkerRate`, `setWorkerOtRate`, `setWorkerShabbatRate`. They hold the worker's **own** rates (tier 2), and an edit changes that worker only (`setWorkerRate` also clears the older `regRate`). Empty = no own rate: the placeholder shows the rate that applies at the client the worker had most hours at in the period (`clientHours`), with "client · name" (or "rate matrix") under it. The client's rate itself is edited in the client card.
  - **Days** — days worked by the punches (`countedDays`, two shifts on one day count once). The Rate column has a ₪/h | ₪/day select per worker; for a daily-paid worker Days is an input (`setWorkerDays`: a number replaces the count for this period, empty goes back) and OT / Shabbat show "—". A daily worker with no own rate shows "set a daily rate".
  - **Warnings** — anomalies show as an amber "N to review" banner and a ⚠ icon per worker.

### Worker pay (`renderWorkerPay()`)

The one place a worker's money is set; the worker modal, the worker card and Upload hours carry no rate, pay mode, travel or bank field ([workers.md](workers.md)).

- **Cards:** one `.wcard` per worker (a new one with no shifts too) in a `.clients-grid`, searchable (`#workerPaySearch`), paged by 10. Each card: the name and the rate (the own rate ₪/h or ₪/day, else the client's in grey; a daily worker without one shows "set a daily rate"); for the period picked in Salary the days, hours, pay, travel and total (from `__lastSalaryEntries`, so `renderWorkerPay` runs after `renderSalary` and after each Salary edit), or "no shifts"; travel ₪/day + ₪/month; the bank, branch and account ("no bank details" in amber).
- **Who edits:** `canEditPay(w)` — the firm owner, a super-admin, staff with the `accounting` permission, and an HR with `payEdit` ("Edit own workers' pay") for its own workers only ([hr.md](hr.md)). A tap on a card (`tap-edit`) opens `openPayModal(wid)`; the worker card's "Pay" button opens the same modal.
- **Pay modal** (`#payOverlay`): Paid ₪/h | ₪/day (`payMode`, `onPayModeChange` hides OT / Shabbat for a daily worker); Rate (the own rate; empty = the client's, by the hour only); OT and Shabbat ₪/h (empty = law); Travel ₪/day (`travelAllowance`) and ₪/month (`travelMonthly`); bank, branch, account. `savePayModal` writes them (`regRate` cleared), `autoSave()`, redraws Accounting.
- **HR** (`hrPayOnly()`): only its own workers' cards, bank details included; a tap opens the pay modal read-only (every field disabled, no Save), or editable with `payEdit`.
- **Client rule** (`saveWorker`, [workers.md](workers.md)): adding a client that has a rate to an hourly worker with an own rate clears the own rate (`hourlyRate = 0`), so the new client's rate applies.

### Per-client rates (`renderRateMatrix()`)

One row per (worker, assigned client). Empty inputs show the resolved rate as a placeholder. `setClientRateOverride(wid, cid, field, val)` writes `w.clientRates[cid][field]` (`null` when emptied; the entry is removed when all three are empty), then saves.

### Supplier commission

- **Rate:** `SUPPLIER_DEFAULT_RATE` = 5 ₪/h. `supplierCommissionRate(w, sid)` returns `w.supplierRates[sid].rate` if set, otherwise the default.
- **Matrix:** `renderSupplierRateMatrix()` — one row per worker with a supplier and a single "Commission ₪/h" input. `setSupplierRateOverride()` writes it, then redraws the matrix and the payable table.
- **Payable by supplier:** `renderSupplierPayable(entries)`:
  - per supplier, hours × commission (never the worker's wage); stored in `__lastSupplierPayableRows` for the export buttons;
  - Excel / PDF buttons → `exportPayableSummary()`;
  - the **"No supplier assigned" row** shows those workers' hours only; its payable is "—" (nothing is owed to a supplier for them, and a wage never appears in this table).

### Billable by client (`renderClientBillable(entries)`)

Per client: hours, mode (Fixed / Tiered) and the billable total. It never shows anything about suppliers.

### Pending hours (approval queue)

- **List:** `renderPendingHours()` sends `loadPendingHours` and lists batches with status `pending`: file, worker, uploaded by, shift count. The batches are `tenants/{t}/pendingHours` documents.
- **Who may approve:** Approve / Reject buttons show only for `tenant_admin` and `superadmin` (the server checks the same). `staff` sees the list read-only; a `supplier` is refused everywhere.
- **Approving:** `approveHoursBatch(id)` → `approvePendingHours` creates IN and OUT punches per row, with no GPS fields and the note `Imported from <file>`. Approving again creates nothing. The app then reads the batch's punches (`punchesOfBatch`) and loads back to the earliest of them, so a past month shows up.
- **Rejecting:** `rejectHoursBatch(id)` → `rejectPendingHours` marks the batch rejected and creates nothing.
- Approving and rejecting store `decidedAt`; the sender sees the batch's status (worker card → Upload hours, [workers.md](workers.md); the supplier portal's My Hours). A supplier's batches (`supplierId`, uploaded by the supplier's name, "entered by hand") come in through the `supplier` function and are approved the same way.

Uploading the hours (worker card) is in [workers.md](workers.md).

## Exports

- **Salary export** (`openSalaryExportModal()` → `runSalaryExport(format)`):
  - it first loads the period's punches, then calls `exportSalary(format, period)`;
  - the rows come from `buildSalaryExportRows(period)`: one row per shift — Worker, Object/Client, Supplier, Date, First In, Last Out, Hours, Rate (`wRegRate` at the shift's client, or `<daily rate>/day`), Day Pay (`shiftPayFor`), Notes (the warnings); for a daily-paid worker with days set by hand, one extra row "Days set by hand: N (punches: M)" brings the total to N × rate;
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
- **Today's punches** — paged by 10, like the on-site, missing, suppliers and expiring tiles ([app-core.md](app-core.md) → Long lists).

## Super-admin cross-firm summary

Admin → Firms → "Payable summary (all firms)" (`toggleSuperadminAccounting()` → `renderSuperadminAccounting()`).
- For each cached firm, `fetchForTenant('loadSchedule'|'loadPunchLog', tenantId)` reads that firm with an explicit `asTenantId`, so the firm being viewed does not change. Punches: this month plus the week before.
- It computes this week's hours and pay per firm with the canonical functions (`shiftPayFor`; a daily-paid worker's days set by hand for this week count, as in Salary) and shows a table with a grand total.
- The client tier of `effectiveRates()` reads the global `clients`, so while a firm's pay is computed its own clients stand in for the loaded firm's, and are swapped back right after.
