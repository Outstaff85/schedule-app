# Signed documents plan: Form 101 and the contract under one signature, one PDF per worker

**Status:** planned, not built (owner, 2026-10-20). This is the short plan; each stage gets its detailed design before it is built.

The owner's scheme:
- The Form 101 template never changes.
- The firm's contract is uploaded as a template, PDF or Word.
- The worker sees both documents filled with their data and signs **once**. The same signature and date go into both.
- Everything is kept under the worker.
- When the worker's data changes, the worker signs again, and the new documents replace the old ones.
- On request, everything is joined into one PDF.

## What is kept, and how

| What | Kept as | Where |
|---|---|---|
| The worker's data | fields of the worker record | Firestore |
| Each scanned page (ID card, passport, ספח, other) | its own JPEG: cut, straight, 1600–2000 px on the long side, ~300–600 KB; its kind and date in the worker record | Storage, the worker's folder |
| The signature | a small PNG, with its date | Storage, the worker's folder |
| Form 101 and the contract | the signed PDFs, built once at signing | Storage, the worker's documents |
| The one PDF of everything | not kept: put together on request | — |

## D1 — scans as separate JPEG pages

- Every scanned page is stored as its own JPEG, listed in the worker record with its kind (`id_front`, `id_back`, `sefach`, `passport`, `other`) and date.
- This replaces the sidecar JSON with the pictures inside, which is a third heavier and has to be loaded whole.
- The existing workers' sidecars are split into pages once, by a migration.
- Form 101, the contract and the joined PDF read the pages from here.

## D2 — contract templates (PDF first)

- The firm uploads its contract as a **PDF** with marks written in the text, for example:
  - `{{given}}`, `{{surname}}`, `{{id}}`, `{{start_date}}`, `{{company}}`;
  - `{{signature}}`, `{{sign_date}}`.
- **Filling:** the server finds each mark in the PDF's text, whites it out and writes the value in its place. Hebrew is drawn right to left, as Form 101 already does (PyMuPDF, `functions/main.py`), and a long value is shrunk to fit. No new server is needed.
- **Templates:** several per firm, in Admin; a firm sees only its own.
- **On upload:** the site lists the marks it found and the unknown ones, and shows a sample PDF filled with made-up data.
- **The first marks:**
  - the worker's names, ID or passport number, birth date, address, phone, start date;
  - the rate, filled only for a login allowed to see pay;
  - the firm's name and details;
  - the client or site;
  - the signature and the signing date.

## D3 — one signature for both documents

- In the worker window: **Documents to sign** → pick the contract template (the firm's default is chosen first).
- **Both documents on screen:** Form 101 and the contract, filled with this worker's data, one after the other, to scroll through. The worker must see what they sign.
- **One signature** at the bottom (the shared `SignaturePad`); the date is set by itself.
- **The same signature and date go into both PDFs.** The two are built on the server in parallel (two calls at once; the function declared `cpu=1`, `concurrency=20`), in the background: the save does not wait.
- The signed PDFs are stored in the worker's documents: Form 101, and `contract` with the template's name and version.
- They are **never rebuilt** afterwards.
  - `regenerateWorkerDoc` and `regenerateAllWorkerDocs` stop rebuilding signed forms.
  - A later change to a template never touches signed contracts.
- Scanned paper contracts stay as they are (docs/scan.md → Contracts).

## D4 — data changed → a new signature, the old documents replaced

1. A change to a field that Form 101 or the worker's contract prints marks the worker **Documents changed — needs a new signature** (the notice on the plate and the card, with Sign as its action).
2. Until the worker signs, the old signed documents stay, so the worker is never without signed documents.
3. When the worker signs, the new Form 101 and contract are stored and the old ones are deleted.

- **A change to the firm's own details** (name, address, phone, deductions file) does not ask every worker to sign again. The new details go into the next signing. To confirm with the owner.
- **Before deleting old Forms 101:** check with the firm's accountant whether old forms must be kept for some years. If so, the old ones go to a hidden archive instead of being deleted.

## D5 — "Download data" on the worker card

- One PDF, put together on request, in this order:
  1. Form 101;
  2. the contract;
  3. the ID card or passport;
  4. the ספח;
  5. the other documents.
- Built from the stored signed PDFs and the JPEG pages. The joined file is not stored.
- A first page with a summary of the worker's data is optional (the owner decides).

## D6 — Word templates

- A `.docx` with the same marks is turned into a PDF **once, when the template is uploaded** (LibreOffice in a Cloud Run service). From then on it is a PDF template as in D2; the signing never waits for LibreOffice.
- Not needed if the owner saves the template from Word as PDF.

## Order

D1 → D2 → D3 → D4 → D5 → D6.

Each stage brings its own docs (docs/form101.md, docs/workers.md and a new docs/contracts.md), browser checks and Hebrew dictionary entries.
