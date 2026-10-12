# Suppliers

Suppliers are staffing agencies a worker comes through. This file covers the Suppliers tab and modal, and how suppliers feed the rest of the app. Code is in `schedule-manager.html`; the supplier's own login page is [supplier-portal.md](supplier-portal.md).

## Data

The global `suppliers` array. It is saved with the schedule; each supplier is one document `tenants/{t}/suppliers/{id}`.

`{id, name, color, phone, bank, bankBranch, accountNumber, companyNumber}` — `companyNumber` is the ח.פ. All of them are plain text, so leading zeros are kept. An older `notes` field may exist but is not shown.

A worker links to **one** supplier through `w.supplierId` (set in the worker modal, or by the owner / super-admin in Admin → Users, a supplier login's **Workers** section: list, Unassign, Add workers — [admin.md](admin.md)); `w.supplierRates[supplierId].rate` overrides the supplier's commission for that worker.

## Suppliers tab (`#sectionSuppliers`)

A header "Suppliers N" with a glass **New** (`openAddSupplier`) and a ⋮ (**Select…**, `startSupplierSelect`). `renderSuppliersPage()` draws a plate per supplier (redesign stage 8, paged by 10): its colour as bar and avatar, the name, "N workers · phone", its workers' hours this month (`workersMonthHours`) in green, a ⋮ (Edit, Delete) and a swipe left (Edit, Delete); a tap, a double click or a long press opens the editor.

- **Adding and editing:** `openAddSupplier()` / `openEditSupplier(sid)` → `showSupplierModal(s)`. The editor ([app-core.md](app-core.md) → Editors) has a head (colour, name, phone), the sections, in the owner's fixed order, **Company** (Name, ח.פ, Phone, Bank / Branch / Account #) and — editing only, `supplierEditorExtraHtml` — **Commission** (the default ₪/h, its workers, this month's hours from `workersMonthHours`, and the commission payable this month — `commissionFor` over `salaryEntriesFor('month')`, the same figure as Payable by supplier; per-worker and per-day rates stay in Accounting), **Portal login** (its supplier logins and the portal tabs they see — `supplierSections`, ticked and saved at once by `saveLoginTicks`; "New portal login" opens the user form with the role and supplier set, `newLoginFor`) and **Workers** (a mini plate per worker with this month's hours), and one Save at the end, with no color picker: a new supplier gets the next `CLIENT_COLORS` color automatically, an edited one keeps its color.
- **Saving:** `saveSupplier()` updates in place or pushes a new supplier (`uid()`), then saves.
- **Removing:** `deleteSupplier(sid, el)` / `deleteSuppliers(ids, els)` never ask: the plate collapses behind the Undo snack (left out meanwhile, `__supplierDelPending`); after 5 s the supplier is removed and, on every worker, `supplierId` is set to `null` and `supplierRates[sid]` deleted; then it saves.

## Where suppliers are used

- **Workers:** the Supplier `<select>` in the worker modal, the Supplier filter, group by supplier, and the supplier badge on cards and rows ([workers.md](workers.md)).
- **Today tab:** "Workers by supplier" headcount (`renderDashSuppliers()`, [accounting.md](accounting.md) → Today).
- **Accounting:**
  - the commission matrix (`renderSupplierRateMatrix()`);
  - "Payable by supplier" (`renderSupplierPayable()`): hours × flat commission, where `supplierCommissionRate(w, sid)` uses the worker's override or `SUPPLIER_DEFAULT_RATE` = 5 ₪/h; for a worker paid by the day, days × the matrix's "₪/day (daily workers)" (`supplierRates[sid].dayRate`, `supplierDayCommission`) when set (`commissionFor`).
  
  A supplier never affects what the worker is paid. See [accounting.md](accounting.md).
- **Exports:** the punch CSV, the salary export and the Excel Statistics sheet carry a Supplier column.
- **Logins:**
  - a user with role `supplier` and a `supplierId` signs in to `/supplier` ([supplier-portal.md](supplier-portal.md));
  - that user is created in Admin → Users ([admin.md](admin.md));
  - the supplier portal gets only its own workers, with no wage, client billing or GPS fields.
