# Signed documents

What is kept under a worker for Form 101 and the contract, and how it is signed. The plan, stage by stage, is [contracts-plan.md](contracts-plan.md); this file describes what is built.

## Scanned pages (D1)

Every scanned page of a worker is its own JPEG in Storage, and the signature a small PNG. They replace the old sidecar: one JSON file with every picture inside as base64 (a third heavier, and loaded whole for any one page).

| What | Stored at | On the worker |
|---|---|---|
| A scanned page: the ID card's front or back, the ספח, the passport, another page | `tenants/<t>/workers/<id>/pages/<ms>-<index>-<kind>.jpg` — a JPEG of at most 2000 px on its long side (`pageForStorage`, `src/manager/logic/uploads.ts`; ~300–600 KB) | `scanPages: [{fileId, kind, primary?, savedAt}]` — `kind` one of `id_front`, `id_back`, `sefach`, `passport`, `other`; the worker's ID card or passport first, `primary: true`; then the other pages in the scan's order |
| The signature | `…/signature/<ms>-signature.png` | `sigFileId`, `sigSavedAt` |
| The old sidecar (until split) | `…/assets/<ms>-<name>_assets.json` | `assetsFileId` |

- **Kinds:** the scanner's kind of the page (`src/scan/doctype.ts`); a page without one is the worker's document when it is the first (`id_front`, or `passport` for a passport worker) and `other` otherwise (`pageKind`, `src/manager/data/pages.ts` — the migration's `page_kind` is the same rule). A contract's pages are not stored here: they go to the worker's documents as one PDF (docs/scan.md → Contracts).
- **Private:** a page and the signature get no download URL. They are read back only through `users_admin` `loadWorkerPages` (`functions-auth/files.py`): every page and the signature of a worker in one call, each path checked to be under `pages/` or `signature/` of a worker of the caller's firm (an own-workers HR: its own workers only). A supplier, a client and the worker's own page never get them.
- **Writing:** `saveScanPages(w, {front, others, sigPng}, keep)` (`src/manager/data/pages.ts`) uploads every new page and the signature at once (`saveWorkerPage`, `saveWorkerSignature` — `uploadWorkerFile`); a part `keep` names (it came from Storage unchanged: the other pages kept on a rescan that took only the front, the signature not drawn again) keeps its stored file. Once all are up, the replaced files and the old sidecar are deleted and `applySavedPages` sets `scanPages`, `sigFileId`, `sigSavedAt` and removes `assetsFileId`. If any upload fails, the worker keeps what it had and the new files already up are deleted. Called by Form 101's upload (docs/form101.md → Storing the result).
- **Reading:** `loadStoredAssets(w)` → `{scanB64, scanMediaType, sigPng, extraPages}` — from the pages, or from the old sidecar (`loadWorkerAssets`) for a worker not split yet. Form 101's rebuild (`regenerateWorkerDoc`; a rebuild whose pages can't be read is not done, so a PDF without its pages never replaces the good one), the rescan's kept pages and the field search of the worker card and window (`findScanFields`, docs/workers.md) read through it.
- **Deleting a worker** deletes every page, the signature and the old sidecar (`scanFileIds`).
- **The worker's scan for the Workers list** (`workerHasScan`, `src/manager/worker.ts`): `scanPages`, or the old `assetsFileId`.

### Splitting the old sidecars (`scripts/migrate/scan_pages.py`)

Once, by the workflow **Split the old scan sidecars into pages** (`.github/workflows/migrate-scan-pages.yml`, started by hand, the deploy's service account), for every firm or one (`tenant`):

- `dry-run` — reads every sidecar of a worker that has no `scanPages` yet, splits it in memory and reports per firm the workers, pages, signatures, the sidecars' and the pages' bytes and the failures (a sidecar gone, not in the worker's folder, or broken). Writes nothing.
- `apply` — writes the pages (a page over 2000 px or not a JPEG is turned into one, Pillow; the others byte for byte) and the signature, with the sidecar's HR stamp (`hrId`), then updates only the worker's own fields (`scanPages`, `sigFileId`, `sigSavedAt` — the sidecar's time —, `assetsMigratedFrom` = the sidecar's path, `assetsFileId` removed). The sidecar file stays. Run again, it finds nothing more.
- `cleanup` — deletes the sidecars already split (`assetsMigratedFrom`) and that field.

`apply` and `cleanup` change real workers' data: they are run only with the owner's yes, after a `dry-run`. Tests: `tests/auth/test_migrate_pages.py`.

### Tests

`tests/auth/test_files.py` (`loadWorkerPages`: one call, a missing page, only pages and signatures of the firm, an own-workers HR), `tests/auth/test_migrate_pages.py`, and the browser test "scan pages" (`tests/e2e/main.test.js`: a new worker from a scan stores its pages and signature, the card's field search and a rebuild read them back, a rescan keeps the stored ספח, a worker on the old sidecar is split on its rebuild, deleting the worker deletes them).
