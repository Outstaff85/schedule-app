# Signed documents plan: Form 101 and the contract under one signature, one PDF per worker

**Status:** built — D0–D7 merged (2026-10-20); the docx2pdf service deployed (2026-10-21, after the owner granted its rights). The old scan sidecars are not split (owner, 2026-10-21: no): they stay and are read as before, each worker's split on its next save. What is built is described in docs/contracts.md.

The owner's scheme:
- The Form 101 template never changes.
- The firm's contract is uploaded as a PDF template. The owner writes it in Word and saves it as PDF there, and a `.docx` can be uploaded directly too (D7, owner, 2026-10-20).
- The worker sees both documents filled with their data and signs **once**. The same signature and date go into both.
- Everything is kept under the worker.
- When the worker's data changes, the worker signs again, and the new documents replace the old ones.
- On request, everything is joined into one PDF.

## D0 — lighter PDFs — built (2026-10-20), on the work branch, not merged yet

- Form 101's template without the whole Calibri: a filled form with three scans 822 → 247 KB, the same to the pixel (docs/form101.md → Building the PDF).
- A scanned contract's pages scaled down to A4 at 200 dpi: ~15 → ~2 MB for 8 camera pages (docs/scan.md → Contracts).
- Tests green (Tests run on the branch). Merged with the plan when the owner says so.

## What is kept, and how

| What | Kept as | Where |
|---|---|---|
| The worker's data | fields of the worker record | Firestore |
| Each scanned page (ID card, passport, ספח, other) | its own JPEG: cut, straight, 1600–2000 px on the long side, ~300–600 KB; its kind and date in the worker record | Storage, the worker's folder |
| The signature | a small PNG, with its date | Storage, the worker's folder |
| Form 101 and the contract | the signed PDFs, built once at signing | Storage, the worker's documents |
| The one PDF of everything | not kept: put together on request | — |

## D1 — scans as separate JPEG pages — built and merged (2026-10-20); the old sidecars are not split at once (owner, 2026-10-21)

Built as docs/contracts.md → Scanned pages: every new save stores pages and the signature as files; a worker still on the old sidecar is read from it, and split into pages on its next save. The one-time split of every old sidecar (`scripts/migrate/scan_pages.py`, the workflow *Split the old scan sidecars into pages*) is run as `dry-run` first; `apply` and `cleanup` only with the owner's yes.


- Every scanned page is stored as its own JPEG, listed in the worker record with its kind (`id_front`, `id_back`, `sefach`, `passport`, `other`) and date.
- This replaces the sidecar JSON with the pictures inside, which is a third heavier and has to be loaded whole.
- The existing workers' sidecars are split into pages once, by a migration.
- Form 101, the contract and the joined PDF read the pages from here.

## D2 — contract templates (PDF first) — built and merged (2026-10-20)

Built as docs/contracts.md → Contract templates and The worker's contract. A picture page is shrunk to 200 dpi but not straightened by the server (the scanner runs on the phone); its marks are placed by hand. Managing templates is for the firm's admin and the super-admin.


- The firm uploads its contract as a **PDF** with marks written in the text, for example:
  - `{{given}}`, `{{surname}}`, `{{id}}`, `{{start_date}}`, `{{company}}`;
  - `{{signature}}`, `{{sign_date}}`.
- **Preparing it in Word:** the marks are typed as plain text, then File → Save as → PDF. Print to PDF or a scan would turn the text into a picture, and the marks could not be found; the upload then says so.
- **Filling:** the server finds each mark in the PDF's text, whites it out and writes the value in its place. Hebrew is drawn right to left, as Form 101 already does (PyMuPDF, `functions/main.py`), and a long value is shrunk to fit. No new server is needed.
- **Made light on upload** (owner, 2026-10-20). Whatever way the PDF was saved (PDF/A with whole fonts, big pictures, a heavy editor), the server turns it into the firm's standard light template, and the heavy original is not kept:
  1. it keeps only the letters each font needs (`subset_fonts`);
  2. it shrinks the pictures (logo, stamp) to 200 dpi, JPEG (`rewrite_images`);
  3. it drops the PDF/A extras and anything unused (`garbage=4`, `deflate`, `clean`).

  Then it checks the light one against the original:
  - every page rendered at 100 dpi looks the same (pictures may differ only by the shrinking);
  - every mark is still found.

  The admin sees the sample PDF of the light one with both sizes ("2.4 MB → 180 KB") and saves it; only the light one is stored, and the original is dropped. If the check fails, the upload says why, and nothing is stored.
  - **Heavy templates go to Admin → Errors** (owner, 2026-10-20), with no warning at upload. A template still over 1 MB after it was made light, or one whose making light failed its check, writes an entry there: the firm, the template's name, both sizes and the reason (whole fonts, big pictures, pages that are pictures). The super-admin sees it and fixes the template when needed.
  - **A page that is only a picture** (a scan, Print to PDF) goes through the same making light (owner, 2026-10-20): its picture is straightened and cut by the scanner's own way when it is a photo, then shrunk to 200 dpi, JPEG (a scanned A4 page ~200–300 KB). It has no text to find marks in, so its marks are **placed by hand**: the upload shows the page, and the admin taps where each value goes and picks the mark (`{{given}}`, `{{signature}}`…), with its width. The places are stored with the template and filled exactly like found marks. A text page can use the same placing too, for a mark the search missed.
  - A Word file (`.docx`) is taken too (D7): it is turned into a PDF on upload, then goes the same way. Saving it as PDF in Word first still works and needs no converter.
- **Templates:** a list per firm, in **Admin → Contract templates**; a firm sees only its own.
  - Each line shows the name, the category (and Default), the size, the date added and how many workers signed it.
  - The list follows the app's list template (`Plate`, `PagedList`, ⋮). A tap opens the template's sample PDF. From ⋮ the template can be renamed, given another category, made the category's default, or replaced by a new file (a new version). **New template** adds one.
  - **Delete** follows the app's rule: no question, an Undo snack (`undoDelete`).
    - Contracts already signed on it stay in the workers' documents.
    - Sends still waiting for a signature on it are withdrawn; those workers are marked **needs sending again**.
  - A worker's own one-off templates (above) are listed in that worker's window, not here.
- **On upload:** the site lists the marks it found and the unknown ones, and shows a sample PDF filled with made-up data.
- **The marks** (owner, 2026-10-20). They are written in Latin letters, in double braces, with no spaces. A Hebrew mark could come out of the PDF's text with its letters reversed, so Latin is the safe form. Each value is printed in Hebrew, as on Form 101, except a foreign passport's names, which are printed in Latin.

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
  | **Pay** — filled only when the login sending it may see pay (`seePay`); otherwise the send is refused, as for the date | |
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
  | **The worker's own terms** | |
  | `{{terms_1}}` … `{{terms_5}}` | the worker's own text fields (above) |
  | **Signing** | |
  | `{{signature}}` | the worker's signature (a picture, fitted to the mark's place) |
  | `{{sign_date}}` | the signing date (D3) |
  | `{{today}}` | the date the document is built |

  An unknown mark (a typo) is listed on upload and placed by hand or fixed in the file. A mark whose value is empty for a worker (no supplier, say) is printed empty.
### Fitting the contract to a worker or a category (owner, 2026-10-20)

Contracts can be added and changed at any time; whatever goes in, the output always goes through the same processing (made light, the marks filled, frozen at signing).
- **Categories:** each template has a category the firm names (for example hourly, monthly, foreign worker, driver). One template per category is its default.
- **The worker's template:** a worker gets the default of their category; in the worker window another template can be picked for this worker alone.
- **A contract for one worker:** a template uploaded from the worker window belongs to that worker only (not listed for others), and goes through the same making light and marks.
- **The worker's own terms without a new template:** the marks `{{terms_1}}`, `{{terms_2}}`… are filled from the worker's own text fields (for example a special rate, hours, a trial period), typed in the worker window. One template then serves many workers with different terms.
- **A changed or replaced template** reaches only new signings; signed contracts stay as signed (D3).

## D3 — one signature for both documents — built and merged (2026-10-20)

Built as docs/contracts.md → Signing. A login sees pay when it is the owner or the super-admin, a staff login with Accounting or Edit pay, or an HR with See workers' pay. The status of a send lives in its request (`signRequests`), not on the worker record; the signed documents are put on the worker by the manager app.


- In the worker window: **Documents to sign** → pick the contract template (the firm's default is chosen first). Then one of two ways:
  - **In person:** the worker signs on the manager's phone.
  - **At home, in the worker's own page** (owner, 2026-10-20): **Send to sign** puts the documents in the worker's page (the punch page, `/punch`, the worker's own link) and offers the link for WhatsApp.
    - The page shows **Documents to sign** at the top; the worker opens them and signs there.
    - The signatures and dates stay there: after signing, the page keeps showing the signed Form 101 and contract to read and download, so the worker always sees what they signed.
    - The manager sees **Sent to sign** on the worker until it is signed, then **Signed** with the date.
    - The link is the worker's own (`punchToken`); the server checks it, and the page gets only this worker's own documents.
- **Both documents on screen, both ways:** Form 101 and the contract, filled with this worker's data, one after the other, to scroll through. The worker must see what they sign, and the signature is open only after scrolling to the end of both.
- **One signature** at the bottom (the shared `SignaturePad`). The moment of signing is kept in the record (`signedAt`, the server's time), apart from the printed date.
- **The signing date** (owner, 2026-10-20) is printed in both documents:
  - **By default** it is the day of signing.
  - **Set by a login with the right** "Set the signing date": a super-admin, the firm's admin, or a login whose template has the tick. In the worker window, before Send to sign or signing in person, they pick the date; it goes to the worker with the documents.
  - **The worker never changes it:** in the worker's page the date is shown, fixed, next to the signature.
  - **The right:** `setSignDate`, a new tick in the shared permission templates, in the **Actions** group next to Edit workers (`RIGHT_ACTIONS`, `src/manager/templates.ts`; docs/permissions-plan.md), off by default. The server checks it too: a send carrying a date from a login without the right is refused as a whole — nothing reaches the worker, and the sender sees why; the documents are sent again (without a date, or by a login with the right).
- **The same signature and date go into both PDFs.** The two are built on the server in parallel (two calls at once; the function declared `cpu=1`, `concurrency=20`), in the background: the save does not wait.
- The signed PDFs are stored in the worker's documents: Form 101, and `contract` with the template's name and version.
- They are **never rebuilt** afterwards.
  - `regenerateWorkerDoc` and `regenerateAllWorkerDocs` stop rebuilding signed forms.
  - A later change to a template never touches signed contracts.
- Scanned paper contracts stay as they are (docs/scan.md → Contracts).

## D4 — data changed → a new signature, the old documents replaced — built and merged (2026-10-20)

Built as docs/contracts.md → A new signature after a change.


1. A change to a field that Form 101 or the worker's contract prints marks the worker **Documents changed — needs a new signature** (the notice on the plate and the card, with Sign as its action).
2. Until the worker signs, the old signed documents stay, so the worker is never without signed documents.
3. When the worker signs, the new Form 101 and contract are stored and the old ones are deleted.

- **A change to the firm's own details** (name, address, phone, deductions file) does not ask the workers to sign again. The new details go into the next signing (owner, 2026-10-20).
- **The old documents are deleted** when the new ones are signed. No accountant's check is needed and there is no archive (owner, 2026-10-20).

## D5 — "Download data" on the worker card — built and merged (2026-10-20)

Built as docs/contracts.md → Download data.


- One PDF, put together on request, in this order:
  1. a summary of the worker's data (owner, 2026-10-20): names, ID or passport number and its expiry, birth date, phone, address, start date, clients or site, supplier, the signing date, and the list of the documents that follow;
  2. Form 101;
  3. the contract;
  4. the ID card or passport;
  5. the ספח;
  6. the other documents.
- One choice, the whole order above, the contract included: the same file serves the accountant too (owner, 2026-10-20: it is light anyway).
- Built from the stored signed PDFs and the JPEG pages. The joined file is not stored.
- The summary never shows pay or rates unless the login may see pay. Its labels are Hebrew, as Form 101's.

## D6 — a worker moves to another firm (a copy, with the worker's consent) — built and merged (2026-10-20)

Built as docs/contracts.md → Moving to another firm. The new record's start date is the day of signing; the new firm's contract is its default template (the one without a category first).


The owner's rule: when a worker moves to another firm, everything under the old firm stays there; the worker's data is copied to the new firm and signed for it; and only when the worker approves it in their own page (owner, 2026-10-20).

1. **The new firm asks.** Its admin uses **Add a worker from another firm** with the worker's ID or passport number.
   - The new firm learns nothing about the worker until the worker approves; it sees only "Request sent".
   - The old firm sees nothing of the new firm.
2. **The worker approves in their own page** (the punch page, `/punch` — the worker's own link). It shows **[new firm] asks to take your details**, and below it:
   - the new firm's Form 101 and contract, filled with the worker's data and the new firm's details, to scroll through;
   - one signature with the date (as D3), which is both the consent and the signing.

   A worker who does not approve leaves nothing copied; the request expires after 14 days.
3. **The copy** (a server function, run only on a signed approval):
   - the new firm gets a new worker record: the personal and family fields, the scanned pages (D1) and the signature;
   - the new firm gets the newly signed Form 101 and contract;
   - nothing else is copied: no hours, pay, rates, clients, supplier, HR, punch-link token or notes.
4. **The old firm** keeps the worker as they were: the record, the documents, the hours. The worker is set Inactive there with **Moved to another firm**, without the new firm's name.

- The firms stay apart. Only the server copies, only after the worker's own signed approval, and each copy is logged (who, when, from which firm to which).

## D7 — Word templates taken directly (owner, 2026-10-20) — built and merged (2026-10-20); the service's first deploy waits for the owner's Google Cloud rights (the deploy's service account needs Cloud Run Admin, Cloud Build Editor, Artifact Registry Administrator — it creates the image repository on the first deploy — and Service Account User; then re-run *Deploy the docx2pdf service*)

Built as docs/contracts.md → Word templates. The service is `services/docx2pdf`, deployed by its own workflow; until its address is in `appConfig/docx2pdf`, a Word file is refused with the way out (save it as PDF in Word).


- A `.docx` with the same marks can be uploaded as it is, as well as a PDF.
- On upload only, it is turned into a PDF by LibreOffice (headless, Hebrew right to left) in a small Cloud Run service. The call carries the user's ID token and the firm is checked. Its first start after idle takes ~5–10 s, once per upload.
- From then on it is a PDF template: made light, its marks found (D2). The `.docx` is not kept. The signing never waits for LibreOffice.
- **In the background:** the upload returns at once and the template's line says **Preparing…**; the admin goes on working. When it is ready, the line shows its sample and sizes, and a toast says so. A failure is the line's message and an Admin → Errors entry.
- **Several files at once:** the list takes several files in one pick. Each file is its own call, all sent at once (`Promise.all`).
  - LibreOffice converts one file at a time per process and is not safe with two conversions sharing one profile, so the service runs one conversion per instance (`concurrency=1`, `cpu=1`). Cloud Run starts up to 5 instances side by side (`max-instances=5`), so 5 files convert at the same time.
  - The making light and the mark search (D2, the PyMuPDF function) take many calls on one instance (`cpu=1`, `concurrency=20`, no shared state per request).

## Order

D1 → D2 → D3 → D4 → D5 → D6 → D7.

Each stage brings its own docs (docs/form101.md, docs/workers.md and a new docs/contracts.md), browser checks and Hebrew dictionary entries.
