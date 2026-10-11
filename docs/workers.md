# Workers

The Workers tab, the worker modal (add / edit / review after a scan), the worker card, worker documents, and the hours import/export entry points. All code is in `schedule-manager.html` unless noted.

## Data: the worker record

One object per worker in the global `workers` array. It is saved as part of the schedule (see [app-core.md](app-core.md) → saving); it is one document `tenants/{t}/workers/{id}`.

| Field | Meaning |
|---|---|
| `id` | `uid()` — `'id'` + 7 random chars |
| `name` | always `docGiven + ' ' + docSurname`, rebuilt on every save |
| `docGiven`, `docSurname` | given name, surname (Latin for a foreign passport) |
| `colorIdx` | index into `WORKER_COLORS` (8 colors) |
| `phone`, `notes` | |
| `status` | `active` / `vacation` / `fired` (shown as פעיל / בחופשה / לא פעיל, Active / On vacation / Inactive) |
| `hourlyRate` | the worker's own rate (₪/h, or ₪/day when `payMode` is `daily`); `otRate`, `shabbatRate`; the older `regRate`. All set in the pay window (Accounting → Salary row, or the worker card's Pay) ([accounting.md](accounting.md)) |
| `clientRates` | `{clientId: {rate, otRate, shabbatRate}}` — per-client override, see [accounting.md](accounting.md) |
| `travelAllowance`, `travelMonthly` | travel: ₪ per day worked and ₪ per month with work, added on top of pay (the pay window (Accounting → Salary row, or the worker card's Pay)) |
| `clientIds` | array — a worker can work at several clients |
| `supplierId`, `supplierRates` | one supplier (agency); `supplierRates[sid].rate` = commission override |
| `hrId` | uid of the HR login the worker belongs to, or absent; set only by the owner / super-admin (worker modal HR field, the HR card in Users) or automatically for a worker an HR adds ([hr.md](hr.md)) |
| `bank`, `bankBranch`, `bankAccountNumber` | the worker's own bank details (the pay window (Accounting → Salary row, or the worker card's Pay)) |
| `schedule` | 7 items, Sunday first: `{type:'work'|'off', start:'HH:MM'|null, end}` |
| `startDate` / `workStartDate` | same value, one input; `startDate` drives the contract warning, `workStartDate` goes to Form 101 |
| `expiryEnabled`, `expiryMonths`, `expiryWarnMonths` | opt-in contract-term warning |
| `token` | punch-link token (`genToken()`, 8 chars) |
| `createdAt` | ISO; Form 101 signature date |
| `docType` | `israeli_id` (default) / `passport` |
| `docId` | ID or passport number. Old records may hold it inside `address` as `ת.ז. 123…`/`Passport X` — always read it through `workerDocId(w)` / `workerAddress(w)` |
| `docSex` (`M`/`F`), `docDob`, `docExpiry`, `address`, `houseNumber`, `city` | Form 101 personal fields |
| `maritalStatus` | `marital_single` / `_married` / `_divorced` / `_widowed` |
| `healthFund` | `Clalit` / `Maccabi` / `Meuhedet` / `Leumit` |
| `incomeType`, `otherIncomeType` | Form 101 income section (`INCOME_TYPE_LABELS`, `OTHER_INCOME_LABELS`) |
| `docChildren` | `[{name, idNo, dob}]` |
| `spouseSurname`, `spouseGiven`, `spouseId`, `spouseDob`, `spouseIncome` (`''`/`none`/`work`/`other`) | Form 101 section ו |
| `avatarB64` | 160×160 JPEG portrait (base64) |
| `docUrl`, `docFileId`, `docSavedAt` | the Form 101 PDF (download URL, Storage path `tenants/…`) |
| `assetsFileId` | the scan sidecar (scan + signature + extra pages) used to rebuild the PDF |
| `docHasSignature`, `docExtraPages` | written by `aiFillForm101()` on each successful save |
| `docUploadFailed` | last PDF upload failed |
| `docs` | other documents: `[{id, type, name, fileId, url, mediaType, uploadedAt, expiry}]` |

## Workers tab (`#sectionWorkers`)

**Toolbar** (`.workers-head`, `.workers-toolbar`):
- "Add Worker" and "Scan passport" — on a phone, two equal buttons across the width;
- the search box with the list/cards toggle beside it;
- a **Filters** button next to the search (`toggleWorkersFilters`): the filters are hidden until it is tapped (the open state is kept on this device, `localStorage.workersFiltersOpen`); the button shows how many are set. Each set filter shows as a chip under the search (`renderWorkersFilterChips`); its ✕ clears that filter (`clearWorkersFilter`);
- the filters (Status, Documents, Client, Supplier, Group by) — one row of five on a computer; two columns on a phone, with Group by across, and no captions (each select's first option names it);
- the worker count.

`renderWorkersPage()` filters, then draws either cards or the table.

- **Filters** (each a `<label class="filter-field">` with a caption; a dropdown with a choice is highlighted by `markActiveFilters()`):
  - search box: name (also the given name / surname from the document), phone, ID or passport number (`workerDocId`; spaces and dashes ignored, from 2 characters), and the worker's clients — name and object;
  - Status (`workersFilterStatus`): by default "Active and on vacation" — inactive workers (`fired`) are left out, and the count line ends with "Inactive: N — show" (`showInactiveWorkers()` picks Inactive); also Active, On vacation, Inactive, All statuses;
  - Documents (`workersFilterDocs`: `incomplete` = `workerDocStatus().level !== 'ok'`, `expiring` = ID/passport or a document expiring/expired);
  - Client and Supplier (`fillFilterSelect()` fills them from `clients`/`suppliers`);
  - Group by (`workersGroupBy`: none / client / supplier).
  
  All filters combine (AND). In client grouping a worker appears under every client they have; in supplier grouping, under one (or "No supplier assigned").
- **View:** `getWorkersView()` returns `cards` unless `localStorage.workersView === 'list'`; `setWorkersView(v)` stores the choice.
  - Cards — `renderWorkerCards(box, list, groupBy, stMetaMap, sig)`. Each card shows avatar, name, status, contract and document badges, ID/passport, hours this month, clients, supplier, HR (owner / super-admin only: the HR login's name as a colored badge like the supplier's, `hrNameOf` / `hrColor` — a steady color picked from `CLIENT_COLORS` by the HR's uid), start date and document status; on a phone (≤ 700 px) the card is compact — avatar, name, badges and one line of hours this month · clients · supplier (`.wcard-sum`), the rest in the worker card a tap opens. Hours come from `workersMonthHours()`, which parses the punch log once, splits it by worker and sums `getWorkerMonthShifts()` — the same shift pairing as payroll.
  - List — a table with columns Worker / Status / ID / Objects / Supplier / Phone / Start / actions (PDF download, delete). A tap on the row opens the worker card; a tap on the card opens the edit form.
  - A tap on a card or row opens `openWorkerCard(wi)`; a double click (computer) or a long press (phone) opens the edit form (`openEditWorker`), as does the card's ✎.

## Badges and status helpers

- **Inactive workers** (`isActiveWorker(w)`: status not `fired`) leave the everyday lists — the Workers tab by default, the sidebar (`renderWorkerList`), the Schedule (`getVisible`), Today (missing, expiries), the manual-punch picker and the contract warnings — and return when set Active on their card (user request 2026-10-11). Accounting still counts their hours; their data and documents stay.
- `workerExpiryStatus(w)` → `null` or `{level:'warning'|'overdue', deadline}` (an active worker with `expiryEnabled`, `startDate`, `expiryMonths`). The deadline is `startDate` + `expiryMonths`, and warning starts `expiryWarnMonths` before it. Shown by `expiryBadgeHtml(w)`, on Today, and when the app opens by a notice under the title bar (`showContractNotice()`: "Contracts: N expired, M expiring soon · Show ✕"; Show opens Today, ✕ hides it until the next start — `sessionStorage.contractNoticeClosed`). The worker form says in red when the warning is on but the start date is empty (`updateExpiryHint`, `#wExpiryNoStart`).
- `workerDocStatus(w)` → `{level:'ok'|'warn'|'error', missing, expiry, docExpiries, docExpired, failed, lines}`:
  - **missing:** no ID/passport number, no `docUrl` (Form 101), no `assetsFileId` (scan), `docHasSignature === false`, or (Israeli ID) `docExtraPages === 0` (no ספח);
  - **expiry:** `docExpiry` already past is an error; within `DOC_EXPIRY_WARN_MONTHS` (3) is a warning;
  - **docExpiries:** `workerDocExpiries(w)` for `w.docs` — one reminder per type + expiry date; warns `WORKER_DOC_WARN_DAYS` ahead (contract 30, visa / work permit 60, other 30);
  - **failed:** `docUploadFailed`.
  
  Shown by `docStatusBadgeHtml(w)` (DOCS / ID EXPIRED / `<TYPE> EXPIRED` / UPLOAD FAILED; nothing when complete) and `docStatusSummaryHtml(w)`.
- **NEW badge** — `newWorkerBadgeHtml(w)`: a green "NEW" next to the name for `NEW_WORKER_DAYS` (3) days after `w.createdAt` (set when the worker is added in the app or by a supplier in its portal; the tooltip gives the date). On the worker cards, the list rows and the worker card; the supplier portal's worker list has the same badge.
- `docUploadFailedBadgeHtml(w)` — the older NO DOCUMENT badge, still used in the Schedule sidebar.
- `parseDocDate(s)` reads `DD/MM/YYYY` (or `.`, `-`) and ISO dates.

## Worker card (`openWorkerCard(wi)`, `#workerCardOverlay`)

Read-only summary, as flat icon + text rows:
- phone; start date; contract warning; ID; document status;
- with `hasPermission('workers')`: a "Scan / Rescan" button at the end of the header (`rescanFromWorkerCard(wi)`: closes the card, opens the worker modal and the scan over it). Under Documents, one amber row per scan field still missing (`cardMissingScanRowsHtml`). When the worker has a saved scan (`assetsFileId`), tapping a row searches it for that field (`findScanFieldFromCard` → `findScanField`). A value found is saved on the worker (`autoSave`, `name` rebuilt for a name field), and the Form 101 is rebuilt (`regenerateWorkerDoc`). Not found → the row says so, with a link to photograph the page again;
- address with house number and city; income types; scheduled hours per week; "document saved";
- "Hours sent:" the worker's latest hours batch and its status (Sent for review / Approved / Rejected, with the date), live ([accounting.md](accounting.md) → Pending hours);
- the clients (labelled "Clients:"); the supplier, labelled "Supplier:";
- notes;
- the Documents section (`workerDocsSectionHtml(w)`).

**Status** — three small pills right under the card's header, at the right (Active / Vacation / Inactive, a colored dot each, the chosen one filled; `setWorkerStatus(wi, v)` saves at once and redraws the card). Under them, also at the right, "נשמר: <date>" (`docSavedAt`, when the Form 101 was last saved). The "Documents: …" status line and the missing scan-field rows are the last lines of the card's details (after HR), right above the Documents section. Without the workers permission the card shows a plain status badge instead. Buttons: **Add document** (`openWorkerDocUpload`, only with `hasPermission('workers')`; the Documents section itself has no add button), Download document, **Upload hours** (with `hasPermission('workers')`) and **Export hours** (with `workers` and `exports`), **Pay** (with `canEditPay()`: closes the card and opens the pay modal, `openPayModal` — [accounting.md](accounting.md) → Pay window). A ✎ at the right of the header (`#workerCardEdit`, `editFromWorkerCard`, with `hasPermission('workers')`) closes it and opens the edit form (`openEditWorker`); so does a double click (computer) or a long press (phone) anywhere on the card other than a button, link or field — a plain tap only reads. Any window opened from the card (the edit form, Pay, Upload hours, …) brings the card back when it closes (`workerCardOverlay.__reopen`, by the worker's id — [app-core.md](app-core.md) → Back to the previous window).

## Worker modal (`showWorkerModal(w)`, `#workerModal`)

One form for add, edit and post-scan review. Labels of every Form 101 field are Hebrew.

- **Opening:**
  - it warms the Form 101 and upload functions (`warmCloudFunctions`);
  - a worker with only `name` gets `docGiven`/`docSurname` split from it for display (without this the "name required" check would silently block the save);
  - module state is reset: `__wScheduleOpen`, `__wExpiryOpen`, `__wForm101Open` (all collapsed); `__wClientIds`; `__wChildren`; `__wAvatarB64`; `__wDocType`.
- **Sections:**
  - **Avatar.** Upload a photo, then crop it in the editor: `openAvatarCropEditor`, drag (`attachAvatarCropDrag`), zoom (`onAvatarCropZoom`), confirm (`confirmAvatarCrop` → 160 px JPEG, `AVATAR_SIZE`, black and white via `grayscaleCanvas`; the scan's portrait is made the same way). Or delete it (`clearWorkerAvatar`).
  - **Scan fields** (no Documents block in the modal — removed as a duplicate, per user request 2026-10-05: the PDF download and the scan / rescan button are on the worker card, `rescanFromWorkerCard`, which opens the modal and `rescanFromWorkerModal()`; a field the scan didn't find links to it too). `SCAN_FIND_FIELDS` is the list of scan fields: given name, surname, ID or passport number, date of birth and sex, plus street, house number and city for an Israeli ID. For each it records the input, the page (front or ספח), the Hebrew label, and the zoomed re-read kind for digits and dates. `workerMissingScanKeys` / `workerMissingScanFields` give the ones a worker lacks. The "חסרים" line under the documents (`#wMissingScan`) follows the fields live: `refreshModalMissingScan()` recounts the empty scan inputs when one is typed in or picked (one `input`/`change` listener on the modal) and when the field search fills one, so a field filled after the modal opened leaves the line.
    - **Field search** (`markScanMissingFields()`, run after the modal is drawn and after a draft is put back). When the worker has a scan to search (`workerHasScanPages`), every empty scan field gets an amber frame (`.scan-missing`), placeholder "🔍 לחצו לחיפוש בסריקה".
    - Tapping a marked field (`_scanFieldTap`) runs `findScanField(w, key, docType)`. Found → the value is filled and the frame turns green for a moment (or amber "check" when unsure). Not found → a hint under the field with a link to `rescanFromWorkerModal()`, and further taps no longer search. Typing clears the mark.
    - **Second pass after a scan** (`autoFindMissingScanFields`, called by `openWorkerModalFromScan`): all marked fields are searched together, in one request. Street, house number and city are left out when the live scan has no page besides the front.
    - `findScanFields(w, keys, docType)` (one request for all keys; `findScanField` for one) takes the photos from `workerScanPages(w)`: the scan in memory when it belongs to this modal, else the Storage sidecar (`loadWorkerAssets`, cached per file). It sends up to 4 photos, ספח pages first when every field is an address field, to `aiFindField` with `fields`. Values found with a box are re-read zoomed in one `aiVerifyFields` per page. Each such zoomed re-read uses the field's kind: `digits9`/`passportNo`, `date`, `hebrewText`/`latinName`, `houseNumber`), and the zoomed read wins. The value is then normalized: ID digits, `DD/MM/YYYY`, sex `M`/`F`, house number without spaces. When the two reads differ, the result is `unsure`: the modal marks the field "check" (`markScanUncertain`), and the card adds "בדקו" to its toast.
    - **Reading a "check" field again** (`recheckScanField(key)`): an amber "check" field that has a scan to search says "tap the field to read it again", and the first tap on the field (`_scanCheckTap`; `pointerdown` for the sex select) runs the same `findScanFields` for that one field. Later taps edit the field as usual (`data-rechecked`); the note's "🔍 קרא שוב מהסריקה" link reads it again. The same value → the frame goes (green for a moment). Another value → the new one is put in, still framed, with "לפני: … · אחרי: …" (before / after) and a "החזר" link (`restoreScanPrev`, the old value in `data-scanPrev`). Not found → the value stays, framed. Typing in the field clears the frame.
    - `rescanFromWorkerModal()` keeps the form as a draft (`window.__wDraft`: field values by id, children, clients, avatar, colour, signature) and opens the scan over the modal.
    - Which scan opens: the review screen of the scan still in memory when the modal came from it (a new worker, or this worker just rescanned); otherwise a new scan of this worker (`__aiRescanWorkerId`).
    - When the scan finishes, `openWorkerModalFromScan()` redraws the modal and calls `applyWorkerDraft()`: a field that had a value keeps it, an empty one takes the scan's value.
    - `openAddWorker`, `openEditWorker`, `startNewScan` and `rescanWorkerDoc` clear the draft.
  - The form's title has no status or saved date: both are on the worker card.
  - **Personal data**, two short fields per line: first + last name; ID/passport + sex; marital status + health fund; date of birth + ID expiry; street + house no. + city (one line of three); start date + phone. No money field: rate, pay mode, OT / Shabbat, travel and bank are set in the pay window (Accounting → Salary row, or the worker card's Pay) ([accounting.md](accounting.md)); `saveWorker` keeps them on an edit (`{...prevW, ...commonFields}`). One rule stays here: when a client that has a rate is added to an hourly worker with a rate of their own, the own rate is cleared (`hourlyRate = 0`), so the new client's rate applies.
  - **Clients.** Chips plus a search box: `renderWClientChips`, `renderWClientSuggest` (only clients not yet added), `addWClient`, `removeWClient`. Enter picks the first match (`pickFirstWClientSuggest`).
  - **Supplier.** A `<select>` (`wSupplierId`).
  - **Weekly schedule.** Collapsible (`toggleWeeklySchedule`). It is only written on save if it was opened: a new worker gets all days off, an existing one keeps their shifts.
  - **Form 101 block and contract-term warning.** Two buttons side by side (`toggleForm101Wrap`: income types; `toggleExpiryWrap`: opening it enables the warning), their panels under them.
  - **Spouse and children.** Two buttons side by side under those (`toggleWPanel('spouse'|'children')`), each opening a framed panel: the spouse fields (`#wSpouseWrap`) and the children rows (`#wChildrenWrap`; `renderChildrenRows`, `addChildRow`, `removeChildRow` — the name across, then ID / passport, date of birth and delete on one line). Both are closed when the modal opens; the buttons show "✓" for a filled-in spouse and the number of children (`updateWPanelLabels`). Picking "married" opens the spouse panel (`onWMaritalChange`).
  - **Signature, notes.** No color picker — a new worker gets the next `WORKER_COLORS` color (`blankWorkerDefaults`), an edited one keeps its color; the signature pad (`wSigCanvas`, see [form101.md](form101.md)); notes; a new punch-link token (`regenerateWorkerToken`).

### Saving (`saveWorker()`)

The window has no Save button: it saves when closed by a tap outside (`workerOverlay.__onUserClose` → `saveWorker({auto:true})`, one save at a time, `saveWorker.busy` → `saveWorkerNow`). A hint under the form says so. On such a close: an edit with nothing changed (form fields, signature, HR pick, a rescan) just closes; an empty name closes without saving (an edit says so in a toast, a new worker is not created); otherwise the steps below run as for the old button. `saveWorker()` with no options (tests, the scan flow) behaves the same except that an empty name focuses the field.


1. **Read the form.** All fields go into `commonFields`. A spouse entered with no marital status saves as `marital_married`. Empty children rows are dropped.
2. **Duplicate guard for a new worker.** If another worker has the same `workerDocId`, `confirm()` offers to update that worker instead:
   - only non-empty values overwrite;
   - schedule, status and color are kept;
   - `clientIds` are merged;
   - a live scan in this session marks it as rescanned.
   
   Cancel returns to the form. A second record with the same number is never created.

   An HR login with "only own workers" has only its own workers in `workers`, so when there is no local match it also asks the server (`checkWorkerDoc`, answers only yes/no across the whole firm) and refuses with "A worker with this document number already exists in the firm". The same server check runs when an HR changes an existing worker's number.
3. **Editing an existing worker.**
   - It merges the form into the record and compares `FORM101_WATCHED_FIELDS` (`docId, address, houseNumber, city, incomeType, otherIncomeType, docSurname, docGiven, maritalStatus, healthFund, workStartDate, phone, docSex, docDob, docChildren` and the five spouse fields).
   - **Rescanned in this session** (`window.__aiRescannedWorkerId === id`): a blocking overlay shows while `autoUploadWithRetry()` rebuilds the PDF from the fresh scan.
   - **Otherwise**, if a watched field changed or a signature was drawn on the pad: `regenerateWorkerDoc(id, newSigPng)` runs in the background from the stored sidecar (a new signature replaces the stored one), followed by a toast.
4. **New worker.**
   - It gets a `token` and `createdAt` and is pushed to `workers`, then saved with `autoSave()`.
   - `hrId`: an HR login's own uid; for an owner / super-admin the HR field's choice.
5. **HR field** (`#wHrId`, owner and super-admin only, options from `hrUsers()`): `hrUsers()` returns the cached HR list, which is loaded once per app open on first need (when the worker modal, a worker tile with an HR, or a card with an HR first calls `hrUsers()` / `ensureHrUsers()`), not at startup; when the list arrives (from `prefetchAdminUsers()`), an open modal's HR field and the worker tiles are redrawn. A change on an existing worker goes through `assignWorkersToHr([id], hrId)`, which also moves the worker's punches to the new HR. The worker card and the worker tile show the HR ("none" / "—" when unassigned) to the owner / super-admin.
   - The signature PNG is captured first (`window.__wCapturedSigPng`).
   - The modal then shows the upload progress (`showWorkerUploadingOverlay`, `renderWorkerUploadProgress`) while `autoUploadWithRetry()` builds and uploads Form 101 from the live scan globals. See [form101.md](form101.md).

`openAddWorker()` clears the scan globals (`__aiScanImage`, `__aiPacketOtherPages`, `__aiAvatarB64`, `__wCapturedSigPng`) so a previous scan never attaches to a manually added worker.

### Deleting (`deleteWorker(wi)`)

Started from the faint red ✕ in a worker tile's top-right corner (`.wcard-del`, only with `hasPermission('workers')`; the worker card has no Delete button) or the ✕ in the list view's row. It first asks for confirmation (the worker's Form 101, scans and documents go too, punches and hours stay). It removes the worker and saves, then best-effort deletes their files through `gsDeleteWorkerDoc()`: the PDF (`docFileId`), the sidecar, and every `docs[].fileId`.

## Punch link

`buildPunchLink(w)` → `https://odinson.ltd/worker-punch.html?t=<token>`; `copyWorkerLink(wid)` copies it. In the worker modal (existing workers) the link block ("קישור אישי להחתמה", with the geofence note) sits right after the signature pad. See [punch.md](punch.md).

## Worker documents (contract, visa, work permit, other)

These are separate from the Form 101 scan, and their labels are English.

- `openWorkerDocUpload(workerId)` opens `#workerDocOverlay`: type (`WORKER_DOC_TYPES`), an optional expiry date, and several files.
- `submitWorkerDocUpload()`:
  - prepares every file with `fileForStorage()` (images shrunk);
  - uploads them in parallel to Storage with `uploadWorkerFile({action:'saveWorkerFile', workerId, …}, onProgress)` — see [app-core.md](app-core.md) → Data calls;
  - appends `{id, type, name, fileId, url, mediaType, uploadedAt, expiry}` to `w.docs`, then saves.
- `deleteWorkerFile(workerId, docId)` removes the entry and deletes the file.

## Hours import (from the worker card)

`openHoursImportModal(workerId)` opens `#hoursImportOverlay`:
- a client select (the worker's clients, or all clients if they have none) and a file input (`.xlsx`, `.xls`, `.csv`, images, PDF; several files);
- **reading the files** — `onHoursImportFileSelected(files)` parses every file in parallel:
  - spreadsheets → `parseHoursExcelFile()` (SheetJS; a header row with `Date`/`In`/`Out` or the same three words in Russian, any order, case-insensitive; dates become `dd/MM/yyyy`);
  - images and PDFs → `fileToUploadPages()`, then every page → `parseHoursImagePage()` (`aiReadHoursTable`);
- **preview** — the first 10 entries are shown;
- **enter by hand** — "Add shift" rows of date / in / out (`addHoursManualRow`, `renderHoursManualRows`, `hoursManualEntries`); each new row takes the day after the last one (`nextManualDate`); a daily-paid worker's (the pay window (Accounting → Salary row, or the worker card's Pay)) row may leave the times empty and counts as one day, 08:00–16:00 (`MANUAL_DAY_SHIFT`). The send button is on whenever there is a file or a row; a row that can't be sent (no date; an hourly worker without in and out; only one of the two times) is outlined red and explained in a toast (`manualRowsProblem`), and nothing is sent;
- **submit** — `submitHoursImportBatch()` sends `savePendingHoursBatch` with the file's and the typed `{workerId, clientId, date, inTime, outTime}` rows in one batch (file name, plus "entered by hand" when rows were typed); the modal stays open and clears;
- **sent for approval** — `loadHoursSent(workerId)` lists this worker's batches (`loadPendingHours`; an own-workers HR gets only its own) with a status chip (`hoursStatusChip`): amber "Sent for review", green "Approved", red "Rejected", with the date; paged by 10.

Nothing reaches payroll until an owner approves it in Accounting ([accounting.md](accounting.md)).

## Hours export (from the worker card)

`openHoursExportModal(workerId)` offers a month picker for the last 12 months. `runHoursExport()` loads that month's punches if needed (`ensurePunchesSince`), then calls `exportShiftsDetail(workerId, y, m, 'excel'|'pdf')` ([accounting.md](accounting.md)).

## Schedule sidebar worker list

`renderWorkerList()` (Schedule tab sidebar) sorts by name / hours / status (`#workerSort`). Each row shows status, contract and upload-failed badges, scheduled hours, with copy-link and delete buttons; a tap elsewhere on the row opens the edit form (`openEditWorker`). See [app-core.md](app-core.md) for the Schedule tab.
