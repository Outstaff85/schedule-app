# Hugging Face plan — models, training data and the scanner's own AI

The approved plan (owner, 2026-10-19) for moving everything about the scanner's models, AI and training to Hugging Face, and for the firm's own **field reader model** that may one day replace the AI reading. The scanner itself is described in docs/scan.md, its rebuild in docs/scan-plan.md, its training in docs/scan-training.md.

Status: **started** (owner, 2026-10-19: "start, and merge the whole plan once all the tests are green"). **H0 done** — the code and the stored fields say what the models do; `rename_fields.py --apply` has run (the old names are still read, for a phone with the old app). **H2–H6 code done**: the deploys take a version from Hugging Face when it is there (else from Storage, as before), the functions' deploy keeps the server's Storage mirror, `preprocess_scan` warms up, `/scan-train` publishes to Hugging Face; `move_to_hf.py --apply` (H2) has run. **H7 + H8a code done**: `scan_feedback` writes to the private bucket once the server has its token (else to Firebase as before), the full documents are collected on the save after a scan (on for every firm), `move_data_to_hf.py` / `delete_data.py`. **Admin → Scanner and the bell done**: the figures, the versions, the document type model's Off / Shadow / Mixed (shadow by default, its figures from the training examples) and the per-firm switch; the bell's scanner notices open it. **H8b-1 built** (2026-10-21): the passport zone reader, the firm's own small model learned from made-up lines (below). **H8b-2 built** (2026-10-21): the zone reader in shadow on the phone, reading once a version holds it. **H8c, H8d wait**: the field reader model is trained once H8a has collected enough documents (the bell will say so); their shadow, mixed and Turn off the AI switches come with them. **H1 done** (owner, 2026-10-19): the private bucket `OutStaff/scanner-data` and the server's token in Secret Manager (`HF_DATA_TOKEN`, declared on `scan_feedback`); the training data now goes to the bucket (a refusal there keeps the files in Firebase). **The owner's one runs done** (2026-10-19, on the PC): `move_to_hf.py --apply` put `base-v1` (`edges.onnx`, `edges-lite.onnx`, `face.onnx`) into the public `OutStaff/scanner-models` under the tag `base-v1`; `rename_fields.py --apply` and `move_data_to_hf.py --apply` found nothing to rename or move (no example had been collected in Firebase).

## Decisions (owner, 2026-10-19)

- **One place for everything about models, AI and training: Hugging Face** (account `OutStaff`).
- **Models → `OutStaff/scanner-models`, a public model repository.** Every version is a tag (`base-v1`, `v2`, …) with its exam report. Public: no key is needed to download, and the models hold no personal data.
- **Training data → `OutStaff/scanner-data`, a private Storage Bucket** (HF's object storage, no Git history — files are written and deleted one by one, a deletion is real). Private storage is free up to 100 GB per account; the estimate is ~15 GB after years. **Never public.**
- **Server: a mirror.** The server keeps loading its models from Firebase Storage as now; at deploy the site's version is copied there from HF, and only that version is kept in Firebase (the others are deleted — HF keeps them for a rollback). At run time the server never calls HF, so an HF outage does not stop scanning. The server **warms up**: the models load when an instance starts, before its first scan.
- **Kept without a time limit**, with a script that deletes every example of one worker or one firm on request (replaces the 12-month deletion).
- **Who can read the data:** only the owner's token on the owner's PC (`H:\hf\home`). The server's token (Secret Manager) may only **write** to the bucket.
- **The AI stays** (Sonnet reads the fields, Haiku gives the kind and turn of pages without a face) until the firm's own model is proven no worse; each step only on the owner's yes, each one undone by one setting.
- **Training on the owner's PC** (it has an NVIDIA card), with pretrained weights from HF.
- **Legal:** the full-document collection (H8a) is approved by the owner; the legal check and the notice to the workers are the owner's. Its switch is per firm and **on by default for every firm** (owner, 2026-10-19); the super-admin can turn it off for a firm.

## Names the users see

The models are named by what they do, in every UI text (bell, Admin → Scanner, the lab, the `/scan-train` reports, the docs) — and in the code too (H0, owner 2026-10-19): **`doctype`** for the document type model (not `docType`, the worker's ID / passport field), **`edges`** for the document edges model.

| Does | UI name | Was called |
|---|---|---|
| finds the document's edges and cuts it | **Document edges model** | the corner model |
| says what the page is (ID front, ID back, ספח, passport, contract, other) and its turn | **Document type model** | the page-kind model |
| reads the name, number, dates, address | **Field reader model** | — (new, H8) |
| sets a page upright by the face | **Face finder** | the face finder |

The bell's notices become "Time to retrain the document edges model" and "Enough pages to train the document type model".

## Architecture

```
 PHONE (site, scanner)                       SERVER (Cloud Functions)
 edges (light) · type of document  ──pages──▶ preprocess_scan: edges, cut, type ◀── models from the
 worker window                     ──read───▶ ai_read: Sonnet / Haiku               Firebase mirror
 Done / Save                       ──examples▶ scan_feedback ──write only──┐       (site's version only)
        ▲ models at deploy                                                  ▼
 HF OutStaff/scanner-models (PUBLIC)  ◀── publish ── OWNER'S PC: /scan-train ◀── HF OutStaff/scanner-data
 tags base-v1, v2, … + exam reports                  download, train, exam, yes    (PRIVATE bucket)
 Firestore: workers, punches, the bell's counters — unchanged
```

- **Collecting:** Done in the scan window → the small copies (H7); Save of the worker window after a scan → the full pages and fields (H8a, on for every firm unless turned off). `scan_feedback` writes them straight to the bucket; the bell's counters stay in Firestore.
- **Training:** the bell says it is due → `/scan-train` on the PC: download from the bucket, train on HF's pretrained weights, exam against the current model and the AI → the owner's yes → a new tag in `scanner-models` → the lab names it.
- **Delivery:** the lab and the site download their version from HF at deploy (no key); the server's deploy copies it to the Firebase mirror. Lab first, then the site, as now.
- **Reading:** the AI as now; a trained model goes through shadow → mixed → without AI (below).

## The way a model replaces the AI

1. **Collect** the examples. 2. **Train** on the PC. 3. **Exam** against the AI on pages never trained on. 4. **Lab** — the owner tries it on the phone. 5. **Shadow** — the model reads every scan beside the AI; its answer goes nowhere, it is only compared with the AI's and with what the user saved (the user waits as now: the model is faster than the AI and runs in parallel). 6. **Mixed** — the model answers where it is sure, the AI reads the rest (faster, cheaper). 7. **Without AI** — only when the model is steadily no worse on every field and document type.

Every step is the owner's call, from the bell and **Admin → Scanner**; "Bring the AI back" is always one tap.

## Admin → Scanner and the bell (super-admin only)

- **Admin → Scanner** (new tile): for each model (document edges, document type, field reader) its step (collect → train → lab → shadow → mixed → without AI), the examples collected, the last exam report, the shadow's figures (days, % agreeing with what the user saved, vs the AI); the buttons **Turn on shadow**, **Turn on mixed mode**, **Turn off the AI**, **Bring the AI back** — each asks to confirm and changes a server setting at once, without a deploy; the per-firm switch of the full-document collection (on by default); the bucket's size.
- **The bell** tells each step and opens the right place: "Enough pages to train the document type model" (→ run `/scan-train` on the PC), "Trained and passed its exam — try it in the lab" (→ Admin → Scanner lab), "N days in shadow: the model X %, the AI Y %" (→ Admin → Scanner), "The AI is needed in only Z % of scans" (→ Admin → Scanner).
- Training never starts from the app: it needs the PC's NVIDIA card and the owner's HF token.

## Stages

### H0 — the code says what the models do (first, before the move)
Rename where the word means the model or its data — not where it means something else (a quad's geometric corners, a zoomed re-read's field kind such as `digits9`):
- **kind → doctype:** `withKind` / `with_kind` → `withDoctype` / `with_doctype`, `_kind_model` → `_doctype_model`, `kind_of` → `doctype_of`, `KIND_MODELS` → `DOCTYPE_MODELS`, `pull_kinds.py` / `train_kinds.py` / `exam_kinds.py` → `*_doctypes.py`, `report_kinds.json` → `report_doctypes.json`, `--force-kinds` → `--force-doctypes`; the records' `kindModel` / `kindFixed` / `kindBy` → `doctypeModel` / `doctypeFixed` / `doctypeBy`, the counters `kindsSince` / `kindsDue` / `kinds` → `doctypesSince` / `doctypesDue` / `doctypes`.
- **corners → edges:** the records' `cornersModel` / `cornersFixed` → `edgesModel` / `edgesFixed`, the counter `newSince` → `edgesSince`, the training scripts' and notices' corner-model names (`scanTrainingNotice` → `scanEdgesNotice`, …).
- **Model files** get their new names when they move to HF (H2): `sa24.onnx` / `lite.onnx` → `edges.onnx` / `edges-lite.onnx`, `kind.onnx` / `kind-lite.onnx` → `doctype.onnx` / `doctype-lite.onnx` (none trained yet).
- **Stored data:** a one-time script renames the fields of the records already collected (`scanTraining`, a few days' worth) and of `scanTrainingStats/current`.
- The UI texts get the new names (Document edges model, Document type model) through the dictionaries; tests, docs and `ai_golden.json` (if a prompt name changes) follow.

### H1 — accounts and keys (the owner, with instructions)
Create `OutStaff/scanner-models` (public model repo) and `OutStaff/scanner-data` (private bucket); a server token that may only write to the bucket, put into Secret Manager (`HF_DATA_TOKEN`) by the owner — never in the repo or the chat. Done already: the owner's Full-access token on the PC (`H:\hf`, `HF_HOME=H:\hf\home`), the HF connector in the sessions, the cloud environment's network (`huggingface.co`, `*.hf.co`).

### H2 — move the models
A script copies every version from Firebase Storage `models/scan/<version>/` to `scanner-models` as tags, with their reports; run once on the PC.

### H3 — the site and the lab take the models from HF
`scripts/scan/fetch-models.sh`, `scripts/scan-lab/fetch-models.sh` (`model_store.py`): download the tag named in `models-version` from HF; the authors' links stay only for `base-v1`.

### H4 — the server's mirror and warm-up (removed 2026-10-19 with `preprocess_scan`: the site's scanner is the lab's page)
The functions' deploy copies the site's version (`functions/scan_models_version.txt`) from HF to Firebase `models/scan/<version>/` when it is not there yet, and deletes the other versions there. `functions/main.py` loads them from Firebase as now (`_scan_models`, `_kind_model`), now when the instance starts (warm-up).

### H5 — `/scan-train` on HF
`publish.py` uploads a new version to `scanner-models` in one commit with the tag `v<N>` (the next number from the tags; nothing is copied — a tag holds every file); the exam reports beside it; the pulls read from the bucket; training uses HF's pretrained weights on the PC's GPU.

### H6 — tests, docs, the rule
Tests for the HF paths (stubbed), docs/scan-training.md, docs/scan-plan.md, docs/backend.md; a CLAUDE.md rule: models — the public HF repo; training data — only the private bucket, never public.

### H7 — the small copies into the bucket
`scan_feedback` writes the small copies (256×256, the corners and kinds) straight to the bucket; the existing ones are moved once from Firebase; no time limit; the delete-on-request script (one worker, one firm).

### H8a — collecting full documents (on by default for every firm; a per-firm switch to turn it off)
On Save of the worker window after a scan: every cut, straightened page as the AI read it (ID card both sides, ספח, passport), the document and page types, each field as Sonnet read it, as the zoomed re-read read it, and as the user saved it (which fields were corrected). Not collected: the raw camera photo, contracts, Form 101, the worker's other fields (rates, phone). The scan is tied to the save through `src/scan-process/session.ts`.

### H8b — passports and check digits without AI (shadow first)
The passport's machine-readable zone (MRZ) read with its check digits — the number and dates without AI; the zoomed re-read of an ID number skipped when its check digit is right. **The reader is the firm's own small model** (owner, 2026-10-21 — not Tesseract: its stock English model reads the zone's `<` as `L` and needs a dictionary of no clear licence for OCR-B; FastMRZ is AGPL): a CRNN of 0.6 M weights (`mrz.onnx`, ~2.5 MB), learned only from made-up zone lines drawn with TRDG in the OCR-B font — every country's passport has the same zone, the made-up ones are mostly Thai, Indian, Ukrainian, Russian, Belarusian, Moldovan and Sri Lankan (owner, 2026-10-21) — and examined on the real passports H8a collects. In two steps:
- **H8b-1 — the training on the PC** (built 2026-10-21): `synth_lines.py mrz` → `train_mrz.py` → `exam_mrz.py` → `publish.py` puts `mrz.onnx` into the next version (docs/scan-training.md → The passport zone reader). Checked in the cloud (CPU): the lines drawn, one short training, the ONNX export checked — the real training is the PC's (`/scan-train`).
- **H8b-2 — the shadow** (built 2026-10-21; it reads once a version holds `mrz.onnx`): the lab's page reads each page's zone with it (`mrzFind` / `mrzRead`: the same line finding, input and decoding as `mrzmodel.py`, ONNX Runtime Web as the other models) and shows line 2 with its check digits on every shot; the site's scan window carries the lines to the scan process, which parses them (`src/scan-process/mrz.ts`) beside the AI; the full document (H8a) keeps the answer (`mrzShadow`), and Admin → Scanner → Passport zone reader shows how often it got the number, the dates and the sex the user kept, against the AI (docs/scan.md → The scan window). Never used for the worker yet: replacing the AI's zone reading is H8d, by the owner's decision from these figures.

### H8c — the field reader model for Hebrew (shadow first)
An open text-recognition model with Hebrew, fine-tuned on H8a's examples (an estimated 1–3 thousand ID cards), on the PC's GPU — or an agent: recognise → check digits → re-read when unsure → ask Sonnet when still unsure. The same data serves both. First trained on made-up lines (owner, 2026-10-21: `synth_lines.py he` — Hebrew names, ID numbers with a right check digit, dates, streets, cities in the PC's Hebrew fonts), so fewer real ID cards are needed; after H8b has shown the way on the passport zone.

### H8d — mixed mode, then without AI
By the owner's decision from the shadow's figures.

## Not changing

Firestore (workers, punches, the bell's counters), the Cloud Functions, Hosting, the Anthropic key in Secret Manager; the lab and the site apart, lab first.
