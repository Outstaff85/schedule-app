# Workers' documents plan — data kept, PDFs built on request

The plan (owner's request, 2026-10-25; approved in principle, each stage still needs the owner's yes) for keeping each worker's documents as **data** and building the PDFs only when someone opens, downloads or bundles them. The documents as they are today are described in docs/contracts.md (the scanned pages, the signature, the contract templates, signing), docs/form101.md (the Form 101 build) and docs/workers.md (the worker card).

Status: **in progress**. Done (merged 2026-10-25, PR #362): S0's inventory script (run on the real project with the owner's yes), S0b (signed files are never deleted on their own — only by a person's own delete) and S2 (Download data with the picker and the A4 ID sheet). Owner's answers of 2026-10-31 are recorded under the questions. Q6 and Q10 are put off by the owner. Next: S1.

## What and why

Today each worker stores heavy PDFs that are built once and kept:

- **The Form 101 in `docUrl` / `docFileId`** (under `workers/<w>/form101/`). Until the worker signs, it is the unsigned Form 101, rebuilt and re-uploaded on every edit of a watched field and on every firm profile edit (`regenerateWorkerDoc`, `regenerateAllWorkerDocs`). After signing, `adoptSigned` points `docUrl` / `docFileId` at the signed Form 101 (`src/manager/logic/signing.ts:76`).
- **The signed Form 101 and the signed contract** (under `form101/` and `docs/`, built by `signing.build`).
- **A copy of the contract template for every signing send** (`workers/<w>/sign/<rid>/contract-template.pdf`). It is never deleted, not even with the worker.

The Form 101 PDFs embed the scan pages (re-encoded JPEGs) that are already stored once in `scanPages`, so a worker's photos are stored two or three times. The "Download data" bundle adds the stored Form 101 and then the photos again, so they appear twice there too. The templates themselves (`functions/assets/form101_fillable.pdf`, about 95 KiB; the firms' contract templates) never change per worker.

Signed files are also deleted today, and nothing stops it:

- `adoptSigned` (`signing.ts:85–86`) deletes the worker's earlier `docFileId` (the unsigned Form 101, or an earlier signed one) and earlier signed contracts;
- `removeDocs` (`src/manager/page/bridge.ts:397–403`) deletes a signed `docs[]` contract without a check;
- `deleteWorkerNow` (`src/manager/page/worker-window.ts:224–233`) deletes the worker's `docFileId`, its signed contracts and the signature;
- `functions-auth/portal.py` `supplierDeleteWorker` (541) deletes a worker record, signed workers included, and leaves its files and `signRequests` behind;
- `storage.rules` lets a workers writer delete anything under `workers/{w}/**` from the browser.

Every browser-started file delete already runs on the server: `gsDeleteWorkerDoc` (`src/manager/data/api.ts:164`) calls `users_admin` `deleteWorkerDoc` (`functions-auth/files.py:107–112`), which deletes through the Admin SDK. So one check in `deleteWorkerDoc` covers every browser path; the `storage.rules` delete rule only covers a direct browser delete.

The goal is to keep per worker only:

- the data (the Firestore record);
- the scan pages (JPEG, once);
- the signature PNG and the signing date;
- the template **version** (templates versioned and never overwritten, so no per-send copies);
- for a signing, its **input manifest** (a stored, locked JSON file of its frozen inputs) and its hash, and a hash of the built PDF, with the builder version recorded so a rebuild gives the same bytes.

PDFs are then built on request: view, download, and the "Download data" bundle. In the bundle, the user picks the parts to include (Form 101, contract, scans, other documents). The ID card front and back (or the passport) and the ספח go together on **one A4 sheet**. The first page stays the summary.

Signed PDFs that exist today are legal copies. **No stage rewrites, moves or deletes them**, and S0b stops the deletes that happen today. The new scheme applies to new signings. The existing unsigned `docUrl` files are migrated (S7).

## Decisions

1. **Signed copies first.** Every new signing must stay provable at every stage. A signed PDF stops being stored only after S9's legal and technical gates are passed. Until then, a small signed copy is kept (recommended for good, Q1). Keeping a file is the safe default: deleting it later is always possible, getting it back is not.
2. **What proves a signing is its input manifest, not the PDF's bytes.** At signing, the server writes a canonical JSON manifest of every input as its own locked file (`sign/<rid>/manifest.json`) and stores its SHA-256 (`manifestSha256`) on the request and in the worker's `signed`. A rebuild reads only that file, never the live request fields. The manifest holds:
   - the cleaned Form 101 payload and the contract values;
   - the template version and its sha256;
   - the Form 101 template's sha256 and the font's sha256;
   - each page's and the signature's sha256;
   - `signDate`, `today` and `taxYear`;
   - the builder version.

   The output hash (`parts.<which>.sha256`) is a second check. If a later builder gives different bytes, the manifest still proves what was signed. Only the presentation is rebuilt with the old builder (S9 → the library bump policy). Both the manifest and its hash are written by the server, so they prove little against the operator; whether an outside timestamp or a copy sent to the worker is needed is asked of counsel (Q4).
3. **Nothing in a PDF depends on the day it is built.** The tax year, "today", the signing date, the template version, the page files and the builder version are fixed when a document is signed (the tax year from the final `signDate`, at `sign`).
4. **A mismatch is an error, never other bytes.** When a rebuilt signed PDF does not match its hash, the user gets an error, the super-admin's bell gets an alert, and (while a stored copy exists) the stored copy is served. A different document is never served.
5. **A signing's inputs and outputs are locked in place, not moved.** The lock is a GCS **temporary hold** (`blob.temporary_hold = True; blob.patch()`): GCS itself refuses a delete or overwrite from the browser, the Admin SDK and `delete_tenant_files` alike, so no code path has to remember a check. Custom metadata only records which requests own the file: one key per request (`lock_<rid>=1`), so a second signing on the same pages never overwrites the first's mark; a hold is released only when no kept request refers to the object. Locking also stamps `hrId` from the worker (pages uploaded by an admin or staff for a worker with an `hrId` carry no stamp today, and the server stamps the signature only when the request has an `hrId`, `signing.py:350`). A rescan after signing adds new pages. The locked ones stay as the signing's inputs, and `scanPages` points to the new ones.
6. **Readers move before writers stop.** The UI stops depending on `docUrl` (S5) before anything stops writing it (S6).
7. **Nothing is deleted before it has a replacement.** Every data migration follows `scripts/migrate/scan_pages.py`:
   1. dry-run;
   2. apply: field updates only, a record of what changed, old files kept;
   3. every manager device reloads;
   4. cleanup, on the owner's yes.
8. **Downloads go through the server.** A new function `worker_docs` builds and streams the PDFs, with firm isolation in the endpoint. Over time it replaces the bearer download-token links stored in Firestore (`docUrl`, `docs[].url`). Its rights checks become real only once the Storage read rule is narrowed and the tokens are revoked (S10, after Q5): until then any manager can read worker files directly.
9. **No cache in the first cut.** A build takes about 0.2–0.5 s warm (measured: Form 101 without pages 0.16–0.20 s, with three large pages about 0.5 s; a contract fill 0.02 s). A short-lived cache is added only if real use shows a need.
10. **Writes are write-once and builds are idempotent.** Version numbers are allocated in a transaction with `create()`; template versions, manifests and signed parts are uploaded with `if_generation_match=0` to fixed paths (`sign/<rid>/<which>.pdf`), so a double-tapped `build` returns the part that is already there.
11. **The safety net** (a cloud setting, the owner's hands): bucket soft delete (or object versioning) and Firestore point-in-time recovery or a scheduled export, so a bug that deletes something is recoverable. Asked in Q10, before S3b.

## Stages

Each stage is one PR from the work branch, with its own checks and a green Tests run. No stage merges without the owner's yes (this plan has no auto-merge exception). Every new UI text goes through `tr()`, with Hebrew added to `i18n/he.json` (`npm run test:i18n`). Everything printed inside a Form 101 stays Hebrew (CLAUDE.md, language rule), and so do the bundle's captions and summary page. Code comments and docs are English. Each stage updates CLAUDE.md ("Files", the duplicated-on-purpose list) in its own PR when it changes what is listed there.

### S0 — measure first, and the owner's answers (no app code)
- **Inventory script `scripts/migrate/docs_inventory.py`**, read-only, run by `workflow_dispatch` (a `migrate-docs.yml` workflow with the `FIREBASE_SERVICE_ACCOUNT` secret, Python 3.12, the same shape as `migrate-scan-pages.yml`). For each firm it reports:
  - the count and bytes under `form101/`, split into unsigned (no `signedAt`) and signed;
  - the signed contracts under `docs/`;
  - the `sign/<rid>/` template copies, split by request status;
  - `pages/`, `signature/` and the orphan signatures (no record refers to them);
  - the old `assets/` sidecars;
  - the template files under `contracts/`;
  - the workers still on a sidecar;
  - the workers with `docFileId` but no `scanPages` and no `assetsFileId` (their photos and signature may exist only inside that PDF, S7);
  - the legacy signing requests not yet applied (no `appliedAt`, S5).
- These figures size the saving and set the order of S6–S10. The estimate below is replaced by them.
- **The owner's answers:** Q1 before S9; Q2 and Q3 before S4; Q10 before S3b; Q4 and Q9 before S10; the rest at their stage. **Counsel** (Q4) before S9's option B.
- Tests: a unit test of the inventory on the emulator (counts by prefix, no writes).
- Docs: this file (the figures go into "Weight").
- **As built:** `scripts/migrate/docs_inventory.py` reaches Firestore and Storage only through two read-only wrappers (`ReadOnlyDb`: stream a collection; `ReadOnlyBucket`: list names and sizes), so no write call exists on what it holds. Per firm it prints one JSON report and then a `TOTAL` line: `form101` (signed / unsigned / unreferenced: a file no record points at, such as an earlier unsigned Form 101), `docs` (signed contracts / other uploads), `signCopies` by request status (`unknown`: no request with that id), `pages`, `signature`, `signatureOrphans`, `assets`, `templates` (files under `contracts/`, records, deleted records), `deletedWorkerFiles` (files under a worker id with no record), `otherWorkerFiles`, `outsideFiles`, `workers` (`signed`, `onSidecar`, `pdfOnly`, with their ids, cut at 50) and `requests` (by status, `notApplied`: signed with no `appliedAt`, with their ids). A file is signed when a signing request's part points at it, or (Form 101) it is the `docFileId` of a worker with `signedAt`, or (contract) a `docs[]` entry with `signed: true`. `migrate-docs.yml` (manual, `task: inventory`, optional `tenant`) runs it with the deploy's service account. Tests: `tests/auth/test_migrate_docs_inventory.py` — the counts by prefix on the Firestore emulator (every document unchanged after the run, update times included) and on stand-ins whose every write method fails, the wrappers expose no write method, and the script's source calls none.
- Status: **done** (with S0b and S2 in one PR): the script, the workflow and the test. Not yet run against the real project: the figures and the owner's answers are still to come.

### S0b — stop deleting signed files (never reverted)
Keeping the files is the safe default, so this does not wait for Q2.
- `adoptSigned` deletes nothing.
- `removeDocs` refuses entries with `signed: true`.
- `deleteWorkerNow` skips the signed files (`docFileId` of a signed worker, signed `docs[]`, the signature of a signed worker).
- `deleteWorkerDoc` refuses a path that is any `signRequests` `parts.*.path`, or the `docFileId` / `docs[].fileId` of a signed worker. One check covers every browser path that reaches it: `pages.ts:119/128`, `adoptSigned`, `deleteWorkerNow`, the worker-delete loop (`bridge.ts:202`), `removeDocs` and the replaced upload (`uploadWorkerFile`'s `previousFileId`, `api.ts:52`).
- `supplierDeleteWorker` refuses a signed worker (`signedAt` / `signedRequestId`).
- Tests: `test_files.py` (`deleteWorkerDoc` refuses each kind of signed path, an unsigned path still deletes); `test_portal.py` (a signed worker cannot be deleted by the supplier); e2e: removing a signed document leaves it, and Delete worker leaves its signed files.
- Docs: docs/contracts.md (signed files are kept), docs/workers.md, docs/portals.md, docs/history.md (why the 2026-10-20 "no archive" deletes stopped).
- Status: **done** (with S0 and S2 in one PR); then narrowed by the owner (2026-10-25): a signed file is never deleted **on its own** (a newer file over it, a rescan, a new signing), but a person's own delete — Remove, Delete worker, a supplier's Delete — removes it (`manual: true`; docs/contracts.md → Signed files are kept). The check is `signed_file` in `functions-auth/files.py`, fed by `signed_lookup` in `functions-auth/main.py`; it also refuses a signing's signature (`sigPath`), a signed worker's `sigFileId`, and the parts of the `transferRequests` that made a worker; without a lookup `deleteWorkerDoc` deletes nothing (docs/contracts.md → Signed files are kept).

### S1 — a builder that gives the same bytes every time (old documents untouched)
- **New folder `functions/builders/`:**
  - `__init__.py`: `BUILDER_VERSION = "b1"` and a registry of builders by version.
  - `form101_b1.py`: `Form101Builder` and `build_form101_pdf`, taken out of `functions/main.py`, **with a copy of every helper it runs** (`_shrink_for_embed`, `_draw_extra_page_image`, the font and bidi code). `main.py` imports them, and `fill_form_101` keeps its URL and its answer.
  - `contract_b1.py`: **a copy of `contracts.fill` and its helpers** (`_font`, the marks), not a wrapper, so a later edit of `contracts.py` (S3) cannot change b1's bytes.
  - `sheets_b1.py`: the A4 ID sheet (below), frozen like the others. The bundle's own layout may change later without touching it.
  - A later builder is a new file (`*_b2.py`). Frozen files are never edited. The guard is the golden **output** hashes (below), which cover the Form 101, the contract fill and the sheet; a file-hash test is only a second tripwire.
  - CLAUDE.md's duplicated-on-purpose list gets the frozen copies (`contracts.fill` → `contract_b1.py`, the Form 101 helpers → `form101_b1.py`), next to `MARKS`.
- **Fixed save:**
  - `finalize()` (main.py:195) and the frozen contract save use `tobytes(..., no_new_id=True)`.
  - The trailer `/ID` is set from the first 16 bytes of the input manifest's SHA-256.
  - **Font subsets named from the manifest:** `doc.subset_fonts()` (`contracts.py:212/355`) names each subset with `random.choices(..., k=6)` (PyMuPDF), so two builds differ. The frozen builder replaces the subset prefix with one derived from the manifest hash (or seeds a local `random.Random` around the call). Tested with a real template, a picture template and a signature.
- **Inputs instead of the clock:**
  - the tax year comes from `p["taxYear"]`, else the year of `signDate`, and only then today (replaces `date.today().year`, main.py:336);
  - the contract's `today` mark comes from the caller.
- **Strict mode:**
  - `build_form101_pdf(p, strict=True)` raises when the signature or a page cannot be placed. This replaces the bare `except: pass` at main.py:459–505. Signing and rebuilds use strict mode.
  - The unsigned preview stays lenient but reports `dropped: n` (an `X-Dropped` header).
- **Photos embedded as they are:** a stored page that is already a JPEG of at most 2000 px goes in with its original bytes (`insert_image(stream=jpeg)`, a DCT passthrough). `_shrink_for_embed` runs only for other formats. This takes Pillow out of the pages' byte chain; **the signature PNG still goes through Pillow** (`_shrink_for_embed`, main.py:464), so Pillow stays pinned as part of the chain.
- **The ID sheet by kind, not by position** (replaces main.py:487–498). `extraPages` items get an optional `kind`; without it, the old positional rule applies.
  - One A4 holds `id_front` and `id_back` side by side at the top and `sefach` below. A missing ספח leaves its box empty, with a Hebrew caption saying it is missing.
  - A `passport` goes on the top half of a page.
  - Each `other` page gets its own page.
  - The layout itself is Q7 (answered: the document — ID card or passport — and the ספח on one sheet).
- **Pinned libraries:**
  - a separate lock file `functions/requirements.lock` holds the full resolved set (`pip freeze` on Python 3.12, with `--require-hashes`): pymupdf, python-bidi, Pillow, fontTools (needed by `subset_fonts`), firebase-admin, firebase-functions, huggingface_hub and every dependency; `functions/requirements.txt` installs from it.
  - A test reads `pymupdf.VersionBind` and the locked versions and fails if they change without a new builder version.
  - The CI test venv (`tests.yml:128`) installs `-r functions/requirements.lock` instead of unpinned pymupdf / Pillow / python-bidi, and the pip cache key (`tests.yml:123`) hashes that file too.
- **Production self-check:** `fill_form_101` gets a `{ping, selftest}` that builds a fixed input and returns its sha256; after each deploy CI compares it with `builder_golden.json` (CI's ubuntu runner is not the Cloud Functions python312 image), so a mismatch is found before S4's shadow check.
- **Templates and the font versioned:**
  - `functions/assets/form101/v1.pdf` (the current file, moved there).
  - `FORM101_TEMPLATES = {"v1": sha256}` and `FONT_SHA256`, both checked at import.
  - The move's other readers follow: `test_form101_template.py`, `scripts/scan-train/gen/pages.py:212`, `tests/auth/test_scan_train_scene.py:532`, docs/scan-training.md, and CLAUDE.md ("keep this map in sync with `functions/main.py`", "`functions/assets/` holds the PDF template and font — the only copies").
  - `tests/e2e/server.py:39` loads `functions/main.py` with `spec_from_file_location`; it puts `functions/` on `sys.path` so `import builders` works.
- **`fill_form_101` gets the settings of the other PDF functions:** 1 GiB and `cpu=1`, as `contract_templates` and `sign_documents` have (main.py:872/903), and the `{ping}` it already has. Today it has 512 MB and no cpu setting (main.py:556).
- **The input manifest:** `builders/manifest.py` writes canonical JSON (sorted keys, no spaces, UTF-8) and hashes it. It is used from S4 on, and tested here.
- Tests:
  - `tests/auth/test_builder_determinism.py`:
    - two builds in two processes give the same SHA-256, for the Form 101, the contract fill (a text template, a picture template, with a signature) and the sheet;
    - the output hashes match `tests/auth/builder_golden.json`, pinned to the CI image (Python 3.12; golden hashes come from CI only, never from the local 3.14 venv);
    - strict mode raises on a broken page;
    - the sheet goes by kind;
    - the manifest is canonical (key order and whitespace do not change the hash);
    - the locked versions match.
  - `test_form101_build.py` is updated.
  - The e2e `fill_form_101` mock is unchanged.
- Docs:
  - docs/form101.md: the builders, strict mode, `taxYear`, the layout by kind, the function's settings, the self-check.
  - docs/form101-field-map.md: the template path, and which builder version the mapped section describes (b1 can no longer be edited; a field change is a new builder).
  - docs/backend.md: the lock file and the golden file.
  - docs/tests.md: the CI venv now installs from the lock.
- Rollback: revert the PR. No data has changed.
- Status: not started.

### S2 — "Download data" with the picker and one A4 ID sheet (the owner's visible win, no data change)
- **New HTTP function `worker_docs`** in `functions/main.py`:
  - europe-west3, 1 GiB, `cpu=1`, `{ping}`, 120 s;
  - **`concurrency=4`**, deliberately not 20: each build holds every page in memory. This differs from the parallel-AI rule, and the reason is written in docs/backend.md.
  - It answers raw `application/pdf`, not base64 JSON (a third smaller, and further from the 32 MiB response cap), with `X-Pages` / `X-Parts` / `X-Dropped` exposed through CORS.
  - Firm isolation:
    - the gate's claims: a tenant member with the Workers right; an own-workers HR only when `worker.hrId == uid`; the super-admin with `asTenantId` (S3's archive step needs it);
    - supplier and client logins and the worker token are refused;
    - every Storage path read must start with `tenants/<t>/workers/<w>/`;
    - **a contract may hold pay unless shown otherwise:** the `signRequests` doc whose `parts.contract.path == fileId` gives `printPay`; when none is found (a legacy entry, a manually uploaded or scanned contract), the contract counts as holding pay and needs `may_see_pay`.
- **The Form 101 values come from the client.** Nothing in `functions/` turns a worker record and the firm profile into the Form 101 payload; `form101Payload` (`src/manager/logic/form101.ts`) builds it in the browser, as `signing.send` and `fill_form_101` receive it today. So the client sends `form101Payload(...)` with the `bundle` and `form101` calls (no photos: the server reads the pages). A Python port is not made (it would be one more duplicated copy).
- **Action `bundle {workerId, include: {form101, contract, scans, docs}, form101}`:**
  1. The summary page, always first (`_summary_page`, unchanged, no pay).
  2. Form 101, in one of three forms:
     - an unsigned worker: a preview built from the sent payload, the current `scanPages` and the firm profile, **without its attached scans when `scans` is also picked**, so the photos appear once;
     - a legacy signed worker: the stored copy, whole (a legal copy is never trimmed);
     - after S4: the signed copy of the new scheme.
  3. The contract, signed first, with the pay rule above.
  4. The scans: the S1 A4 sheet (`id_front` + `id_back` + `sefach`, or `passport`), then each `other` page. When a legacy stored Form 101 is included, it already holds the photos, so the separate ID sheet is skipped unless the user picked only `scans`. The picker says so.
  5. The other `docs[]`.
  - Pages are read from Storage in parallel (a thread pool).
  - A total size cap (25 MiB) gives a clear error.
  - The bundle is never stored.
- **An unsigned preview never carries a signing's signature.** After `adoptSigned` (and in transfer) `sigFileId` is the signing's own signature PNG. A server-built unsigned preview embeds no signature from a signing: at most a signature captured from a scan, and only for a worker with no signed set. Every unsigned preview carries a visible Hebrew mark "טיוטה — לא נחתם" (preview, not signed), and the builder fills no `signDate` into it.
- **Action `form101 {workerId, form101}`:** the unsigned preview alone. The client no longer has to send photos for a preview.
- **`signing.bundle`** stays until S10 for an old device, and calls the new builder code (the sheet, the captions) instead of keeping its own, so `HE_KINDS` / `HE_DOC_TYPES` and the sheet stay one copy.
- **Client:**
  - A new React window `src/manager/DownloadData.tsx`, opened from the worker card (`WorkerCard.tsx:189`), replaces the direct `signing.bundle` call.
  - Built from `Window` + `CheckGrid` / `CheckTile`: Form 101, Contract, ID and scans, Other documents.
  - A tile is greyed out when nothing stands behind it.
  - The default selection (Q8, answered): Form 101 and the ID sheet ticked, the contract and the other documents not; the summary page always first, with no tick. The last choice is remembered in localStorage, wrapped in try/catch.
  - A bridge action fetches the PDF as a blob → `openPdf`.
  - `WORKER_DOCS_FN_URL` in `src/manager/logic/functions.ts`, warmed with `{ping}` when the worker card opens.
- **The e2e mock** `tests/e2e/server.py` gets a `worker_docs` route.
- Tests:
  - `tests/auth/test_worker_docs.py`:
    - the rights matrix: admin, the super-admin with `asTenantId`, staff with and without Workers, own and other HR, supplier, client and the worker token refused;
    - every subset of `include`, with page order and count;
    - one ID sheet, and the photos appear once;
    - a legacy signed worker's stored Form 101 is served whole;
    - no pay without the right, for a contract with `printPay` and for one with no request behind it;
    - an unsigned preview has the preview mark and no signing's signature;
    - a path escape is refused;
    - the size cap.
  - `test_signing.py:165` (the bundle order) moves here.
  - e2e: the window, its ticks and the page count of the result.
- Docs:
  - docs/workers.md: Download data.
  - docs/backend.md: `worker_docs` and its settings.
  - docs/components.md: only if a shared piece is added.
  - CLAUDE.md "Files": `functions/` names `worker_docs`.
- Rollback: revert. No data has changed.
- Status: **done** (with S0 and S0b in one PR). Built ahead of S1, so: the ID sheet is `functions/idsheet.py`, shared by `worker_docs` and the old `signing.bundle` (S1 freezes its copy for the signed documents); the preview is the current `build_form101_pdf` with no pages of its own (the sheet and the other pages are added after it), marked on every form page; `HE_KINDS` / `HE_DOC_TYPES` and the summary page moved to `idsheet.py` / `workerdocs.py`. Choices where this stage left one: a file path outside the worker's folder, or a stored file that cannot be read, is skipped and counted in `X-Dropped` rather than failing the whole bundle; a contract left out for pay is reported in an extra exposed header `X-Withheld` (and a toast), and the file name in `X-Name`; a signed worker whose signed copy is not found gets no Form 101 (never a preview in its place); for a worker still on a sidecar, the sidecar's first picture is the document and the rest are other pages; a passport worker gets no empty ספח box; the old `signing.bundle` now applies the pay rule too and leaves the scans out when the stored Form 101 is in it.

### S3 — contract templates versioned and never overwritten
- **Data model:** a new subcollection `tenants/<t>/contractTemplates/<tid>/versions/<n>` = `{fileId: tenants/<t>/contracts/<tid>/v<n>.pdf, sha256, size, pages, placed, marks, unknown, pictures, createdAt, createdBy}`.
  - It is written once by the server and never changed: `<n>` is allocated in a transaction with `create()`, and the file is uploaded with `if_generation_match=0`, so two concurrent saves cannot collide.
  - `firestore.rules` gives clients no access to it, the same as the template record.
  - The template record keeps `version` and `fileId` (the current ones), so its readers do not change.
- **`contracts.run`:**
  - **Save with `replaceId`** (contracts.py:536–560) writes the new version's record and file and **no longer deletes the old file** (556–560).
  - **Delete** (594–612) becomes a soft delete: `deletedAt`, `isDefault: false`, instead of the file delete and `ref.delete()` (596–600). The existing `deletedAt` filters then take effect (contracts.py:470/481/539, signing.py:262, transfer.py:113), and Admin hides deleted templates.
  - A version file is hard-deleted only when no kept `signRequests` doc refers to it (a check at delete time, plus a sweep in S10).
  - **`signedCount`** is incremented in `signing.build` when a contract part is made. Today it never changes.
- **Firm deletion** (`delete_tenant_files`) would wipe the template versions and the signing inputs together with the firm. Until Q9 is answered, Delete firm first lists the firm's signed documents and offers an archive download: **a zip of the original signed files (byte for byte), each signing's manifest and its locked inputs, with a hash listing** — not a merged bundle, whose bytes would no longer match any hash. The super-admin confirms the deletion only after that. After S3b, `delete_tenant_files` stops at held objects unless the super-admin gives an explicit override, which is logged. It also refuses while an in-flight transfer request (asked, not yet copied) of another firm reads this firm's pages.
- **One-off `scripts/migrate/template_versions.py`** (dry-run / apply, in `migrate-docs.yml`) writes `versions/<current>` with its sha256 for every existing template. Older versions' files are already gone; for those, the `sign/<rid>/` copies remain the record.
- Tests:
  - `tests/auth/test_contracts.py`:
    - a replace keeps v1's file and adds v2;
    - two concurrent saves get two versions;
    - a delete is soft, and a deleted template cannot be sent;
    - a version that a request refers to is never hard-deleted;
    - the backfill is idempotent.
  - `tests/auth/test_core.py`: `deleteTenant` with and without the archive step, the override logged.
  - e2e: Firms → Delete firm shows the archive step before the confirm.
- Docs:
  - docs/contracts.md: templates, versions, soft delete.
  - docs/admin.md: Delete firm's archive step.
- Rollback: revert the code. The extra version records and kept files are harmless.
- Status: not started.

### S3b — the locks (temporary holds), before any signing depends on them (never reverted)
Shipped on its own, before S4, so reverting S4 can never take the lock enforcement with it.
- **One small helper** `hold(blob, rid, worker)` / `release(blob, rid)`, duplicated on purpose in `functions/` and `functions-auth/` (added to CLAUDE.md's list): sets `temporary_hold`, adds `lock_<rid>=1`, stamps `hrId` from the worker. It reads the object with `bucket.get_blob()` (a bare `bucket.blob(path).metadata` is `None` until `reload()`), and **fails closed**: when the state cannot be read, the caller treats the object as locked. `release` removes only its own key and lifts the hold only when no `lock_*` key is left.
- **`signing.build`** holds each part it stores.
- **A one-off backfill** `scripts/migrate/hold_signed.py` (dry-run / apply, in `migrate-docs.yml`) holds every existing `signRequests` `parts.*.path`, every signed worker's `docFileId` and signed `docs[].fileId`, and the signature of every signed worker. It runs before any cleanup script (S7, S10) exists.
- **Every delete path stops at a hold.** GCS refuses the delete itself; each path turns that into a clear answer instead of an error:
  - `deleteWorkerDoc` (covers every browser path, listed in S0b);
  - `delete_tenant_files` (S3's override);
  - `src/manager/data/pages.ts` (119, 128): a rescan keeps a replaced file that is held;
  - `functions/transfer.py` `_copy`: copies, never deletes;
  - `contracts.run` delete (S3);
  - `scripts/migrate/scan_pages.py` cleanup, and the later `unsigned_docs.py` and `sign_copies.py`.
- `storage.rules` also refuses a browser update or delete of an object with any `lock_*` metadata (defence in depth; managers can still read it).
- Tests: `test_files.py` (a held path is refused, an unheld one deletes); a helper test that a second request's lock survives the first's release, and that an unreadable object counts as locked; `tests/rules/` (a browser cannot update or delete a locked object); the backfill's dry-run and idempotence.
- Docs: docs/contracts.md (the locks), docs/backend.md, docs/hr.md (the `hrId` stamp on locked files), CLAUDE.md (the duplicated helper).
- Status: not started.

### S4 — a frozen snapshot at signing, the input manifest, the signed PDF still stored (shadow mode)
- **On `signRequests/<rid>`** (server-only):
  - **At `send`:**
    - `templateFile` = the version's `fileId`, plus `templateSha256`;
    - **the copy to `sign/<rid>/contract-template.pdf` stops** (signing.py:265–266), and `templatePath = templateFile` is written for old code;
    - `snapshot.pages = [{fileId, kind, sha256}]` from the worker's `scanPages` at send time;
    - `snapshot.form101Template = "v1"`, `snapshot.builder = BUILDER_VERSION`;
    - the cleaned `form101` already freezes the employer block.
  - **At `sign`, in this order:**
    1. `snapshot.today`, and `signDate` (always fixed now); `snapshot.taxYear` from that final `signDate` (a form sent on 28/12 and signed on 02/01 prints the new year);
    2. `sigPath` and `sigSha256`;
    3. the snapshot pages and the signature are **held first** (S3b's helper);
    4. then every snapshot page is re-checked: it exists and its sha256 matches. A page that changed or vanished between `send` and `sign` refuses the signing with `E_DOCS_CHANGED` (the holds of this request are released), and the request must be sent again. This closes the gap where `view` and `build` read different pages;
    5. the manifest is written as `sign/<rid>/manifest.json` (`if_generation_match=0`), held, and its hash is stored as `manifestSha256`.
  - **At `build`:**
    - the frozen builder runs on the inputs read from the manifest file, in strict mode; **whenever a snapshot exists, the pages come from `snapshot.pages`, never from the live `scanPages`**;
    - the PDF is stored at `sign/<rid>/<which>.pdf` with `if_generation_match=0`; a losing double build returns the part already there;
    - the part is held;
    - `parts.<which> = {path, name, size, sha256, builder}`.
- **Shadow check:** every view or bundle of a new-scheme signed part rebuilds it and compares hashes. A mismatch is logged (Admin → Errors, `kind: signedRebuildMismatch`), and the **stored** bytes are served.
- **`E_DOCS_CHANGED` on both screens:** the worker's page (`src/punch/Documents.tsx`, `src/punch/sign.ts`) and the manager's `SignWindow.tsx` show it through `tr()`, with a Hebrew entry.
- `src/manager/page/form101.ts`: `keep.sig` / `keep.others` keep working, since the paths do not change.
- Tests:
  - `test_signing.py`:
    - no `sign/<rid>/` copy, and `templateFile` is a version file (a new assertion: no test checks the copy today);
    - the snapshot and the manifest file are complete, and `manifestSha256` is the hash of the stored file;
    - the pages, the signature, the manifest and the parts get held;
    - a page changed or deleted after `send` gives `E_DOCS_CHANGED`;
    - `taxYear` follows the final `signDate`;
    - a double `build` stores one part;
    - `parts.sha256` equals the stored bytes and a rebuild.
  - e2e 1517–1607 are updated: the copy check at `main.test.js:1523` (`/\/sign\//.test(templatePath)`) now expects a version file, and the pages still show; a punch-page case shows `E_DOCS_CHANGED`.
- Docs:
  - docs/contracts.md: the snapshot, the manifest, the shadow check.
  - docs/backend.md: the data model.
- Rollback: revert the code. Requests that already hold a snapshot keep working, because `templatePath` is still written. The holds stay (S3b is not reverted).
- Status: not started.

### S5 — the server writes the signed fields; the UI reads status from data; downloads go through `worker_docs`
- **Server:**
  - When both parts exist, `signing.build` writes the worker's fields with a field update:
    - `signedAt`, `signDate`, `signedRequestId`, `signedPrint`, `signedPrintPay`, `signedPrintMarks`, `sigFileId`;
    - `signed: {requestId, at, date, scheme: 2, builder, manifestSha256, form101Sha256, contractSha256}`;
    - the `docs[]` contract entry `{signed, templateId, templateVersion, signRequestId, sha256}`, with **no `url`**.
  - A legacy signed set keeps its `fileId` / `url`.
  - **The legacy requests move to the server:** before the rule below lands, a one-off script (and `signing.build` from then on) applies every built legacy request that has no `appliedAt`, the way `adoptSigned` does but deleting nothing. `adoptSigned` (`src/manager/logic/signing.ts:63–94`) stops writing from the browser.
- **`worker_docs` gets two more actions:**
  - `signed {workerId, requestId, which}`:
    - the new scheme: a rebuild checked against `parts.sha256`, or the stored copy while one exists;
    - legacy (`parts.path` or `docFileId` with no snapshot): the stored file.
  - `file {workerId, fileId}`: streams one `docs[]` file of this worker, replacing its token `url`.
  - The worker page reaches its signed parts only through `signing.view` (the same rebuild and check).
- **Client:**
  - `workerDocStatus` (`src/manager/logic/workers.ts:78–98`) reads data instead of `docUrl`, `docHasSignature` and `docExtraPages`:
    - "Form 101" is complete when the Form 101 fields, the primary `scanPages` page (or an `assetsFileId` sidecar) and the signature exist (new `form101Ready(w)`);
    - "signature" is `!!w.sigFileId`, or a sidecar (`assetsFileId`), so a worker still on a sidecar is not flagged before S7;
    - "ספח" is missing when an Israeli ID worker has no `scanPages` page of kind `sefach` (and no sidecar).
  - These read through `worker_docs` (a bridge action `openWorkerPdf(kind)`): `WorkerCard.tsx:188` and `:124` (the docs pane's Open), `Workers.tsx:175`, `WorkerEditor.tsx:471/489/495` and `page/bridge.ts:187`.
  - `WorkerCard.tsx:230` (the Rescan / Scan document label) keys on the scan pages instead of `docUrl`.
  - "Saved:" (`WorkerCard.tsx:215/229`) shows `sigSavedAt` or the latest `scanPages.savedAt`.
  - The `WorkerEditor.tsx:495` hint (the stored document updates itself) is reworded to "the PDF is built when you open it", with its Hebrew entry.
  - **`saveSchedule` writes the server's signed fields, not the device's copy** (`src/lib/firestore-backend.ts`): before each worker `set`, it copies `signedAt`, `signDate`, `signedRequestId`, `signed`, `signedPrint`, `signedPrintPay`, `signedPrintMarks` from the stored doc, the way `CLIENT_PAY` is handled (349–358). A manager who has the worker open or edited while it is signed remotely (the listener keeps unsaved edits, line 429) then saves without dropping them.
- **Firestore rules** (126–138): a browser update of a worker may not change `signedAt`, `signDate`, `signedRequestId`, `signed`, `signedPrint`, `signedPrintPay` or `signedPrintMarks` (listed by name; `diff().affectedKeys()`). A write that leaves them equal to the stored values passes.
  - A current device passes because `saveSchedule` copies them from the stored doc.
  - An old device that sends stale signed values is refused, and its whole batch with it; the version bar forces its reload. This window is short because the legacy apply moves to the server first.
  - It is checked on the emulator with a whole-document `set` from an old snapshot.
- Tests:
  - `test_worker_docs.py`:
    - `signed`: a legacy file is served as stored, and a new part matches its hash;
    - `file`: the rights matrix and path escapes.
  - The legacy-apply script: applies, deletes nothing, idempotent.
  - A unit test of `form101Ready` / `workerDocStatus` (scan pages, sidecar, passport, missing ספח).
  - `tests/rules`: the signed fields are immutable from the browser, the other fields still save, and an equal value passes.
  - e2e:
    - the notices come from data;
    - Download document returns a PDF without `docUrl`;
    - a worker edited while the server signs it saves, and keeps its signed fields;
    - suppliers and clients still get nothing (2851, 3025 kept).
  - `test_portal.py` is unchanged.
- Docs:
  - docs/workers.md: status from data, downloads.
  - docs/portals.md: the no-links rule now also holds in the endpoint.
  - docs/hr.md, docs/backend.md (`saveSchedule`'s copied fields).
  - docs/contracts.md: the server writes the signed state.
- Rollback: revert. `docUrl` is still written for unsigned workers until S6.
- Status: not started.

### S6 — stop storing the unsigned Form 101
- **`aiFillForm101`** (`src/manager/page/form101.ts`):
  - keeps reading the scan and saving the pages and the signature (`saveScanPages`);
  - no longer calls `FORM101_FN_URL` or uploads a PDF;
  - the `docUrl` / `docFileId` / `docSavedAt` / `docHasSignature` / `docExtraPages` / `docUploadFailed` writes are removed (170–177, 190).
- **Removed:** `regenerateWorkerDoc`, `regenerateAllWorkerDocs`, `maybeRegenAfterFirmEdit` and their callers:
  - the `regenerateDoc` call (`worker-save.ts:99–101`), `WorkerCard.tsx:79`, `page/admin.ts:142`, `page/wiring.ts:55`;
  - the `form101Regen:*` localStorage keys;
  - `FORM101_WATCHED` too, unless something else still uses it.
- **Kept, slimmed:** the `api.uploadForm101` calls at `worker-save.ts:92` (rescan) and `:113` (new worker) save only the pages and the signature; their "Building the PDF, please do not close…" progress text (91, 112) is removed.
- **`fill_form_101` is retired from the client:** nothing calls it after this stage (the preview is `worker_docs` `form101`). It answers `{error: "E_RELOAD"}` to every call but `{ping}` / `{ping, selftest}`, so an old device fails loudly; it is removed in S10. `FORM101_FN_URL` leaves `SCAN_WARM_URLS` (`logic/functions.ts:21`), `globals.ts:92` and the save warm-up (`worker-window.ts:163`).
- **`storage.rules`** refuses a browser create under `tenants/{t}/workers/{w}/form101/**`.
- **`saveScanContract`** (Q6): the scanned contract photos become `scanPages` of kind `contract` instead of a client-built PDF in `docs[]`. This can be deferred.
- Tests:
  - e2e 1400–1452 are rewritten: a rescan stores the pages and the signature, no `docFileId` appears, and the editor's status comes from data. The e2e worker fixture (`tests/e2e/server.py:101`) loses its `docUrl` / `docFileId`.
  - `fill_form_101` answers `E_RELOAD` to a build call and still answers `{ping}`.
  - `tests/rules`: a browser create under `form101/` is refused.
  - A small grep check under `tests/build/` (run with the build check): no `regenerateWorkerDoc` / `regenerateAllWorkerDocs` / `form101Regen:` left in `src/`.
- Docs: docs/form101.md (no stored unsigned PDF), docs/workers.md, docs/app-core.md (uploads, the warm-ups).
- Rollback: revert the client and the rule. The builder and the endpoint still exist.
- Status: not started.

### S7 — migrate the existing unsigned `docUrl` (data; the owner's yes for each step)
- **Preconditions:**
  - S6 is deployed and every manager device has reloaded;
  - S3b's backfill has run (every signed file is held);
  - the `scan_pages.py` dry-run reports no sidecar workers, or this script skips them and lists them.
- **`scripts/migrate/unsigned_docs.py`** in `migrate-docs.yml` (dry-run / apply / cleanup / restore, with an optional `tenant`).
- **Selection:** workers with `docFileId` and **without** `signedAt` or `signed`, whose `docFileId` is not the `parts.form101.path` of any `signRequests` doc (a guard against a legacy signed file), and not held. **Skipped and listed:** workers with no `scanPages` and no `assetsFileId`, whose photos and signature may exist only inside that PDF, until their images are extracted into `scanPages` and the signature (an extract step of this script, on the owner's yes).
- **dry-run:** for each firm, the count, the bytes and the exceptions.
- **apply:**
  - writes `tenants/<t>/migrations/unsignedDoc_<w>` = `{docFileId, docUrl, size, downloadTokens, at}`;
  - a field update deletes `docUrl`, `docFileId`, `docSavedAt`, `docHasSignature`, `docExtraPages` and `docUploadFailed`, and sets `docScheme: 2`;
  - strips `firebaseStorageDownloadTokens` from the file, so the old links stop working at once;
  - the file is kept;
  - running it again repairs fields that a stale whole-document save put back.
- **cleanup:** deletes the file only when the worker still has no `docFileId` and the record matches.
- **restore** (before cleanup): writes the fields back from the records, and puts the saved `firebaseStorageDownloadTokens` value back on the file, so the restored `docUrl` works.
- Signed legacy workers are never touched.
- Tests: `tests/auth/test_migrate_unsigned_docs.py`, modelled on `test_migrate_pages.py`:
  - the selection, with signed, held and photo-less workers skipped;
  - idempotence and the stale-save repair;
  - the token strip, and restore putting the token back;
  - the cleanup guard.
- Docs: docs/form101.md (the migration section), docs/history.md.
- Rollback: `restore`. After cleanup, the preview is still built on request, so nothing is lost.
- Status: not started.

### S8 — transfer (D6) on the new scheme
- **`functions/transfer.py`:**
  - At ask time it freezes the new firm's default template **version** (`templateFile`, `templateVersion`, `templateSha256`), the profile, `start` and the page snapshot with each page's sha256. View and build no longer read the live template (164–179). The tax year is frozen at `sign`, from the final `signDate` (as S4).
  - **The pages are copied at ask time, not at build:** today the build reads the old firm's live `scanPages`, which the old firm can rescan or delete before the copy is made. The snapshot pages are copied into the new firm's worker (`tenants/<toTenant>/workers/<new_id>/pages/`) and held there before the worker signs, and view and build read only those copies.
  - The manifest and the holds follow S4. The signature is already written under the new firm (`transfer.py:223–224`), and so are both parts.
  - `_copy` (262–291) uses the copied pages and writes `signed{…}` and the `docs[]` entry with `templateId`, `templateVersion` and `signRequestId`, and **no `_download_url` tokens**.
- Tests:
  - `test_transfer.py` 141–143: a frozen version, no token, the pages copied and held at ask time, a rescan in the old firm after asking changes nothing;
  - e2e 1635/1654.
- Docs: docs/contracts.md D6.
- Status: not started.

### S9 — slim signed copies; then, only with counsel's and the owner's yes, no signed PDF at all
- **S9a, the default (Q1 option A), brings `form101_b2`:** a changed output is a new builder version.
  - For signings made under b2, the view at signing is already slim: the two form pages with the signature, and the pages shown after it as separate S1 sheets, so the worker signs exactly what is stored. About 140 KB.
  - The filled contract is stored as now.
  - The photos then live once, held, with their hashes in the manifest.
  - The bundle and the worker page put the held pages after the slim copy, in the S1 sheet layout.
  - Signings made under b1 keep their full stored copy.
- **S9b, option B, store no signed PDF.** It needs all of these gates:
  - **counsel's answer** (Q4) that a rebuilt PDF counts as the signed original under the Electronic Signature Law 2001 and the Tax Authority's conditions for a digital Form 101;
  - the S4 shadow check has logged zero mismatches for N weeks (Q1);
  - a library bump policy, chosen by the owner:
    - **(i) materialize, then bump:** before any pin change, every new-scheme signing is rebuilt on the old pins, and a held PDF is stored for any whose hash would change. This is cheaper and needs no new service.
    - **(ii) a frozen builder service:** `services/pdf-builder/`, Cloud Run deployed by image digest, with `BUILDER_VERSION` → digest in `functions/builders/registry.json` and old images kept.

  Then `build` stores no PDF: `parts.<which> = {sha256, size, name, builder}`. A view rebuilds and serves only on a hash match. On a mismatch the user gets an error, and the manifest still proves the inputs. The flag `appConfig/signedStore = true` turns storing back on.
- **CI tripwire, both options:** the golden output hashes on python312 (S1) and the production self-check fail any unannounced library change.
- Tests:
  - the slim copy has two pages, the view at signing equals the stored copy, and the bundle shows the photos once;
  - S9b: a rebuild matches the golden hash, a mismatch is refused, and the materialize script (or the service image) passes the determinism test.
- Docs: docs/contracts.md, docs/backend.md, docs/history.md.
- Status: not started.

### S10 — deletion and cleanup
- **Deleting a worker moves to the server:** `users_admin deleteWorker` replaces the loop of client deletes in `src/manager/page/worker-window.ts:224–233` (which already deletes each file through `deleteWorkerDoc`, one call per file). It removes the worker's unsigned files and old unheld signatures in one call, with the HR scope.
  - **Until Q4 is answered, the default is to keep** every signed request, its manifest, its inputs and its template version: they stay with `deletedWorker: true` and a lifecycle date. A worker's `signRequests` are the only place a signing's snapshot lives, so they are never deleted with a signed worker.
  - `supplierDeleteWorker` goes through the same server delete.
  - `firestore.rules`: a browser cannot delete a worker that has `signed` / `signedAt` (the `saveSchedule` delete of a missing worker, line 344, is refused for it).
- **One-off `scripts/migrate/sign_copies.py`** (dry-run / apply):
  - deletes only the exact path `tenants/<t>/workers/<w>/sign/<rid>/contract-template.pdf`, matched by pattern and never read from a stored field (from S4 on, `req.templatePath` points at the shared version file), and only for requests that are `replaced` or `withdrawn`, or `signed` with a stored contract part (the signed PDF is the record there);
  - keeps the rest;
  - lists, and on cleanup deletes, signature PNGs that no record refers to and that are not held;
  - sweeps template version files that no **kept** request refers to.
- **Removed:** the old `signing.bundle`; `fill_form_101`'s build path; `adoptSigned`, once the dry-run finds no legacy request without `appliedAt`; and the `form101` upload kind in `uploadWorkerFile`.
- **Q5:** strip the download tokens from the legacy signed files and clear `docUrl` / `docs[].url`, once every reader uses `worker_docs`.
- **The Storage read rule is narrowed** (after Q5): today `match /tenants/{t}/{path=**}` lets any `manager(t)` read every worker file, staff without the Workers right and logins without `seePay` included. Browser reads of worker files then need the Workers right (own HR by its stamp), and `form101/` and `docs/` are read only through `worker_docs`; `pages/` and `signature/` stay readable for those logins (`loadWorkerPages`). Only from here do `worker_docs`' Workers and pay checks really protect anything.
- Tests:
  - `test_core.py` (the `users_admin` tests) / `test_files.py`: the delete scope, the HR scope, the retention flag, held files kept, `signRequests` kept for a signed worker;
  - `test_portal.py`: the supplier delete goes through the server delete;
  - `tests/rules`: a browser cannot delete a signed worker; the narrowed read rule (staff without Workers refused, `docs/` refused from the browser);
  - `test_migrate_sign_copies.py`: only the pattern path is deleted, never a version file.
- Docs:
  - docs/contracts.md, docs/workers.md, docs/tests.md;
  - CLAUDE.md "Files": `services/pdf-builder/` if S9b(ii) is chosen;
  - docs/history.md: why the stored unsigned PDFs and the per-send copies were removed.
- Status: not started.

## Data model when done

- **Worker:**
  - kept:
    - the Form 101 fields;
    - `scanPages[] {fileId, kind, primary, savedAt}` (a signing's pages stay in place, held);
    - `sigFileId`, `sigSavedAt`, `signedAt`, `signDate`, `signedRequestId`, `signedPrint`, `signedPrintPay`, `signedPrintMarks`;
    - `docs[]` (without `url` for new entries);
  - new:
    - `signed {requestId, at, date, scheme, builder, manifestSha256, form101Sha256, contractSha256}`, written by the server and immutable from the browser;
    - `docScheme: 2`;
  - removed for unsigned workers: `docUrl`, `docFileId`, `docSavedAt`, `docHasSignature`, `docExtraPages`, `docUploadFailed`;
  - legacy signed workers keep `docFileId` / `docUrl` and `docs[].fileId` / `url` (the tokens stripped after Q5).
- **Template:** `contractTemplates/<tid>` plus `versions/<n>` (an immutable file, sha256, `placed`, `marks`), with soft delete.
- **signRequest:**
  - `templateFile`, `templateSha256`;
  - `snapshot {pages[{fileId, kind, sha256}], sigPath, sigSha256, taxYear, today, signDate, form101Template, builder}`;
  - `manifestSha256` (the manifest itself is the held file `sign/<rid>/manifest.json`);
  - `parts.<which> {sha256, size, name, builder, path?}`.
- **Storage per worker:**
  - `pages/*.jpg`, once (held when signed);
  - `signature/*.png` (held when signed);
  - `sign/<rid>/manifest.json` and, while stored, `sign/<rid>/<which>.pdf` (held);
  - `docs/*`, the uploaded documents;
  - the slim signed copies (S9a);
  - the legacy `form101/` and `docs/` signed PDFs, kept and held.

## Weight

This is an estimate until S0's inventory (`migrate-docs.yml`, `task: inventory`) is run with the owner's yes; its figures then replace it. Measured builds: an unsigned Form 101 with its scans is 0.2–1.2 MB (198 KB with three small JPEGs, 1.16 MB with three large ones), and 140 KB without pages. The scan pages are about 300–600 KB each, about 1–2 MB per worker.

| Per worker | Today | When done |
|---|---|---|
| Unsigned worker | pages, 1–2 MB, plus the unsigned Form 101, 0.2–1.2 MB | pages only: **saves 15–40%** |
| Signed worker | pages + the unsigned or replaced Form 101, plus the signed Form 101 (0.2–1.2 MB), the contract, and a template copy per send (0.1–1 MB or more each, heavier for picture templates) | pages + a slim Form 101 (about 140 KB) + the contract: **saves roughly 30–50%**, more for workers sent several times |

Each signing send also stops adding a template copy, and each firm profile edit stops re-uploading every unsigned worker's PDF. Keeping signed files that are deleted today (S0b) and the earlier signed sets (Q2) adds back a little.

## Open questions for the owner

- **Q1 — keep a signed PDF at all? — answered (owner, 2026-10-31):** option A, read from the owner's "yes" to the recommended option.
  - **A (recommended):** a small signed copy without the photos (S9a).
  - **B:** only the hashes and the manifest (S9b). This needs counsel and a library bump policy. If B, how many weeks of zero mismatches first?
- **Q2 — keep earlier signed sets when a worker signs again? — answered (owner, 2026-10-31):** kept for Q4's period, held, read from the owner's "yes" (the safe reading: nothing is deleted). The 2026-10-20 rule is "no archive", and `adoptSigned` deletes them today. S0b stops that delete anyway (keeping is the safe default); the question is whether they are later deleted on purpose or kept for Q4's period, held.
- **Q3 — a rescan after signing.** The signed photos stay, held, beside the new ones (two sets of the worker's photos in Storage). Acceptable? **Answered (owner, 2026-10-31):** every screen shows only the new photos (`scanPages`); the old ones stay hidden and held for the retention period, because Q1's slim copy holds no photos and they are the proof of what was signed.
- **Q4 — retention and the legal question — the owner's answers (2026-10-31), checked on the web the same day; no lawyer has seen them:**
  - **Retention: seven years, not the one year first answered** (owner's go after the check): at least seven years from the end of the tax year a document belongs to, or six from the filing of that year's report, whichever is later, counted from the worker's last year (Income Tax bookkeeping instructions, section 25(c)); a wage claim also runs seven years (Limitation Law, section 5). Whether a Form 101 is formally part of the accounting system was not found in a primary source; commercial sources say seven years.
  - **The Tax Authority does have conditions for a digital Form 101** (the rules for 2026, 12 January 2026, no. 2026-000058): a system approved by the Authority; the worker's personal password, entered again before sending; mandatory fields and attachments enforced; the worker's declaration in its set wording; the form locked; the employer's check, then a PDF locked and signed with an approved electronic signature; the worker told and given the signed form; every earlier version kept; an archive that retrieves them. A form not completed this way is defective, which means the maximum tax deduction for the worker. An employer's own system applies at least four months before the end of the tax year before the year of use. Nothing in this repo shows this app registered, and its signature is a drawn PNG: this is open, for the owner (see Risks).
  - A rebuilt PDF that matches its hash counts as the original, no outside timestamp and no copy to the worker, a slim copy is acceptable: the owner's own positions, not checked; the rules above speak of a locked signed PDF kept in the archive, so they are the ground to check before S9. The questions were:
  - how long Form 101 and signed contracts must be kept after a worker leaves or is deleted;
  - the Tax Authority's conditions for a digital Form 101;
  - whether a rebuilt PDF counts as the signed original under the Electronic Signature Law 2001;
  - whether an outside timestamp (RFC 3161) of the manifest hash, or emailing the worker a copy, is needed, since the server writes both the manifest and its hash;
  - whether a slim copy (S9a), whose view at signing shows the pages separately, is acceptable.
- **Q5 — revoke the download links — answered (owner, 2026-10-31): yes,** the links already saved in Firestore (`docUrl`, `docs[].url`) are revoked once every download goes through the server.
- **Q6 — scanned contracts — put off (owner, 2026-10-31): they stay a PDF in `docs[]` for now.** Should the scanned contract photos (`saveScanContract`) become `scanPages` of kind `contract` in S6, or stay a PDF in `docs[]`?
- **Q7 — the ID sheet layout — answered (owner, 2026-10-25):** the worker's document and the ספח on one A4 sheet — the ID card (front, and its back when scanned) or the passport, with the ספח on the same sheet. The exact placement (side by side or stacked) follows the pictures' shapes so each stays readable; a missing ספח leaves its box empty with a Hebrew caption.
- **Q8 — the bundle's default ticks — answered (owner, 2026-10-25):** ticked by default: Form 101 and the ID sheet (the ID card or passport with the ספח); the contract and the other documents unticked. The summary page is always the first page and has no tick of its own.
- **Q9 — deleting a firm — answered (owner, 2026-10-31):** its signed documents and template versions are kept as a preserved archive for Q4's seven years (first answered as up to one year; raised with Q4's retention), then deleted.
- **Q10 — the safety net — put off (owner, 2026-10-31).** It was to come before S3b; S3b does not depend on it technically, but until it is on, a deleted file or record is not recoverable. (Needs the owner's hands in the cloud console.) Turn on bucket soft delete (or object versioning) and Firestore point-in-time recovery or a scheduled export? Before S3b.

## Risks still open

- **An old device's whole-document save after S5–S7.** It is covered by:
  - `saveSchedule` copying the server's signed fields (current devices);
  - the signed-fields rule and the forced reload (old devices);
  - the `form101/` create rule and `E_RELOAD`;
  - rerunning apply.
- **A refused worker fails its whole save batch.** An old device's batch with one refused worker loses every other edit in it until it reloads.
- **Memory and response size of large bundles:** covered by `concurrency=4`, the 25 MiB cap and raw PDF responses.
- **Python 3.14 locally and the ubuntu CI runner against the python312 production image:** golden hashes come only from CI, and the production self-check compares them after each deploy.
- **The signature itself is a drawn PNG plus a server time.** The manifest hash proves the inputs were not changed afterwards. It is not a cryptographic signature (counsel, Q4).
- **The endpoint's rights checks are only as strong as the Storage read rule.** Until S10 narrows it, any manager can read worker files directly with a token link or the SDK.
- **A digital Form 101 without the Tax Authority's approval (found 2026-10-31, Q4).** The rules ask for an approved system and the employer's approved electronic signature; a form that does not meet them counts as defective, with the maximum tax deduction for the worker. Still to settle, with the owner: whether the app's signed Form 101 is used as the digital form at all, and the way out (a form signed by hand, an approved system, or the app's own registration; the Authority also offers to consider easing the locking and signing, rule B3.e).
- **Cold starts:** `min_instances=0`, so the first view after a quiet period takes a few seconds. The app sends `{ping}` warm-ups, as it does for the other functions.
