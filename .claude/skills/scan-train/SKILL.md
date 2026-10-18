---
name: scan-train
description: Retrain the scanner's corner models on the owner's PC from the corrections collected on the site (docs/scan-plan.md → S6) — download the examples, fine-tune, exam old vs new, and on the owner's yes publish a new model version to the lab. Run when the bell says "Time to retrain the scanner".
---

# /scan-train — retrain the scanner (owner's PC)

The whole process (what is collected, where it is kept, why each step): docs/scan-training.md.

The site collects every page whose corners a user corrected (`scan_feedback`, Firestore `scanTraining`, Storage `training/scan/`). This skill turns them into a new model version. **The lab learns first, the site follows**: a new version is only ever given to the lab here; the site gets it later, after the owner tried it in the lab (step 7). Talk to the owner in Russian.

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

## 5. The owner decides
- **Yes** → `python scripts/scan-train/publish.py`: the new models become `models/scan/v<N>/` in Storage (with the report), the bell's counter is reset, `scripts/scan-lab/models-version` names `v<N>`, the copies on the PC are deleted.
- **No** → `python scripts/scan-train/clean.py` (deletes the copies; nothing changes in Storage).

## 6. Give the new version to the lab
Commit `scripts/scan-lab/models-version` on the work branch and deploy it the usual way (CLAUDE.md → Git workflow: Tests workflow, PR, merge with the owner's OK). The lab (`/scan-lab/`, Admin → Scanner lab) then runs `v<N>`; the owner tries it on the phone.

## 7. Later — give it to the site (only when the owner says the lab is better)
Set the same version in **both** `scripts/scan/models-version` (the phone's model) and `functions/scan_models_version.txt` (the server's; a test keeps them equal), then deploy. Rolling back = the previous version in the same files.
