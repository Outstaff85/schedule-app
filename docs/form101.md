# Form 101 (PDF)

How a worker's Form 101 PDF is built, stored and rebuilt.
- The client assembles a JSON payload: `aiFillForm101()` in `src/manager/page/form101.ts`, its values from `form101Payload(worker, isId, profile)` in `src/manager/logic/form101.ts` (pure; React migration 8f).
- The Cloud Function `fill_form_101` (`functions/main.py`, PyMuPDF, region us-central1) fills the template and returns the PDF. The call carries the manager's Firebase ID token (`Authorization: Bearer`); the function refuses any other caller (`functions/gate.py`, [backend.md](backend.md) → Cloud Functions).
- The client stores the PDF, and the scan's pages (one JPEG each) and the signature (a PNG) in Firebase Storage ([contracts.md](contracts.md) → Scanned pages).

**Before touching field rects or the template:** read and update [form101-field-map.md](form101-field-map.md) (every AcroForm field: name, rect, Hebrew label, meaning).

**Language:** everything printed on the form is Hebrew. The only exception: a foreign-passport worker's or spouse's given name and surname stay in Latin letters.

## When it is built

All paths call `aiFillForm101(isId, workerId, presetAssets?)`, which builds the PDF and uploads it (there is no download mode). `isId` is the document type being saved: the worker window's save passes the type of the form (`fields.docType` — a rescan that found a passport builds a passport form), and the build writes it onto the worker.

| Path | Function | Scan source |
|---|---|---|
| New worker saved | `autoUploadWithRetry()` (one retry after 1.5 s), modal shows progress | the live scan globals: `window.__aiScanImage`, `__aiPacketOtherPages`, the signature pad |
| Worker rescanned in this session (`__aiRescannedWorkerId`) | `autoUploadWithRetry()` | the live scan globals |

The live path reads the live globals (the scan image, `__aiPacketOtherPages`, `__wCapturedSigPng`, `__aiRescanWorkerId`) into locals before its first `await`, and only the live path clears them at its end. A background rebuild (`presetAssets`) never reads nor clears them, so a rebuild of worker B that ends while worker A is being scanned leaves A's ספח pages, signature and rescan target as they are.
| A Form 101 field changed on an existing worker | `regenerateWorkerDoc(id)` in the background | the stored pages and signature (`loadStoredAssets(w)`, `src/manager/data/pages.ts`) — never the live globals, which may belong to another scan; when they can't be read, nothing is rebuilt |
| — a worker with signed documents (`signedAt`) | never: `regenerateWorkerDoc` does nothing, `regenerateAllWorkerDocs` skips them, the save of the worker window rebuilds nothing, and a rescan stores only its pages — a signed Form 101 changes only by a new signing ([contracts.md](contracts.md) → Signing) | — |
| Firm profile changed (employer block) | `regenerateAllWorkerDocs()`, one worker at a time, for workers that have `docUrl` and stored pages or a signature (`hasStoredAssets`) | the stored pages |

The trigger fields are `FORM101_WATCHED` in `src/manager/worker.ts`, checked by `form101Changed()` in `saveWorker()` (`src/manager/worker-save.ts`, [workers.md](workers.md)). A worker window opened and closed with nothing changed saves nothing and rebuilds nothing.

## The payload (`aiFillForm101`)

Everything comes from the saved worker record, `targetWorker`:

| Payload field | Source |
|---|---|
| `isId`, `isIsraeli` | `docType !== 'passport'` |
| `surname`, `given`, `dob`, `sex`, `no` | the worker's ID or passport fields (`no` = `workerDocId`) |
| `signDate` | `DD/MM/YYYY` of `createdAt` (else today) |
| `workerPhone`, `incomeType`, `otherIncomeType` | worker |
| `employer` | `{companyName, street, streetNumber, city, phone, deductionsFileNumber}` from the firm profile, refreshed from the server first when the session's copy is over 5 minutes old (`refreshTenantProfile`; also run 4 s after the app opens). A super-admin's edit of another firm marks it (`form101Regen:<tenantId>` in `localStorage`); that firm's Form 101s are rebuilt the next time this device opens it (`maybeRegenAfterFirmEdit`) |
| `street`, `houseNumber` | the street (`workerAddress`) and the house number apart, so a number such as `12א` or `12/3` is printed whole |
| `address` | street + house number in one string (for an older server; the PDF uses `street` / `houseNumber` when they are sent) |
| `city`, `marital`, `workStart` (`workStartDate`), `healthFund`, `children` | worker — for both document types |
| `spouse` | `{surname, given, idNo, dob, income}` when any spouse field is set |
| `signaturePngBase64` | the pad of the worker window (the shared `SignaturePad`; its save hands the PNG to `window.__wCapturedSigPng`, which `getSignaturePng()` returns) or the stored signature (`sigFileId`); a signature drawn while editing an existing worker is passed to the rebuild (`regenerateWorkerDoc(id, newSigPng)`, `sigChanged`) |
| `extraPages` | `[{b64, mediaType, caption}]`: the main scan first (`'Document scan'`), then the other pages (`'Document'`) |

Missing firm-profile fields (`firmProfileMissing`) are shown as a toast after the save.

**Rescan without new extra pages:** when a rescan in this session captured no extra pages, the stored ones (the ספח…) are loaded for the PDF and kept as they are stored, so they are not lost; the same for the signature.

## Building the PDF (`build_form101_pdf`, functions/main.py)

- **Template:** `functions/assets/form101_fillable.pdf`, with the Heebo font (`functions/assets/heebo-hebrew.ttf`). These are the only copies.
  - The template's fields use the PDF's own Helvetica (`/Helv` in their `DA` and the form's `DR`), so the template carries no font file for them: ~95 KB, and a filled form without scans ~170 KB. It once carried the whole Calibri for 47 fields (586 KB in every Form 101) that the `garbage` clean-up could not drop, because the fields named it. `tests/auth/test_form101_template.py` keeps the template under 200 KB.
- **`Form101Builder`** addresses fields by their AcroForm names.
  - **Hebrew text:** `set_hebrew()` sets the value, blanks the field's own appearance, and draws the text by hand. PyMuPDF has no RTL shaping, so the text goes through `bidi.get_display()` and is right-aligned.
  - **Plain text:** `set_text()` keeps PyMuPDF's own appearance (fine for left-to-right text). `set_text_centered()` draws it centered by hand (the house number).
  - **Digits:** `set_comb(name, value, max_len, size)` — comb fields, one digit per box.
  - **Checkboxes:** `check(name)` blanks the box and draws a blue tick inside the checkbox's own rectangle, with no offset.
  - **Positions:** every field is filled exactly at its rectangle in the template; fields are moved in the PDF itself (there is no position correction in code).
- **What is filled:**
  - **Header:** surname and given name; date of birth (`_ddmmyyyy` → 8 boxes, zero-padded); `id_top2` (an Israeli ID as below); tax year = the current year.
  - **Employer:** name, address (street + number + city), phone, deductions file — digits only, the last 8 in the 8 boxes (the form prints the leading 9 itself).
  - **Sex:** `sex_male` / `sex_female`. Kibbutz member `cb_p1_1` is always ticked ("no").
  - **Israeli ID:**
    - `resident_yes` and `resident_h`;
    - the worker's ID in `employer_zeut_num` (`_israeli_id`: digits only, an 8-digit ID zero-padded to 9) — the field is misnamed: by position it is the worker's own ID;
    - marital status if set;
    - start date (`Date_start_work`);
    - health fund (`hf_yes` plus the Hebrew name, `HEALTH_FUND_HE`).
  - **Passport:** `resident_no`; marital status (single unless set); `passport_no` (13 boxes); start date; health fund.
  - **Income:** `INCOME_TYPE_CB`. Other income: `none` → `cb_p1_10`; otherwise `cb_p1_11` plus `OTHER_INCOME_CB`.
  - **Address:** `addr_street` / `addr_number` from `street` / `houseNumber` (an older caller's one `address`, or a `street` that still holds the number while `houseNumber` is empty — an older record — is split by `_split_street`) and `addr_city`, for both document types.
  - **Children:** up to 6 rows (`CHILD_FIELD_SUFFIXES`). The name is split on the first space into given name and surname; the date of birth goes to 8 boxes; the ID or passport number goes to `child_passport_no*` (letters kept).
  - **Spouse, section ו** (`fill_spouse`):
    - names;
    - an 8–9 digit ID → `spouse_employer_deductions` (zero-padded to 9; the field is the spouse ID despite its name); anything else → `spouse_passport_no`;
    - `spouse_dob`;
    - income → `SPOUSE_INCOME_CB`: `none` → `cb_p1_22`; `work` → `cb_p1_23` + `cb_p1_24`; `other` → `cb_p1_23` + `cb_p1_25`.
  - **Worker phone, signing date, signature:** the signature image goes to page 2 in `SIG_RECT`.
- **Scan pages:**
  - the first two `extraPages` share one page, top and bottom halves (normally the ID front and the ספח);
  - every further page gets its own page;
  - each image is shrunk to 150 dpi for its box (`_shrink_for_embed` — JPEG 82, or PNG when the image has transparency);
  - this happens only here: the stored page stays as it was kept (a JPEG of at most 2000 px).
- **Output:**
  - the file is saved with `garbage=4, deflate, clean`, and `NeedAppearances=false`;
  - the file name is `<given> <surname> - <ID or passport number> - <company>.pdf` ([form101-field-map.md](form101-field-map.md) → File name);
  - `build_form101_pdf` returns `(pdf bytes, file name)`; the function returns `{pdfBase64, fileName}`.
- **Warm-up:** `{"ping":true}` gets an immediate answer (`_ping_response`). All three functions in `functions/main.py` do this; the client pings them when the worker modal opens and when a scan starts.

## Storing the result

The PDF and the scan's pages are uploaded at the same time; the progress bar runs 20–90 %, combined over every upload.

| What | Action | Stored at |
|---|---|---|
| PDF | `saveWorkerDoc` `{fileBase64, fileName, previousFileId, workerId}` | Storage `tenants/<t>/workers/<id>/form101/<ms>-<name>`, with a download URL |
| Each scanned page (the ID card or passport first, then the other pages; not the contract's pages) | `saveScanPages()` (`src/manager/data/pages.ts`): `saveWorkerPage` per page, all at once, each shrunk to a JPEG of at most 2000 px (`pageForStorage`) | Storage `…/pages/<ms>-<index>-<kind>.jpg` (no URL); listed on the worker as `scanPages` |
| The signature | `saveWorkerSignature`, with the pages | Storage `…/signature/<ms>-signature.png` (no URL); `sigFileId`, `sigSavedAt` |

- **Pages:** stored when the save has a scan of this session (a new worker, a rescan), or a new signature, or on a rebuild of a worker still on the old sidecar (its pages are split then). A part that came from Storage unchanged (the other pages kept on a rescan, the signature not drawn again) keeps its stored file. Once the new files are up, the replaced ones and the old sidecar are deleted; a failed upload keeps what the worker had ([contracts.md](contracts.md) → Scanned pages).
- **The worker record after a successful save:** `docUrl`, `docFileId`, `docSavedAt`, `scanPages`, `sigFileId`, `sigSavedAt`, `docHasSignature`, `docExtraPages`; `docUploadFailed` is set to `false`; `assetsFileId` (the old sidecar) is removed. These fields (and `docType`, `previousFileId`, and `docUploadFailed` on a failure) go to the worker as the list holds it after each await (`liveWorker()`), not to the object the build started with: a merged save or an HR's live list may replace every worker object while the PDF is built, and a write onto the replaced object would be lost.
- **Replacing the old file:** the file being replaced (`previousFileId`) is deleted after the new one is up, through `users_admin`.
- **Failure:** any error sets `docUploadFailed = true`, which shows the UPLOAD FAILED / NO DOCUMENT badge, and a toast.

Upload mechanics (`uploadWorkerFile`): [app-core.md](app-core.md) and [backend.md](backend.md).
