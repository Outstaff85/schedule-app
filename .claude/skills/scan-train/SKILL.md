---
name: scan-train
description: Retrain the scanner on the owner's PC from what the site collected — the document edges models (docs/scan-plan.md → S6) and the document type models (S7) — download the examples, train, exam against the old models / Haiku, and on the owner's yes publish a new model version to the lab. Run when the bell says "Time to retrain the document edges model" or "Enough pages to train the document type model".
---

# /scan-train — retrain the scanner (owner's PC)

The whole process (what is collected, where it is kept, why each step): docs/scan-training.md.

The site collects every page whose corners a user corrected (`scan_feedback`, Firestore `scanTraining`, Storage `training/scan/`). This skill turns them into a new model version. **The lab learns first, the site follows**: a new version is only ever given to the lab here; the site gets it later, after the owner tried it in the lab (step 7). Talk to the owner in Russian.

Two kinds of training, run one or both (the bell says which is due):
- **Document edges** (S6, "Time to retrain the document edges model") — steps 2–4.
- **Document types** (S7, "Enough pages to train the document type model") — step 4b.
Both end in the same step 5: one new version holds whatever was trained; the rest is carried over.

## 1. Check the PC
- `nvidia-smi` — the RTX 4070 must be listed (training on the CPU works but takes hours; say so and ask).
- Python 3.11+ in `scripts/scan-train/.venv` (create it if missing):
  `python -m venv scripts/scan-train/.venv`, then in it
  `pip install torch --index-url https://download.pytorch.org/whl/cu124` and `pip install -r scripts/scan-train/requirements.txt`.
- Google access under the owner's own account: `gcloud auth application-default login` (once; the owner signs in in the browser). Never ask for keys or passwords in chat.
- Hugging Face, the models' home (`OutStaff/scanner-models`, public; docs/hf-plan.md): the owner's token on the PC — `hf auth whoami` must say `OutStaff` (else the owner runs `hf auth login`; the token is never pasted in chat). The owner's PC keeps it in `H:\hf\home` (`HF_HOME`).
- Once, before the first training on Hugging Face: `python scripts/scan-train/move_to_hf.py --apply` (the versions still in Storage go to Hugging Face as tags) and `python scripts/scan-train/rename_fields.py --apply` (the records collected before H0 get today's names). Each says what it would do without `--apply`; both are safe to run again.

## 2. Download the examples
`python scripts/scan-train/pull.py` — prints how many examples, how many kept apart for the exam. Fewer than ~100 to train on: tell the owner it is early and ask whether to go on.

## 3. Train
`python scripts/scan-train/train.py` — both document edges models (`edges-lite.onnx` for the phone's live frame, `edges.onnx` for the server), starting from the lab's current version (`scripts/scan-lab/models-version`). ~15–30 min on the 4070. Each epoch prints its loss; it must go down.

## 4. Exam
`python scripts/scan-train/exam.py` — the pages never trained on, old models vs new: mean corner error, share within 2 %, share not found. Show the owner this report in plain words (before → after). If it says "NO — do not publish", say so and recommend `clean.py`.

## 4b. Document types (S7)
1. `python scripts/scan-train/pull_doctypes.py` — the page copies with their kinds; prints how many per kind. A kind with fewer than ~80 to train on: say it is early, ask whether to go on.
2. `python scripts/scan-train/train_doctypes.py` — the phone's model (EfficientNet-Lite0, `doctype-lite.onnx`) and the server's (Lite2, `doctype.onnx`), from ImageNet weights (downloaded once by timm). ~10–20 min on the 4070. The loss must go down.
3. `python scripts/scan-train/exam_doctypes.py` — the exam pages: kind right, how many it is sure of (≥ 90 %) and how right those are, the turn right, and **the site's way** (the model where sure, Haiku elsewhere) against **Haiku alone**. Show the owner this in plain words.
4. When it says a model is worse, it prints the next size up (owner, 2026-10-19: Lite0 → Lite1 → Lite2… until the result is right): run that `train_doctypes.py --only phone --phone tf_efficientnet_lite1` (or `--only server --server …`), then `exam_doctypes.py` again. At Lite4 and still worse: more page copies are needed — `clean.py`, and wait for the bell.

## 5. The owner decides
- **Yes** → `python scripts/scan-train/publish.py`: the new version goes to Hugging Face as one commit tagged `v<N>` (https://huggingface.co/OutStaff/scanner-models/tree/v<N>, with the reports; every model not retrained is carried over from the lab's version), the bell's counters are reset (`edgesSince` after the edges, `doctypesSince` after the document types), `scripts/scan-lab/models-version` names `v<N>`, the copies on the PC are deleted. Document type models whose exam said "not worth publishing" are left out unless the owner explicitly says to publish them anyway (`--force-doctypes`).
- **No** → `python scripts/scan-train/clean.py` (deletes the copies; nothing changes on Hugging Face).

## 6. Give the new version to the lab
Commit `scripts/scan-lab/models-version` on the work branch and deploy it the usual way (CLAUDE.md → Git workflow: Tests workflow, PR, merge with the owner's OK). The lab (`/scan-lab/`, Admin → Scanner lab) then runs `v<N>`; the owner tries it on the phone — with document type models in the version, every shot also shows the document type, how sure, and the turn it needs.

## 7. Later — give it to the site (only when the owner says the lab is better)
Set the same version in **both** `scripts/scan/models-version` (the phone's models) and `functions/scan_models_version.txt` (the server's; a test keeps them equal), then deploy (the functions' deploy copies the version from Hugging Face into the server's Storage mirror, `scripts/scan/mirror.py`). The document type models switch on by themselves when the version has them: the deploy puts `doctype-lite.onnx` on the site (`/scan/models.json` says so) and `preprocess_scan` reads `doctype.onnx`; a page they are sure of needs no Haiku. Rolling back = the previous version in the same files.
