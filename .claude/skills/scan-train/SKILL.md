---
name: scan-train
description: Retrain the scanner on the owner's PC from what the site collected — the document edges models (docs/scan-plan.md → S6) and the document type models (S7) — download the examples, train, exam against the old models / Haiku, and on the owner's yes publish a new model version to the lab. Run when the bell says "Time to retrain the document edges model" or "Enough pages to train the document type model".
---

# /scan-train — retrain the scanner (owner's PC)

The whole process (what is collected, where it is kept, why each step): docs/scan-training.md.

The site collects every page whose corners a user corrected (`scan_feedback`, Firestore `scanTraining`, Storage `training/scan/`). This skill turns them into a new model version. **The lab learns first, the site follows**: a new version is only ever given to the lab here; the site gets it later, after the owner tried it in the lab (step 7). Talk to the owner in Russian.

Three kinds of training, run one or more (the bell says which is due; the passport zone reader when the owner asks):
- **Document edges** (S6, "Time to retrain the document edges model") — steps 2–4.
- **Document types** (S7, "Enough pages to train the document type model") — step 4b.
- **Passport zone reader** (docs/hf-plan.md → H8b, made-up lines only) — step 4c.
All end in the same step 5: one new version holds whatever was trained; the rest is carried over.

## 1. Check the PC
- The copies go to `~/.scan-train`; with little space on C:, the owner sets `SCAN_TRAIN_HOME` to a folder on another disk (`setx SCAN_TRAIN_HOME D:\scan-train`, a new terminal after).
- `nvidia-smi` — the RTX 4070 must be listed (training on the CPU works but takes hours; say so and ask).
- Python 3.11+ in `scripts/scan-train/.venv` (create it if missing):
  `python -m venv scripts/scan-train/.venv`, then in it
  `pip install torch --index-url https://download.pytorch.org/whl/cu124` and `pip install -r scripts/scan-train/requirements.txt`.
- Google access under the owner's own account: `gcloud auth application-default login` (once; the owner signs in in the browser). Never ask for keys or passwords in chat.
- Hugging Face, the models' home (`OutStaff/scanner-models`, private; docs/hf-plan.md): the owner's token on the PC — `hf auth whoami` must say `OutStaff` (else the owner runs `hf auth login`; the token is never pasted in chat). The owner's PC keeps it in `H:\hf\home` (`HF_HOME`).
- Once, before the first training on Hugging Face: `python scripts/scan-train/move_to_hf.py --apply` (the versions still in Storage go to Hugging Face as tags) and `python scripts/scan-train/rename_fields.py --apply` (the records collected before H0 get today's names). Each says what it would do without `--apply`; both are safe to run again.

## Stopped in the middle
Every training saves its progress after each epoch (`~/.scan-train/checkpoints/`; the passport zone reader in `~/.scan-train/mrz-ckpt/`). If one stopped (Ctrl+C, a crash, the PC turned off), run the same command again with `--resume`; to train the edges, document type or Hebrew model further from where its last run ended, `--more` (the zone reader starts from its best weights by itself; `--fresh` for random ones) (docs/scan-training.md → Stopped and picked up again).

## 2. Download the examples
`python scripts/scan-train/pull.py` — prints how many examples (and how many came from the scan attempts, S8), how many kept apart for the exam. Fewer than ~100 to train on: tell the owner it is early and ask whether to go on.

## 3. Train
With few examples (or when the owner asks), made-up photos first: `pip install -r scripts/scan-train/requirements-synth.txt` once, then `python scripts/scan-train/synth_docs.py --count 20000` (add `--backgrounds <folder>` if the owner has photos of tables and floors; `--count 40 --show` to look at them first, `~/.scan-train/synth/docs/show/`), and MIDV — real photos of mock documents (once: `python scripts/scan-train/midv.py --download midv2020 --drop-raw` — the sets made, the download deleted; then `python scripts/scan-train/datasets_hf.py push` keeps them in the private bucket, and on another PC `datasets_hf.py pull` brings them back instead of downloading again). Before the first version trained with MIDV goes to the site, remind the owner of its terms (docs/scan-training.md → MIDV). Paper pages from SmartDoc (CC BY 4.0; once: `python scripts/scan-train/smartdoc.py --download --drop-raw`, then `datasets_hf.py push`). The firm's own pages as templates: `python scripts/scan-train/pull_templates.py`, then `synth_docs.py --templates` (about one page in six is kept apart for the exam and never laid) and `synth_docs.py --templates --exam` (the exam photos of those pages; their face and text washed out; they are workers' documents and stay on the PC). Train with `--synth N --midv M --smartdoc K` — together about as many as the real examples up to a few times as many, and with thousands of them `--epochs 3`–`5` (docs/scan-training.md → Made-up document photos, MIDV).

`python scripts/scan-train/train.py` — both document edges models (`edges-lite.onnx` for the phone's live frame, `edges.onnx` for the server), starting from the lab's current version (`scripts/scan-lab/models-version`). ~15–30 min on the 4070. Each epoch prints its loss; it must go down.

## 4. Exam
`python scripts/scan-train/exam.py` — the pages never trained on, old models vs new, set by set (the users' pages kept apart, the exam photos of the owner's real pages kept apart — `synth_docs.py --templates --exam` —, and 300 photos each of MIDV-2020's and SmartDoc's exam documents when those sets are on the PC — so the exam works before the site has collected pages): mean corner error, share within 2 %, share not found. From the scan attempts it also prints the extra pages found where the user deleted one (lower is better) and how often a retaken page is answered other than the rejected frame. Show the owner this report in plain words (before → after), and point them to the picture report it opens in the browser (`~/.scan-train/report.html`: the 10 exam pages where the models differ most, the old corners red, the new blue, the right ones green — it stays on the PC). If it says "NO — do not publish", say so and recommend `clean.py`.

## 4b. Document types (S7)
1. `python scripts/scan-train/pull_doctypes.py` — the page copies with their kinds; prints how many per kind. A kind with fewer than ~80 to train on: say it is early, ask whether to go on.
2. `python scripts/scan-train/train_doctypes.py` — the phone's model (EfficientNet-Lite0, `doctype-lite.onnx`) and the server's (Lite2, `doctype.onnx`), from ImageNet weights (downloaded once by timm). ~10–20 min on the 4070. The loss must go down.
3. `python scripts/scan-train/exam_doctypes.py` — the exam pages: kind right, how many it is sure of (≥ 90 %) and how right those are, the turn right, and **the site's way** (the model where sure, Haiku elsewhere) against **Haiku alone**. Show the owner this in plain words.
4. When it says a model is worse, it prints the next size up (owner, 2026-10-19: Lite0 → Lite1 → Lite2… until the result is right): run that `train_doctypes.py --only phone --phone tf_efficientnet_lite1` (or `--only server --server …`), then `exam_doctypes.py` again. At Lite4 and still worse: more page copies are needed — `clean.py`, and wait for the bell.

   Before the site has its own page copies (or beside them): `python scripts/scan-train/synth_pages.py --count 6000` (made-up pages of every kind — drawn, the owner's real pages made other people's, SmartDoc, MIDV), then `train_doctypes.py --synth 6000`. With no page copies from the site the exam has nothing to measure: say so, and that the lab (then the site's shadow against Haiku) shows how it does.

## 4c. Passport zone reader (H8b)
1. Once: `pip install --no-deps trdg==1.8.0` and `pip install -r scripts/scan-train/requirements-synth.txt` in the same `.venv`.
2. `python scripts/scan-train/synth_lines.py mrz --count 100000` — the made-up zone lines (OCR-B, on every core but the first, at low priority; ~5–10 min) into `~/.scan-train/synth/mrz/`. Nothing of it is uploaded.
   With MIDV downloaded (step 3), also `python scripts/scan-train/midv_mrz.py` — real zone lines of MIDV-2020's mock passports for training, and exam pages (docs/scan-training.md → The passport zone reader); then train with `train_mrz.py --midv`.
3. `python scripts/scan-train/train_mrz.py` — the small CRNN (`mrz.onnx`), ~10–20 min on the 4070; each epoch prints the lines read right on the check lines — it must go up to ≥ 93 % (the exam also needs ≥ 95 % of MIDV's real exam passports with every check-digit field right). It starts from the best weights of the trainings before (`~/.scan-train/mrz-ckpt/best.pt`, kept by `clean.py` / `publish.py`; `--fresh` from random weights); a stopped training goes on with `--resume`.
4. `python scripts/scan-train/exam_mrz.py` — the made-up check lines and the real passports collected (H8a), against the AI; with `midv_mrz.py` run, also MIDV-2020's exam passports (real photos never trained on). Show the owner in plain words; "NO" → more lines (`--count 200000`) or more epochs (`train_mrz.py --epochs 20`), then the exam again.

## 4d. Hebrew field reader (H8c — on the PC only for now; when the owner asks)
1. `python scripts/scan-train/pull_templates.py` (the owner's marked pages; `template_fields.json` names them).
2. `python scripts/scan-train/synth_fields.py --count 3000` and `python scripts/scan-train/synth_fields.py --count 300 --check`.
3. `python scripts/scan-train/train_he.py` (~10–20 min on the 4070) — the check fields read right, by kind, and the ID numbers with a right check digit. Show the owner; "NO" → more pages (`--count 6000`) or epochs (`--epochs 30`). On "YES" `publish.py` puts `he.onnx` with `he-layouts.json` into the version; the lab reads ID cards with it, the site in shadow beside the AI (Admin → Scanner → Hebrew field reader).

## 5. The owner decides
- **Yes** → `python scripts/scan-train/publish.py`: the new version goes to Hugging Face as one commit tagged `v<N>` (https://huggingface.co/OutStaff/scanner-models/tree/v<N>, with the reports; every model not retrained is carried over from the lab's version), the bell's counters are reset (`edgesSince` after the edges, `doctypesSince` after the document types), `scripts/scan-lab/models-version` names `v<N>`, the scan attempts trained on move to `attempts/used/v<N>/` (`attemptsSince` lowered by them; only with the edges in the version), the copies on the PC are deleted (`--keep-copies` keeps them when another training still needs them). Document type models whose exam said "not worth publishing" are left out unless the owner explicitly says to publish them anyway (`--force-doctypes`); the same for the passport zone reader (`--force-mrz`) and the Hebrew field reader (`--force-he`).
- **No** → `python scripts/scan-train/clean.py` (deletes the copies; nothing changes on Hugging Face).

## 6. Give the new version to the lab
Commit `scripts/scan-lab/models-version` on the work branch and deploy it the usual way (CLAUDE.md → Git workflow: Tests workflow, PR, merge with the owner's OK). The lab (`/scan-lab/`, Admin → Scanner lab) then runs `v<N>`; the owner tries it on the phone — with document type models in the version, every shot also shows the document type, how sure, and the turn it needs.

## 7. Later — give it to the site (only when the owner says the lab is better)
Set the same version in **both** `scripts/scan/models-version` (the phone's models) and `functions/scan_models_version.txt` (written into each training example; a test keeps them equal), then deploy. The site's scanner is the lab's page (`scan/`), so it runs the version the way the lab does. Rolling back = the previous version in the same files.
