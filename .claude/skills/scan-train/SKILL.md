---
name: scan-train
description: Retrain the scanner on the owner's PC from what the site collected — the corner models (docs/scan-plan.md → S6) and the page-kind models (S7) — download the examples, train, exam against the old models / Haiku, and on the owner's yes publish a new model version to the lab. Run when the bell says "Time to retrain the scanner" or "Enough pages for the page-kind model".
---

# /scan-train — retrain the scanner (owner's PC)

The whole process (what is collected, where it is kept, why each step): docs/scan-training.md.

The site collects every page whose corners a user corrected (`scan_feedback`, Firestore `scanTraining`, Storage `training/scan/`). This skill turns them into a new model version. **The lab learns first, the site follows**: a new version is only ever given to the lab here; the site gets it later, after the owner tried it in the lab (step 7). Talk to the owner in Russian.

Two kinds of training, run one or both (the bell says which is due):
- **Corners** (S6, "Time to retrain the scanner") — steps 2–4.
- **Page kinds** (S7, "Enough pages for the page-kind model") — step 4b.
Both end in the same step 5: one new version holds whatever was trained; the rest is carried over.

## 1. Check the PC
- `nvidia-smi` — the RTX 4070 must be listed (training on the CPU works but takes hours; say so and ask).
- Python 3.11+ in `scripts/scan-train/.venv` (create it if missing):
  `python -m venv scripts/scan-train/.venv`, then in it
  `pip install torch --index-url https://download.pytorch.org/whl/cu124` and `pip install -r scripts/scan-train/requirements.txt`.
- Google access under the owner's own account: `gcloud auth application-default login` (once; the owner signs in in the browser). Never ask for keys or passwords in chat.

## 2. Download the examples
`python scripts/scan-train/pull.py` — prints how many examples, how many kept apart for the exam. Fewer than ~100 to train on: tell the owner it is early and ask whether to go on.

## 3. Train
`python scripts/scan-train/train.py` — both models (`lite.onnx` for the phone's live frame, `sa24.onnx` for the server), starting from the lab's current version (`scripts/scan-lab/models-version`). ~15–30 min on the 4070. Each epoch prints its loss; it must go down.

## 4. Exam
`python scripts/scan-train/exam.py` — the pages never trained on, old models vs new: mean corner error, share within 2 %, share not found. Show the owner this report in plain words (before → after). If it says "NO — do not publish", say so and recommend `clean.py`.

## 4b. Page kinds (S7)
1. `python scripts/scan-train/pull_kinds.py` — the page copies with their kinds; prints how many per kind. A kind with fewer than ~80 to train on: say it is early, ask whether to go on.
2. `python scripts/scan-train/train_kinds.py` — the phone's model (EfficientNet-Lite0, `kind-lite.onnx`) and the server's (Lite2, `kind.onnx`), from ImageNet weights (downloaded once by timm). ~10–20 min on the 4070. The loss must go down.
3. `python scripts/scan-train/exam_kinds.py` — the exam pages: kind right, how many it is sure of (≥ 90 %) and how right those are, the turn right, and **the site's way** (the model where sure, Haiku elsewhere) against **Haiku alone**. Show the owner this in plain words.
4. When it says a model is worse, it prints the next size up (owner, 2026-10-19: Lite0 → Lite1 → Lite2… until the result is right): run that `train_kinds.py --only phone --phone tf_efficientnet_lite1` (or `--only server --server …`), then `exam_kinds.py` again. At Lite4 and still worse: more page copies are needed — `clean.py`, and wait for the bell.

## 5. The owner decides
- **Yes** → `python scripts/scan-train/publish.py`: the new models become `models/scan/v<N>/` in Storage (with the reports; every model not retrained is carried over from the lab's version), the bell's counters are reset (`newSince` after the corners, `kindsSince` after the kinds), `scripts/scan-lab/models-version` names `v<N>`, the copies on the PC are deleted. Page-kind models whose exam said "not worth publishing" are left out unless the owner explicitly says to publish them anyway (`--force-kinds`).
- **No** → `python scripts/scan-train/clean.py` (deletes the copies; nothing changes in Storage).

## 6. Give the new version to the lab
Commit `scripts/scan-lab/models-version` on the work branch and deploy it the usual way (CLAUDE.md → Git workflow: Tests workflow, PR, merge with the owner's OK). The lab (`/scan-lab/`, Admin → Scanner lab) then runs `v<N>`; the owner tries it on the phone — with page-kind models in the version, every shot also shows the kind, how sure, and the turn it needs.

## 7. Later — give it to the site (only when the owner says the lab is better)
Set the same version in **both** `scripts/scan/models-version` (the phone's models) and `functions/scan_models_version.txt` (the server's; a test keeps them equal), then deploy. The page-kind models switch on by themselves when the version has them: the deploy puts `kind-lite.onnx` on the site (`/scan/models.json` says so) and `preprocess_scan` reads `kind.onnx`; a page they are sure of needs no Haiku. Rolling back = the previous version in the same files.
