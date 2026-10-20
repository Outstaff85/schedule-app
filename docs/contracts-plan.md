# Signed documents plan: Form 101 frozen at signing, contract templates, one PDF per worker

**Status:** planned, not built (owner, 2026-10-20). This is the short plan; each stage gets its detailed design before it is built.

A signed document with a date is a legal record: it is built once, when the worker signs, and never rebuilt from later data. The data stays in the database and the scans and signature in the sidecar; only the signed PDFs are stored. The one PDF of everything is made on request.

## C1 — Form 101 frozen at signing

- The PDF is built once, when the worker signs, in the background (the save does not wait for it), and stored as is.
- No rebuild after that:
  - `regenerateWorkerDoc` and `regenerateAllWorkerDocs` (firm profile) stop rebuilding signed forms.
  - A change of a Form 101 field (`FORM101_WATCHED`) or of the firm profile after the signing marks the worker **Form 101 changed — needs a new signature**.
- A new signature makes a new Form 101 with its own date; the old one stays in the worker's documents (history).

## C2 — "Download everything as one PDF"

- A button on the worker card puts together, on request:
  - the latest signed Form 101;
  - the ID card or passport, the ספח;
  - the signed contracts;
  - the other documents.
- The joined file is not stored; each part is the stored one.

## C3 — contract templates (Word)

- The firm uploads a `.docx` contract with marks in braces, for example `{{given}}`, `{{surname}}`, `{{id}}`, `{{start_date}}`, `{{company}}`, `{{signature}}`, `{{sign_date}}`.
- Several templates per firm, in Admin. A firm sees only its own.
- On upload the site lists the marks it found and the unknown ones, and makes a sample PDF with made-up data.
- The first marks:
  - the worker's names, ID or passport number, birth date, address, phone and start date;
  - the rate, filled only for a login allowed to see pay;
  - the firm's name and details;
  - the client or site;
  - the signature and the signing date.
- Excel templates: later, the same way, if needed.

## C4 — signing a contract

- In the worker window: Contract → pick a template → the contract with this worker's data on screen → the worker signs with a finger, the date is set by itself.
- The PDF is built and frozen. It goes to the worker's documents as type `contract`, with the signing date and the template's name and version.
- A later template change never touches signed contracts.
- A worker's data changed after the signing → the same **needs a new signature** mark as in C1.
- Scanned paper contracts stay as they are (docs/scan.md → Contracts).

## C5 — the server

- Word → PDF with Hebrew right to left: LibreOffice (headless) in a Cloud Run service:
  - the marks are filled into the `.docx`, then it is converted to PDF, then compressed;
  - a text PDF of ~50–200 KB.
- The call carries the user's ID token and the firm is checked, as the other functions do.
- Its first start after idle takes ~5–10 s, in the background.

## Order

C1 → C2 → C5 → C3 → C4. Each stage: its docs (docs/form101.md, docs/workers.md and a new docs/contracts.md), the browser checks, the Hebrew dictionary.
