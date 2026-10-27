# Signed documents

What is kept under a worker for Form 101 and the contract, and how it is signed. The plan it was built from, stage by stage (D0–D7, done), is archived as [archive/docs/contracts-plan.md](../archive/docs/contracts-plan.md); this file describes what is built.

## Scanned pages (D1)

Every scanned page of a worker is its own JPEG in Storage, and the signature a small PNG. They replace the old sidecar: one JSON file with every picture inside as base64 (a third heavier, and loaded whole for any one page).

| What | Stored at | On the worker |
|---|---|---|
| A scanned page: the ID card's front or back, the ספח, the passport, another page | `tenants/<t>/workers/<id>/pages/<ms>-<index>-<kind>.jpg` — a JPEG of at most 2000 px on its long side (`pageForStorage`, `src/manager/logic/uploads.ts`; ~300–600 KB) | `scanPages: [{fileId, kind, primary?, savedAt}]` — `kind` one of `id_front`, `id_back`, `sefach`, `passport`, `other`; the worker's ID card or passport first, `primary: true`; then the other pages in the scan's order |
| The signature | `…/signature/<ms>-signature.png` | `sigFileId`, `sigSavedAt` |
| The old sidecar (until split) | `…/assets/<ms>-<name>_assets.json` | `assetsFileId` |

- **Kinds:** the scanner's kind of the page (`src/scan/doctype.ts`); a page without one is the worker's document when it is the first (`id_front`, or `passport` for a passport worker) and `other` otherwise (`pageKind`, `src/manager/data/pages.ts` — the migration's `page_kind` is the same rule). A contract's pages are not stored here: they go to the worker's documents as one PDF (docs/scan.md → Contracts).
- **Private:** a page and the signature get no download URL. They are read back only through `users_admin` `loadWorkerPages` (`functions-auth/files.py`): every page and the signature of a worker in one call, each path checked to be under `pages/` or `signature/` of a worker of the caller's firm (an own-workers HR: its own workers only). A supplier, a client and the worker's own page never get them.
- **Writing:** `saveScanPages(w, {front, others, sigPng}, keep)` (`src/manager/data/pages.ts`) uploads every new page and the signature at once (`saveWorkerPage`, `saveWorkerSignature` — `uploadWorkerFile`); a part `keep` names (it came from Storage unchanged: the other pages kept on a rescan that took only the front, the signature not drawn again) keeps its stored file. Once all are up, the replaced files and the old sidecar are deleted (a signed worker's signature is kept: a delete on its own — Signed files are kept, below) and `applySavedPages` sets `scanPages`, `sigFileId`, `sigSavedAt` and removes `assetsFileId`. If any upload fails, the worker keeps what it had and the new files already up are deleted. Called by Form 101's upload (docs/form101.md → Storing the result).
- **Reading:** `loadStoredAssets(w)` → `{scanB64, scanMediaType, sigPng, extraPages}` — from the pages, or from the old sidecar (`loadWorkerAssets`) for a worker not split yet. Form 101's rebuild (`regenerateWorkerDoc`; a rebuild whose pages can't be read is not done, so a PDF without its pages never replaces the good one), the rescan's kept pages and the field search of the worker card and window (`findScanFields`, docs/workers.md) read through it.
- **Deleting a worker** deletes every page, the old sidecar and the signature (`scanFileIds`; a person's own delete — Signed files are kept, below).
- **The worker's scan for the Workers list** (`workerHasScan`, `src/manager/worker.ts`): `scanPages`, or the old `assetsFileId`.

### Splitting the old sidecars (`scripts/migrate/scan_pages.py`)

Once, by the workflow **Split the old scan sidecars into pages** (`.github/workflows/migrate-scan-pages.yml`, started by hand, the deploy's service account), for every firm or one (`tenant`):

- `dry-run` — reads every sidecar of a worker that has no `scanPages` yet, splits it in memory and reports per firm the workers, pages, signatures, the sidecars' and the pages' bytes and the failures (a sidecar gone, not in the worker's folder, or broken). Writes nothing.
- `apply` — writes the pages (a page over 2000 px or not a JPEG is turned into one, Pillow; the others byte for byte) and the signature, with the HR stamp (`hrId` in the file's metadata — the worker's own `hrId`, else the sidecar's stamp, read with `bucket.get_blob`, since a blob from `bucket.blob()` has no metadata loaded), then a record of the split outside the worker (`tenants/<t>/migrations/scanPages_<worker>`: the sidecar, the new fields, the stamp; no rule lets the app reach it), then updates only the worker's own fields (`scanPages`, `sigFileId`, `sigSavedAt` — the sidecar's time —, `assetsMigratedFrom` = the sidecar's path, `assetsFileId` removed). The sidecar file stays. Run again, it splits nothing more, and it **repairs a stale save**: the app saves a worker as a whole document, so a manager device that still holds a copy from before `apply` (an unsaved edit, kept across reloads) puts back `assetsFileId` with no `scanPages`; a worker whose `assetsFileId` is its recorded sidecar and has no pages gets the recorded fields back with a field update — the same files, none written again, even after `cleanup` deleted the sidecar (`restored` in the report; a recorded file gone is a failure). A worker split before the records existed gets one from its current fields (`recorded`); a worker whose pages or signature were changed in the app since the split (a rescan, a page added, a new signature — the whole-document save keeps `assetsMigratedFrom`) gets its record refreshed to them (`refreshed`), so a later stale save is repaired with the newest pages.
- `cleanup` — deletes the sidecars already split (`assetsMigratedFrom`) and that field, only for a worker that still carries its recorded split (no `assetsFileId`, `assetsMigratedFrom` = the recorded sidecar; otherwise `skipped`, with the reason — a stale save from before `apply` never matches, since it brings `assetsFileId` back and has no `assetsMigratedFrom`). Pages or a signature changed in the app since `apply` don't stop it: the record is first refreshed to them (`refreshed`). The record stays, so a stale save that comes later is still repaired by running `apply` again.

**Every manager device reloads (or signs out) after `apply`, and `cleanup` runs only after that** — a device's unsaved copy from before `apply` is what a stale save writes back.

`apply` and `cleanup` change real workers' data: they are run only with the owner's yes, after a `dry-run`. Tests: `tests/auth/test_migrate_pages.py`.

### Tests (D1)

`tests/auth/test_files.py` (`loadWorkerPages`: one call, a missing page, only pages and signatures of the firm, an own-workers HR), `tests/auth/test_migrate_pages.py`, and the browser test "scan pages" (`tests/e2e/main.test.js`: a new worker from a scan stores its pages and signature, the card's field search and a rebuild read them back, a rescan keeps the stored ספח, a worker on the old sidecar is split on its rebuild, deleting the worker deletes them).

## Contract templates (D2)

A firm's contract is a PDF with **marks** typed in its text: `{{given}}`, `{{id}}`, `{{signature}}`… — Latin letters in double braces, no spaces (the full list: `MARKS` in `functions/contracts.py` and `src/manager/contracts.ts`, as the table under The marks below). In Word the marks are typed as plain text and the file saved with File → Save as → PDF; blanks after a mark (spaces up to the next letter) are the room a long value may take.

### The marks

They are written in Latin letters, in double braces, with no spaces. A Hebrew mark could come out of the PDF's text with its letters reversed, so Latin is the safe form. Each value is printed in Hebrew, as on Form 101, except a foreign passport's names, which are printed in Latin.

| Mark | Filled with |
|---|---|
| **Worker** | |
| `{{given}}` | given name |
| `{{surname}}` | surname |
| `{{full_name}}` | given name and surname |
| `{{id}}` | ID or passport number |
| `{{id_type}}` | ת.ז. or דרכון |
| `{{id_expiry}}` | the ID's or passport's expiry date |
| `{{dob}}` | date of birth |
| `{{sex}}` | זכר / נקבה |
| `{{marital}}` | marital status |
| `{{phone}}` | phone |
| `{{address}}` | street and house number |
| `{{city}}` | city |
| `{{full_address}}` | street, house number, city |
| `{{health_fund}}` | health fund |
| **Work** | |
| `{{start_date}}` | start date |
| `{{end_date}}` | contract end (start date + the contract's months), when set |
| `{{contract_months}}` | the contract's length in months, when set |
| `{{site}}` | the client or site (several: joined by commas) |
| `{{supplier}}` | the supplier, when there is one |
| `{{schedule}}` | the weekly hours (days and times) |
| **Pay** — filled only when the login sending it may see pay (the owner or super-admin, a staff login with Accounting or Edit pay, an HR with See workers' pay — `may_see_pay` / `canSeePay`); otherwise the send is refused, as for the date | |
| `{{rate}}` | the worker's rate (₪ per hour, or per day for daily pay) |
| `{{pay_mode}}` | שעתי / יומי |
| `{{ot_rate}}` | overtime rate |
| `{{shabbat_rate}}` | Shabbat rate |
| `{{travel}}` | travel allowance (per day, or per month) |
| `{{bank}}` | bank, branch and account number |
| **Firm** | |
| `{{company}}` | the firm's name |
| `{{company_address}}` | the firm's address |
| `{{company_phone}}` | the firm's phone |
| `{{deductions_file}}` | the deductions file number |
| `{{company_signature}}` | the firm's signature (a picture fitted above the mark, as `{{signature}}`; blank when the firm has none) — The firm's signature and stamp, below |
| `{{stamp}}` | the firm's stamp (a square of 56–110 pt, five times the mark's height, centred on the mark; blank when the firm has none), drawn over a signature there |
| **The worker's own terms** | |
| `{{terms_1}}` … `{{terms_5}}` | the worker's own text fields (above) |
| **Signing** | |
| `{{signature}}` | the worker's signature (a picture, fitted to the mark's place) |
| `{{sign_date}}` | the signing date (D3) |
| `{{today}}` | the date the document is built |

An unknown mark (a typo) is listed on upload and placed by hand or fixed in the file. A mark whose value is empty for a worker (no supplier, say) is printed empty.

### The server (`functions/contracts.py`, the `contract_templates` function)

- **Marks** (`find_marks`): a mark is its name with two braces on each side, found character by character, so a Hebrew line whose text the PDF keeps in visual order (the braces come out mirrored, apart from the name) is read too. Each is kept with its place, the text's size and the line's direction (Hebrew → right to left). A name in braces that is no mark is listed as unknown (a typo).
- **Made light** (`light`): `subset_fonts` (only the letters each font needs), `rewrite_images` (pictures over 200 dpi down to 200, JPEG 80), the XML metadata dropped, saved with `garbage=4`, `deflate`, `clean` (when that wins nothing, the cleaned original or the file as it came). Then checked: every page rendered at 100 dpi has a mean difference of at most 6 per channel (14 on a page with a picture) from the original, and every mark is still found — otherwise the upload is refused with the reason and nothing is stored. A page with no text and a picture on most of it is a **picture page** (`picture_pages`): its marks are placed by hand. Over 25 MB or 30 pages: refused.
- **Admin → Errors:** a refused upload, and a light template still over 1 MB (`HEAVY_BYTES`, with the reasons: pages that are pictures, whole fonts, big pictures), write an `errors` entry (`page: contracts`, the firm, the name, both sizes); the upload itself shows no warning beyond "still heavy".
- **Filling** (`fill(template, values, placed, signature, seal, sign_mark)`): each found mark is whited out (a redaction that keeps pictures and lines) and its value written in its place with the Heebo font — Hebrew through `bidi.get_display` —, anchored right in a Hebrew line and left otherwise, shrunk (to 70 % of the text's size at most) to fit the mark and the blank after it. Then, on each page, the pictures, in this order: the signer's signature at its mark (`sign_mark`, `{{signature}}` — the PNG fitted above the mark; blank without one), the firm's signature at every `{{company_signature}}`, the firm's stamp at every `{{stamp}}`, and, when `seal.every_page`, the firm's signature and then its stamp at the bottom right of the page (The firm's signature and stamp, below) — so a stamp always lies over a signature. `seal` is `{signature, stamp, every_page}` (PNGs or None); a missing picture draws nothing and its mark stays blank. Each picture is kept once in the file and shown again on the other pages (`insert_image(xref=…)`). A mark placed by hand (`placed`: page, x, y, w, h in points from the page's top left) is filled the same way, without whiting out. An empty value is printed empty.
- **Actions** (`run`, a manager-side login of the firm — `functions/gate.py`; a super-admin in the firm it views, `asTenantId`):

  | Action | Who | Does |
  |---|---|---|
  | `list` `{workerId?}` | any manager login | the firm's templates (not a worker's own, unless that worker's id is given), sorted by category and name; `canManage`, `canFirmSign`, `seal: {hasStamp, hasSignature}` |
  | `file` `{id, sample?}` | any manager login | the template's PDF, or its sample filled with made-up data (`SAMPLE_VALUES`, a made-up signature; the firm's real signature and stamp when uploaded, else made-up ones — `sample_seal` —, at the bottom right when the template has the tick) |
  | `prepare` `{pdfBase64, name, sealEveryPage?}` | owner, super-admin | made light and checked → `{lightBase64, sampleBase64, origSize, lightSize, marks, unknown, pictures, pages: [{w, h, png}], heavy}` (the pages small, for placing marks by hand; the sample with the seal unless `sealEveryPage` is false) |
  | `sample` `{pdfBase64, placed, sealEveryPage?}` | owner, super-admin | the sample again, with the marks placed by hand |
  | `save` `{pdfBase64, name, category, placed, origSize, workerId?, replaceId?, sealEveryPage?}` | owner, super-admin | the light PDF to Storage `tenants/<t>/contracts/<id>/<ms>.pdf` and the record `tenants/<t>/contractTemplates/<id>`; the first of a category is its default; a worker's own is never a default; a new template's `sealEveryPage` is true unless sent false; `replaceId` = a new version (`version` + 1, the old file deleted; it keeps its `sealEveryPage` unless one is sent) |
  | `update` `{id, name?, category?, isDefault?, sealEveryPage?}` | owner, super-admin | rename, another category (no longer the default), make the category's default (the old one stops being it), the every-page seal on or off |
  | `seal`, `sealSave`, `sealDelete` | — | the firm's signature and stamp (`functions/seal.py`, below) |
  | `delete` `{id}` | owner, super-admin | the record and its file; a default passes to another template of its category |

- No client reads or writes `contractTemplates` or `contracts/` (no rule grants them): everything goes through the function.

### Admin → Contract templates (`src/manager/ContractTemplates.tsx`)

- A `Plate` per firm template (`PagedList`): the name (and its version from 2 on), the category, **Default** and **Stamp** (the every-page seal is on) chips, the size, the date added, how many signed it (`signedCount`, counted from D3), unknown marks in amber. A tap opens its sample (`file` with `sample`, in a new tab); a double click / ✎ renames it; ⋮: Edit (the name), Category, Make default (when it is not), Replace file, **Stamp on every page: turn on / turn off** (`update` `sealEveryPage`), Delete (the Undo snack, then `delete`).
- **Signature and stamp** (next to New template) opens the firm's signature and stamp in a window (`FirmSealWindow`).
- **New template** (`.og-new`) picks a PDF → the upload window (`UploadWindow`): "Making the file light…", then both sizes ("Made light: 2.4 MB → 180 KB"), the name and the category (the firm's categories offered), the tick **Firm's signature and stamp on every page** (a `CheckTile`; on for a new template, a replaced one's own value; a change makes the sample again), the marks found as chips, the unknown ones, the picture pages, **Open the sample**, and Save. **Place a mark by hand** shows the pages (the picture pages always): pick a mark and its width, tap where it goes; each placed mark is a chip (✕ removes it) and a box on the page, and the sample is made again.
- Deleting a template withdraws the sends still waiting for a signature on it (Signing → `send` below).

## The firm's signature and stamp

A firm keeps one **signature** and one **stamp**, drawn on its contracts — never on Form 101 — at the bottom right of every page (when the template has the tick) and at the marks `{{company_signature}}` / `{{stamp}}`: **the signature first, the stamp over it** (owner, 2026-10-27).

- **Stored** (`functions/seal.py`): the record `tenants/<t>/firmSeal/current` = `{stamp: {path, w, h, size, at, by} | null, signature: {path, w, h, size, at, by, way: 'drawn' | 'upload'} | null}`, the files `tenants/<t>/firmSeal/stamp-<ms>.png` and `…/signature-<ms>.png` — each a transparent PNG cropped to its ink, at most 800 px on its long side and 400 KB. A replace or a delete removes the old file. They stay under `tenants/<t>/`, so deleting the firm removes them (`delete_tenant_files`).
- **Only the function reads and writes them:** firestore.rules have no match for `firmSeal` (deny) and storage.rules keep every browser out of `tenants/<t>/firmSeal/` — another firm never reads them, and inside the firm only the `contract_templates` function does (the previews it returns are the only copy a browser gets).
- **Cleaning a picture** (`clean_stamp`; `clean_signature` for an uploaded signature): PNG, JPEG or WebP, at most 8 MB and 6000 px ("This file is not a picture", "The picture is too big"); turned upright (EXIF) and its light flattened — each pixel divided by the paper around it (a small copy with the ink taken out by a max filter, heavily blurred: radius = its long side / 25), so a phone photo's uneven paper reads as white; the darkest channel gives the ink's alpha (0.93 → transparent, 0.55 → full ink) and the colour is the flattened colour a little darker; cropped to the ink plus 4 px and scaled to 800 px at most. Nothing left: "Nothing found on the picture". A signature **drawn** on the pad (already transparent) is only cropped and scaled.
- **Who may change them** (`may_firm_sign` in `functions/seal.py`, `canFirmSign` in `src/manager/logic/access.ts` — the same rule): the firm's owner and the super-admin; a staff or HR login with the right **Firm's signature and stamp; client contracts** (`firmSign`, an action tick of the permission templates, off by default — docs/admin.md → Users pane). Others are refused: "Only the firm's admin or a login with the right "Firm's signature and stamp" changes them".
- **The actions** (through `contract_templates`, the same firm rule — a super-admin works in `asTenantId`):

  | Action | Who | Does |
  |---|---|---|
  | `seal` | any manager login | `{hasStamp, hasSignature, canFirmSign}`, plus `previews: {stamp, signature}` (base64 PNG, 400 px at most) and `signatureWay` only for a login that may change them |
  | `sealSave` `{kind: 'stamp' \| 'signature', imageBase64, drawn?}` | `may_firm_sign` | cleaned and stored, the old file deleted, the record updated → the state and its `preview` |
  | `sealDelete` `{kind}` | `may_firm_sign` | the file and the field removed |

- **Where it is drawn** (`contracts.fill`, `seal_boxes`): in what the reader sees (`page.rect`, the page's rotation taken into account; the pictures go into the page's own space through `derotation_matrix`, turned with the page). With k = the page's short side / 595 (0.6–1.6), R = width − 28k, B = height − 22k: the firm's signature fitted, its proportion kept, into (R − 150k, B − 48k, R − 30k, B) and aligned to its bottom right (120 × 48 pt on an A4); then the stamp, centred in (R − 90k, B − 70k, R − 10k, B + 10k) (80 × 80 pt), over the signature's right part. On every page of the document. A firm with no stamp or no signature: nothing drawn for the missing one.
- **The template's tick** `sealEveryPage`: on for a new template unless unticked in the upload window; a template saved before it has no field, which means off (existing templates don't change on their own); ⋮ turns it on or off.
- **Frozen at the send:** `send` copies the firm's current pictures next to the frozen template (`tenants/<t>/workers/<w>/sign/<id>/company-signature.png`, `…/stamp.png`; `freeze`) and keeps `seal: {signature, stamp, everyPage}` on the request; `view` (unsigned) and `build` (signed) draw that copy (`read_frozen`), so the signer sees what they sign and a later change never touches what was sent. A request sent before this has no `seal` and draws none. Signed contracts already stored are never rebuilt. A move from another firm (D6) freezes the new firm's pictures when it asks (`tenants/<new firm>/transfers/<id>/`), drawn by the new firm's template's own tick and marks. A change of the seal, like the firm's details, asks no worker to sign again (`printHash` leaves the firm's marks out).
- **The samples** (`file` with `sample`, `prepare`, `sample`): the firm's real signature and stamp when uploaded, else made-up ones (`sample_company_signature`, `sample_stamp` — a blue double ring with "חותמת לדוגמה"), so the admin sees the placement.
- **In the app** (`src/manager/FirmSeal.tsx`, `FirmSealSection` / `FirmSealWindow`): a `Plate` each for **Firm's signature** (Draw — a window with the `SignaturePad` and Save —, Upload picture) and **Stamp** (Upload picture), the preview on a white card, the bar green when set; ⋮ / swipe Delete through the Undo snack; a picture is shrunk on the device first (`downscaleForUpload`). Saved on its own. A login without the right sees only whether each is set. It is in the firm window (Admin → Firms → the firm, its own or a super-admin's: **Signature and stamp**), in Admin → Contract templates (**Signature and stamp**) and, for a login with the right (a staff or HR login sees no Admin), in the worker window's Contract section (**Firm's signature and stamp**).

### Tests

`tests/auth/test_seal.py` (a stamp photo on uneven paper loses its paper, cropped, scaled; not a picture, too big and an empty picture refused; a drawn signature kept as drawn; who may; save / replace (the old file deleted) / delete, refused without the right; the previews only with the right; another firm sees nothing; a super-admin in the firm it views; freeze and read back), `tests/auth/test_contracts.py` (the every-page seal on three pages, bottom right, the stamp after the signature, one file object per picture; the marks drawn, blank without a picture; a turned page; the tick on save, absent = off, kept by a new version, `update`; the sample with the firm's real stamp), `tests/auth/test_signing.py` (the send freezes the seal and a later change doesn't reach it; the signed contract has it, never rebuilt; Form 101 never; an old send draws none; no tick, no seal; seal marks never carried as values), `tests/auth/test_transfer.py` (frozen when the new firm asks), `tests/auth/test_core.py` (`firmSign` for staff and HR only, off in Full access), `tests/rules/rules.test.mjs` (no login reads or writes `firmSeal` in Storage or Firestore; other firm files still read), the browser check "firm's signature and stamp" (`tests/e2e/main.test.js`: Firm details, a stamp photo and a drawn signature, the template's chip and its sample with both bottom right — the stamp over the signature —, ⋮ off) and "hr: no Firm's signature and stamp button without its right" (`tests/e2e/hr.test.js`).

## The worker's contract (D2)

On the worker (`src/manager/WorkerContract.tsx`, the worker window's **Contract** section — docs/workers.md): `contractCategory`, `contractTemplateId` (empty: the category's default, `defaultFor`) and `contractTerms` (the worker's own `{{terms_1}}`…`{{terms_5}}`). **A contract for this worker only** uploads a template through the same window, kept with `workerId` (listed only with that worker, never a default) and picked for the worker. A changed or replaced template reaches only new signings (D3). For a login that may change the firm's signature and stamp (`canFirmSign`), **Firm's signature and stamp** opens them (`FirmSealWindow`).

### Tests (D2)

`tests/auth/test_contracts.py` (marks in both directions and a typo; made light, same look, pictures shrunk; not a PDF refused; a picture page; filling, also by hand, and the signature; the actions — prepare, save, defaults, a worker's own, another firm sees none, staff may not manage, a new version, delete; Admin → Errors entries), and the browser check "contract templates" (`tests/e2e/main.test.js`: the upload made light with its marks — the Hebrew line too — and the typo, the sample, Save as the category's default, a tap opens the sample, the worker window's Contract section saved, ⋮ and Delete through Undo).

## Signing (D3)

Form 101 and the worker's contract are signed **once**, with the same signature and date in both, and are never built again.

### The manager's side

- **Documents to sign** on the worker card (`card-sign`, a login that edits workers) opens the sign window (`src/manager/SignWindow.tsx`). It reads `ManagerBridge.signContext(id)` — the saved worker, Form 101's values (`form101Payload`), the contract's mark values (`contractValues`, `src/manager/logic/contract-values.ts`: Hebrew as Form 101, a passport's names Latin; the pay marks only for a login that sees pay, `canSeePay`), the punch link and its WhatsApp link — and the templates (`list` with the worker): the worker's own pick, else its category's default, is chosen first.
- **The signing date:** the day of signing by default; a login with the right **Set the signing date** (`canSetSignDate`: the owner, the super-admin, or the template's `setSignDate` tick — archive/docs/permissions-plan.md) picks it in the window. The worker never changes it.
- **Send to sign** (`send`, way `remote`): the request waits in the worker's own page; the window shows the link with **Send on WhatsApp** and Copy. The WhatsApp text (`signMessage`, `src/manager/page/bridge.ts`) is in the sender's language: the worker's full name, the ID or passport number, a line on what to do (open the personal account at the link, read, sign at the bottom), then the link; the link's preview reads **Personal account** (`worker-punch.html`'s title). **Sign here** (way `person`): both documents filled, in the window (`SignDocuments`), one signature → `sign`, the window closes at once and the two PDFs are built in the background (`buildSigned`: `build` form101 and contract at once), then taken onto the worker.
- **On the worker** (`src/manager/logic/signing.ts`): the firm's requests are read when the Workers tab is drawn (at most once a minute; `loadSignRequests`), when a worker card opens (when 10 s old — a signing done in the worker's own page shows from any tab) and after a signing (forced: a read already on its way is followed by a new one, so the one waited for has the signing built); the card shows **Sent to sign**, **Signed <date>** — the latest signing's date, also while its PDFs are still being built (`signing`: Sign here puts the request as `signing` with the date the server gave at once, `rememberRequest`) — or **Needs sending again** (the template was deleted before the signature). A signed request not taken yet is put on the worker once (`adoptSigned`): Form 101 as `docUrl` / `docFileId`, the contract as a `docs` entry with `signed: true`, `signedAt`, `signDate`, `signedRequestId`, the signature (`sigFileId`); the replaced Form 101 and contract leave the record but their files are kept (Signed files are kept, below); then `applied`.
- **Never built again:** a worker with `signedAt` keeps its signed Form 101 — no rebuild after an edit or a firm change, a rescan stores only its pages (docs/form101.md → When it is built). A later change to a template never touches signed contracts.

### The server (`functions/signing.py`, the `sign_documents` function)

- **`send`** (a login that edits workers; an own-workers HR only its own): the whole send is refused — nothing reaches the worker — when it carries a signing date from a login without `setSignDate`, or a non-empty pay mark (`rate`, `pay_mode`, `ot_rate`, `shabbat_rate`, `travel`, `bank`) from a login that doesn't see pay (`may_see_pay`: the owner, the super-admin, a staff login with Accounting or Edit pay, an HR with See workers' pay). The template's file is copied for this send (`…/workers/<w>/sign/<id>/contract-template.pdf`), so a replaced template doesn't change what the worker signs, and so are the firm's signature and stamp (`seal: {signature, stamp, everyPage}` — The firm's signature and stamp, above); a waiting send of the same worker is `replaced`. Deleting a template withdraws its waiting sends (`withdrawn`).
- **`view`** `{which}`: Form 101 (`build_form101_pdf` with the stored pages — docs/contracts.md → Scanned pages — and the date) or the contract (`contracts.fill` with the values, the date, `{{today}}` and the frozen seal), unsigned; once signed, the stored signed PDF.
- **`sign`** `{signaturePng}`: once (a PNG of at most 400 KB), kept in `…/signature/`, `signedAt` = the server's time, the date fixed (the day of signing unless set).
- **`build`** `{which}`: the signed PDF built with the signature and the date, stored in `…/form101/` or `…/docs/`; called twice at once; whoever sees both parts marks the request `signed`. A part already built is answered as it is — never built again.
- **The worker's page** calls `mine`, `view`, `sign`, `build` with the punch link's token only: the worker's own latest request (a token of another worker sees nothing).
- `list`, `applied`, `withdraw` for the manager app.

### Tests (D3)

`tests/auth/test_signing.py` (the send refused as a whole without the date right or with pay marks; an own-workers HR; the worker's page by its token, another worker's link sees nothing; the frozen template; one signature; two builds, never again; the date of signing by default; a new send replaces; a deleted template withdraws), `tests/auth/test_core.py` (the new right off in Full access), and the browser checks "signing" (`tests/e2e/main.test.js`: Send to sign with the WhatsApp link, the worker's page — both documents, the end of both, one signature, both PDFs with the same date —, the manager app takes them, a rebuild leaves them, the card's chip; Sign here in person).

## A new signature after a change (D4)

- **At the send** the sign window keeps what the documents print about the worker: `printHash(form101, values, marks, withPay)` (`src/manager/logic/contract-values.ts`) — Form 101's values without the firm's block, the date and `street` / `houseNumber` (they repeat `address`), and the contract's marks the template prints (`printMarks`), without the firm's marks; the pay marks count only when the sender saw pay (`printPay`, which the server keeps true only for a login that sees pay). The server stores them with the request; taking the signed documents onto the worker copies them (`signedPrint`, `signedPrintPay`, `signedPrintMarks`).
- **A change** to any of those values (the worker window, a scan, the card) gives the worker the amber notice **Documents changed — needs a new signature** (`signedChanged`, `workerNotices` in `src/manager/page/workers.ts`) on the plate and the card, with **Sign** as its action: the worker card opens with the sign window (`askSign` / `takeSign`, `SignWindow.tsx`). A change to the firm's own details (name, address, phone, deductions file) asks no worker to sign again; the new details go into the next signing.
- **Until the worker signs**, the old signed documents stay. **When the worker signs**, the new Form 101 and contract replace them on the worker record (`adoptSigned`, Signing above); the old files are kept in Storage, named by their own request's `parts` (Signed files are kept, below). Whether earlier signed sets are later deleted on purpose is the owner's open question (docs/documents-plan.md → Q2).

Tests: `tests/auth/test_signing.py` (the hash kept with the send, pay only for a login that sees pay) and the browser check "new signature (D4)".

## Signed files are kept

A signed file is a legal copy: it is **never deleted on its own** — when a newer file replaces it, a rescan, a new signing — only by **a person's own delete** (owner, 2026-10-25): Remove on the worker card, Delete worker, a supplier's Delete (docs/documents-plan.md → S0b; the 2026-10-20 deletes on re-signing stopped — docs/history.md). A **signed file** is:

- a part (`parts.*.path`) or the signature (`sigPath`) of any signing request of the worker (`signRequests`, and the `transferRequests` that made the worker in its new firm);
- a `docs[]` entry marked `signed: true`;
- for a **signed worker** (`signedAt` or `signedRequestId`): its `docFileId`, every `docs[].fileId` and its `sigFileId`.

Where it is enforced:

- **The server** — `users_admin` `deleteWorkerDoc` (`functions-auth/files.py`, `signed_file`) answers "A signed document is kept and can't be deleted" and deletes nothing — unless the call is a person's own delete (`manual: true`, only the literal true). `main.py` hands it `signed_lookup(workerId)` (the worker record, its `signRequests` and the `transferRequests` with `toTenant` / `newWorkerId`); without it, `run` deletes nothing that is not manual. Every file delete the browser starts goes through it (`gsDeleteWorkerDoc(fileId, manual)`): on its own — the replaced pages and signature (`saveScanPages`), the file a new upload replaces (`uploadWorkerFile`'s `previousFileId`) — and manual — `removeDocs` (Remove on the card) and `deleteWorkerNow` (Delete worker). The firm and HR checks apply to a manual delete as to any other. A request's parts are refused even when the worker record no longer names them (the record replaced or already deleted).
- **The manager app** — `adoptSigned` (a new signing over an older one) deletes nothing; Remove on a signed document (`removeDocs`, `src/manager/page/bridge.ts`; the card's documents box offers Delete on every document) and Delete worker (`deleteWorkerNow`: every file of the worker) are a person's own delete and send `manual`.
- **The supplier** — `supplierDeleteWorker` (`functions-auth/portal.py`) deletes a signed worker's record too: a person's own delete (docs/portals.md).

Not covered yet: a direct browser delete allowed by `storage.rules` (no app code does one), and `delete_tenant_files` when a firm is deleted; the documents plan's later stages lock signed files in place (temporary holds, S4).

Tests: `tests/auth/test_files.py` (each kind of signed path refused on its own, also with the worker record gone; a manual delete removes each, only the literal true counts and the firm check still holds; an unsigned path, a page and a sidecar of a signed worker still deleted; no lookup, no delete), `tests/auth/test_portal.py` (a supplier may delete a signed worker), and the browser checks (`tests/e2e/main.test.js`: the server refuses the signed Form 101, contract and signature on their own; Remove on a signed document and Delete worker send every file as manual).

## Download data (D5)

**Download data** in the worker card's ⋮ opens a picker (Form 101, the contract, the ID and scans, the other documents) and the `worker_docs` function puts the picked parts into one PDF after a summary page — the stored signed Form 101 whole, or a preview marked as not signed; the contract only for a login that sees pay unless its sign request printed none; the ID card or passport with the ספח on **one A4 sheet**; never stored. Described in [workers.md](workers.md) → Download data (`functions/workerdocs.py`, `functions/idsheet.py`; docs/documents-plan.md → S2).

The old call, `sign_documents` `bundle` `{workerId}` (`bundle` in `functions/signing.py`), stays for a device that has not reloaded: everything, Form 101 the stored `docFileId`, as base64 JSON — put together by the same code (`workerdocs.build_bundle`), so the summary, the ID sheet, the captions and the pay rule are one copy.

Tests: `tests/auth/test_worker_docs.py` (both calls) and the browser check "download data".

## Moving to another firm (D6)

A copy, with the worker's signed consent (`functions/transfer.py`, through `sign_documents`):

1. **The new firm asks:** its admin (or a super-admin inside it) taps **From another firm** in the Workers tab (`TransferAskWindow`, `src/manager/TransferAsk.tsx`) and types the worker's ID or passport number → `transferAsk`. A **super-admin** (who sees every firm anyway) gets above the number field a **Worker** list to pick from (`Combobox` with `rows={5}`: a search on top — by name or ID / passport — and five workers in view at a time, the rest by scrolling; owner, 2026-10-26): the other firms' workers that are not Inactive and have an ID / passport number, read with `fetchForTenant('loadSchedule', …)` per firm in parallel, each with its firm and number; a pick fills the number. A firm's own admin never gets that list — another firm's workers stay hidden from it (firm data isolation). The server looks in the other firms (the collection-group index on `workers.docKeys`; an Israeli ID matches with or without its leading 0 — `doc_key_forms`, as `checkWorkerDoc` — so "12345678" finds a worker stored as "012345678" and the other way round) and opens a request for each worker found who is not Inactive; the answer is always **Request sent**, found or not — the new firm learns nothing until the worker approves, and the old firm sees nothing of it. A request not answered ends after 14 days (`expiresAt`, marked `expired` when next read).
2. **The worker approves in their own page** (the old firm's punch link): a card **[new firm] asks to take your details** (`TransferCard`, `src/punch/Documents.tsx`) opens a sheet with the new firm's Form 101 and contract filled with the worker's data and the new firm's details (`view` with `transfer: true`: Form 101's values and the contract's marks built on the server — `form101_payload` (the street and the house number apart, as `form101Payload` sends them, so "12א" prints whole), `contract_values`; the work and pay marks stay empty; the contract is the new firm's default template, the one without a category first), one signature with the day's date (`sign` — the consent and the signing in one), then the two PDFs built at once (`build`); or **Decline** (nothing is copied).
3. **The copy** (`_copy`, only after both signed PDFs are built): a new worker record in the new firm with the personal and family fields only (`PERSONAL`: names, ID / passport, its expiry, birth date, sex, marital status, health fund, phone, address, income types, children, spouse), the scanned pages and the signature (copied in Storage), the signed Form 101 (`docUrl`) and contract (`docs`, `signed`), a new punch-link token, the start date = the day of signing, `movedFromOtherFirm`. Nothing else: no hours, pay, rates, clients, supplier, HR, token or notes.
4. **The old firm** keeps the worker as they were — the record, the documents, the hours — set Inactive (`status: fired`) with `movedToOtherFirm` (the card's chip **Moved to another firm**), without the new firm's name.

Each copy is logged in `transferLog/<request id>` (when, the request, from which firm and worker to which firm and new worker, who asked); creating that entry is also the copy's one-time lock — the two builds may finish together, and only the one that creates it makes the copy (`_claim`). `transferRequests` and `transferLog` are top-level collections only the functions read and write.

Tests: `tests/auth/test_transfer.py` (the new firm learns nothing, only its admin asks, not its own worker; the worker signs and only the personal data is copied, the old firm keeps the worker Inactive, the log; declined or expired copies nothing) and the browser check "transfer".

## Word templates (D7)

- **Upload:** Admin → Contract templates (and A contract for this worker only) take a `.docx` as well as a PDF (`TEMPLATE_ACCEPT`, `isWordFile` in `src/manager/contracts.ts`). `prepare` with `docxBase64` has the file turned into a PDF first (`convert_docx`, `functions/contracts.py`), then it goes the same way as a PDF (made light, its marks found, D2). The `.docx` is not kept, and signing never waits for LibreOffice.
- **The service** `docx2pdf` (`services/docx2pdf/`: `convert.py`, `main.py`, `Dockerfile` — Python, LibreOffice headless with the Culmus Hebrew fonts) on Cloud Run, europe-west3: `POST {docxBase64}` → `{pdfBase64}`. The `contract_templates` function forwards the caller's own ID token (`Authorization`); the service lets in only a firm's admin or the super-admin (`check`). Each conversion has its own LibreOffice profile in a temporary folder; the service runs one conversion per instance (`concurrency 1`, `cpu 1`), up to 5 instances side by side (`max-instances 5`), none while idle — its first start after idle takes a few seconds. Deployed by `.github/workflows/deploy-docx2pdf.yml` on a push to `main` touching it, which writes its address to Firestore `appConfig/docx2pdf.url`; until then a Word file is refused with "Word files can't be converted yet — in Word, save it as PDF and upload that" (and an Admin → Errors entry).
- **Several files at once:** picking more than one file prepares each in the background — each is its own call, all sent at once; its line says **Preparing…** (`contract-pending`), a ready one is saved as it is (its file name, no category) with a toast with both sizes, a failed one stays as a red line with its reason (swipe / ⋮ Delete removes it). One file opens the upload window as before.
- **Marks in a LibreOffice PDF:** a Hebrew line may come out with its letters interleaved, so every known mark whose name appears in the page's text is looked for, and the braces around it decide (`find_marks`).

Tests: `tests/auth/test_docx2pdf.py` (a real conversion — LibreOffice is installed in CI —, its marks found also in the Hebrew line, not a Word file refused, a profile per conversion, who may call the service, `prepare` with a Word file and without the service) and the browser check "word templates" (a PDF and a `.docx` at once, both Preparing…, both templates).
