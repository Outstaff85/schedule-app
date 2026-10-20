# Scanner training (how the scanner learns)

The whole training of the scanner in one place: where the examples come from, where they are kept, how a model is trained, checked and handed over, and what the owner does. Approved by the owner on 2026-10-18 (docs/scan-plan.md → S6). The scanner itself is docs/scan.md → The scan window.

## The idea in one line

**The site collects → the owner's PC trains → the lab tries → the site gets the new model.**

```
 site (src/scan/)            Storage / Firestore              owner's PC                 Hugging Face                 lab (/scan-lab/)   site
 users correct corners  ──►  training/scan/, scanTraining ──► /scan-train: pull, train,  ──► OutStaff/scanner-models ──► tried on the ──► set for the site
 and document types          (or the private HF bucket)       exam, publish (on "yes")       tag v<N>, set for the lab   phone           when better
```

- **The site's scanner** is the only source of examples: real scans by the firms' users. The lab collects nothing (no login, no data).
- **The models' home is Hugging Face** (docs/hf-plan.md): the public repo `OutStaff/scanner-models`, one tag per version (`base-v1`, `v2`…), every file of the version in its commit, named by what it does (`edges.onnx`, `edges-lite.onnx`, `face.onnx`, `doctype.onnx`, `doctype-lite.onnx`, the exam reports). The examples are in Firebase (Storage `training/scan/`, Firestore `scanTraining`). A version not moved yet (`move_to_hf.py`) is still read from Storage `models/scan/<version>/` under its old names (`sa24.onnx`, `lite.onnx`, `yunet640.onnx`).
- **The lab and the site never share code or a model file** (CLAUDE.md → Scanner: the lab and the site are apart); each names the model version it uses.

## 1. What is collected (on the site)

In the scan window (docs/scan.md → The scan window):

- **Corners** — a tap on a page opens its photo with the frame the model found; the user drags a corner and taps Apply. The model's corners and the user's are an example.
- **Page kind** — each page shows the kind Haiku gave it (ID card, its back, ספח, passport, contract, other); the user can pick another. Haiku's kind and the user's are an example.

On **Done**, every page the server found is sent in the background to the function `scan_feedback` (`src/scan/server.ts`, `sendFeedback`); with no network the examples wait in a queue on the phone (`localStorage` `scanFeedbackQueue`) and go the next time the scan window opens. A page:

| | sends | kept? |
|---|---|---|
| corners moved (≥ 0.5 % of the photo) | both corners + a 256×256 copy of the part of the photo the model looked at | yes |
| kind changed | both kinds + a 256×256 copy of the page | yes |
| neither — one page in five (`rightSeen`) | its corners and kinds + the same 256×256 copy, marked `keep`, and a 256×256 copy of the page | yes, as "the model was right" (`right: true`) — so the training also learns what the model already does well and does not forget it, and the document type model gets pages of every kind, not only Haiku's mistakes |
| neither — the other four | the corners and kinds only | no — only counted |

**What the document edges model learns from** is the photo as the model saw it — before it was cut, straightened or enhanced — scaled to 256×256, which is exactly the model's input: the copy, where the model put the corners on it, and where they really are. The cut page is not needed for the corners; it is used only for the page kind, which a future kind model reads on cut pages. Never the full photo; only small copies.

## 2. Where it is kept

`scan_feedback` (`functions/main.py`, checks in `functions/feedback.py`, the files through `functions/datastore.py`; a manager login's ID token; its actions: `add` — the examples above, `document` — a full document (below), `attempt` / `attemptOutcome` — every scan attempt (S8, below), `stats`, `mode`, `settings` / `setSettings`). **Where the files go** (docs/hf-plan.md → H7): the **private** Hugging Face bucket `OutStaff/scanner-data` (the secret `HF_DATA_TOKEN`, declared on `scan_feedback` — a token that may only write there; never public); a write the bucket refuses (out of reach, no token) goes to Firebase instead, as before H7, so nothing is lost:

| | the private bucket | Firebase (until the token is there, and what is not moved yet) |
|---|---|---|
| the edges copy | `edges/<YYYY-MM>/<id>.jpg` | Storage `training/scan/<YYYY-MM>/<id>.jpg` |
| the page copy | `doctype/<YYYY-MM>/<id>.jpg` | Storage `training/scan/<YYYY-MM>/<id>-page.jpg` |
| the record | `records/<YYYY-MM>/<id>.json` | Firestore `scanTraining/<id>` |
| a full document (H8a) | `documents/<tenant>/<YYYY-MM>/<id>/page-<n>.jpg`, `record.json` | Storage `training/documents/…` |
| every scan attempt (S8) | `attempts/new/<site\|lab>/<YYYY-MM-DD>/<id>/picture.jpg`, `answer.json`, `outcome-<time>.json`; after a training `attempts/used/v<N>/…` | Storage `training/attempts/…` |

What is in Firebase moves to the bucket with `scripts/scan-train/move_data_to_hf.py --apply` (it creates the bucket private and refuses a public one; run on 2026-10-19 — nothing was there yet); it is kept for an example that lands in Firebase when the bucket refuses, and the pulls read both.

- the copies → (above);
- the record → `edgesModel`, `edgesFixed`, `moved`, `doctypeModel`, `doctypeFixed`, `doctypeBy` (who gave `doctypeModel`: `haiku` or `model`), `right` (a page the model got right, kept as a sample), `source`, `model` (the model version that answered), `tenantId`, `image`, `pageImage`, `createdAt`, `deleteAt`;
- the counts → Firestore `scanTrainingStats/current`: `edgesSince` (corner corrections since the last training — the kept right pages and the scan window's `page` examples do not count), `kept`, `right`, `movedSum`, `doctypesSince` (the page copies of each kind, by the kind the user left — for the document type model), and after a training `lastTrainedAt`, `lastVersion`, `lastReport`.

**Names (docs/hf-plan.md → H0, 2026-10-19):** the fields say which model they teach — `edges*` the document edges model, `doctype*` the document type model. Before H0 they were `cornersModel` / `cornersFixed`, `kindModel` / `kindFixed` / `kindBy`, `newSince`, `kindsSince`, `lastKindsTrainedAt` / `lastKindsReport`. `scripts/scan-train/rename_fields.py --apply` has run (2026-10-19; nothing was stored under the old names); the old names are still read, for a phone with the old app: `scan_feedback` takes an example under either name (a phone with the old app, a queued example), the counters add the old one to the new (`feedback.edges_since`, `feedback.doctype_counts`), the pulls map an old record (`common.named`), and a publish clears the old counters.

**Full documents for the field reader model (H8a, owner 2026-10-19):** on the save of the worker window after a scan (a new worker, or a rescanned one — `saveWorker` → `ManagerBridge.sendScanDocument`, `scanDocument` in `src/scan-process/session.ts`, `sendScanDocument` in `src/scan/server.ts`), the scan goes to `scan_feedback` (`action: "document"`): the document's own pages as the AI read them (not a contract, not an "Other" page; the primary marked), each page's document type, the AI's read with its `fieldBoxes` (where each field is) and the other pages' reads, the fields the scan filled (`scanned`, `workerFields`) and the fields saved (`saved`) — `corrected` lists where they differ, the AI's mistakes. Never the worker's other fields (rates, phone). **On for every firm by default**; the super-admin turns it off for a firm (`tenants/<id>/settings/scan.collectDocuments: false`, `collects_documents`). The counts: `documentsSince`, `documents`, `fieldsCorrected`. Kept without a time limit; the legal check and the notice to the workers are the owner's.

**Every scan attempt (S8, owner 2026-10-20; docs/scan-plan.md → S8):** `scan_feedback` `{"action": "attempt", "attempts": [...]}` (any manager login, up to 10 per request) takes the scanner's attempts from the site and the lab: the picture (a JPEG up to 1.5 MB), the models' corners (none when the picture was taken whole), the corners the user moved (kept only when moved ≥ 0.5 %), the outcome (`kept`, `retaken`, `deleted`), the retake group, the source (`site` / `lab`), how it came in (`camera`, `photo`, `pdf`), the model version, the way it ran and how many pages it was cut into (checks: `feedback.check_attempt`). Each goes to its own folder with `answer.json` (`attempt_record`), and the answer names the folders; a later outcome — a kept page deleted from its batch — is `{"action": "attemptOutcome", "dir", "outcome", "page"}`, written beside it as `outcome-<time>.json` (`page`: which of its pages); pages deleted before the attempt was sent come in it as `deletedPages`; the corners the user moved in the corner editor come as `edgesFixed` (the first document) and `edgesMoreFixed` (the others, `null` where not moved). The phone's side (what is an attempt, when it is decided, the queue): docs/scan.md → The scan window. The count: `attemptsSince` and `attempts`.

**Privacy:** no client can read or write any of it (no Firestore or Storage rule opens them, the bucket is private); only `scan_feedback` writes, only `/scan-train` on the owner's PC (the owner's own Google account and HF token) reads. Every firm's corrections are used, with no switch (owner, 2026-10-18). **Deleting on request:** `scripts/scan-train/delete_data.py --firm <tenantId>` or `--worker <workerId>` (`--apply`) deletes every example of a firm or a worker's full documents, from the bucket (for real: no history) and from Firebase.

**Time limit:** none in the bucket (owner, 2026-10-19 — the delete-on-request script instead). In Firebase, until moved: each record has `deleteAt` = +365 days and Firestore deletes it (the TTL policy in `firestore.indexes.json`); the copies under `training/` are deleted after 365 days by a Storage lifecycle rule (`scripts/scan/storage_lifecycle.py`, set by the rules deploy; it needs Storage Admin on the deploy's service account — the deploy warns if it could not set it).

## 3. When to train

When **20** new corrections are kept (owner, 2026-10-20: 20 for every model), the super-admin's bell shows **Time to retrain the scanner** (the server counts; the app asks `scan_feedback` `{"action":"stats"}` at most every 6 hours). When every page kind but "Other" has **20** page copies (`doctypesSince`, `feedback.DOCTYPE_AT`), it shows **Enough pages for the document type model** (`doctypesDue`). When **15** new scan attempts are in (`attemptsSince`, `feedback.ATTEMPTS_AT`; S8), it shows **New scan attempts — time to train** (`attemptsDue`). Nothing trains by itself.

## 4. How a model is trained (`/scan-train` on the owner's PC)

The skill `.claude/skills/scan-train/SKILL.md`, run in Claude Code on the owner's PC (RTX 4070), runs `scripts/scan-train/` step by step:

1. **`pull.py`** — downloads every kept corner example to `~/.scan-train/`, and every new scan attempt (S8, `attempts/new/` — in the bucket, or in Firebase where the bucket refused it): its examples by `attempts.py` (a kept page — its moved corners, else the model's — on the photo with the documents found before it painted over in the border's colour; a deleted page — "nothing here", empty maps; a retaken page with no corners moved — the exam only, as a hard page), and the folders pulled (`attempts.json`); about one in seven (chosen by its id, always the same ones) is kept apart as the **exam** and never trained on.
2. **`train.py`** — fine-tunes both corner models — `lite.onnx` (the phone's live frame) and `sa24.onnx` (the server's accurate one) — starting from the **lab's** current version (`scripts/scan-lab/models-version`):
   - the ONNX file is turned into PyTorch (`onnx2torch`) and checked to answer like the original;
   - each corner becomes a target spot (a Gaussian of the models' own spread, σ ≈ 2.4 heatmap pixels) where the user put it; a page the user deleted (S8) has no spots — "nothing here";
   - the loss weighs the spots over the empty background (a plain one makes every peak fade), batch norms keep their statistics, mirrored pages and light changes are added;
   - the trained model is exported back to ONNX and checked again. ~15–30 min on the 4070.
3. **`exam.py`** — the exam pages are read by the old models and the new ones: mean corner error, the share within 2 %, the share not found, and from the attempts the extra pages found where the user deleted one and how often a retaken page is answered other than the rejected frame → a "before → after" report (`~/.scan-train/report.json`), and **the picture report** `~/.scan-train/report.html`, opened in the browser: the 10 exam pages where the models differ most, the old corners red, the new blue, the right ones green (it shows workers' documents: it stays on the PC and goes with the copies). If any model is worse it says **do not publish**.
4. **The owner decides.** **Yes** → **`publish.py`**: the new models go to Hugging Face as the next version — one commit with every file of the version, tagged `v<N>` (the models not retrained and the face finder carried over, the reports beside them; the owner's HF token on the PC), the bell's counter is reset, the lab is pointed at `v<N>` (`scripts/scan-lab/models-version`), the attempts trained on move to `attempts/used/v<N>/` (`attemptsSince` lowered by them), and the copies on the PC are deleted. **No** → **`clean.py`** deletes the copies; nothing changes.

### The page kinds (S7)

When the bell says **Enough pages for the document type model** (every kind but "Other" has 20 page copies), `/scan-train` runs its page-kind steps:
1. **`pull_doctypes.py`** — every kept page copy with the kind the user left (and the one Haiku or the model gave); the same one in seven is the exam.
2. **`train_doctypes.py`** — two models from ImageNet weights (timm): the phone's (EfficientNet-Lite0, `doctype-lite.onnx`) and the server's (Lite2, `doctype.onnx` — no server code runs it since 2026-10-19; the phone's is the one at work), each with two answers: the kind (6) and the turn the page needs (4) — the turn learned by showing every upright copy at a random quarter turn. Exported to ONNX and checked.
3. **`exam_doctypes.py`** — on the exam pages: kind right, how many it is sure of (≥ 90 %) and how right those are, the turn right, and the site's way (the model where sure, Haiku elsewhere) against Haiku alone. A worse model → the next size up (Lite1, Lite2… — owner, 2026-10-19), trained and examined again.
4. **The owner decides** — `publish.py` puts the models into the next version beside the document edges models (the counter `doctypesSince` reset), or `clean.py`.

The models switch on by themselves once their version is set (the lab first, then the site): a page the model is sure of needs no Haiku.

## 5. Lab first, then the site

- **Lab:** the changed `scripts/scan-lab/models-version` is deployed (PR, merge); `/scan-lab/` then runs `v<N>` and the owner tries it on the phone.
- **Site:** only when the owner says the lab is better, the same version is set in **both** `scripts/scan/models-version` (the phone's light model, `/scan/`) and `functions/scan_models_version.txt` (the server's accurate model; a test keeps the two equal), then deployed.
- **Rollback:** the previous version in the same files; every version stays on Hugging Face.

At deploy each copy's `fetch-models.sh` takes its version from Hugging Face (`resolve/<tag>/<file>`, no key — the repo is public), else from Storage while the version is not moved yet; only `base-v1` may fall back to the models' authors — a trained version is the firm's own. **The server runs no scanner model** (2026-10-19: `preprocess_scan` and its Storage mirror were removed — the site's scanner is the lab's page, which runs its models on the phone); `functions/scan_models_version.txt` only names the site's version in each training example.

## 6. The owner's side

1. The bell says **Time to retrain the document edges model** (or **Enough pages to train the document type model**).
2. On the PC: Claude Code in this project → `/scan-train` (the first time it sets up Python and asks the owner to sign in to Google in the browser once; Hugging Face: `hf auth login` once, the token kept on the PC).
3. About an hour later: the "before → after" report → **yes** or **no**.
4. Try the new version in the lab (Admin → Scanner lab); if it is better, say so — it is then given to the site.

## Files

| What | Where |
|---|---|
| page kinds, their examples, sending a full document (H8a) | `src/scan/doctype.ts`, `src/scan/Scanner.tsx` (`classify`, `examples`), `src/scan/server.ts` (`sendFeedback`, `doctypeMode`, `sendScanDocument`) — the pages are cut by the lab's page (`scan/`), so they send document type examples only (`source: "page"`), no corner examples |
| receiving, checks, counts | `functions/main.py` (`scan_feedback`), `functions/feedback.py` |
| the bell's notices | `src/manager/page/header.ts` (`scanEdgesNotice`, `scanDoctypeNotice`, `scanAttemptsNotice` — S8, at 15 new attempts) |
| the training data on Hugging Face | `functions/datastore.py`; `scripts/scan-train/move_data_to_hf.py` (once), `delete_data.py` (on request), `common.py` (`DATA`, `data_records`, `data_file`), `pull.py` (`records`) |
| full documents (H8a) | `src/scan-process/session.ts` (`scanDocument`), `src/scan/server.ts` (`sendScanDocument`), `src/manager/worker-save.ts`, `functions/feedback.py` (`check_document`, `document_record`), `functions/main.py` (`_scan_document`, `collects_documents`) |
| the models on Hugging Face | `scripts/scan-train/publish.py`, `move_to_hf.py` (once), `common.py` (`REPO`, `model_path`, `next_version`); the deploys: `scripts/scan*/fetch-models.sh` |
| 12-month deletion | `firestore.indexes.json` (TTL), `scripts/scan/storage_lifecycle.py`, `.github/workflows/deploy-rules.yml` |
| training | `scripts/scan-train/` (corners: `pull.py`, `attempts.py` — the scan attempts' examples —, `train.py`, `exam.py`; page kinds: `pull_doctypes.py`, `train_doctypes.py`, `exam_doctypes.py`; both: `publish.py`, `clean.py`, `common.py`, `requirements.txt`), `.claude/skills/scan-train/SKILL.md` |
| the document type models at work | `scan-lab/index.html` (`doctypeNote`, `doctypeSess`), `scan/embed.js` (`answer` — each posted page's), `src/scan/Scanner.tsx` (Off / Shadow / Mixed), the deploy's `models.json` (`scripts/scan/fetch-models.sh`, `scripts/scan-lab/fetch-models.sh`) |
| model versions | `scripts/scan-lab/models-version`, `scripts/scan/models-version`, `functions/scan_models_version.txt` |
| tests | `tests/auth/test_scan_feedback.py`, the browser test "scan window corners and kinds" (`tests/e2e/main.test.js`) |
