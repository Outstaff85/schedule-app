# Suppliers

Suppliers are staffing agencies a worker comes through. This file covers the Suppliers tab and modal, and how suppliers feed the rest of the app. Code is in `schedule-manager.html`; the supplier's own login page is [supplier-portal.md](supplier-portal.md).

## Data

The global `suppliers` array. It is saved with the schedule; each supplier is one document `tenants/{t}/suppliers/{id}`.

`{id, name, color, phone, bank, bankBranch, accountNumber, companyNumber}` — `companyNumber` is the ח.פ. All of them are plain text, so leading zeros are kept. An older `notes` field may exist but is not shown.

A worker links to **one** supplier through `w.supplierId` (set in the worker modal, or by the owner / super-admin in Admin → Users, a supplier login's **Workers** section: list, Unassign, Add workers — [admin.md](admin.md)); `w.supplierRates[supplierId].rate` overrides the supplier's commission for that worker.

## Suppliers tab (`#sectionSuppliers`)

`renderSuppliersPage()` draws a card per supplier in `#suppliersGrid`: name, ח.פ, phone, bank details and the assigned workers, with a ✕ in the top corner that removes the supplier (`.wcard-del`, as on a worker card); a tap anywhere else on the card opens its edit form (`isPlainTap` → `openEditSupplier`). The tab has no role gate beyond the `suppliers` permission (`NAV_TAB_PERMISSION`).

- **Adding and editing:** `openAddSupplier()` / `openEditSupplier(sid)` → `showSupplierModal(s)`. The fields are Name, ח.פ, Phone, Bank / Branch / Account #, with no color picker: a new supplier gets the next `CLIENT_COLORS` color automatically, an edited one keeps its color.
- **Saving:** `saveSupplier()` updates in place or pushes a new supplier (`uid()`), then saves.
- **Removing:** `deleteSupplier(sid)` removes the supplier and, on every worker, sets `supplierId` to `null` and deletes `supplierRates[sid]`; then it saves.

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
