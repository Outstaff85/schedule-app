---
name: scan-train
description: Retrain the scanner on the owner's PC from what the site and the lab collected — the document edges models (docs/scan-plan.md → S6), the document type model (S7), the passport zone reader and the Hebrew field reader — through the gen flow (real data, backgrounds, made-up sets per model, QA, mix, train, exam, mine), and on the owner's yes publish a new model version to the lab. Run when the bell says "Time to retrain the document edges model", "Enough pages to train the document type model" or "New scan attempts — time to train".
---

# /scan-train — retrain the scanner (owner's PC)

The whole process (what is collected, where it is kept, why each step): docs/scan-training.md (→ 4, "The gen flow, step by step"). Talk to the owner in Russian.

**The lab learns first, the site follows**: a new version is only ever given to the lab here; the site gets it later, after the owner tried it in the lab (step 13) — and the site stays on `base-v1` until the owner says the lab's cycle is done. Every command below runs in `scripts/scan-train` (the `.venv` there). One new version holds whatever was trained and said yes to; every model not named is carried over from the lab's version.

## 1. Check the PC
- The copies go to `~/.scan-train`; with little space on C:, the owner sets `SCAN_TRAIN_HOME` to a folder on another disk (`setx SCAN_TRAIN_HOME D:\scan-train`, a new terminal after).
- `nvidia-smi` — the RTX 4070 must be listed (training on the CPU works but takes hours; say so and ask).
- Python 3.11+ in `scripts/scan-train/.venv` (create it if missing): `python -m venv scripts/scan-train/.venv`, then in it `pip install torch --index-url https://download.pytorch.org/whl/cu124`, `pip install -r scripts/scan-train/requirements.txt` and, for the made-up sets, `pip install -r scripts/scan-train/requirements-synth.txt` (and `pip install --no-deps trdg==1.8.0` for the passport zone lines).
- Google access under the owner's own account: `gcloud auth application-default login` (once; the owner signs in in the browser). Never ask for keys or passwords in chat.
- Hugging Face, the models' home (`OutStaff/scanner-models`, private; docs/hf-plan.md): the owner's token on the PC — `hf auth whoami` must say `OutStaff` (else the owner runs `hf auth login`; the token is never pasted in chat). The owner's PC keeps it in `H:\hf\home` (`HF_HOME`).
- Once, before the first training on Hugging Face: `python move_to_hf.py --apply` (the versions still in Storage go to Hugging Face as tags) and `python rename_fields.py --apply` (the records collected before H0 get today's names). Each says what it would do without `--apply`; both are safe to run again.

## 2. Where things stand
`python -m gen status` — for each model (edges, doctype, mrz, he): the real pictures a person labelled (by split), the newest made-up set and whether its QA passed, the mix, what is in `new/`, the exam's verdict (and whether the report is for the file in `new/`), gen mine's last run, and **next:** the one command to run. It only reads this PC; the bell's counters are the server's. Tell the owner in plain words which models are due.

## 3. Real data
- `python pull.py` — the kept corner examples and every new scan attempt (and `attempts/exam/`, always the exam); prints how many to train on and how many kept apart. Fewer than ~100 to train on: say it is early and ask whether to go on.
- `python pull_doctypes.py` (the page copies and the full documents' pages with their kinds; a kind with fewer than ~80 to train on: say it is early) and `python pull_templates.py` (the firm's own pages as templates; the pages `heldout.json` keeps are never laid on a training picture).
- `python -m gen real` — every real labelled picture in one index, labelled only from what a person did (read-only). Tell the owner the counts by `labelBy` and split, never a name or a number off a document. `python -m gen sources --check` must say nothing the exam keeps is on the training side.

## 4. Backgrounds
`python -m gen bg pull` (the bank from the private bucket, made ready by itself: catalogued, checked, split — `gen build` refuses a bank that is not). When the owner adds photos by hand: `python -m gen bg add ~/.scan-train/backgrounds --category auto` (the owner's own shots with `--owner`), `python -m gen bg check` (tell the owner the counts by category and the rejected photos: under 1600 px, near-duplicates, one the edges model sees a document in) and `python -m gen bg split`.
- A category the bank is short of: `python -m gen bg fetch` (CC0 / public-domain photos from Openverse, at most 40 a run, catalogued, checked and split by itself; never pushed — tell the owner how many wait for `python -m gen bg push`). The automatic cycle runs it every cycle (docs/scan-training.md → The generator tunes itself).

## 5. A made-up set per model
- **Edges:** `python -m gen build --model edges --count 8000` (scenes: one camera for the table and the documents) — with gen mine's focus once there is one: add `--focus ~/.scan-train/mine/focus.json` (step 10).
- **The capture settings**: a training run takes `~/.scan-train/gen/tune.json` (`python -m gen tune`: the camera moved toward the real photos by the last realism panel) and `gen/ablation.json` (`python -m gen ablate`: the effects that help the real exam) by itself when they are there; `--no-tune` draws today's way. Tell the owner what `gen build` printed as the capture settings, and the needs in `gen/needs.json` (a new effect, a new document type, photos no free source gives).
- **Document type, passport zone, Hebrew fields, face** (the phone's own cuts, by the lab's edges model): `python -m gen build --model doctype,mrz,he,face --count 2000` (`--focus` the same way; a new edges version in the lab: draw it again — the cache is per edges model).
- **Passport zone lines:** `python synth_lines.py mrz --count 100000`; with MIDV on the PC also `python midv_mrz.py` (training lines 00–69, select 70–79, exam 80–99; MIDV gives zone lines of four passports only: Azerbaijan, Greece, Latvia, Serbia).
- **Hebrew fields:** `python synth_fields.py --count 3000` and `python synth_fields.py --count 300 --check`.
- **Open sets** (once): `python midv.py --download midv2020 --drop-raw`, `python smartdoc.py --download --drop-raw`, then `python datasets_hf.py push` (another PC: `datasets_hf.py pull`). Before the first version trained with MIDV goes to the site, remind the owner of its terms (docs/scan-training.md → MIDV).
- The exam's own drawn sets, when an exam asks for them: `python -m gen build --model edges --exam` (E2) and `python -m gen build --model doctype,mrz,he,face --exam --editor-cap 1 --bad-share 1`.

## 6. QA
`python -m gen qa --run <run>` for every set drawn (it draws a sample again byte for byte — `gen verify` — and writes `<run>/qa/index.html`). Open the sheet, show the owner the line "intersection with held-out = 0" and the realism panel; the trainings refuse a set without a passed QA.

## 7. Mix
`python -m gen mix --model edges --synth-run <edges run> --real-repeat 30` and `python -m gen mix --model doctype --synth-run <cuts run> --synth-run <open cuts run>` (add `--midv N --smartdoc K` for the edges; the open cuts run is the phone's own cut of MIDV's and SmartDoc's training photos — `python -m gen build --model doctype --cuts --open midv,smartdoc --open-n N --count 0`, or `--open` on the cuts run itself —, about 15 % of an epoch: tell the owner the open share the summary prints). After a `gen mine`, add `--hard` (its `mine/hard/pool.jsonl`: the hard examples repeated `--hard-repeat 3` times more; refused when the pool holds anything like the exam). When `gen status` shows fewer than 20 real select rows, draw a made-up select set (`python -m gen build --model edges --split select`, or `--model doctype,mrz,he,face --split select`; then `gen qa`) and add `--select-run <that run>`: the training says which select set picked the epoch. Tell the owner the real share of an epoch (20–30 % is the aim). When `gen real` ran again after a mix, the training refuses it: run `gen mix` again.

## 8. Train
- **Edges:** `python train.py --from-mix ~/.scan-train/models/edges` — both document edges models (`edges-lite.onnx` for the live frame, `edges.onnx` for the shot), from the lab's current version (`scripts/scan-lab/models-version`); `--base <version>` starts from another published version. ~15–30 min on the 4070. The loss must go down; it prints its seed, the counts per source and the real share.
- **Document type:** `python train_doctypes.py --from-mix ~/.scan-train/models/doctype` — **only the phone's model, EfficientNet-Lite0** (`doctype-lite.onnx`; owner, 2026-10-24). A larger network only on the owner's word; the server's Lite2 is never published.
- **Passport zone reader:** `python train_mrz.py --midv` (from its best weights, `mrz-ckpt/best.pt`; the first time after `midv_mrz.py` kept 70–79 apart, with `--fresh`); when `exam_mrz.py`'s phone-path exam shows a gap there, add `--phone-run <cuts run>` (the zone lines of the phone's own cuts, a training run whose QA passed — the training lines only; it prints the shares, ~50 / 15 / 35 % made-up / MIDV / phone cuts is the aim). Each epoch prints the check lines read right; ≥ 93 % is needed.
- **Hebrew field reader** (when the owner asks): `python train_he.py --phone-run <cuts run>`.
- **Stopped in the middle:** the same command with `--resume` (only with the same data). **`--more`** trains further from the last run's weights — refused when the class table or `heldout.json` changed, when an example it trained on is on the exam side today, or the checkpoint has no data fingerprint (train fresh; `--more-anyway` only on the owner's explicit call); the edges' `--more` builds the network from the saved weights' own base by itself, and an explicit `--base` that differs is refused (docs/scan-training.md → Stopped and picked up again).

## 9. Exam
- **Edges:** `python exam.py` — the new models beside **the parent** and **the lab's version**, set by set (E1 the users' pages, the templates, E2, E3 MIDV / SmartDoc as no-regression checks only — the base model saw them —, E4 the phone's input path, E5 a card on its sheet). Show the owner the report in plain words (parent → new, each rule that failed) and the picture report it opens (`~/.scan-train/report.html`, on the PC only). "unchanged model — nothing to publish": the new file is the parent's or the lab's. "heldout.json changed since … — drawing it again": the exam draws its stale sets again by itself; only when it stops on one it cannot draw, run the command it prints, then the exam again.
- **Document type:** `python exam_doctypes.py` — the new model beside the lab's doctype-lite: the kind by type and by document, the turn exam (only pages whose turn is known; sure turns right ≥ 98 %), "your documents" editor-cut and phone-cut, the site's way against Haiku alone.
- **Passport zone reader:** `python exam_mrz.py` (the real passports, MIDV's exam passports — it stops without `midv-mrz/exam`: `datasets_hf.py pull midv-mrz`, or `--no-midv` on the owner's word —, the phone's path), against the AI and the lab's reader; say plainly when no real passport was examined.
- **Hebrew field reader:** `train_he.py`'s check is its exam (the 5 roles the phone reads, each ≥ 90 %, the ID check digit ≥ 95 %; `--phone-exam <cut exam run>` adds the phone's cuts).

A "NO": say so, then step 10 before training again — or `python clean.py`.

## 10. Mine
`python -m gen mine` — the exams' mistakes (`exam_rows.jsonl`) joined with the made-up scenes' attributes: `~/.scan-train/mine/focus.json` (what the next set draws more of: background category, layout, document kind, camera tilt, stage — each between 0.5× and 3×, at least 30 exam examples a bucket, the last run's weights halved each run), `mine/hard/pool.jsonl` (only real training-side pictures a person corrected, never an exam picture) and `mine/note.txt`. Read the note to the owner in plain words; the next round draws with `--focus` (step 5).

## 11. The owner decides
- **Yes** → first `python publish.py <flags> --dry-run` with exactly the models the owner said yes to — `--edges`, `--doctypes`, `--mrz`, `--he` (with no flag it only lists the reports it found) — and show its plan: each model's gate (the rules that failed, the warnings), the files of the version (new or carried over), the counters, the attempt folders to move; nothing is written. On the owner's yes to that plan, `python publish.py <flags>`: the version goes to Hugging Face as one commit tagged `v<N>`, the counters of the models published are reset, `scripts/scan-lab/models-version` names `v<N>`, the attempts leave `attempts/new/` (only with `--edges`), the used reports and copies are deleted (`--keep-copies` keeps the copies). It refuses a report written for another file than the one in `new/` ("is for a different model; run the exam again") and a model whose file is the lab's own. A model whose exam said no is left out unless the owner explicitly says to publish it anyway (`--force-edges`, `--force-doctypes`, `--force-mrz`, `--force-he`).
- **No** → `python clean.py` (deletes the copies but the background bank; sets each unpublished training's progress aside in `checkpoints/rejected/` with the published weights back in place; nothing changes on Hugging Face).

## 12. Give the new version to the lab
Commit `scripts/scan-lab/models-version` (and `scripts/scan-train/heldout.json` when `publish.py` said it marked the new version not held-out clean) on the work branch and deploy it the usual way (CLAUDE.md → Git workflow: Tests workflow, PR, merge with the owner's OK). The lab (`/scan-lab/`, Admin → Scanner lab) then runs `v<N>`; the owner tries it on the phone.

## 13. Later — give it to the site (only when the owner says the lab's cycle is done and the lab is better)
Set the same version in **both** `scripts/scan/models-version` (the phone's models) and `functions/scan_models_version.txt` (written into each training example; a test keeps them equal), then deploy. The site's scanner is the same scanner as the lab's (`src/scan/`), with its own copy of the models in `/scan/`, so it runs the version the way the lab does. Rolling back = the previous version in the same files.
