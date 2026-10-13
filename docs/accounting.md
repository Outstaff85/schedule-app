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
  - Warnings (English texts shown through `tr()`, so in the chosen language): double IN, OUT without IN, a 0-minute shift, a shift over 12 h, an open shift.
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
- **Daily pay** — `w.payMode === 'daily'` (picked per worker in the pay window, `savePayModal`): the worker is paid `dailyRate(w)` — their own rate (`wOwnRate`), read as ₪/day — once for every day worked, whatever the hours; no OT / Shabbat, and a client's (hourly) rate never applies. Every payroll figure prices a shift with **`shiftPayFor(hours, w, isSat, clientId, date, seenDays)`**: for a daily-paid worker the first shift of a day pays the day rate and later shifts that day pay 0 (`seenDays`, one Set per worker over the period); otherwise `shiftPay`. Days set by hand for a period (`w.dayOverrides[salaryPeriodKey(period)]`, `dayOverride`; keys `w:<Sunday>`, `m:<yyyy-mm>`, `all`) replace the counted days: pay = days × daily rate.
- **Client billing** — a separate figure that never changes worker pay: `clientBillPay(hours, client, isSat)`.
  - `fixed` → `hours × fixedBillRate`;
  - `daily` → `dailyBillRate` for a shift with hours (0 for an empty one), whatever its length;
  - `tiered` → the law tiers on `clientBillRate(client)` (`billRate`, else the old `defaultHourlyRate`), unless a flat `billOtRate` / `billShabbatRate` is set (applied like `shiftPay`).

## Accounting tab (`#sectionAccounting`)

Every text of the tab goes through the chosen language ([translations.md](translations.md)): `tr()` in the render functions, `data-i18n` on the static headers. This covers the help (ⓘ) texts, the pay modal, messages, the period labels (`SALARY_PERIOD_LABELS`, month names in the language's locale) and the salary / payable exports. With Hebrew the tab reads חשבונות and its sections חישוב שכר, שכר עובדים, תעריפים לפי לקוח, עמלות ספקים, לתשלום לספקים, לתשלום למשאבי אנוש, לחיוב לקוחות, שעות ממתינות לאישור. Shift warnings from `analyzeDayPunches` (shared with the rest of the app) stay English.

**Top of the tab** (redesign stage 7): the period in glass (`#accPeriodNav`: ‹ `stepSalaryPeriod(-1)` an earlier period, the period select `#salaryPeriod` styled as a glass button, › a later one), the figures (`#accFigs`, `renderAccFigs(entries)`: the period's hours and payroll — pay + travel — over every Salary row from `salaryEntriesFor`, and the hours batches waiting, a tap opens Approvals), and the tabs **Salary / Billing / Approvals** (`#accTabs`, `__accTab`, `setAccTab(k)`; a red count on Approvals). Each block below carries `data-tab` (salary: Salary Calculation; billing: the rate matrices, Payable by supplier, Payable by HR, Billable by client; approvals: Hours approvals, Pending hours) and CSS shows only the open tab's blocks (`#sectionAccounting[data-acctab]`). An HR sees no tabs (its Hours review and Salary only). The salary lines are plates (the bar and avatar in the line's colour, the total in the figure green).

`renderAccounting()` draws, in this order on the page:
1. **Salary Calculation** — `renderSalary()` into `#dashSalary`.
2. **Per-client rates** — `renderRateMatrix()`.
3. **Per-supplier rates** — `renderSupplierRateMatrix()`.

   Both tables are turned off for now (`ACC_RATE_TABLES = false`, user request 2026-10-11): their sections are hidden and not drawn. Rates already set in them still count — a worker's per-client override (`w.clientRates`, tier 1 of `effectiveRates`) and the per-supplier commission (`w.supplierRates`); `true` shows them again.
4. **Payable by supplier** — `renderSupplierPayable()`, called from `renderSalary()`.
   **Payable by HR** — `renderHrPayable()` (owner / super-admin, shown when the firm has HR logins): per HR, `commissionFor` with the HR's commission rates (its `commissionRate` and `commissionDayRate` when set) on the workers whose `hrId` is that HR; never a wage.
5. **Billable by client** — `renderClientBillable()`, called from `renderSalary()`.
   **Hours approvals** — `renderHourApprovals(period)`, called from `renderSalary()` (a month period, never for an HR): what each client, supplier and HR login approved, disputed or proposed to fix, with Accept / Reject for a fix ([hours-review.md](hours-review.md)).
6. **Pending hours** — `renderPendingHours()`.

Each section title has an (i) button (`.acc-help`) that opens the section's explanation in a modal (`openAccountingHelp(key)` → `#accHelpOverlay`, texts in `ACCOUNTING_HELP`); the page itself carries no explanatory text. A change to how a section works updates its text there.

The tab is gated by the `accounting` permission. For an HR that permission gives only the reduced tab of `hrPayOnly()` (never the full one) ([hr.md](hr.md) → Pay): `renderAccounting` hides every section but Salary, `renderSalary` keeps only its workers and adds "My commission"; the pay window is read-only for it unless `payEdit`. An HR with an hours tick also gets **Hours approval** at the top (`#accSecReview`, `hrHourReview()`, the shared `hours-review.js`), and the tab for it alone when it has no Accounting section ([hours-review.md](hours-review.md)).

### Salary (`renderSalary()`)

The per-worker and per-client figures come from `salaryEntriesFor(period)` → `{byWorker, byClient}` (byWorker entries: `worker, workerId, hours, days, regH, otH, shabH, total, travel, warns, clientHours, countedDays, daysUsed`); `renderSalary()` draws them and the accountant report reuses them. The worker's own "My Hours and Pay" on the punch page repeats the same steps for one month ([punch.md](punch.md)).


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
- **Head (one line, variant A, user request 2026-10-11):** the title, the period select drawn as accent text with its arrow (`.acc-period`, `#salaryPeriod`), a search icon (`toggleSalarySearch()` opens `#salarySearch` under the line, focused; closing it clears the search) and an export icon (`openSalaryExportModal`). The Payable by supplier head carries its Excel / PDF icons the same way (`.acc-head`).
- **Rows: only the workers with shifts in the period** (the entries of `salaryEntriesFor`; workers without hours are not listed). `#salarySearch` narrows the rows by name, and the totals with them; Payable by supplier and the rest always use every entry (`__lastSalaryEntries`).
- **Totals** (`.sal-sum`, above the list): Hours, Pay, Travel ₪, Total Pay (= pay + travel); an HR also gets "My commission". They cover every row shown.
- **List** (no input fields; one compact line per worker so a long list stays short, user request 2026-10-11): a line (`.sal-row`) holds the worker (⚠ when there are punches to check), hours and total pay; a tap opens its details (`.sal-det`): the Regular / Overtime / Shabbat split, Days (`daysUsed`; "punches: N" when set by hand), Rate (the own rate ₪/h or ₪/day; grey "client ₪x/h" when the client's applies — the client the worker had most hours at, `clientHours`; amber "set a daily rate" / "no rate"), Pay, Travel ₪, Bank (bank, branch, account; amber "no bank details"), and an HR's "My commission". The rows are paged by 10 ([app-core.md](app-core.md) → Long lists). Supplier payable and client billable are paged the same way.
- **Details** are one line each (the label left, the figure right).
- **Payable by supplier / by HR, Billable by client:** lines in the template (the supplier's, HR's or client's color on the left; hours under the name; the sum on the right); a tap on a supplier or client line opens a window with the workers behind the sum (`openSupplierPayDetail` — each worker's hours and commission by `commissionFor`; `openClientBillDetail` — each worker's hours at that client from `clientHours`, and the client's total), paged by 10.
- **A row:** a tap opens or closes its details; the worker's name opens the worker card (`openWorkerCardById`); its details hold **Pay**, which opens the pay window — so does a double click (computer) or a long press (phone) on the row (`openPayModal`, below).
  - **Warnings** — anomalies show as an amber "N to review" banner and a ⚠ icon per worker.

### Pay window (`openPayModal(wid)`, `#payOverlay`)

The one place a worker's money is set — from a Salary row or the worker card's "Pay" button (so a worker without shifts in the period is set there); the worker modal and Upload hours carry no rate, pay mode, travel or bank field ([workers.md](workers.md)). There is no separate Worker pay section (merged into Salary, user request 2026-10-11).

- **Who edits:** `canEditPay(w)` — the firm owner, a super-admin, staff with the `accounting` permission, and an HR with `payEdit` ("Edit own workers' pay") for its own workers only ([hr.md](hr.md)). The **Pay** button in a Salary row's details opens it; so does the worker card's "Pay" button.
- **Fields:** Paid ₪/h | ₪/day (`payMode`, `onPayModeChange` hides OT / Shabbat and shows Days for a daily worker); Rate (the own rate; empty = the client's, by the hour only); **Days — <period>** for a daily worker (`#payDays`: the days of the period picked in Salary, `dayOverride(w, salaryPeriodKey(period))`; empty = by the punches, shown as the placeholder; saved in `w.dayOverrides`); OT and Shabbat ₪/h (empty = law); Travel ₪/day (`travelAllowance`) and ₪/month (`travelMonthly`); bank, branch, account. `savePayModal` writes them (`regRate` cleared), `autoSave()`, redraws Accounting.
- **HR** (`hrPayOnly()`): only its own workers' Salary rows, bank included; its **Pay**, a double click or a long press opens the pay window read-only (every field disabled, no Save), or editable with `payEdit`.
- **Client rule** (`saveWorker`, [workers.md](workers.md)): adding a client that has a rate to an hourly worker with an own rate clears the own rate (`hourlyRate = 0`), so the new client's rate applies.

### Per-client rates (`renderRateMatrix()`)

One row per (worker, assigned client). Empty inputs show the resolved rate as a placeholder. `setClientRateOverride(wid, cid, field, val)` writes `w.clientRates[cid][field]` (`null` when emptied; the entry is removed when all three are empty), then saves.

### Supplier commission

- **Rate:** `SUPPLIER_DEFAULT_RATE` = 5 ₪/h. `supplierCommissionRate(w, sid)` returns `w.supplierRates[sid].rate` if set, otherwise the default. **Daily rate:** `supplierDayCommission(w, sid)` returns `w.supplierRates[sid].dayRate` if set, else `null`; a fixed ₪ per day worked for a worker paid by the day.
- **Matrix:** `renderSupplierRateMatrix()` — one row per worker with a supplier and two inputs: "Commission ₪/h" and "₪/day (daily workers)" (empty for a daily worker = hours × ₪/h). `setSupplierRateOverride()` writes it, then redraws the matrix and the payable table.
- **Commission:** `commissionFor(w, e, hourRate, dayRate)` — a worker's commission for one Salary row: if the worker is paid by the day (`isDailyPay`) and a day rate is set, days × day rate; else hours × hour rate (the supplier's default or override).
- **Payable by supplier:** `renderSupplierPayable(entries)`:
  - per supplier, `commissionFor` with the supplier's rates (never the worker's wage); stored in `__lastSupplierPayableRows` for the export buttons;
  - Excel / PDF icons in the section head → `exportPayableSummary()`;
  - **only the suppliers with hours and a commission** in the period; workers without a supplier are left out, and with no row the section (`#accSecPayable`) is hidden (user request 2026-10-11). The same holds for Payable by HR (only HRs with hours and a commission rate, `#accSecHrPayable`) and Billable by client (only clients with hours and a billing rate, `#accSecBillable`); Salary lists only workers with shifts.

### Billable by client (`renderClientBillable(entries)`)

Per client: hours, mode (Fixed / Tiered) and the billable total. It never shows anything about suppliers.

### Pending hours (approval queue)

- **List:** `renderPendingHours()` sends `loadPendingHours` and lists batches with status `pending`, a template-3 line each (amber mark): the worker, then file · uploaded by, then the shift count; ✓ / ✕ icons at the right. For the owner a "Batches" section line and Select always on (`startPendingSelect`): tick batches, then the glass bar's **Approve** (each through `approveHoursBatch`) or **Reject** (`bulkHoursBatches`, one confirm for all). The batches are `tenants/{t}/pendingHours` documents.
- **Who may approve:** the Approve / Reject icons show only for `tenant_admin` and `superadmin` (the server checks the same). `staff` sees the list read-only; a `supplier` is refused everywhere.
- **Approving:** `approveHoursBatch(id)` → `approvePendingHours` creates IN and OUT punches per row, with no GPS fields and the note `Imported from <file>`. Approving again creates nothing. The app then reads the batch's punches (`punchesOfBatch`) and loads back to the earliest of them, so a past month shows up.
- **Rejecting:** `rejectHoursBatch(id)` → `rejectPendingHours` marks the batch rejected and creates nothing.
- Approving and rejecting store `decidedAt`; the sender sees the batch's status (worker card → Upload hours, [workers.md](workers.md); the supplier portal's My Hours). A supplier's batches (`supplierId`, uploaded by the supplier's name, "entered by hand") come in through the `supplier` function and are approved the same way.

- **Live count and status:** `watchHoursBatches()` (after the load, any manager-side login) keeps `__hoursBatches` from `listenPendingHours`. `updateHoursBadge()` shows the number of batches waiting for a decision on the Accounting tab (`#accPendingBadge`, `.tab-badge`, hidden at 0); the worker card shows the worker's latest batch and its status (`cardHoursStatusHtml` / `latestHoursBatch`, redrawn live while the card is open); an open Accounting tab redraws Pending hours.

Uploading the hours (worker card) is in [workers.md](workers.md).

## Exports

- **Salary export** (`openSalaryExportModal()` → `runSalaryExport(format)`):
  - it first loads the period's punches, then calls `exportSalary(format, period)`;
  - the rows come from `buildSalaryExportRows(period)`: one row per shift — Worker, Object/Client, Supplier, Date, First In, Last Out, Hours, Rate (`wRegRate` at the shift's client, or `<daily rate>/day`), Day Pay (`shiftPayFor`), Notes (the warnings); for a daily-paid worker with days set by hand, one extra row "Days set by hand: N (punches: M)" brings the total to N × rate;
  - formats:
    - Excel — SheetJS, sheet "Salary";
    - PDF — a print page in a new window;
    - CSV.
    - **Accountant report** (`'accountant'`, hidden for an HR that only sees pay) — `exportAccountantReport(period)`: an Excel file `accountant-<period>.xlsx` with the sheet "Summary" (title, firm name, then one row per worker from `salaryEntriesFor`: Worker, ID / Passport, Supplier, Pay mode, Rate, Days, Regular / Overtime / Shabbat / Total hours, Pay, Travel, Total, Bank, Branch, Account, Warnings, and a total row) and the sheet "Shifts" (the rows of `buildSalaryExportRows`).
  
  `exportSalaryCSV()` = CSV without the picker.
- **Hours of one worker:** `getWorkerMonthShifts(workerId, year, month, workerLog?)` → `[{date, inTime, outTime, hours}]` for shifts that *start* in that month. `exportShiftsDetail(workerId, year, month, 'excel'|'pdf')` writes Date / In / Out / Hours plus a total. Opened from the worker card ([workers.md](workers.md)).
- **Summary rows:** `exportPayableSummary(rows, {title, filename, format})` writes rows the caller already computed (`{label, hours, rate, total}`) to Excel or PDF; it never recalculates.
- **Punch log CSV:** `exportPunchCSV()` — see [admin.md](admin.md).
- **Schedule week (Excel / PDF / JSON):** see [app-core.md](app-core.md).

## Today tab (`#sectionDashboard`)

Real-time attendance from the punch log and today's schedule; `renderDashboard()`. Never gated.

**Greeting** (redesign stage 5): at the top, "Good morning / Good afternoon / Good evening / Good night, <first name>" by the device's local time (5–12, 12–17, 17–21, 21–5; `partOfDay`, `greetingHtml`, `renderGreeting`), with a small animated icon after the name (`GREET_ICONS`: sunrise, sun, sunset, moon with stars). No box, no summary line.

**Notifications** (redesign stage 5): the bell in the title bar (`#bellBtn`, manager-side logins only; a red count that pulses, the bell swings while something is unread). `notifList()` builds the list, newest first, each with a steady id (prefixed with the firm): an ID / passport or a document (visa, permit, contract, other) expired or expiring, a contract ended or ending, no punch on today's shift (the same rules as the worker plate's notices — [workers.md](workers.md)), hours batches waiting (`__hoursBatches`, with Accounting), and a client login that approved every day of this month (`refreshNotifApprovals`, the hours function's list at most every 5 minutes, not for HR). A tap on the bell opens a glass panel with a tail (`toggleBell`, `#bellPanel`, paged by 10): icon in its importance colour, title, a detail line, the time (or date), a glowing cyan dot on unread ones, and **Mark all read** (`markAllNotifRead`). A tap on one marks it read and opens what it is about (the worker's notices sheet, or Accounting). A no-punch notification of a worker with a phone has **Call** and **WhatsApp** buttons under it (`acts`, `noPunchActs`; [admin.md](admin.md) → WhatsApp reminder). The read ids are kept on the login's account (`notifReads/{uid}`, `loadNotifReads` / `saveNotifReads`, [backend.md](backend.md)), so they follow it to any device. `refreshBell()` runs after every `render()`, on hours-batch changes and every minute.

Drawn in the app's template (variant 3, user request 2026-10-11; see [app-core.md](app-core.md) → Layout): four figures on top (`#dashStats`: on site, missing, expiring, punches). **A figure is a filter** (variant A, user request 2026-10-11; `dashFilterTo(key)`, `__dashFilter`): a tap shows only its section, opened, highlights the figure and writes "Showing: … · Show all" under the figures (`#dashFilterNote`); the same figure or Show all brings everything back. **Each section folds** with the arrow at its right (`toggleDashSec(key)`; the folded ones are kept on this device in `localStorage.dashFolded`; `applyDashView()` applies both after each draw), then one section per list with its count, each worker a line with a colored mark on the left (`t3Line` / `t3Av`; red — missing or out, green — on site or in, amber — expiring); a tap on a line opens the worker card. An empty section is hidden (the log says "No punches today").

- **On site now** — workers whose last punch today is IN; shows "since" time and distance.
- **Should be here** — first on the page, with how late ("late 2h" / "late 20 min"); today's shift (`shiftOn`, so a change for today's date counts) started more than 15 minutes ago and there is no punch, or the worker punched OUT more than 10 minutes before the shift's end.
- **Workers by supplier** — `renderDashSuppliers()`: a headcount line per supplier (a tap opens Suppliers) that has workers; workers without a supplier get no card, and with no such supplier the section is hidden (`#dashSuppliersWrap`); no pay data.
- **Expiry cards** — contract-term warnings (`workerExpiryStatus`) and expiring or expired worker documents (`workerDocExpiries`).
- **Today's punches** — paged by 10, like the on-site, missing, suppliers and expiring tiles ([app-core.md](app-core.md) → Long lists).

## Super-admin cross-firm summary

Admin → Firms → "Payable summary (all firms)" (`toggleSuperadminAccounting()` → `renderSuperadminAccounting()`).
- For each cached firm, `fetchForTenant('loadSchedule'|'loadPunchLog', tenantId)` reads that firm with an explicit `asTenantId`, so the firm being viewed does not change. Punches: this month plus the week before.
- It computes this week's hours and pay per firm with the canonical functions (`shiftPayFor`; a daily-paid worker's days set by hand for this week count, as in Salary) and shows a table with a grand total.
- The client tier of `effectiveRates()` reads the global `clients`, so while a firm's pay is computed its own clients stand in for the loaded firm's, and are swapped back right after.
