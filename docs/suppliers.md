# Suppliers

Suppliers are staffing agencies a worker comes through. This file covers the Suppliers tab and window, and how suppliers feed the rest of the app. Since stage 6d the tab and its window are React inside the manager page (`src/manager/Clients.tsx` → `Suppliers`, `SupplierEditor.tsx`, the rules in `clients.ts`; [build.md](build.md) → The manager's React pieces); the records, the figures and the saves stay in `schedule-manager.html` (`ManagerBridge`). The supplier's own login page is [supplier-portal.md](supplier-portal.md).

## Data

The global `suppliers` array. It is saved with the schedule; each supplier is one document `tenants/{t}/suppliers/{id}`.

`{id, name, color, phone, bank, bankBranch, accountNumber, companyNumber}` — `companyNumber` is the ח.פ. All of them are plain text, so leading zeros are kept. An older `notes` field may exist but is not shown.

A worker links to **one** supplier through `w.supplierId` (set in the worker modal, or by the owner / super-admin in Admin → Users, a supplier login's **Workers** section: list, Unassign, Add workers — [admin.md](admin.md)); The supplier's own commission rate is `sp.commission` = `[{from, mode: 'hour'|'day', rate}]` (each entry applies from its date; none = ₪`SUPPLIER_DEFAULT_RATE` 5/h); `w.supplierRates[supplierId].rate` (or `.dayRate` for a daily-paid worker) overrides it for that worker.

## Suppliers tab (`#suppliersRoot`, React)

`renderSuppliersPage()` asks `ManagerIsland.renderSuppliers()` to draw `Suppliers` from `ManagerBridge.suppliers()` (each supplier's name, colour, phone, its workers and their hours this month — `workersMonthHours` — and `canEdit`, the `suppliers` section). The breadcrumb shows "Suppliers N"; no page title, no side panel. A glass **New** and, with `suppliers`, **Select** above the plates; a plate per supplier (paged by 10): its colour as the bar, the name, "N workers · phone", the hours in green, a ⋮ (Edit, Delete) and a swipe left (Edit, Delete); a tap (with a mouse after 250 ms, waiting for a double click), a double click or a long press opens the window.

- **The window** (`#supplierModal`, React `SupplierEditor`): `openAddSupplier()` / `openEditSupplier(sid)` set `editingSupplierId` (a new supplier gets the next `CLIENT_COLORS` colour, an edited one keeps its colour — no colour picker) and `showSupplierModal(s)` draws it (`ManagerIsland.openSupplier`) with `ManagerBridge.supplierInfo(editId)`: its workers with this month's hours, the commission payable (`supplierMonthPayable` — `supplierCommission` over `salaryEntriesFor('month')`, the same figure as Payable by supplier), its supplier logins, `canRate` (`isFirmAdminSession`), `canDelete`, `SUPPLIER_DEFAULT_RATE`. A head (colour, name, "N workers · ₪X this month" — a new one: the phone — and a ⋮ with Delete: closed without saving, then the Undo snack), the section plates in the owner's fixed order — **Company** (Name — amber while empty; Company no. and Phone in a pair; Contact person — `contactPerson`; Bank / Branch / Account #) and, for a saved supplier, **Commission** (three figures — this month's hours, the commission payable, its workers. The owner and the super-admin set the supplier's own rate here: Per hour / Per day (`#sComMode`), Rate (`#sComRate`, empty = the default) and Applies from (`#sComFrom`, a Date Picker, today by default); saving runs `commissionFromForm`, which adds an entry to `sp.commission` from that date, replacing one with the same date, only when the rate or mode changes on that date (`rateOn` — the portal's `myRateOn`, the same rule as the page's `supplierRateOn`); everyone else reads the current rate; up to three older rates are listed under it; per-worker overrides stay in Accounting and win; `firestore.rules` lets only the owner or a superadmin change `commission`), **Portal login** (its supplier logins with, per login, the portal tabs it sees — `supplierSections` — "Sees own workers' pay" — `showPay` — and its hours ticks — `hourPerms`: Hours, Approve, Dispute, Fix, Schedule, Export — as read-only tiles under its template ("Rights follow <template>"; they change only in the template, [admin.md](admin.md) → Users pane); "New portal login" → `newLoginFor('supplier', id)`: the user form with the role and supplier set) and **Workers** (a small plate per worker — green active, red inactive — with this month's hours) — and one **Save** ("Add Supplier" for a new one). A tap outside closes the window without saving.
- **Saving:** `supplierRecordOf` (+ the commission list when it changed) → `ManagerBridge.commitSupplier(editId, fields)` → `commitSupplier` updates in place or pushes a new supplier (`uid()`), toasts, redraws and saves. An empty name opens Company and focuses it.
- **Removing:** Delete never asks: the plate goes behind the Undo snack (left out meanwhile); after 5 s `ManagerBridge.deleteSuppliers(ids)` → `deleteSuppliersNow` removes the supplier and, on every worker, sets `supplierId` to `null` and deletes `supplierRates[sid]`; then it saves.

## Where suppliers are used

- **Workers:** the Supplier `<select>` in the worker modal, the Supplier filter, group by supplier, and the supplier badge on cards and rows ([workers.md](workers.md)).
- **Today tab:** "Workers by supplier" headcount (drawn in React: `todayModel` in `src/manager/today.ts`, the section in `src/manager/Today.tsx`; [accounting.md](accounting.md) → Today).
- **Accounting:**
  - "Payable by supplier" (`renderSupplierPayable()`): per worker `supplierCommission(w, e, sid)` — with an override of the worker's own (`workerHasSupplierOverride`: `supplierRates[sid].rate`, or `.dayRate` for a daily-paid worker) `commissionFor` (hours × the ₪/h, or days × the ₪/day); otherwise `e.supCom`, summed shift by shift in `salaryEntriesFor` by `supplierShiftCommission(sp.commission, h, date, seenDays)`: the supplier's rate on that shift's date (`supplierRateOn`) by the hour (hours × rate) or by the day (the rate once per day worked), or `SUPPLIER_DEFAULT_RATE` = 5 ₪/h.
  
  A supplier never affects what the worker is paid. See [accounting.md](accounting.md).
- **Exports:** the punch CSV, the salary export and the Excel Statistics sheet carry a Supplier column.
- **Logins:**
  - a user with role `supplier` and a `supplierId` signs in to `/supplier` ([supplier-portal.md](supplier-portal.md));
  - that user is created in Admin → Users ([admin.md](admin.md));
  - the supplier portal gets only its own workers, with no wage, client billing or GPS fields.
