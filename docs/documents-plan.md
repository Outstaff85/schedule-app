# Workers' documents plan — data kept, PDFs built on request

The plan (owner's request, 2026-10-25; approved in principle, each stage still needs the owner's yes) for keeping each worker's documents as **data** and building the PDFs only when someone opens, downloads or bundles them. The documents as they are today are described in docs/contracts.md (the scanned pages, the signature, the contract templates, signing), docs/form101.md (the Form 101 build) and docs/workers.md (the worker card).

Status: **in progress**. Done: S0 (the inventory, run 2026-11-03), S0b (no signed file deleted on its own), S1 (the frozen builders, then b2), S2 (Download data with the A4 ID sheet), S3 (template versions, merged 2026-11-03, PR #374, with the signed archive made at a person's delete). **The rest of the plan was rewritten on 2026-11-03** after the owner's decisions of that day — see "The plan rewritten on 2026-11-03" below, whose N1–N6 replace the old S3b–S10. Next: N1 (one server delete for a worker, the supplier's too).

## What and why

Today each worker stores heavy PDFs that are built once and kept:

- **The Form 101 in `docUrl` / `docFileId`** (under `workers/<w>/form101/`). Until the worker signs, it is the unsigned Form 101, rebuilt and re-uploaded on every edit of a watched field and on every firm profile edit (`regenerateWorkerDoc`, `regenerateAllWorkerDocs`). After signing, `adoptSigned` points `docUrl` / `docFileId` at the signed Form 101 (`src/manager/logic/signing.ts:76`).
- **The signed Form 101 and the signed contract** (under `form101/` and `docs/`, built by `signing.build`).
- **A copy of the contract template for every signing send** (`workers/<w>/sign/<rid>/contract-template.pdf`). It is never deleted, not even with the worker.

The Form 101 PDFs embed the scan pages (re-encoded JPEGs) that are already stored once in `scanPages`, so a worker's photos are stored two or three times. The "Download data" bundle adds the stored Form 101 and then the photos again, so they appear twice there too. The templates themselves (`functions/assets/form101/v1.pdf`, about 95 KiB; the firms' contract templates) never change per worker.

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

**Changed on 2026-11-03** (see The plan rewritten on 2026-11-03): decisions 2 (the input manifest proves a signing), 4 (a rebuilt signed PDF checked by its hash), 5 (the signing's files locked in place by holds) and the slim copies of decision 1 are **dropped** — a rescan overwrites the pages and a person's delete archives then deletes, so the stored signed PDF is the record and is kept full, for good. Decisions 3, 6, 7, 8, 9, 10 (write-once versions) and 11 still hold.

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

Each stage is one PR from the work branch, with its own checks and a green Tests run. No stage merges without the owner's yes (this plan has no auto-merge exception). Every new UI text goes through `tr()`, with Hebrew added to `i18n/he.json` (`npm run test:i18n`). Everything printed on Form 101's own two pages stays Hebrew (CLAUDE.md, language rule). The pages attached after them do not fall under that rule (owner, 2026-10-31); what is printed there stays as it is, the bundle's Hebrew captions and summary page and the English captions by position alike. Code comments and docs are English. Each stage updates CLAUDE.md ("Files", the duplicated-on-purpose list) in its own PR when it changes what is listed there.

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
- **As built** (where it differs from the above, or the above was written before S2):
  - **Pinned to what production runs:** PyMuPDF 2.0 came out on 2026-10-19 and production moved to it on its own at the deploy of 2026-10-27 (nothing was pinned). The lock keeps 2.0; it brings `pymupdf-layout`, `pymupdf4llm`, `onnxruntime` and `networkx`, which the app does not use.
  - **Font subsets:** nothing to fix. `doc.subset_fonts()` is MuPDF's own subsetter since PyMuPDF moved to it, and it names a subset from the font's data (two processes give the same name); `random.choices` is only in the old `fallback=True` path. fontTools is not needed and is not in the lock. The `/ID` was the one random thing: MuPDF writes a new one on every save.
  - **No passthrough (owner, 2026-10-31):** the plan's "photos embedded as they are" was built, then dropped: every picture is decoded whole and re-encoded, so PDF sizes stay as they were, the bytes stay fixed with Pillow pinned, and a truncated JPEG is found (only its header was read before). `_shrink_for_embed` is back in the pages' chain.
  - **The check at send (owner, 2026-10-31):** `send` builds both documents strictly and throws them away, `view` is strict and `sign` builds them once more with the signature, for the move to another firm too (`view`, `sign`). A damaged or missing page is the manager's message before the worker signs: this is the stage's addition to S4's `E_DOCS_CHANGED`, which still catches a page changed between `send` and `sign`. `build` strict from the first signature on, and a date that cannot give the tax year raises too.
  - **What a signature is given on (the main session's decision, 2026-10-31, to be told to the owner):** a retry after the signature uses only what `sign` froze, so the pages never change under a signature and a rescan does not put a failed build right. `sign` freezes today and the page list with hashes; for a move to another firm it also freezes the template's file (a copy), the values, Form 101's values, the placed marks and the worker's personal fields. S4's manifest and locks take this further.
  - **The way out (the rule chosen):** a build that fails after the signature stays `signing` with `buildErrors`. The worker's page retries once on opening and has Try again; the manager has Try again and Withdraw. Withdraw works on a request with an error, or after 10 minutes with none, and deletes nothing: the signature and any part built stay on the request and in Storage. When frozen pages cannot be built the way out is Withdraw and a new send, which the worker views and signs again. No screen says Signed until a document exists; a client contract's status has the same stuck state and Try again.
  - **A stuck move to another firm (the owner's decision, 2026-10-31):** on Decline, or 14 days after the signature, the signature and any built parts of a move that was never copied are deleted. It is the one automatic delete of signed material, and it applies only when nothing was copied. The status moves first, and a path stays on the request until its delete is confirmed.
  - **Statuses move in a transaction (`functions/moves.py`):** `sign`, Decline, Withdraw, a replacing send, a part kept and the last step to `signed` / `done` each hold only while the status still allows them. The copy resumes: its claim is a lease apart from `copyCreated` and `copyDone`.
  - **A JPEG with no end marker stays refused, on the evidence:** Pillow refuses it exactly as it refuses a 1 % cut, and an end marker added back makes even a 60 % file load with no error, so nothing here can prove such a picture whole. It stops at `send`, where a rescan is all it costs, and the app's writers (canvas, Pillow) always write the marker.
  - **The bytes do not depend on the machine:** the same hashes came out on Windows with Python 3.14, on ubuntu with 3.12 and on the Cloud Functions image, all with PyMuPDF 2.0. Golden hashes still come from CI only.
  - **A check the plan did not have:** a `functions-image` job in `tests.yml` builds `functions/` with Google's buildpacks and runs it, so the lock's install and the bytes on the real image are proved on every PR, before a deploy. The buildpack installs functions-framework in a pip call of its own, so the hashes do not get in its way.
  - **The trailer `/ID` with no manifest:** until S4 nothing has a manifest, so every build takes it from a hash of its own inputs (the payload; the template, the values and the pictures). `manifest_sha256` is the parameter S4 passes.
  - **`fill_form_101` keeps printing this year:** the plan's rule (`taxYear`, else the year of `signDate`) would have moved the tax year of a stored unsigned form to the year the worker was added, because `form101Payload` sends `createdAt` as `signDate`. So the function passes this year as `taxYear`, and `signing` / `workerdocs` strip a sent `taxYear`. The rule then changes only a signed form whose signing date falls in another year than its build.
  - **`concurrency=20`** on `fill_form_101`, as `contract_templates` and `sign_documents`: with `cpu=1` and none named it would be the platform's 80.
  - **`dropped`** reaches the header through `report`, a dict the caller passes, so `build_form101_pdf` keeps returning `(bytes, name)`. `fill_form_101` sends it as a header too; its JSON body is unchanged.
  - **`contract_b1` and `sheets_b1` have no live caller yet:** `signing._pdf` and `client_signing` still fill with `contracts.fill`, and the sheet in a Form 101 is the only use of `sheets_b1`. S4 moves the contract to the frozen builder, with its manifest. `contract_b1` was compared with `contracts.fill` on a text template, a picture template and a client's: the same bytes apart from the `/ID`.
  - **The passport's place:** `sheets_b1` is S2's layout by shape (Q7, answered later than this stage was written), so a passport takes the room its shape needs rather than a fixed top half.
  - **The sheet's title** said "ID card and ספח" over an empty ספח box. Fixed in `idsheet.py` and `sheets_b1.py` before freezing.
  - **`extraPages` from the app carry no `kind`:** the stored unsigned form stays by position until S6 ends it. Only the signing sends kinds.
  - **Self-check:** `{ping, selftest}` covers Form 101, the contract and the sheet (eleven fixed inputs), once per instance. The deploy reaches it with no secret; the step cannot run before the first deploy, so its first real run is the merge of this stage.
- Status: **done**, merged 2026-10-31.
- **Builder b2 (owner, 2026-10-31): the attached sheet's words follow the language.** `sheets_b2.py` and `form101_b2.py` are new frozen files; b1 stays for what was signed with it. Download data and the preview take the viewer's language from the app (`lang`; none sent: English). A signed form takes the signer's: the page sends the language it showed the documents in, with `view` and `sign`, and `frozen {lang, builder}` holds it for every retry. A page or a signature with none stays on b1's Hebrew. Hebrew in b2 is b1's bytes exactly; b2's contract is `contract_b1.py`, unchanged, and the registry says so; a part names the version (`parts.form101.builder`). The words are a list in each file, held equal to `i18n/he.json` by a test, since a frozen builder must not read a dictionary that can change and `functions/` deploys without it. The summary page, the two form pages, the other documents' captions and the by-position English captions do not change.

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
- **The owner's answers (2026-11-03), which change this stage:**
  - **Template delete:** a template no one signed on is deleted for real, with its versions; one someone signed on is kept hidden (soft). New templates are added as before; a replaced one keeps its earlier versions.
  - **The signed archive, made at a delete only:** while the worker is there, what they signed stays with them. When a person deletes a signed document, the worker or the firm, each document the worker signed with their own hand — and the scans it was signed on — is first copied to `<firm name>/<given surname ID>/Form 101`, `…/Contracts` (the contract beside the template it was made from) and `…/Scans` (the scans on A4 sheets, two pictures to a sheet — the document, then its back or the ספח; a third starts another sheet), then deleted. A rescan simply overwrites the scans (an old passport replaced by the new one): nothing archived then. Read as both ways of signing (the worker's own link and the manager's phone: the worker signs by hand in both) and a move's documents into the new firm.
  - **What the worker did not sign by hand is just deleted.** Nothing is deleted or archived on its own: only a person's delete.
  - So Delete firm gets no archive download step: the firm's delete copies the hand-signed documents into `archive/`, outside the firm's files, before anything goes.
- **As built:** `contracts.py` — `save` writes `versions/<n>` with `create()` (a number taken goes to the next one) and `contracts/<id>/v<n>.pdf` with `if_generation_match=0` (`new_version`), never deletes the old file; `delete` is real for a template no one signed on (`signed_on`) and soft otherwise (`deletedAt`, `deletedBy`, `isDefault: false`), and `update`, a replace, `file` and a send refuse a soft-deleted template; `count_signed` adds one to `signedCount` when the worker's or the client's `build` keeps a signed contract. The signed archive — `functions-auth/signed_archive.py`: `put` before every `deleteWorkerDoc` (`files.run`'s `keep`), `archive_tenant` before `deleteTenant`, a failure stopping the delete — is described in docs/contracts.md → The signed archive. The backfill is `scripts/migrate/template_versions.py` (`migrate-docs.yml`, `template_versions-dry-run` / `template_versions-apply`): the current version's record for every template; it only adds. Not built here: the holds (S3b), the sweep (S10).
- Tests: `tests/auth/test_contracts.py`, `test_signing.py`, `test_signed_archive.py`, `test_migrate_template_versions.py`, `tests/rules/rules.test.mjs` (docs/contracts.md → Tests).
- Status: built 2026-11-03; the backfill to be run with the owner's yes after the merge.

## The plan rewritten on 2026-11-03 (after S3)

The stages below replace the old S3b–S10. The owner's decisions of 2026-11-03 changed the ground under them:

- **A person's delete archives, then deletes.** What the worker signed by hand (Form 101, contracts, and the scans they
  were signed on, on A4 sheets) is copied to `archive/<firm>/<given surname ID>/` and then deleted from the worker; what
  was not signed by hand is just deleted. Nothing is deleted or archived on its own (docs/contracts.md → The signed
  archive).
- **A rescan overwrites the scans** (an old passport replaced by the new one): the pages a signing was given on are not
  kept in place.
- **A template no one signed on is deleted for real**; one someone signed on is kept hidden.

**Dropped, because they conflict with these decisions:**

- **The old S3b, holds on the worker's files:** they would stop a person's delete and a rescan, which the owner wants
  to work. The protection moves to the archive (N5 below).
- **The old S9, slim signed copies and no stored signed PDF:** once a rescan overwrites the pages, the signed PDF is the
  only copy of what was signed, with its photos. **The signed PDFs stay stored, full, for good.**
- **From the old S4, the input manifest, the rebuild of a signed PDF and its shadow check:** nothing is rebuilt from
  inputs any more (the stored PDF is the record). The part of S4 still useful — a send points at the template version
  instead of making its own copy — is N3 below.
- **Q11's "hidden and held for seven years in compressed storage":** replaced by the archive. **Q3's "the old photos stay
  hidden beside the new ones":** replaced by the rescan overwrite.

What stays from the goal: keep the worker's data and pages once, build every unsigned PDF on request, store each signed
PDF once, and keep what was signed by hand in the archive when the worker goes.

### N1 — one server delete for a worker, the supplier's too (closes the gaps found)
- **`users_admin deleteWorker {workerId}`** (functions-auth): in one call — the signed archive for every document the
  worker signed by hand (`signed_archive.put`, as `archive_tenant` does for a firm), then every file under
  `tenants/<t>/workers/<w>/` (pages, signature, form101/, docs/, sign/), then the record. A copy that fails stops it all:
  nothing deleted. HR scope as `deleteWorkerDoc`.
- **The manager app's Delete worker** (`deleteWorkerNow`, `src/manager/page/worker-window.ts`) calls it instead of a
  loop of `deleteWorkerDoc` calls fired while the record is removed by a later save (today the record can go first,
  and a worker signed before the signing requests then loses its archive copy).
- **The supplier's delete** (`supplierDeleteWorker`, `functions-auth/portal.py`) goes through the same server delete:
  today it removes only the record, leaving the files behind and archiving nothing.
- `sign/<rid>/` copies of a deleted worker go with it (the contract's template is already copied beside it in the
  archive).
- Tests: the delete in one call (archive first, then the files, then the record), a failed copy deleting nothing, the HR
  scope, the supplier's delete archiving a signed worker; e2e: Delete worker leaves no file behind and the archive holds
  the signed set.
- Status: not started. **Recommended next.**

### N2 — the server writes the signed fields; status from data; downloads through `worker_docs` (the old S5)
- When both parts exist, `signing.build` writes the worker's signed fields itself (`signedAt`, `signDate`,
  `signedRequestId`, `sigFileId`, the `docs[]` contract entry with `templateId`, `templateVersion`, `signRequestId` and no
  `url`); the legacy requests with no `appliedAt` are applied by a one-off script, deleting nothing; `adoptSigned` stops
  writing from the browser.
- `worker_docs` gets `signed {workerId, requestId, which}` (the stored signed PDF) and `file {workerId, fileId}` (one
  `docs[]` file), replacing the token links.
- The worker's notices (`workerDocStatus`) read data, not `docUrl`; every Open / Download goes through `worker_docs`.
- `saveSchedule` copies the server's signed fields from the stored doc; `firestore.rules` refuse a browser change of them.
- Tests and docs as the old S5 listed them (`test_worker_docs.py`, the rules, the legacy-apply script, e2e).
- Status: not started.

### N3 — a send uses the template version, no copy per send (from the old S4)
- At `send`: `templatePath` = the version's file (`contracts/<id>/v<n>.pdf`) with its `templateSha256`; the copy to
  `sign/<rid>/contract-template.pdf` stops. A template signed on is never deleted for real, so the version file stays.
- The signed archive takes the template from that version file (it already reads `templatePath`).
- The move to another firm (N5's transfer below) does the same.
- Tests: no `sign/<rid>/` copy, the version file used, an old request with its own copy still built.
- Status: not started.

### N4 — stop storing the unsigned Form 101, then migrate the old ones (the old S6 + S7)
- The unsigned Form 101 is never stored: the scan saves only the pages and the signature; the preview and Download are
  built on request (`worker_docs`, already there). `regenerateWorkerDoc`, `regenerateAllWorkerDocs` and the per-edit
  re-upload go; `fill_form_101` answers `E_RELOAD` to an old device.
- **Migration** `scripts/migrate/unsigned_docs.py` (dry-run / apply / restore; cleanup on the owner's yes): the unsigned
  `docFileId` / `docUrl` fields of unsigned workers removed, the file kept until cleanup. Signed workers never touched.
- Tests and docs as the old S6 + S7 listed them.
- Status: not started.

### N5 — the archive protected; the move to another firm on the new scheme
- **The archive cannot be deleted for seven years** (Q4's retention): a retention rule on the `archive/` folder (an
  object hold or a bucket retention policy on an archive bucket — the owner's choice, a cloud setting). After the seven
  years, a deletion only on the owner's yes, never on its own.
- **Optional, the owner's choice:** Admin → Archive for the super-admin — the folders and files listed, a file opened or
  a worker's folder downloaded as a zip (today only the Firebase console shows it).
- **The move to another firm** (`functions/transfer.py`, the old S8): the new firm's template version frozen at ask time
  (N3), the old firm's pages copied into the new firm's worker at ask time, so a rescan in the old firm after asking
  changes nothing; `_copy` writes no token links.
- Status: not started.

### N6 — cleanup and the read rule (the old S10's remainder)
- **The leftovers found by the inventory**, each deleted only on the owner's yes, after a dry-run list: the 4 Form 101
  files no record points at (2.3 MB), the 5 files of workers already deleted (1.5 MB), the orphan signature, the
  `sign/<rid>/` copies of `replaced` / `withdrawn` sends. Nothing signed is touched.
- **Q5:** the download tokens stripped from the stored files and `docUrl` / `docs[].url` cleared, once every reader uses
  `worker_docs` (N2).
- **The Storage read rule narrowed** (after Q5): worker files read in the browser only with the Workers right, `form101/`
  and `docs/` only through `worker_docs`.
- **Removed code:** the old `signing.bundle`, `fill_form_101`'s build path, `adoptSigned`, the `form101` upload kind.
- Status: not started.

### Not changed, put off by the owner
- **Q10, the safety net:** bucket soft delete and Firestore point-in-time recovery — a cloud setting for the owner's
  hands. Without it, a mistaken delete outside the archive cannot be undone.
- **Q6:** scanned contracts stay a PDF in `docs[]`.

## Data model now and when done

- **Worker:** the Form 101 fields; `scanPages[] {fileId, kind, primary, savedAt}` (replaced by a rescan); `sigFileId`,
  `signedAt`, `signDate`, `signedRequestId`, `signedPrint*` (written by the server from N2); `docs[]` (no `url` for new
  entries); the unsigned `docUrl` / `docFileId` gone after N4.
- **Template:** `contractTemplates/<tid>` + `versions/<n>` (the file, its SHA-256, `placed`, `marks`); a template no one
  signed on deleted for real, one signed on kept hidden (`deletedAt`). Built.
- **signRequest:** `templatePath` = the version file (N3), `parts.<which> {path, name, size, builder}` — the stored signed
  PDFs, kept for good.
- **Storage per worker:** `pages/*.jpg` once; `signature/*.png`; `form101/` and `docs/` — the signed PDFs and the
  uploaded documents; no unsigned Form 101 (N4), no per-send template copy (N3).
- **Archive:** `archive/<firm>/<given surname ID>/Form 101 | Contracts | Scans` + a `.json` per document — made at a
  person's delete, protected for seven years (N5). Built (the protection: N5).

## Weight

(The table's "when done" column assumed the slim signed copies of the old S9, dropped on 2026-11-03: a signed worker keeps its full signed PDFs; the savings come from the unsigned Form 101 and the per-send copies, N3–N4.)

**S0's inventory, run on the real project on 2026-11-03** (every firm, totals): 6 workers (2 signed, 3 still on a sidecar), 3 signing requests (all signed and applied); Form 101: 2 signed (0.5 MB), 4 unsigned (2.2 MB) and 4 no record points at (2.3 MB); 0 signed contracts under `docs/`; 3 template copies of signed sends (0.3 MB); 6 scan pages (0.7 MB); 4 signatures (54 KB), 1 orphan; 4 old sidecars (0.7 MB); 1 template (0.1 MB); 5 files of deleted workers (1.5 MB) — about 8.4 MB in all. The data is still small, so the order of S6–S10 needs no change for weight. The estimate below was made before it. Measured builds: an unsigned Form 101 with its scans is 0.2–1.2 MB (198 KB with three small JPEGs, 1.16 MB with three large ones), and 140 KB without pages. The scan pages are about 300–600 KB each, about 1–2 MB per worker.

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
- **Q3 — a rescan after signing. Changed by the owner on 2026-11-03: a rescan overwrites the scans (an old passport replaced by the new one); the signed PDF keeps the photos it was signed with.** The earlier text: The signed photos stay, held, beside the new ones (two sets of the worker's photos in Storage). Acceptable? **Answered (owner, 2026-10-31):** every screen shows only the new photos (`scanPages`); the old ones stay hidden and held for the retention period, because Q1's slim copy holds no photos and they are the proof of what was signed.
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
- **Q11 — a person's delete of a signed file against the locks. Changed by the owner on 2026-11-03: a person's delete copies what was signed by hand to the signed archive, then deletes it (built in S3); no holds on the worker's files.** The earlier answer (owner, 2026-10-31): Remove and Delete worker take the document off every screen, and its file stays hidden and held for Q4's seven years. Hidden files go into compressed storage: a lossless archive whose unpacked bytes still match their hashes, in the cheapest storage class that keeps the hold (photos and PDFs barely shrink when zipped, so the class is most of the saving; S3b settles the format). After the seven years a sweep deletes them; its first run needs the owner's yes. The one exception: a super-admin may delete a file for real at once (a wrong person's document), confirmed and logged. Until S3b and S10 are built, a person's delete still deletes for real (S0b).

## Risks still open

- **An old device's whole-document save after S5–S7.** It is covered by:
  - `saveSchedule` copying the server's signed fields (current devices);
  - the signed-fields rule and the forced reload (old devices);
  - the `form101/` create rule and `E_RELOAD`;
  - rerunning apply.
- **A refused worker fails its whole save batch.** An old device's batch with one refused worker loses every other edit in it until it reloads.
- **Memory and response size of large bundles:** covered by `concurrency=4`, the 25 MiB cap and raw PDF responses.
- **Python 3.14 locally and the ubuntu CI runner against the python312 production image:** golden hashes come only from CI; the `functions-image` job checks them on that image on every PR, and the production self-check compares them after each deploy.
- **The signature itself is a drawn PNG plus a server time.** The manifest hash proves the inputs were not changed afterwards. It is not a cryptographic signature (counsel, Q4).
- **The endpoint's rights checks are only as strong as the Storage read rule.** Until S10 narrows it, any manager can read worker files directly with a token link or the SDK.
- **A digital Form 101 without the Tax Authority's approval (found 2026-10-31, Q4).** The rules ask for an approved system and the employer's approved electronic signature; a form that does not meet them counts as defective, with the maximum tax deduction for the worker. The owner's decision (2026-10-31): the signature stays as it is, as the working version, for now. The ways out, if this is taken up again: a form signed by hand, an approved system, or the app's own registration; the Authority also offers to consider easing the locking and signing (rule B3.e).
- **Cold starts:** `min_instances=0`, so the first view after a quiet period takes a few seconds. The app sends `{ping}` warm-ups, as it does for the other functions.
